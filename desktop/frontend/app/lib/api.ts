import { clearConversationSessions } from "./conversation-session.ts";
import type { ChatMode } from "./chat-mode.ts";
import type { AnswerTrace } from "./answer-trace.ts";
import type { FailureCause } from "./filing-failure.ts";
import type { WebSource } from "./web-sources";
import { chatModelEfforts, DEFAULT_CHAT_CONFIG } from "./chat-model-policy.ts";
// Explicit `.ts`, because `node --test --experimental-strip-types` resolves
// these pure modules by path and will not guess the extension.
import { DEFAULT_PERSONA_ID } from "./personas.ts";

/**
 * Empty in a deployed build: the Worker proxies /api/* to Cloud Run, so calls
 * are same-origin and the session cookie stays first-party. Locally the backend
 * is a separate process on :8000, which is why the default is absolute.
 *
 * Inlined at build time — set NEXT_PUBLIC_API_BASE_URL="" when building to deploy.
 */
export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

/**
 * A failed request, carrying the status so a caller can tell 401 from 404 without
 * parsing prose. Every message still comes from the server's `detail`, so existing
 * `error.message` reads are unaffected.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  /**
   * The structured half of the failure, when the server sent one.
   *
   * A 409 that says "still in use" is only actionable with the list of what is
   * using it; flattening every error to a sentence threw that away and left the
   * reader hunting. `message` stays the sentence, so nothing that only reads
   * that has to change.
   */
  readonly detail?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code?: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Where to send someone whose session has expired.
 *
 * A module-level hook rather than a prop or a context, because `api()` is a plain
 * function called from dozens of sites across several files — a context is not
 * readable from it, and threading a callback through every call site is not viable.
 * The app installs this once on mount.
 */
let unauthorizedHandler: ((from: string) => void) | null = null;
let lastRedirect = "";

export function setUnauthorizedHandler(handler: ((from: string) => void) | null) {
  unauthorizedHandler = handler;
  lastRedirect = "";
}

function reportUnauthorized() {
  clearConversationSessions();
  if (!unauthorizedHandler || typeof window === "undefined") return;
  const from = `${window.location.pathname}${window.location.search}`;
  // A page that fires several requests at once gets several 401s; they all mean
  // the same thing and should produce one navigation.
  if (from === lastRedirect) return;
  lastRedirect = from;
  unauthorizedHandler(from);
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
  options: {
    /**
     * Handle the 401 yourself. Set by the boot probe on `/api/auth/me`, whose whole
     * job is to ask whether there is a session — being told "no" is an answer, not a
     * session expiring underneath someone.
     */
    allow401?: boolean;
  } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 && !options.allow401) reportUnauthorized();
    const detail = body.detail;
    throw new ApiError(
      typeof detail === "object" && detail
        ? detail.message ?? `Request failed (${response.status})`
        : detail ?? `Request failed (${response.status})`,
      response.status,
      typeof detail === "object" && detail ? detail.code : undefined,
      typeof detail === "object" && detail ? detail : undefined,
    );
  }
  if (response.status === 204) return undefined as T;
  const result = await response.json();
  if (path.split("?")[0] === "/api/config" && result.modelReasoningEfforts) {
    result.modelReasoningEfforts = chatModelEfforts(result.modelReasoningEfforts);
  }
  return result as T;
}

