/**
 * The FastAPI child process: how it is started, watched, and stopped.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_DEFAULT_MODEL, CLAUDE_MODELS } from "../frontend/app/lib/claude-models.ts";

export interface BackendOptions {
  /** The bundled interpreter, e.g. `<resources>/python/bin/python3`. */
  python: string;
  dataDir: string;
  logsDir: string;
  apiHost: string;
  apiPort: number;
  uiOrigin: string;
  sessionSecret: string;
  apiKey: string;
  apiBaseUrl?: string;
  /** Subscription transport; credentials never reach the Python process. */
  inference?: { url: string; token: string };
  connection?: ConnectionId;
  /** The page lender every capture, preview and draft check runs in (`browser-host.ts`). */
  browserHost?: { socket: string; token: string };
  /** Trusted host bundle built from the same artifact renderer as chat. */
  artifactRendererPath?: string;
  signal?: AbortSignal;
}

export interface Backend {
  readonly url: string;
  stop(): void;
  /** Settles once a stopped child has exited and released its port. */
  readonly closed: Promise<void>;
  /** The tail of stderr, for a failure the user would otherwise see as a blank window. */
  recentErrors(): string;
}

const LUNA = "gpt-6-luna";
const SOL = "gpt-6.1-sol";

/**
 * Every model and reasoning effort the backend reads, owned by the desktop.
 *
 * The wheel ships its own defaults and changes them between releases; an unset
 * variable would silently follow a pin bump. The parity suite fails when this
 * table and the installed backend's tasks differ: a task setting missing here,
 * one the backend no longer reads, or a different model or effort.
 */
export const MODEL_SETTINGS = {
  // The chat picker offers exactly these, whatever the wheel lists.
  MODEL_CHOICES: `${LUNA},${SOL}`,
  MODEL_DEFAULT: SOL,
  REASONING_EFFORT_DEFAULT: "medium",
  CONVERSATION_TITLE_MODEL: LUNA,
  CONVERSATION_TITLE_REASONING_EFFORT: "low",
  // Chooses the Memory pages a Project question is handed, before the answer.
  MEMORY_SELECT_MODEL: LUNA,
  MEMORY_SELECT_REASONING_EFFORT: "medium",
  DIGEST_MODEL: SOL,
  DIGEST_REASONING_EFFORT: "medium",
  // The research pass that looks outside a document before its digest is written.
  RESEARCH_MODEL: SOL,
  RESEARCH_REASONING_EFFORT: "medium",
  // Whether a document just added is one the reader deleted, whose page was kept.
  MEMORY_SAME_DOCUMENT_MODEL: LUNA,
  MEMORY_SAME_DOCUMENT_REASONING_EFFORT: "low",
  // Memory maintenance: which pages an event bears on, and whether to file at all.
  MEMORY_FILE_SELECT_MODEL: LUNA,
  MEMORY_FILE_SELECT_REASONING_EFFORT: "medium",
  // The agent that reads Memory and edits its concept pages.
  MEMORY_MAINTAIN_MODEL: SOL,
  MEMORY_MAINTAIN_REASONING_EFFORT: "medium",
  // The checker that reads each edited page against its evidence. It has the last word.
  MEMORY_VERIFY_MODEL: SOL,
  MEMORY_VERIFY_REASONING_EFFORT: "high",
  // The composer that writes how a domain's pages connect.
  MEMORY_DOMAIN_MODEL: SOL,
  MEMORY_DOMAIN_REASONING_EFFORT: "medium",
  // Reorganisation and lint.
  MEMORY_REVIEW_MODEL: SOL,
  MEMORY_REVIEW_REASONING_EFFORT: "medium",
} as const;

import { AI_CONNECTIONS, type ConnectionId } from "../frontend/app/lib/ai-connection.ts";
export type { ConnectionId } from "../frontend/app/lib/ai-connection.ts";

/** A Claude plan and a Claude API key serve the same Claude models. */
const servesClaude = (connection: ConnectionId) => AI_CONNECTIONS[connection].provider === "anthropic";

/**
 * Subscription model names stay separate from API choices because availability
 * can differ between connections. Both currently serve the same pair.
 */
