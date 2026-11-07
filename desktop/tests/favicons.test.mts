import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { faviconHandler, iconType, privateAddress, publicFetch, publicHost } from "../main/favicons.ts";

const origin = "http://localhost:8317";
const ask = (host: string, method = "GET") => new Request(`${origin}/desktop/favicon?host=${encodeURIComponent(host)}`, { method });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const fresh = () => mkdtempSync(join(tmpdir(), "favicons-"));

/** A network that answers from a table and records what it was asked. */
function network(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetch = async (url: string) => {
    asked.push(url);
    return routes[url]?.() ?? new Response(null, { status: 404 });
  };
  return { asked, fetch };
}

test("only a public DNS name is ever looked up", () => {
  assert.equal(publicHost("www.GitHub.com"), "github.com");
  assert.equal(publicHost("sgl-project.github.io"), "sgl-project.github.io");
  for (const bad of ["localhost", "127.0.0.1", "[::1]", "printer.local", "metadata.google.internal", "router.lan",
    "1.0.0.127.in-addr.arpa", "intranet", "a.b/c", "github.com:8080", "user@github.com", "", null]) {
    assert.equal(publicHost(bad), null, String(bad));
  }
});

test("a name is refused when it resolves into this machine or its network, however it is spelled", async () => {
  for (const [address, family] of [["127.0.0.1", 4], ["10.1.2.3", 4], ["172.20.0.1", 4], ["192.168.1.1", 4], ["169.254.169.254", 4],
    ["100.64.0.1", 4], ["0.0.0.0", 4], ["::1", 6], ["::", 6], ["::ffff:127.0.0.1", 6], ["fd00::1", 6], ["fe80::1", 6]] as const) {
    assert.equal(privateAddress(address, family), true, address);
  }
  assert.equal(privateAddress("140.82.112.3", 4), false);
  assert.equal(privateAddress("2606:4700::6810:84e5", 6), false);
  // The check sits where the connection is made: a public-looking name for a private address never connects.
  await assert.rejects(publicFetch("https://localhost/favicon.ico", { signal: AbortSignal.timeout(5000) }), /private address/);
});