export type User = {
  username: string;
  email?: string;
  useStandardTier: boolean;
};
export type PaperDigestMetadata = {
  status: "pending" | "ready" | "failed" | "missing";
  version?: string;
  model?: string;
  sourceMode?: "pdf-multimodal" | "extracted-text";
  estimatedTokens?: number;
  updatedAt?: string;
  message?: string;
  sourceUrl?: string;
};
export type DigestCitation = {
  id: number;
  /** `external` is a claim an outside source makes: it names a captured page and one of its sections. */
  claimType: "author-claim" | "digest-inference" | "external";
  page: number | null;
  section: string | null;
  evidenceId?: string | null;
};
/** An outside page, as it was captured on the day a digest first cited it. */
export type CapturedSource = {
  id: string;
  url: string;
  finalUrl: string;
  title: string;
  capturedAt: string;
  /** The passages cited from it, each with the section it was found in. */
  findings: Array<{ claim: string; quote: string; anchor: string; bearsOn: string }>;
  sections: Array<{ anchor: string; title: string; level: number; markdown: string }>;
};
export type DigestAsset = {
  id: string;
  inventoryId: string;
  kind: "source-figure" | "source-table";
  caption: string;
  alt: string;
  teachingValue: string;
  afterEvidenceId: number;
  page?: number | null;
  section?: string | null;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
};
export type ResearchDigest = {
  contentMarkdown: string;
  citations: DigestCitation[];
  assets: DigestAsset[];
};
export type Paper = {
  id: string;
  title: string;
  /** Allocated by the backend; titles are never slugged in the browser. */
  slug: string;
  filename: string;
  /** Pages for a PDF, sections for a web page. */
  pages: number;
  tokens: number;
  /** Absent on every paper stored before web documents existed, and on PDFs. */
  kind?: "pdf" | "web";
  url?: string;
  favicon?: string;
  digest?: PaperDigestMetadata;
  /** Set once a reader archives the paper out of the working set. */
  doneAt?: string;
  lastEngagedAt?: string;
  thumbnailAvailable?: boolean;
  thumbnailVersion?: number;
  /** Stamped on every capture attempt, so a failure is not retried on sight. */
  thumbnailAttemptedAt?: string;
  /** Consecutive failures at the current renderer; absent means none. */
  thumbnailAttempts?: number;
  /**
   * A web page whose saved copy is its first window, while the rest is read
   * (`capture-queue.ts`); absent once it holds all of the page.
   */
  capture?: "partial";
};

export type ConversationKind =
  | "document_chat"
  | "project_chat"
  | "memory_chat";
export type DashboardConversation = {
  id: string;
  kind: ConversationKind;
  title: string;
  lastEngagedAt: string;
  projectId?: string | null;
  paperId?: string | null;
  projectName?: string | null;
  projectSlug?: string | null;
  paperSlug?: string | null;
  /** The settings sheet's Chats pane names it, and a Dashboard thread card says what it was about with it. */
  paperTitle?: string | null;
  lastDocumentSlug?: string | null;
};
export type DashboardDocument = Paper & {
  projectId: string;
  projectName: string;
  projectSlug: string;
};
export type DashboardProject = {
  id: string;
  name: string;
  slug: string;
  /**
   * Palette position, not list position: the rows arrive sorted by recency, so
   * a project's index in `projects` changes as it is read while its colour must
   * not. Counted server-side from the same order the library rail's
   * `projectAccent` counts from, so the two surfaces always agree.
   */
  accentIndex: number;
  totalCount: number;
  activeCount: number;
  documents: DashboardDocument[];
  /** Newest engagement across every document, across the full scrollable list. */
  lastEngagedAt: string;
};
export type DashboardData = {
  stats: { projects: number; documents: number; completed: number; completedPercent: number };
  conversations: DashboardConversation[];
  projects: DashboardProject[];
};
export type DigestDetail = { paper: Paper; digest: ResearchDigest | null };

export const isWebPaper = (paper: Paper | null | undefined) =>
  paper?.kind === "web";

/** A linked PDF uses the web-document contract but keeps a PDF-shaped filename. */
export const isWebPdf = (paper: Paper | null | undefined) =>
  isWebPaper(paper) && Boolean(paper?.filename.toLowerCase().endsWith(".pdf"));

/** Archived out of the working set: still openable, out of chat and `@`. */
export const isDone = (paper: Paper | null | undefined) => Boolean(paper?.doneAt);
/**
 * Used only until /api/config answers. The server owns these limits — keep
 * this in step with the published backend configuration rather than hardcoding numbers at
 * call sites.
 */
