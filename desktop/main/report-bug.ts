/**
 * Help → Report a Bug…: the diagnostics go on the clipboard, and the bug report
 * form (`.github/ISSUE_TEMPLATE/bug_report.yml`) opens in the reader's browser
 * with the app version filled in.
 *
 * The diagnostics never enter the URL. They run to hundreds of lines, and a URL
 * is kept in browser history and server logs; the clipboard goes only where the
 * reader pastes it, into a form they read over before submitting. The version is
 * the only thing the URL carries.
 *
 * Electron stays in `index.ts`: this module is handed what it calls, so the
 * tests drive the whole flow without it.
 */

/**
 * Where bug reports go. The private repository while friends preview the app;
 * Stage 10 moves it to the public one.
 */
export const REPO = "thekevinli/delphi";

/** The form's file name, and the input whose `id` the version prefills. */
const TEMPLATE = "bug_report.yml";

export function bugReportUrl(appVersion: string): string {
  return `https://github.com/${REPO}/issues/new?template=${TEMPLATE}&version=${encodeURIComponent(appVersion)}`;
}

export const BUG_REPORT_COPIED =
  "Delphi's diagnostics are on your clipboard, ready to paste. The bug report form opens on GitHub, where you " +
  "need to be signed in: choose the kind of bug, give it a title and a brief description, attach up to 2 " +
  "screenshots if they help (no video), and paste the diagnostics into the Diagnostics field. Keys, tokens, " +
  "email addresses and your user name were taken out; read the diagnostics over before you submit.";

export function bugReportNotCopied(error: unknown): string {
  const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0];
  return `Delphi could not copy its diagnostics (${reason}). The bug report form still works without them: ` +
    "choose the kind of bug, give it a title and a brief description, and attach up to 2 screenshots if they help (no video).";
}

export interface BugReportHost {
  appVersion: string;
  /** The redacted block, as Help → Copy Diagnostics collects it. */
  diagnostics: () => Promise<string>;
  copy: (text: string) => void;
  /** Says what is on the clipboard and what comes next; true goes on to the form. */
  confirm: (detail: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
}

/**
 * Copies, explains, then opens the form; resolves to whether it opened. The
 * explanation comes before the browser, not after: the browser takes the front
 * as it opens, and a dialog shown then would wait unseen behind it.
 *
 * Failing to copy the diagnostics is logged and said, and the form still opens;
 * a reader reporting a broken app must still be able to report it. Failing to
 * open the browser rejects, for the menu to show.
 */
export async function reportBug(host: BugReportHost): Promise<boolean> {
  let detail = BUG_REPORT_COPIED;
  try {
    host.copy(await host.diagnostics());
  } catch (error) {
    console.error("[delphi] Report a Bug could not copy the diagnostics:", error);
    detail = bugReportNotCopied(error);
  }
  if (!await host.confirm(detail)) return false;
  await host.openExternal(bugReportUrl(host.appVersion));
  return true;
}
