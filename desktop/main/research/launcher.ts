import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const marker = "#!/bin/sh\n# Delphi managed MCP launcher v1\n";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Keep transport details out of the install command; no secret enters this file. */
export function installLauncher(home: string, bridge: string, socket: string, pairing: string, token: string): string {
  if (![home, bridge, socket, token].every(isAbsolute) || !/^[a-f0-9-]{36}$/i.test(pairing) || [home, bridge, socket, token].some(value => /[\x00-\x1f\x7f]/.test(value))) throw new Error("Invalid MCP launcher configuration");
  const directory = join(home, ".local", "bin"), target = join(directory, "delphi-mcp");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const existing = lstatSync(target);
    if (!existing.isFile() || !readFileSync(target, "utf8").startsWith(marker)) throw new Error(`Cannot install Delphi MCP: ${target} already exists and is not a Delphi-managed launcher. Move or rename it first.`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const content = `${marker}# Refreshed by Delphi; the token stays in Delphi's profile, readable by you alone.\nif [ ! -x ${quote(bridge)} ]; then\n  echo 'Delphi MCP bridge is missing. Open Delphi to refresh this launcher.' >&2\n  exit 1\nfi\nexec ${[bridge, socket, pairing, token].map(quote).join(" ")} "$@"\n`;
  const temp = join(directory, `.delphi-mcp-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temp, "wx", 0o700);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(temp, 0o700);
    renameSync(temp, target);
  } finally {
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return target;
}

/** Match only direct setup questions; mixed research requests still go to chat.
 * /mcp is an explicit model-free escape hatch for any wording or language. */
export function isMcpSetupRequest(prompt: string): boolean {
  const text = prompt.trim().toLowerCase();
  if (text === "/mcp") return true;
  return text.length < 600 && /\bdelphi\s+mcp\b/.test(text) && /\b(install|installation|set up|setup|connect|reconnect|configure)\b/.test(text)
    && /^(?:(?:wait|ok|please)[,.]?\s+)*(?:how (?:do|can|should|to)|where (?:do|can|are|is)|i (?:forgot|forget|need help)|(?:show|tell|give|remind) me|repeat (?:the|your))\b/.test(text)
    && !/\b(?:don't|do not|never)\b/.test(text);
}
export const mcpReminder = "Keep Delphi open. MCP setup instructions are available in Help → Set Up Delphi MCP, on the plan page, or by typing /mcp in chat.";
/** Shared by chat reminders, the plan handoff, and the native Help menu. */
export const mcpSetup = {
  command: `codex mcp add delphi -- ${quote(join(homedir(), ".local", "bin", "delphi-mcp"))}`,
  introduction: "In Delphi, choose Help → Set Up Delphi MCP to prepare or refresh the local launcher. Then run this once in Terminal and open a new Codex session:",
  troubleshooting: "This absolute launcher path works even when Codex starts from the Dock. If an older registration uses only delphi-mcp, run the command above again to replace it.",
  completion: "Once Delphi MCP is registered with this absolute launcher path, subsequent app updates need no registration change: Delphi refreshes its managed launcher when it opens. Give Codex the plan_id and keep Delphi open. The connection stays local and receives no Delphi provider key; Codex uses its own account and workspace permissions.",
};
export const launcherInstructions = `${mcpSetup.introduction}\n\n\`\`\`sh\n${mcpSetup.command}\n\`\`\`\n\n${mcpSetup.troubleshooting}\n\n${mcpSetup.completion}`;