export const DEFAULT_APP_CONFIG: AppConfig = {
  providerConfigured: false,
  ...DEFAULT_CHAT_CONFIG,
  maxPapersPerProject: 10,
  maxPapersTotalPerProject: 50,
  maxUploadMb: 30,
  maxUploadSourceMb: 60,
  maxPagesPerPaper: 100,
  webDocumentsEnabled: true,
  webBrowsingEnabled: true,
  webSavedPageMaxBytes: 8 * 1024 * 1024,
  chatImageMaxPerQuestion: 2,
  chatImageMaxPerThread: 50,
  chatImageMaxThreadBytes: 32 * 1024 * 1024,
  chatImageMaxSourceMb: 20,
  chatImageMaxSourcePixels: 40_000_000,
  chatImageMaxSide: 512,
  chatImageRetentionDays: 30,
  defaultPersona: DEFAULT_PERSONA_ID,
  personaMarketplaceEnabled: false,
  personaMaxCharacters: 30_000,
  personaMaxNameCharacters: 40,
  personaMaxTaglineCharacters: 140,
  conversationTitleMaxCharacters: 120,
  librarySearchEnabled: true,
  librarySearchMaxResults: 20,
  memoryEnabled: true,
  memoryMaxPages: 1_000,
  memoryPageMaxCharacters: 12_000,
  memoryRelatedHops: 2,
  memoryRewriteNoteMaxWords: 20,
};

export type ProjectSummary = {
  id: string;
  name: string;
  /** Unique within this owner's visible route namespace. */
  slug: string;
  paperCount: number;
  updatedAt: string;
};
export type Project = ProjectSummary & {
  owner: string;
  papers: Paper[];
};
export type ReaderResolution = {
  project: Project;
  paperId: string | null;
};
/**
 * A persona without its body. Listings and browse pages carry only this, which
 * is what keeps a marketplace page a few hundred bytes a row.
 */
export type PersonaSummary = {
  id: string;
  /** True for the ones shipped in code; those have no author and no revision.
   *  The picker groups on this field, so nothing here lists which those are. */
  official: boolean;
  name: string;
  element: string;
  tagline?: string | null;
  capabilities: string[];
  visibility?: "private" | "public";
  revision?: number;
  installs?: number;
  author?: string;
  slug?: string;
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string;
  /** Set on a copy forked from someone else's published persona. */
  installedFrom?: string;
};

export type Persona = PersonaSummary & { content: string };

/**
 * What `GET /api/chat` answers with, for any scope.
 *
 * `personaId` is `null` when this conversation has never been held in one, in
 * which case the account default answers. It names an official key or a
 * persona this account owns — and may name one since deleted, which resolves
 * to the default rather than failing the thread.
 */
export type ChatThreadRead = {
  conversationId?: string | null;
  personaId?: string | null;
  messages: ChatMessage[];
  images: ChatImage[];
};

export type PersonaCatalog = { official: PersonaSummary[]; mine: PersonaSummary[] };

/** Keyset paging: `nextCursor` is opaque and null once the listing is exhausted. */
export type PersonaBrowsePage = {
  items: PersonaSummary[];
  nextCursor: string | null;
};

export type PdfRect = { x: number; y: number; w: number; h: number };
export type HtmlAnchor = {
  version: 1; revision: string; blockHash: string; blockOrdinalHint: number;
  startInBlock: number; start: number; end: number; prefix: string; suffix: string;
};
export type Highlight = {
  id: string;
  type: "pdf" | "text" | "html";
  anchor?: HtmlAnchor;
  placement?: { revision: string; start: number; end: number };
  requestId?: string;
  page?: number;
  rects?: PdfRect[];
  start?: number;
  end?: number;
  text: string;
  color: string;
};
/**
 * What the reader wrote against a passage, anchored to the highlight that says
 * where the passage is. `filedAt` is null until a Memory pass has read it —
 * notes reach the wiki lazily and never enqueue work of their own.
 */
export type Note = {
  id: string;
  highlightId: string;
  page: number | null;
  anchorY: number | null;
  quotedText: string;
  /** Markdown. */
  body: string;
  createdAt: string;
  updatedAt: string;
  filedAt: string | null;
};
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  selectedText?: string;
  referencedPapers?: Array<{ id: string; title: string }>;
  referencedImages?: Array<{ id: string; number: number }>;
  model?: string;
  reasoningEffort?: string;
  error?: boolean;
  cancelled?: boolean;
  /** The answer was cut off before it finished, and why. What was written
   *  is kept; it is not a finished answer, and can be asked for again. */
  incomplete?: { reason: string };
  /** The web pages the answer cites, in order, each once. Links in the text
   *  are matched to these by address. */
  sources?: WebSource[];
  requestId?: string;
  viewportUrl?: string;
  viewportEvidence?: ViewportEvidence;
  /** How the answer was reached: what it was handed, what the model said it
   *  was doing and every call Delphi ran, per stretch. Stored with the answer,
   *  so a reload shows what the reader watched being built. */
  trace?: AnswerTrace;
};