export const SUBSCRIPTION_MODEL_FALLBACK: Readonly<Record<string, string>> = {
  [LUNA]: "gpt-6-luna",
  [SOL]: "gpt-6.1-sol",
};

const CLAUDE_TASK_MODELS: Readonly<Record<string, string>> = {
  [LUNA]: "claude-sonnet-5-5",
  [SOL]: "claude-opus-5-5",
};

/** `MODEL_SETTINGS` as a connection serves it. */
export function modelSettings(connection: ConnectionId): Record<keyof typeof MODEL_SETTINGS, string> {
  const claude = servesClaude(connection);
  const serve = (model: string) => claude ? CLAUDE_TASK_MODELS[model] ?? model
    : connection === "chatgpt-oauth" ? SUBSCRIPTION_MODEL_FALLBACK[model] ?? model : model;
  const choices = claude ? Object.keys(CLAUDE_MODELS)
    : [...new Set(MODEL_SETTINGS.MODEL_CHOICES.split(",").map(serve))];
  return Object.fromEntries(Object.entries(MODEL_SETTINGS).map(([key, value]) => [key,
    // The chat picker default is independent of background task sizing.
    key === "MODEL_DEFAULT" && claude ? CLAUDE_DEFAULT_MODEL
      : key === "MODEL_CHOICES" ? choices.join(",")
      : key.endsWith("_MODEL") || key === "MODEL_DEFAULT" ? serve(value) : value,
  ])) as Record<keyof typeof MODEL_SETTINGS, string>;
}

/**
 * The model and effort each backend task runs on over one connection. A ChatGPT
 * connection is usable only when its plan offers every pair.
 */
export function desktopTaskModels(connection: ConnectionId) {
  const settings = modelSettings(connection);
  return {
    chat: { model: settings.MODEL_DEFAULT, effort: settings.REASONING_EFFORT_DEFAULT },
    title: { model: settings.CONVERSATION_TITLE_MODEL, effort: settings.CONVERSATION_TITLE_REASONING_EFFORT },
    memorySelect: { model: settings.MEMORY_SELECT_MODEL, effort: settings.MEMORY_SELECT_REASONING_EFFORT },
    digest: { model: settings.DIGEST_MODEL, effort: settings.DIGEST_REASONING_EFFORT },
    memorySameDocument: { model: settings.MEMORY_SAME_DOCUMENT_MODEL, effort: settings.MEMORY_SAME_DOCUMENT_REASONING_EFFORT },
    memoryFileSelect: { model: settings.MEMORY_FILE_SELECT_MODEL, effort: settings.MEMORY_FILE_SELECT_REASONING_EFFORT },
    memoryMaintain: { model: settings.MEMORY_MAINTAIN_MODEL, effort: settings.MEMORY_MAINTAIN_REASONING_EFFORT },
    memoryVerify: { model: settings.MEMORY_VERIFY_MODEL, effort: settings.MEMORY_VERIFY_REASONING_EFFORT },
    memoryDomain: { model: settings.MEMORY_DOMAIN_MODEL, effort: settings.MEMORY_DOMAIN_REASONING_EFFORT },
    memoryReview: { model: settings.MEMORY_REVIEW_MODEL, effort: settings.MEMORY_REVIEW_REASONING_EFFORT },
  };
}

/** The API connection's task models, which the parity suite checks against the wheel. */
export const DESKTOP_TASK_MODELS = desktopTaskModels("openai-api");

/** The minimal `/responses` call first launch spends when `/models` refuses a key. */
export const KEY_CHECK = { model: LUNA, effort: "low", maxOutputTokens: 16 } as const;

/**
 * The environment Delphi runs under inside the app.
 *
 * Configuration is explicit because the bundled working directory has no env file.
 */
