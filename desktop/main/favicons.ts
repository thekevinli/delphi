/**
 * `/desktop/favicon?host=…`: the icon of a site an answer cites.
 *
 * The reader never loads a remote address itself, so a cited site never sees
 * the reader's referrer, cookies or page. The shell fetches
 * `https://<host>/favicon.ico` once, when an answer citing the host is shown,
 * keeps it on disk, and serves it from the app's own origin. A site with no
 * usable icon answers 204, which the reader's image takes as an error without
 * logging one, and draws its letter mark.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, type LookupFunction } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";

const MAX_BYTES = 100_000;
const TIMEOUT_MS = 5_000;
const REDIRECTS = 3;
/** A public DNS name: labels, a dot, a letter TLD. No IP literal, no single label. */
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PRIVATE_SUFFIX = /(?:^|\.)(?:localhost|local|internal|lan|home|arpa|test|invalid)$/;

const PRIVATE = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 3]] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  PRIVATE.addSubnet(net, bits, "ipv6");
}

export function publicHost(value: string | null): string | null {
  const host = (value ?? "").trim().toLowerCase().replace(/^www\./, "");
  return HOST.test(host) && !PRIVATE_SUFFIX.test(host) ? host : null;
}

export const privateAddress = (address: string, family: number) => PRIVATE.check(address, family === 6 ? "ipv6" : "ipv4");

/** Resolve as usual, but refuse a name with any address inside this machine or its network. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, "", 0);
    if (!addresses.length || addresses.some(({ address, family }) => privateAddress(address, family))) {
      return callback(Object.assign(new Error(`${hostname} resolves to a private address`), { code: "EPRIVATE" }), "", 0);
    }
    if (options.all) return (callback as unknown as (error: null, all: LookupAddress[]) => void)(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

/**
 * One GET to a public address, checked where the connection is made so a name
 * cannot resolve elsewhere afterwards. No cookies, no referrer, no compression:
 * the size cap counts the bytes that arrive.
 */
export function publicFetch(url: string, { signal }: { signal: AbortSignal }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { lookup: publicLookup, signal, headers: { accept: "image/*", "accept-encoding": "identity" } }, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) if (typeof value === "string") headers.set(name, value);
      const status = response.statusCode ?? 502;
      const empty = status === 204 || status === 304 || (status >= 300 && status < 400);
      if (empty) response.resume();
      resolve(new Response(empty ? null : Readable.toWeb(response) as ReadableStream, { status, headers }));
    });
    request.on("error", reject);
    request.end();
  });
}

/** An icon's bytes; `null` when the site has none; a throw when the site could not be asked. */
async function download(host: string, fetcher: typeof publicFetch): Promise<Uint8Array | null> {
  let url = `https://${host}/favicon.ico`;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= REDIRECTS; hop += 1) {
    const response = await fetcher(url, { signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const next = new URL(response.headers.get("location") ?? "", url);
      // A redirect may move the icon, never off https, onto another port or onto a private name.
      if (next.protocol !== "https:" || next.port || !publicHost(next.hostname)) return null;
      url = next.href;
      continue;
    }
    if (response.status >= 500) throw new Error(`${host} answered ${response.status}`);
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      size += read.value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(read.value);
    }
    const bytes = new Uint8Array(size);
    chunks.reduce((offset, chunk) => (bytes.set(chunk, offset), offset + chunk.byteLength), 0);
    return size ? bytes : null;
  }
  return null;
}

/** The image type the bytes are, by their signature; anything else is refused. */
export function iconType(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((byte, index) => bytes[index] === byte);
  if (starts(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return null;
}

export function faviconHandler(options: {
  dir: string;
  authenticate: (request: Request) => Promise<boolean>;
  fetch?: typeof publicFetch;
}) {
  const fetcher = options.fetch ?? publicFetch;
  // One download per host per launch, however many answers cite it. A site
  // that answered without an icon is not asked again until relaunch; one that
  // could not be reached is asked again next time.
  const pending = new Map<string, Promise<Uint8Array | null>>();
  const load = async (host: string) => {
    const file = join(options.dir, host);
    const cached = await readFile(file).catch(() => null);
    if (cached) return new Uint8Array(cached);
    const bytes = await download(host, fetcher);
    if (bytes && iconType(bytes)) {
      // Written aside and renamed, so a crash never leaves half an icon to serve.
      await mkdir(options.dir, { recursive: true })
        .then(() => writeFile(`${file}.part`, bytes))
        .then(() => rename(`${file}.part`, file))
        .catch(() => undefined);
    }
    return bytes;
  };
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/desktop/favicon") return undefined;
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (!await options.authenticate(request)) return new Response(null, { status: 403 });
    const host = publicHost(url.searchParams.get("host"));
    if (!host) return new Response(null, { status: 400 });
    if (!pending.has(host)) pending.set(host, load(host).catch(() => { pending.delete(host); return null; }));
    const bytes = await pending.get(host)!;
    const type = bytes && iconType(bytes);
    if (!bytes || !type) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
      headers: { "content-type": type, "cache-control": "private, max-age=604800", "x-content-type-options": "nosniff" },
    });
  };
}