export type ViewportSection = {
  anchor: string;
  title: string;
  level: number;
  markdown: string;
  words: number;
};
export type AnonymousViewport = {
  source: "anonymous";
  kind: "html" | "image" | "pdf" | "unknown";
  url: string;
  title?: string;
  sourceHash?: string;
};
export type CapturedViewport = { source: "captured"; kind: "html"; url: string; title: string; revision: string; texts: string[] };
export type ChatViewport = AnonymousViewport | CapturedViewport;
export type ViewportEvidence = {
  evidenceId: string;
  url: string;
  title: string;
  kind: "html" | "image";
  sourceHash: string;
};
export type ChatImage = {
  id: string;
  number: number;
  width: number;
  height: number;
  sourceBytes: number;
  normalizedBytes: number;
  sourceFormat: "png" | "jpeg" | "webp";
  createdAt: string;
  expiresAt: string;
  firstUseExcerpt?: string | null;
  used: boolean;
};
/**
 * What a composer's pills were set to when a question left it: Chat or Plan,
 * the model, its reasoning effort and whether web search was on. A question
 * handed from the Ask composer to a docked conversation carries these with it,
 * or the conversation sends it with its own pills and silently drops the
 * reader's choice.
 */
export type ComposerChoice = { mode: ChatMode; model: string; effort: string };
export type AppConfig = {
  providerConfigured: boolean;
  defaultModel: string;
  models: string[];
  defaultReasoningEffort: string;
  reasoningEfforts: string[];
  modelReasoningEfforts: Record<string, string[]>;
  maxPapersPerProject: number;
  maxPapersTotalPerProject: number;
  maxUploadMb: number;
  /** The largest file worth sending: above `maxUploadMb`, it is compressed first. */
  maxUploadSourceMb: number;
  maxPagesPerPaper: number;
  webDocumentsEnabled: boolean;
  webBrowsingEnabled: boolean;
  /** The largest page copy, in UTF-8 bytes, the reader's frame may send after an annotation. */
  webSavedPageMaxBytes: number;
  /** Browser-store listing used only by the first-paste signed-in prompt. */
  chatImageMaxPerQuestion: number;
  chatImageMaxPerThread: number;
  chatImageMaxThreadBytes: number;
  chatImageMaxSourceMb: number;
  chatImageMaxSourcePixels: number;
  chatImageMaxSide: number;
  chatImageRetentionDays: number;
  /** What a conversation answers as until the reader picks. */
  defaultPersona: string;
  personaMarketplaceEnabled: boolean;
  personaMaxCharacters: number;
  personaMaxNameCharacters: number;
  personaMaxTaglineCharacters: number;
  conversationTitleMaxCharacters: number;
  librarySearchEnabled: boolean;
  librarySearchMaxResults: number;
  memoryEnabled: boolean;
  memoryMaxPages: number;
  memoryPageMaxCharacters: number;
  memoryRelatedHops: number;
  /** Words a reader may use to say why a page should be written again. */
  memoryRewriteNoteMaxWords: number;
};

/** One hit from the raw layer: a pointer into a document, never its text. */
export type LibraryHit = {
  paperId: string;
  paperTitle: string;
  /** Route metadata, so a hit is a link rather than a second round trip. */
  paperSlug: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  documentKind: "pdf" | "web";
  /** `page` for a PDF, `section` for a web document. */
  kind: "page" | "section";
  locator: string;
  /** How the hit is cited back — "p. 7" or the heading's own title. */
  locatorLabel: string;
  sectionTitle: string;
  snippet: string;
  score: number;
  done: boolean;
};

export type LibrarySearchResponse = { query: string; results: LibraryHit[] };

/**
 * A Memory page without its body — what every listing carries.
 *
 * The split mirrors `PersonaSummary`/`Persona` and exists for the same reason:
 * a listing that can carry bodies is a listing that eventually does.
 */
export type MemoryKind = "domain" | "concept" | "source";

export type MemoryCitation = {
  id: number;
  /**
   * `author-claim` is what a document says; `external` a claim an outside
   * source makes, with the capture it rests on; `reader-note` the reader's
   * own margin note; `derived` Delphi's inference, which names no source and
   * so carries no locator.
   */
  claimType: "author-claim" | "external" | "reader-note" | "derived";
  evidenceId?: string | null;
  /** False when the capture an `external` citation names is no longer kept. */
  captured?: boolean;
  noteId?: string | null;
  paperId?: string | null;
  page?: number | null;
  section?: string | null;
  /** Display context derived from the source's validated research digest. */
  sectionTitle?: string | null;
};