test("an icon is served only as the image its bytes say it is", () => {
  assert.equal(iconType(PNG), "image/png");
  assert.equal(iconType(new Uint8Array([0, 0, 1, 0, 1])), "image/x-icon");
  assert.equal(iconType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(iconType(new TextEncoder().encode("<!doctype html><title>Not found</title>")), null);
});

test("a cited site's icon is fetched once, kept on disk, and served from the app", async () => {
  const dir = fresh();
  const net = network({ "https://github.com/favicon.ico": () => new Response(PNG, { headers: { "content-type": "text/html" } }) });
  const handler = faviconHandler({ dir, authenticate: async () => true, fetch: net.fetch });

  const [first, second] = await Promise.all([handler(ask("github.com")), handler(ask("www.github.com"))]);
  assert.equal(first?.status, 200);
  assert.equal(first?.headers.get("content-type"), "image/png");
  assert.equal(first?.headers.get("x-content-type-options"), "nosniff");
  assert.match(first?.headers.get("cache-control") ?? "", /^private, max-age=\d+$/);
  assert.deepEqual(new Uint8Array(await first!.arrayBuffer()), PNG);
  assert.equal(second?.status, 200);
  assert.equal(net.asked.length, 1);
  assert.deepEqual(readdirSync(dir), ["github.com"]);

  // The next launch reads it from disk and asks the network nothing.
  const offline = network({});
  const relaunched = faviconHandler({ dir, authenticate: async () => true, fetch: offline.fetch });
  assert.equal((await relaunched(ask("github.com")))?.status, 200);
  assert.equal(offline.asked.length, 0);
  assert.deepEqual(new Uint8Array(readFileSync(join(dir, "github.com"))), PNG);
});

test("a site with no usable icon is an empty answer the reader draws a letter for, and is not asked again", async () => {
  const dir = join(fresh(), "not-yet-made");
  const endless = () => new Response(new ReadableStream({ pull: controller => controller.enqueue(new Uint8Array(16_384)) }));
  const net = network({
    "https://docs.example.org/favicon.ico": () => new Response("<!doctype html><p>Home</p>", { headers: { "content-type": "text/html" } }),
    "https://big.example.org/favicon.ico": () => new Response(new Uint8Array(200_000)),
    // No length stated and no end: the cap is counted as it arrives.
    "https://endless.example.org/favicon.ico": endless,
    "https://empty.example.org/favicon.ico": () => new Response(new Uint8Array()),
  });
  const handler = faviconHandler({ dir, authenticate: async () => true, fetch: net.fetch });
  for (const host of ["docs.example.org", "big.example.org", "endless.example.org", "empty.example.org", "missing.example.org"]) {
    const response = await handler(ask(host));
    assert.equal(response?.status, 204, host);
    assert.equal(response?.headers.get("cache-control"), "no-store", host);
  }
  await handler(ask("docs.example.org"));
  assert.equal(net.asked.length, 5);
  assert.throws(() => readdirSync(dir));
});

test("a site that could not be reached is asked again, not remembered as having no icon", async () => {
  let up = false;
  const asked: string[] = [];
  const fetch = async (url: string) => {
    asked.push(url);
    if (!up) throw new Error("offline");
    return new Response(PNG);
  };
  const flaky = faviconHandler({ dir: fresh(), authenticate: async () => true, fetch });
  assert.equal((await flaky(ask("github.com")))?.status, 204);
  up = true;
  assert.equal((await flaky(ask("github.com")))?.status, 200);
  assert.equal(asked.length, 2);

  const failing = network({ "https://down.example.org/favicon.ico": () => new Response(null, { status: 503 }) });
  const handler = faviconHandler({ dir: fresh(), authenticate: async () => true, fetch: failing.fetch });
  await handler(ask("down.example.org"));
  await handler(ask("down.example.org"));
  assert.equal(failing.asked.length, 2);
});

test("a redirect may move the icon, but never off https, onto another port or a private name, or round in circles", async () => {
  const to = (location: string) => () => new Response(null, { status: 301, headers: { location } });
  const net = network({
    "https://moved.example.org/favicon.ico": to("/static/icon.png"),
    "https://moved.example.org/static/icon.png": () => new Response(PNG),
    "https://plain.example.org/favicon.ico": to("http://plain.example.org/favicon.ico"),
    "https://port.example.org/favicon.ico": to("https://intranet.example.org:8443/admin?id=1"),
    "https://inward.example.org/favicon.ico": to("https://localhost/favicon.ico"),
    "https://metadata.example.org/favicon.ico": to("https://169.254.169.254/favicon.ico"),
    "https://loop.example.org/favicon.ico": to("https://loop.example.org/favicon.ico"),
  });
  const handler = faviconHandler({ dir: fresh(), authenticate: async () => true, fetch: net.fetch });
  assert.equal((await handler(ask("moved.example.org")))?.status, 200);
  for (const host of ["plain.example.org", "port.example.org", "inward.example.org", "metadata.example.org", "loop.example.org"]) {
    assert.equal((await handler(ask(host)))?.status, 204, host);
  }
  assert.ok(!net.asked.some(url => /^http:|localhost|169\.254|:8443/.test(url)));
  assert.equal(net.asked.filter(url => url.startsWith("https://loop.")).length, 4);
});

test("the route answers only a signed-in GET for a public name, and leaves every other path alone", async () => {
  const net = network({});
  const handler = faviconHandler({ dir: fresh(), authenticate: async () => true, fetch: net.fetch });
  const denied = faviconHandler({ dir: fresh(), authenticate: async () => false, fetch: net.fetch });
  assert.equal(await handler(new Request(`${origin}/desktop/reader/find`)), undefined);
  assert.equal((await handler(ask("github.com", "POST")))?.status, 405);
  assert.equal((await denied(ask("github.com")))?.status, 403);
  assert.equal((await handler(ask("127.0.0.1")))?.status, 400);
  assert.equal((await handler(ask("../../etc/passwd")))?.status, 400);
  assert.equal(net.asked.length, 0);
});