export function backendEnv(options: BackendOptions): NodeJS.ProcessEnv {
  if (options.connection && servesClaude(options.connection) && !options.inference) throw new Error("Claude connections require the local transport.");
  if (options.inference && options.apiKey) throw new Error("Subscription inference cannot also configure an API key.");
  return {
    // A deliberately narrow inheritance, but HOME must be the *real* one:
    // page capture records that pointing Chrome at a fresh HOME makes
    // Chrome-for-Mac treat the run as a new profile and start the Google
    // Updater, which hung every capture. This is also why the app is not
    // sandboxed.
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "en_US.UTF-8",

    // Absolute, so the settings loader's relative-path branch — which resolves
    // against the installed package's own directory and would land inside
    // site-packages — is never reached.
    DATA_DIR: options.dataDir,

    // Signs the session cookie and the page/navigation/staged-upload tokens.
    SESSION_SECRET: options.sessionSecret,
    SESSION_DAYS: "3650",
    COOKIE_SECURE: "false",

    // The UI is the only origin allowed to call the API.
    FRONTEND_ORIGINS: options.uiOrigin,

    /*
     * A *different host* from the UI, which is the entire isolation mechanism
     * for proxied third-party pages: cookies ignore port but not host, so the
     * host-only session cookie on the UI's host never reaches this origin.
     * The application's own startup check also refuses to boot if this equals
     * a frontend origin.
     */
    WEB_SANDBOX_ORIGIN: `http://${options.apiHost}:${options.apiPort}`,

    /*
     * The tier a request uses when the reader picks Flex in Settings → Advanced. The
     * backend resolves it per request: "default" (Standard) while the account
     * prefers Standard, which it does unless the reader changes it, and this
     * value otherwise. A ChatGPT plan has no tier; its bridge drops the field.
     */
    OPENAI_SERVICE_TIER: "flex",

    ...modelSettings(options.connection ?? (options.inference ? "chatgpt-oauth" : "openai-api")),

    // A plan has no Files API. PDFs then travel inline, and the file ids an API
    // key uploaded stay valid for when the reader switches back.
    ...(options.inference ? { OPENAI_FILES_ENABLED: "false" } : {}),

    /*
     * The subscription connection is the OpenAI API as far as the backend can
     * tell: a loopback base URL and a per-launch token. The reader's API key,
     * if they ever saved one, is never passed in this mode, so no request can
     * reach a paid account.
     */
    OPENAI_API_KEY: options.inference ? options.inference.token : options.apiKey,
    ...(options.inference ? { OPENAI_API_BASE_URL: options.inference.url }
      : options.apiBaseUrl ? { OPENAI_API_BASE_URL: options.apiBaseUrl } : {}),

    // Marketplace policy does not restrict registration. The core must enforce
    // a desktop bootstrap policy before public distribution.
    PERSONA_MARKETPLACE_ENABLED: "false",

    // Electron's own Chromium, lent a page at a time. With it set the backend
    // never looks for an installed Chrome, so none is ever launched.
    ...(options.browserHost ? { BROWSER_HOST_SOCKET: options.browserHost.socket, BROWSER_HOST_TOKEN: options.browserHost.token } : {}),
    ...(options.browserHost && options.artifactRendererPath
      ? { ARTIFACT_RENDERER_PATH: options.artifactRendererPath } : {}),

    // The bundle is read-only; `python-runtime.sh` has already precompiled.
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
    // Asserted rather than widened: under the frontend's type check, which
    // compiles this file for its tests, Next's types make `NODE_ENV` required,
    // and the backend child is deliberately never given one.
  } as Record<string, string | undefined> as NodeJS.ProcessEnv;
}

/**
 * The ASGI app the backend child serves: the desktop's own layer over core
 * (`desktop/backend`), installed beside core's wheel in the bundled runtime.
 * Every test and fixture that starts a backend names it through this, so they
 * run what the app runs.
 */
export const BACKEND_APP = "delphi_desktop.main:app";

/**
 * Runs uvicorn, and ends it when the app is gone however the app ended.
 *
 * The app holds the write end of this process's stdin and never writes to it.
 * The kernel closes that end when the app exits for any reason, including a
 * SIGKILL or a crash that runs no quit handler, so end-of-file on stdin means
 * the parent is gone. The backend then stops the way a normal quit stops it,
 * through SIGTERM and uvicorn's graceful shutdown, which hands running
 * filing claims back; if that hangs, it exits outright.
 */
export const PARENT_WATCH = [
  "import os, runpy, signal, sys, threading, time",
  "def orphaned():",
  "    sys.stdin.buffer.read()",
  "    os.kill(os.getpid(), signal.SIGTERM)",
  "    time.sleep(10)",
  "    os._exit(1)",
  "threading.Thread(target=orphaned, name='parent-watch', daemon=True).start()",
  "sys.argv = ['uvicorn', *sys.argv[1:]]",
  "runpy.run_module('uvicorn', run_name='__main__', alter_sys=True)",
].join("\n");