export type MemoryFigure = {
  id: string;
  pageId: string;
  caption: string;
  alt?: string | null;
  origin: { paperId?: string; page?: number; url?: string };
  width: number;
  height: number;
  bytes: number;
  createdAt: string;
  /** False when capture failed; the page omits the unavailable visual. */
  captured: boolean;
  sourceUrl?: string;
  kind?: "source-figure" | "source-table";
  provenance?: Record<string, unknown>;
  mimeType?: string;
  skillVersion?: string | null;
};

export type MemoryPageSummary = {
  id: string;
  slug: string;
  kind: MemoryKind;
  domain: string;
  title: string;
  summary: string;
  tags: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  linkDegree: number;
  sourcePaperId?: string;
  score?: number;
};

export type MemoryPage = MemoryPageSummary & {
  body: string;
  citations: MemoryCitation[];
  /** Every `[[slug]]` the body points at. */
  links: string[];
  figures: MemoryFigure[];
};

/**
 * One page a pass touched, and what it did to it.
 *
 * `kind` and `action` are nullable because an event written before `edits`
 * existed recorded a slug and nothing else. Null means "this event does not
 * say", which the row renders as silence rather than as a guess.
 */
export type MemoryEdit = {
  slug: string;
  title: string;
  kind: MemoryKind | null;
  /**
   * Computed from `revision == 1`, never asked of the model.
   * `merged` is reserved for a future consolidate pass; nothing writes it yet,
   * but the Log filter and badge already know the word so the UI does not need
   * a second trip when that pass lands.
   */
  action: "created" | "revised" | "merged" | "deleted" | null;
  /** This pass's line about *this* page; null falls back to the event summary. */
  note?: string | null;
  /**
   * When `action` is `merged`, the slug that was folded in. Absent on every
   * event today — the Log only renders the arrow when both sides are present.
   */
  mergedFrom?: string | null;
};

/**
 * Two or more pages of the base asserting incompatible things.
 *
 * `quotes` holds, for every page named, at least one passage copied from that
 * page, so the disagreement can be read without opening either.
 */
export type MemoryContradiction = {
  pages: string[];
  claim: string;
  detail: string;
  quotes?: Array<{ page: string; quote: string }>;
};

/**
 * One page a document's last job staged and could not write, with the
 * checker's reason and the passage it objected to.
 */
export type MemoryDroppedPage = {
  slug: string;
  title: string;
  action: string;
  reason: string;
  quote: string;
};

/** A figure kept as a link rather than captured — the ones that rot. */
export type MemoryUncapturedFigure = {
  id: string;
  caption: string;
  sourceUrl?: string;
  pageSlug?: string | null;
};

export type MemoryEvent = {
  kind: string;
  createdAt: string;
  summary: string;
  method?: string;
  /**
   * Every slug this pass wrote. Kept as strings forever — the census and the
   * log's fallback row both read it, and a record that keeps its old shape is
   * the habit `paper_record` enforces. `edits` is the richer list beside it,
   * absent on every event written before it existed.
   */
  pages?: string[];
  edits?: MemoryEdit[];
  figures?: string[];
  requestId?: string;
  projectId?: string;
  paperId?: string;
  /** A filing's author, by the name the reader knew it by: what Written by names once it is deleted. */
  title?: string;
  /** A Memory chat's filing: which generation of the chat wrote, as a reset chat keeps its id. */
  chatGeneration?: number;
  /** Lint only: the one finding only a model can make. */
  contradictions?: MemoryContradiction[];
  /** Lint only: the marker of each `reconcile` job the check queued. */
  reconcile?: string[];
  /**
   * Lint only: the computed half as it stood when the check ran, kept on the
   * event so a reader can see what the model was looking at. Same shape as
   * the live `/health` field — Health reads that live, but the event still
   * carries the snapshot.
   */
  brokenFigures?: MemoryUncapturedFigure[];
};

