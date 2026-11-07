/**
 * A test-only profile directory, honoured only when `DELPHI_PROFILE_DIR` is set.
 *
 * The packaged-app smoke (`build/smoke-packaged.mjs`) runs the built app on a
 * scratch profile so it never touches the reader's library. Everything the
 * profile holds lives under `userData`: config.json, the data directory, logs,
 * research plans, and also Chromium's cookies and storage and the
 * single-instance lock. So the override has to land before any of those is
 * read, which is why `index.ts` imports this module first.
 *
 * Unset, nothing changes. Set, it must be an absolute path: a relative one
 * would resolve against whatever the working directory happens to be, which for
 * a bundled app is nowhere in particular. An unusable value stops the app rather
 * than falling back, because the fallback is the reader's real library.
 *
 * Each profile keeps its own secrets in its own config.json, so a scratch
 * profile never reads or replaces another profile's.
 */
import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { app } from "electron";

export const PROFILE_DIR_ENV = "DELPHI_PROFILE_DIR";

/** The overriding directory, `undefined` when the variable is unset, or a refusal. */
export function profileOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[PROFILE_DIR_ENV];
  if (value === undefined) return undefined;
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${PROFILE_DIR_ENV} must be an absolute path, not ${JSON.stringify(value)}. Unset it to use the real profile.`);
  }
  return resolve(value);
}

export function applyProfileOverride(target: Pick<Electron.App, "setPath">, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = profileOverride(env);
  if (dir === undefined) return undefined;
  // `setPath` refuses a directory that does not exist yet.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  target.setPath("userData", dir);
  // Its default already follows `userData`; stated so the window's cookies
  // cannot land in the real profile whatever reads the path first.
  target.setPath("sessionData", dir);
  return dir;
}

applyProfileOverride(app);
