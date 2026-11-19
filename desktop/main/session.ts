/**
 * Sign the single local account in, without ever showing a sign-in.
 *
 * The desktop app has no accounts, but it keeps Delphi's cookie. That is not
 * ceremony: `WEB_SANDBOX_ORIGIN` serves proxied third-party pages with
 * `allow-same-origin`, and the only thing stopping such a page from driving the
 * API is that `delphi_session` is host-only on the *UI's* host and so is never
 * sent to the sandbox's host. Delete the cookie and any page a reader adds gets
 * their whole library.
 *
 * So the mechanism stays and the experience goes: the main process registers and
 * logs in once, into the same `session.defaultSession` the window uses. The
 * password is generated, kept in the owner-only profile, and never reaches the renderer —
 * which is why this lives here and not in the page.
 *
 */
import { session } from "electron";

import { localUsername, readConfig } from "./config.ts";

interface Attempt {
  status: number;
  body: string;
}

/** Through Electron's own stack, so cookies land in the window's session. */
async function post(uiOrigin: string, path: string, payload: unknown): Promise<Attempt> {
  const response = await session.defaultSession.fetch(`${uiOrigin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    // The whole point: use the session the BrowserWindow will use.
    credentials: "include",
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.text() };
}

export async function signedIn(uiOrigin: string): Promise<boolean> {
  const response = await session.defaultSession.fetch(`${uiOrigin}/api/auth/me`, {
    credentials: "include",
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok;
}

/**
 * Make sure the window opens already signed in.
 *
 * Registration is attempted first and a 400/409 is an ordinary outcome — it
 * means this profile has run before. Only the login has to succeed.
 */
export async function ensureSession(uiOrigin: string, password: string): Promise<void> {
  if (await signedIn(uiOrigin)) return;

  const { username } = localUsername(readConfig());
  const credentials = { username, password };
  const registered = await post(uiOrigin, "/api/auth/register", credentials);
  if (registered.status === 200) return;

  const loggedIn = await post(uiOrigin, "/api/auth/login", credentials);
  if (loggedIn.status === 200) return;

  throw new Error(
    "Could not open the local Delphi account.\n\n" +
      `register: ${registered.status} ${registered.body.slice(0, 200)}\n` +
      `login: ${loggedIn.status} ${loggedIn.body.slice(0, 200)}\n\n` +
      "If this profile was created by a different install, its stored password " +
      "no longer matches. Keep config.json and data/ intact and restore the matching " +
      "profile backup. Deleting configuration does not reset the existing account.",
  );
}