/**
 * The Health tab's payload: arithmetic over the records, plus the last check.
 *
 * The two tiers are deliberately different shapes. Everything at the top level
 * is computed on every request and is correct before anyone presses anything;
 * `lastCheck` is a model pass and is `null` until one has run, which is why
 * contradictions show a dash rather than a zero.
 */
export type MemoryHealth = {
  pages: number;
  computedAt: string;
  orphans: Array<{
    slug: string;
    title: string;
    kind: MemoryKind;
    domain: string;
  }>;
  uncapturedFigures: MemoryUncapturedFigure[];
  droppedTargets: MemoryDroppedTarget[];
  lastCheck: MemoryEvent | null;
};

/**
 * A page a document's last job dropped, with the document a retry names.
 *
 * Reported from the newest event of the document's markers, so a later job
 * that wrote everything it staged clears the row with no flag to go stale.
 */
export type MemoryDroppedTarget = MemoryDroppedPage & {
  marker: string;
  paperId: string;
  projectId?: string | null;
  filedAt?: string | null;
};

/**
 * One piece of durable work the wiki owes itself.
 *
 * The queue is the server's; a foreground tab only runs it. `label` and
 * `context` are resolved from the records by `GET /api/memory/maintenance`,
 * because a marker is an idempotency key and says nothing to the person whose
 * document it is.
 */
export type MaintenanceJob = {
  id: string;
  kind: "document" | "session" | "reconcile" | "domain" | "page-rewrite";
  marker: string;
  /**
   * What the job was queued with. A document job names its document here, and
   * so does the session beside one; a Memory chat's session names its
   * conversation.
   */
  payload?: { projectId?: string | null; paperId?: string | null; conversationId?: string | null };
  status: "pending" | "leased" | "failed";
  attempts: number;
  leaseExpiresAt: string | null;
  retryAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  label: string;
  context: string;
  /** Why a failed job stopped (`lib/filing-failure.ts`); null for one that has not failed. */
  failure: JobFailure | null;
};

/** The server's account of a failed job: which cause, and for a refused check, the pages and why. */
export type JobFailure = {
  cause: FailureCause;
  /** When this failure happened: what names it, where the row's `updatedAt` moves for other reasons. */
  failedAt: string;
  pages: Array<{ title: string; reason: string }>;
};

/** The queue's counts and its rows. `due` is what a drain would claim now. */
export type MaintenanceSnapshot = {
  pending: number;
  leased: number;
  /**
   * What "Stop filing" would remove, counted by the server with the same rule
   * the cancel applies — including the document being written this second,
   * which the drain abandons at its next stage boundary. Not derived here: a
   * client counting rows itself would eventually offer to stop work the cancel
   * leaves alone, which is how the button came to do nothing during a
   * single-document run.
   */
  cancellable: number;
  failed: number;
  due: number;
  jobs: MaintenanceJob[];
  /** How many tries a job gets before it gives up. */
  maxAttempts: number;
};

/**
 * One domain of interest, as a record rather than a string on every page.
 *
 * `domain` repeats `slug`, and both are kept: every reader of this listing
 * predates the record and reads `entry.domain`, so promoting a string to an
 * entity broke none of them.
 */
