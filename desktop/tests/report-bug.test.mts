/** Help → Report a Bug…: the URL it opens, what stays out of it, and the form it opens. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { BUG_REPORT_COPIED, REPO, bugReportNotCopied, bugReportUrl, reportBug, type BugReportHost } from "../main/report-bug.ts";

const TEMPLATES = new URL("../../.github/ISSUE_TEMPLATE/", import.meta.url);
const FORM = readFileSync(new URL("bug_report.yml", TEMPLATES), "utf8");
const CONFIG = readFileSync(new URL("config.yml", TEMPLATES), "utf8");

interface Field {
  type: string;
  id?: string;
  label?: string;
  description?: string;
  render?: string;
  required: boolean;
  options: string[];
}

/**
 * The form's shape, read by indentation. The shell has no YAML library and takes
 * no dependency for one file, so this reads the regular layout the form is
 * written in, and fails on a line outside it rather than guessing.
 */
function readForm(text: string): { top: Map<string, string>; fields: Field[] } {
  assert.doesNotMatch(text, /\t/, "YAML indents with spaces only");
  const [head, body, ...rest] = text.split(/^body:\n/m);
  assert.ok(body !== undefined && rest.length === 0, "the form has one body");
  const top = new Map([...head.matchAll(/^([a-z_]+):(?: (.*))?$/gm)].map(([, key, value]) => [key, value ?? ""]));
  for (const line of body.split("\n")) {
    assert.ok(line === "" || line.startsWith("  - type: ") || line.startsWith("    "), `outside the form's layout: ${JSON.stringify(line)}`);
  }
  const [before, ...elements] = body.split(/^ {2}- (?=type: )/m);
  assert.equal(before, "", "the body is a list of elements");
  const fields = elements.map(element => {
    const value = (indent: number, key: string) => new RegExp(`^ {${indent}}${key}: (.+)$`, "m").exec(element)?.[1];
    const options = /^ {6}options:\n((?: {8}- .+\n)+)/m.exec(element)?.[1];
    return {
      type: /^type: (\w+)\n/.exec(element)?.[1] ?? assert.fail(`an element without a type: ${element}`),
      id: value(4, "id"),
      label: value(6, "label"),
      description: value(6, "description"),
      render: value(6, "render"),
      required: /^ {4}validations:\n {6}required: true$/m.test(element),
      options: options?.trimEnd().split("\n").map(line => line.slice("        - ".length)) ?? [],
    };
  });
  return { top, fields };
}

const { top, fields } = readForm(FORM);
const field = (id: string) => fields.find(candidate => candidate.id === id) ?? assert.fail(`no field ${id}`);

function host(overrides: Partial<BugReportHost> = {}) {
  const calls: Array<[string, string]> = [];
  const value: BugReportHost = {
    appVersion: "0.7.0-dev.0",
    diagnostics: async () => DIAGNOSTICS,
    copy: text => { calls.push(["copy", text]); },
    confirm: async detail => { calls.push(["confirm", detail]); return true; },
    openExternal: async url => { calls.push(["open", url]); },
    ...overrides,
  };
  return { host: value, calls };
}

// A block of the real one's length and shape; any line of it in a URL is a leak.
const DIAGNOSTICS = [
  "Delphi diagnostics, 2026-10-24T09:00:00.000Z",
  "\nApp", "  Delphi: 0.7.0-dev.0 (packaged)", "  State: ready",
  "\nConnection", "  AI connection: Claude subscription", "  Claude Code: found, 2.1.310 at ~/.local/bin/claude",
  "\nBackend log, last 300 lines of ~/Library/Logs/Delphi/backend.log",
  ...Array.from({ length: 300 }, (_, i) => `INFO:     127.0.0.1:${50_000 + i} - "GET /api/projects/p1/papers/d${i} HTTP/1.1" 200 OK`),
].join("\n") + "\n";

test("the URL is the form on this repository, with only the version encoded into it", () => {
  assert.equal(REPO, "thekevinli/delphi");
  assert.equal(bugReportUrl("0.7.0-dev.0"),
    "https://github.com/thekevinli/delphi/issues/new?template=bug_report.yml&version=0.7.0-dev.0");
  // A version that looks like more query parameters stays one value.
  const odd = "1.0 beta+1&labels=wontfix#x";
  const url = bugReportUrl(odd);
  assert.equal(url, "https://github.com/thekevinli/delphi/issues/new?template=bug_report.yml&version=1.0%20beta%2B1%26labels%3Dwontfix%23x");
  const parsed = new URL(url);
  assert.equal(parsed.hash, "");
  assert.deepEqual([...parsed.searchParams], [["template", "bug_report.yml"], ["version", odd]]);
});

test("the URL names this form, and its version is the form's version input", () => {
  const params = new URL(bugReportUrl("0.7.0")).searchParams;
  assert.ok(existsSync(new URL(params.get("template")!, TEMPLATES)), "the template is in .github/ISSUE_TEMPLATE");
  for (const [key] of params) if (key !== "template") assert.equal(field(key).type, "input", `${key} prefills an input`);
});

