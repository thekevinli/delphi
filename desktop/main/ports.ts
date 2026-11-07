/**
 * The two loopback ports, and the host split the security model rests on.
 *
 * Delphi serves proxied third-party pages from `WEB_SANDBOX_ORIGIN` and grants
 * them `allow-same-origin`, which is what lets embedded players and 3D demos
 * work. That is only safe because the `delphi_session` cookie is *host-only* on
 * the UI's host and therefore never sent to the sandbox's host. Cookies ignore
 * port but not host, so the whole guarantee is the two names below being
 * different — not the two port numbers.
 *
 * Delphi already guards this twice — its own startup check refuses to boot when
 * the two collide, and its document routes answer 500 if a session cookie ever
 * reaches a sandboxed navigation. This is the third belt, on our side of
 * the line, so that a future "just use one port" simplification fails loudly
 * instead of silently handing an untrusted page an authenticated API.
 */
import { createServer } from "node:net";

/** The UI origin. Host-only cookies for `localhost` never reach `127.0.0.1`. */
export const UI_HOST = "localhost";
/** FastAPI, and therefore also `WEB_SANDBOX_ORIGIN`. */
export const API_HOST = "127.0.0.1";

export function assertHostSplit(uiHost: string, apiHost: string): void {
  if (uiHost === apiHost) {
    throw new Error(
      `The UI and API must not share a host (both "${uiHost}"). ` +
        "The sandbox origin's isolation is a host-only cookie, not a port.",
    );
  }
}

/**
 * A free port on one specific host.
 *
 * Bound to the exact host we will serve on, because "free" is per-interface:
 * `localhost` may resolve to `::1` while `127.0.0.1` is IPv4, and a port free
 * on one can be taken on the other.
 */
export async function freePort(host: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close(() => reject(new Error(`Could not find a free port on ${host}`)));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

export async function choosePorts(): Promise<{ uiPort: number; apiPort: number }> {
  assertHostSplit(UI_HOST, API_HOST);
  return { uiPort: await freePort(UI_HOST), apiPort: await freePort(API_HOST) };
}