export async function startBackend(options: BackendOptions): Promise<Backend> {
  if (!existsSync(options.python)) {
    throw new Error(`No bundled interpreter at ${options.python}`);
  }

  const log = createWriteStream(join(options.logsDir, "backend.log"), { flags: "a" });
  const errors: string[] = [];

  let child: ChildProcess | undefined;
  let stopped = false;
  let restarts = 0;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  const cancellation = new AbortController();
  let markClosed!: () => void;
  const closed = new Promise<void>(resolve => { markClosed = resolve; });
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    cancellation.abort();
    clearTimeout(restartTimer);
    options.signal?.removeEventListener("abort", stop);
    const doomed = child;
    if (doomed && doomed.exitCode === null && doomed.signalCode === null) {
      doomed.kill("SIGTERM");
      // Past the graceful window above, so cancellation gets to run first.
      const timer = setTimeout(() => doomed.kill("SIGKILL"), 5_000);
      timer.unref();
      doomed.once("close", () => { clearTimeout(timer); log.end(); markClosed(); });
    } else { log.end(); markClosed(); }
  };
  log.on("error", (error) => { errors.push(error.message); stop(); });
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();

  const launch = (): void => {
    if (stopped) return;
    child = spawn(
      options.python,
      [
        "-c", PARENT_WATCH, BACKEND_APP,
        "--host", options.apiHost,
        "--port", String(options.apiPort),
        // One worker: the sync storage layer is already served through a
        // threadpool, and two workers over one .data directory would race —
        // the local storage layer guards with in-process locks only.
        "--workers", "1",
        // Two seconds for in-flight requests to finish, then uvicorn cancels
        // them. A cancelled filing drain hands its job back unspent, so the
        // job runs again on the next start instead of waiting out its lease.
        "--timeout-graceful-shutdown", "2",
        "--log-level", "info",
      ],
      {
        env: backendEnv(options),
        // A directory with no `.env` and nothing to import, rather than
        // whatever Finder handed the app.
        cwd: options.dataDir,
        // stdin is the parent-death signal described at PARENT_WATCH.
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    // Never written to; an EPIPE after the child exits is not an error.
    child.stdin?.on("error", () => {});
    child.on("error", (error) => {
      errors.push(error.message);
      stop();
    });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (!log.writableEnded) log.write(text);
      // Keep a bounded tail. The isolated PDF worker keeps its stderr for
      // exactly this reason: a subprocess that hides stderr cannot be debugged.
      errors.push(text);
      if (errors.length > 80) errors.splice(0, errors.length - 80);
    });

    child.on("exit", (code, signal) => {
      if (stopped) return;
      log.write(`\n[delphi] backend exited code=${code} signal=${signal}\n`);
      // Backoff rather than a tight loop: a misconfiguration (a bad model
      // effort pairing, say) prevents startup and would
      // otherwise spin.
      if (restarts < 5) {
        restarts += 1;
        restartTimer = setTimeout(launch, Math.min(1000 * 2 ** restarts, 15_000));
      }
    });
  };

  launch();

  const url = `http://${options.apiHost}:${options.apiPort}`;
  try {
    await waitForHealth(url, 60_000, () => errors.join(""), cancellation.signal);
  } catch (error) {
    stop();
    throw new Error(`Backend startup failed: ${error instanceof Error ? error.message : String(error)}\n${errors.join("").slice(-2000)}`, { cause: error });
  }
  return {
    url,
    stop,
    closed,
    recentErrors: () => errors.join(""),
  };
}

export async function waitForHealth(url: string, timeoutMs: number, tail: () => string, signal: AbortSignal = new AbortController().signal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(2_000, Math.max(1, deadline - Date.now())))]) });
      await response.body?.cancel();
      signal.throwIfAborted();
      if (response.ok) return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = String((error as Error).message ?? error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `The Delphi backend did not become healthy in ${timeoutMs / 1000}s (${lastError}).\n\n${tail().slice(-2000)}`,
  );
}