export type MemoryDomain = {
  slug: string;
  domain: string;
  title: string;
  summary: string | null;
  /** `reader` once someone has claimed the domain; never downgrades to `model`. */
  origin: "model" | "reader";
  position: number;
  pages: number;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * One page a re-filing pass thinks belongs somewhere else.
 *
 * A proposal, never an applied change: the reader accepts moves one at a time,
 * because a pass that re-filed forty pages the moment it finished would cost
 * forty undos to disagree with.
 */
export type MemoryMove = {
  slug: string;
  title: string;
  from: string;
  to: string;
  why: string;
};

export type MemoryReorganization = {
  moves: MemoryMove[];
  method: string;
  domains: MemoryDomain[];
};

/**
 * What a Related Memory rail needs, and nothing else.
 *
 * Deliberately not `MemoryOverview`: that carries the event log too, which
 * nothing on the Reader's own critical path reads.
 */
export type MemoryGraph = {
  revision: number;
  statistics: MemoryGraphStatistics;
  domains: MemoryDomain[];
  pages: MemoryPageSummary[];
  links: Array<{ from: string; to: string }>;
};

export type MemoryGraphStatistics = {
  pages: number;
  links: number;
  domains: number;
};

export type MemoryNeighborhood = MemoryGraph & {
  center: MemoryPageSummary | null;
  distances: Record<string, number>;
};

export type MemoryDocumentNeighborhood = MemoryNeighborhood & {
  paperId: string;
  filing: DocumentFilingState;
  sourcePage: MemoryPageSummary | null;
};

/**
 * What the wiki holds *about one document*, when the graph shows nothing — and
 * one thing it holds when the graph shows a page.
 *
 * Several booleans rather than one, because "no page for this document" is
 * several different situations wearing the same absence: never filed, filing
 * still owed, and filed by a pass that wrote no page carrying the document's
 * provenance. The Reader's rail says a different sentence for each.
 *
 * `stale` is the one that is true even when there *is* a page: filed, readable,
 * and written by a pass Delphi has since replaced. It is the only field here
 * the reader can see beside a document that looks perfectly well filed, and
 * without it nothing in the product ever offered to bring such a page forward.
 */
export type DocumentFilingState = {
  filed: boolean;
  /** A maintenance job for it is pending, leased, or waiting on a retry. */
  queued: boolean;
  /** A job that reached its attempt ceiling; nothing will pick it up again. */
  stuck: boolean;
  /** Filed, but by a pass that is no longer the one Delphi files with. */
  stale: boolean;
  /** What its last job staged and could not write; any entry offers Retry. */
  dropped: MemoryDroppedPage[];
  /** Which pass wrote it, or null where it predates the stamp. */
  filedVersion: string | null;
  /** The pass running now. Served, so no client spells the constant itself. */
  version: string;
  /**
   * A page a deleted document left, which this one may be. Its filing waits
   * until the reader says whether to use that page.
   */
  /** The kept page a waiting filing asks about; `deletedAt` is null for a document deleted before Delphi noted when. */
  sameAs: { slug: string; title: string; deletedAt: string | null } | null;
};

export type MemoryOverview = {
  version: string;
  revision: number;
  statistics: MemoryGraphStatistics;
  domains: MemoryDomain[];
  pages: MemoryPageSummary[];
  /** Every `[[slug]]` edge a page's body carries. */
  links: Array<{ from: string; to: string }>;
  events: MemoryEvent[];
};

/**
 * One document a page was compiled from, with its citations grouped.
 *
 * `available: false` is a document that has since been deleted or moved out of
 * reach. It is kept rather than dropped: provenance survives the paper, so the
 * dangling citation is exactly what the reader should see.
 */
export type MemorySource = {
  paperId: string;
  projectId: string | null;
  title: string | null;
  passages: number;
  pages: number[];
  sections: string[];
  available: boolean;
};

/**
 * One author of a concept page, read from the event log
 * (`memory_authorship`): a document's filing, the chats and notes beside a
 * document, or a Memory chat. Once the reader has deleted it, `removed` is
 * set and `title` is the name its event kept, or null for a filing from
 * before events kept one.
 */
export type MemoryAuthor = {
  kind: "document" | "session" | "chat";
  id: string;
  projectId: string | null;
  title: string | null;
  firstAt: string;
  note: string | null;
  removed: boolean;
};

/** A page deleting a document or a project may take with it (`GET /api/memory/{documents|projects}/{id}/dependents`). */
export type MemoryDependentPage = Pick<MemoryPageSummary, "slug" | "title" | "kind">;

export type MemoryPageDetail = {
  page: MemoryPage;
  sources: MemorySource[];
  backlinks: MemoryPageSummary[];
  /** A source page's document, wherever it is filed now; `projectId` is null once it has left the library. */
  document?: { paperId: string; projectId: string | null } | null;
  /** A concept page's, oldest first; empty for a source or domain page. */
  authors?: MemoryAuthor[];
};

/**
 * A PDF that only fits once compressed. The bytes are already stored under a
 * paper id the token carries; the record is not written until the reader says
 * yes, and the bytes are deleted if they say no.
 */
export type StagedUpload = {
  status: "compressed";
  title: string;
  uploadedBytes: number;
  bytes: number;
  token: string;
};

/** An upload either becomes a paper outright, or waits on the reader. */
export type UploadResult = Paper | StagedUpload;

export const isStagedUpload = (result: UploadResult): result is StagedUpload =>
  (result as StagedUpload).status === "compressed";