test("the diagnostics go to the clipboard and never into the URL", async () => {
  const { host: reader, calls } = host();
  assert.equal(await reportBug(reader), true);
  assert.deepEqual(calls.map(([name]) => name), ["copy", "confirm", "open"], "copied, explained, then opened");
  assert.equal(calls[0][1], DIAGNOSTICS);
  assert.equal(calls[1][1], BUG_REPORT_COPIED);
  assert.match(BUG_REPORT_COPIED, /on your clipboard, ready to paste/);
  const url = calls[2][1];
  assert.equal(url, bugReportUrl("0.7.0-dev.0"));
  for (const form of [url, decodeURIComponent(url)]) {
    for (const line of DIAGNOSTICS.split("\n")) if (line.trim().length > 12) assert.ok(!form.includes(line.trim()), `leaked ${line}`);
  }
});

test("cancelling keeps the diagnostics on the clipboard and opens nothing", async () => {
  const { host: reader, calls } = host({ confirm: async () => false });
  assert.equal(await reportBug(reader), false);
  assert.deepEqual(calls.map(([name]) => name), ["copy"]);
});

test("diagnostics that cannot be copied are said and logged, and the form still opens", async t => {
  const logged = t.mock.method(console, "error", () => {});
  for (const failing of [
    { diagnostics: async () => { throw new Error("the receipt is gone\nstack"); } },
    { copy: () => { throw new Error("the receipt is gone"); } },
  ] satisfies Array<Partial<BugReportHost>>) {
    const { host: reader, calls } = host(failing);
    assert.equal(await reportBug(reader), true);
    assert.deepEqual(calls, [
      ["confirm", bugReportNotCopied(new Error("the receipt is gone"))],
      ["open", bugReportUrl("0.7.0-dev.0")],
    ]);
  }
  assert.match(bugReportNotCopied(new Error("x")), /could not copy its diagnostics \(x\)\. The bug report form still works/);
  assert.equal(logged.mock.callCount(), 2);
});

test("a browser that cannot open rejects, for the menu to show", async () => {
  const { host: reader } = host({ openExternal: async () => { throw new Error("no browser"); } });
  await assert.rejects(reportBug(reader), /no browser/);
});

test("Help has Report a Bug… next to Copy Diagnostics, and both copy the same block", () => {
  const source = readFileSync(new URL("../main/index.ts", import.meta.url), "utf8");
  const menu = source.slice(source.indexOf("function buildMenu("), source.indexOf("\n}\n", source.indexOf("function buildMenu(")));
  const help = menu.slice(menu.indexOf('role: "help"'));
  assert.deepEqual([...help.matchAll(/^ {12}label: "([^"]+)"/gm)].map(([, label]) => label),
    ["Set Up Delphi MCP", "Show Logs", "Copy Diagnostics", "Report a Bug…", "Show Data Folder"]);
  const item = help.slice(help.indexOf('label: "Report a Bug…"'), help.indexOf('label: "Show Data Folder"'));
  assert.match(item, /await reportBug\(\{/);
  assert.match(item, /\bdiagnostics, copy: text => clipboard\.writeText\(text\)/);
  assert.match(item, /openExternal: url => shell\.openExternal\(url\)/);
  // One collection of the diagnostics, shared by the two items.
  assert.equal(source.split("collectDiagnostics(").length, 2);
  assert.match(help.slice(help.indexOf('label: "Copy Diagnostics"')), /clipboard\.writeText\(await diagnostics\(\)\)/);
});

test("the issue form has its fields, and requires the kind and a description", () => {
  assert.equal(top.get("name"), "Bug report");
  assert.ok(top.get("description"));
  // No title prefix: a prefilled title would satisfy GitHub's required title.
  assert.equal(top.get("title"), undefined);
  assert.match(FORM, /^labels:\n {2}- bug\n/m);
  assert.deepEqual(fields.map(({ type, id }) => [type, id]), [
    ["markdown", undefined],
    ["dropdown", "kind"],
    ["textarea", "what-happened"],
    ["textarea", "steps"],
    ["textarea", "screenshots"],
    ["textarea", "diagnostics"],
    ["input", "version"],
  ]);
  assert.deepEqual(fields.filter(({ required }) => required).map(({ id }) => id), ["kind", "what-happened"]);
  const inputs = fields.filter(({ type }) => type !== "markdown");
  for (const { id, label } of inputs) {
    assert.match(id!, /^[A-Za-z0-9_-]+$/);
    assert.ok(label, `${id} has a label`);
  }
  assert.equal(new Set(inputs.map(({ id }) => id)).size, inputs.length, "ids are unique");
  assert.equal(new Set(inputs.map(({ label }) => label)).size, inputs.length, "labels are unique");

  assert.deepEqual(field("kind").options, [
    "Installing or launching Delphi", "The reader (PDFs, web pages)", "Memory", "Chat",
    "Plan mode or MCP", "Settings or sign-in", "Something else",
  ]);
  assert.equal(field("what-happened").label, "What happened?");
  assert.match(FORM, /^ {6}placeholder: A brief description of the bug\.$/m);
  assert.equal(field("diagnostics").render, "text");
  assert.match(field("diagnostics").description!, /Help → Copy Diagnostics/);
});

test("the attachment limit is in the form's words, not a check GitHub cannot make", () => {
  const screenshots = field("screenshots");
  assert.equal(screenshots.description, "Attach up to 2 screenshots (PNG or JPG). Please no video.");
  // A textarea with `render` takes no attachments, so the screenshots field must not have one.
  assert.equal(screenshots.render, undefined);
  assert.equal(screenshots.required, false);
});

test("every issue goes through the form", () => {
  assert.match(CONFIG, /^blank_issues_enabled: false$/m);
  assert.doesNotMatch(CONFIG, /^blank_issues_enabled: (?!false$)/m);
});
