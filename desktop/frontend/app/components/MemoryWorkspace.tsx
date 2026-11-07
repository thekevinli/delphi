"use client";

/**
 * Memory, browsed.
 *
 * A real page outside the `(reader)` group, so opening it does
 * not tear down the reading workspace behind it — and so coming back from it
 * remounts nothing.
 *
 * Three routes over one dataset: the page tree with its backlinks rail, the
 * graph, and health — what is wrong with the wiki's shape, beside the log of
 * what every pass touched. Graph and Health live at durable subroutes reached
 * from Settings; health adds its own API read, the only one that costs a
 * figures query.
 *
 * The log had a tab of its own until it did not earn one: it and the findings
 * are the same scope asked from two sides, and reading them apart meant
 * clicking between two views to learn whether the finding in front of you was
 * the one this morning's pass had just made.
 *
 * Searching used to live here twice over and belong here neither time: a Find
 * control in the top bar that reached only wiki pages, and a `LibraryPane` over
 * the raw library that no route had mounted since the tabs were rebuilt. Both
 * are gone. Account-wide search is `SearchOverlay`, opened from the account
 * menu or ⌘K over whichever shell is mounted — which is where a control whose
 * scope is the whole product belongs.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { waitForMemoryRewrite } from "../lib/memory-rewrite";
import { authorDate, authorName } from "../lib/memory-authorship";
import { deletedCounts, provenanceCounts, sourceGroups } from "../lib/provenance";
import {
  type CSSProperties,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
  useState,
} from "react";

import {
  API_BASE,
  ApiError,
  api,
  DEFAULT_APP_CONFIG,
  setUnauthorizedHandler,
  type AppConfig,
  type ComposerChoice,
  type MemoryEdit,
  type MemoryEvent,
  type MemoryHealth,
  type MaintenanceJob,
  type MaintenanceSnapshot,
  type MemoryKind,
  type MemoryMove,
  type MemoryReorganization,
  type MemoryOverview,
  type MemoryNeighborhood,
  type MemoryPage,
  type MemoryPageDetail,
  type MemoryPageSummary,
  type DashboardDocument,
  type PdfRect,
  type Project,
  type ProjectSummary,
  type PersonaSummary,
  type User,
} from "../lib/api";
import {
  type BackfillCandidate,
  type BackfillPlan,
  type BackfillState,
  backfillFromQueue,
  type RunDocument,
  type RunSummary,
  backfillFraction,
  describeFilingStage,
  describePlan,
  describePlanAction,
  describeRun,
  failureKey,
  planBackfill,
} from "../lib/backfill";
import { FAILURE_CAUSES, causeOf, failureSentence } from "../lib/filing-failure";
import { documentPath, focusBox } from "../lib/routes";
import { CHAT_COLUMN, MEMORY_CHAT, defaultChatColumn, memoryChatColumn, rightColumnCeiling } from "../lib/right-column";
import { sideColumnCeiling, sideColumnWidth } from "../lib/side-chat";
import { rememberMemoryPage } from "../lib/last-read";
import { SettingsModal, type SettingsPane } from "./SettingsModal";
import { DEFAULT_PERSONA_ID } from "../lib/personas";
import {
  buildMemoryTree,
  treePath,
  type TreeNode,
  treeSlugs,
} from "../lib/memory-tree";
import { readSseStream, type SseEvent } from "../lib/sse";
import {
  drainMemoryMaintenance,
  memoryStages,
  onMemoryFiled,
  onMemoryQueue,
  onMemoryStage,
  requestMemoryMaintenance,
  startMemoryMaintenance,
} from "../lib/memory-maintenance";
import { startCaptures } from "../lib/capture-queue";
import {
  KIND_LABELS,
  knownPages,
  type KnownPages,
  dailyEditCounts,
  eventEdits,
  groupEditsByDay,
  isMemorySlug,
  memorySlug,
  MAX_SEEDED_QUESTION,
  MEMORY_PAGES_CHANGED,
  plainSummary,
  relatedMemory,
  summaryRepeatsBody,
} from "../lib/memory";
import { ChatPanel } from "./ChatPanel";
import { PanelDivider } from "./PanelDivider";
import { RelatedMemoryRail } from "./RelatedMemoryRail";
import type { ConversationSummary } from "../lib/conversation-session";
import { AskComposer } from "./chat/AskComposer";
import { AskDelphiButton } from "./chat/AskDelphiButton";
import { MemoryIcon } from "./MemoryIcon";
import { MemoryGraphCanvas } from "./MemoryGraphCanvas";
import { MemoryRail, type MemoryView } from "./MemoryRail";
import {
  EFFORT_LABELS,
  modelLabel,
  ModelPill,
  PersonaPill,
} from "./ChatBits";
import { type CiteMarker, MemoizedMemoryBody } from "./MemoryMarkdown";
import CapturedSourceView, { OutsideSourceLink } from "./CapturedSourceView";
import { TopBar } from "./TopBar";
import { ModalLayer } from "./ModalLayer";
import { hint, MARKS, NoticeMark, Toast, type Notice, type NoticeState } from "./Notice";
import { Chevron, TechnicalDetail } from "./HealthBits";
import { RunFailures } from "./RunFailures";
import { useDismissOnOutsideActivity } from "../lib/use-dismiss";
import {
  dayLabel,
  gaveUp,
  gaveUpLine,
  type HealthList,
  healthCounts,
  jobTag,
  notWritten,
  type RailStatus,
  railStatus,
  type Waiting,
} from "../lib/health-status";

export type MemorySection = "wiki" | "graph" | "health";
type MemoryOperationError = {
  message: string;
  retry?: "reload" | "refile";
};

async function requestReorganization(
  onProgress: (message: string) => void,
): Promise<MemoryReorganization> {
  const response = await fetch(
    `${API_BASE}/api/memory/reorganize/stream`,
    { method: "POST", credentials: "include" },
  );
  if (!response.ok || !response.body) {
    throw new Error(
      response.status === 503
        ? "No model provider is configured"
        : `Request failed (${response.status})`,
    );
  }
  let result: MemoryReorganization | null = null;
  let failed = "";
  for await (const payload of readSseStream(response.body)) {
    if (payload.type === "progress") {
      onProgress(String(payload.message || "Reviewing page placement…"));
    } else if (payload.type === "error") {
      failed = String(payload.message || "The re-filing check failed");
    } else if (
      payload.type === "done" &&
      Array.isArray(payload.moves) &&
      Array.isArray(payload.domains)
    ) {
      result = payload as MemoryReorganization;
    }
  }
  if (failed) throw new Error(failed);
  if (!result) throw new Error("The re-filing check ended without a result");
  return result;
}

/**
 * How far back a page counts as recently changed for the census line.
 *
 * A fixed window rather than "since you last looked": the base keeps no record
 * of when that was, and inventing one would make the count mean something
 * different on every visit — which is worse than meaning one slightly arbitrary
 * thing consistently.
 *
 * A day rather than the week this used to be. A week is a horizon over which
 * the number stops meaning anything: on any base being actively read it is
 * large, it never returns to zero, and a count that is always on reads as
 * decoration rather than as news. A day goes quiet, which is what makes it
 * worth glancing at. The settings sheet used to carry a copy of this constant
 * for a Memory card that no longer exists there — the account menu
 * reaches the wiki now — so this is the only one.
 */
const CHANGED_WINDOW_MS = 24 * 60 * 60 * 1000;

export function MemoryWorkspace({
  initialSlug,
  initialSection = "wiki",
  initialAsk = false,
  initialQuestion = "",
  initialDomain = null,
}: {
  initialSlug: string | null;
  /** The map opens zoomed onto this domain (`/graph?domain=`), e.g. on the
   *  way back from one of its pages. */
  initialDomain?: string | null;
  /** Route-selected surface; Graph and Health have durable subroutes. */
  initialSection?: MemorySection;
  /** Reopen the Spotlight overlay after a reload (`?ask=1`). */
  initialAsk?: boolean;
  /** One-shot seed from `?q=` — auto-sent once the overlay is ready. */
  initialQuestion?: string;
}) {
  const router = useRouter();
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [neighborhood, setNeighborhood] = useState<MemoryNeighborhood | null>(null);
  const [detail, setDetail] = useState<MemoryPageDetail | null>(null);
  // Which slug `detail` is an answer *about* — set on success and on the
  // "there is no such page" path alike. Without it a fetch still in flight is
  // indistinguishable from one that came back empty, and the pane spends the
  // request telling the reader the page was never written. That is wrong most
  // visibly right after a filing: the pass writes the page, the rail opens it,
  // and the wiki says nothing has been written here yet.
  const [resolvedSlug, setResolvedSlug] = useState<string | null>(null);
  const [slug, setSlug] = useState(initialSlug);
  const section = initialSection;
  // The router reuses this shell across views. Adopt the destination's domain
  // before rendering its map, while keeping local focus through Health visits.
  const [domainFocus, setDomainFocus] = useState({
    section, domain: initialDomain, focus: initialDomain,
  });
  const routeChanged = domainFocus.section !== section || domainFocus.domain !== initialDomain;
  // The list Health's rail foot opened, closed again whenever Health is left.
  const [healthList, setHealthList] = useState<HealthList | null>(null);
  if (domainFocus.section !== section && healthList) setHealthList(null);
  const focusDomain = routeChanged && section === "graph" ? initialDomain : domainFocus.focus;
  if (routeChanged) setDomainFocus({ section, domain: initialDomain, focus: focusDomain });
  const setFocusDomain = (focus: string | null) =>
    setDomainFocus({ section, domain: initialDomain, focus });
  /* The right rail is only ever a docked conversation now: a page's links
     moved to the left rail so the page itself can take the width. It opens
     at the Reader's `defaultChatColumn`, so a conversation opened from
     Memory, the Dashboard, or Settings lands in the same column as one
     opened beside a document. */
  const [railChatWidth, setRailChatWidth] = useState(CHAT_COLUMN);
  /* The fixed ceiling until mounted, then the window's share once a large
     display passes it. Read after mount so the server's markup and the first
     client render agree. */
  const [railCeiling, setRailCeiling] = useState(MEMORY_CHAT.ceiling);
  // Until the reader drags it, the opening width follows the window as the
  // Reader's does; once dragged, a resize only clamps it.
  const railChatDragged = useRef(false);
  const [railViewport, setRailViewport] = useState(1512);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const viewport = window.innerWidth;
      setRailViewport(viewport);
      setRailCeiling(rightColumnCeiling(viewport, MEMORY_CHAT.ceiling));
      setRailChatWidth((width) =>
        memoryChatColumn(railChatDragged.current ? width : defaultChatColumn(viewport), viewport));
    };
    const resize = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("resize", resize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, []);
  // The bounds live here rather than as a CSS `min-width`, per invariant 31:
  // a floor the window cannot honour overflows the grid instead of widening
  // it, and the pane that goes off the right edge is this one.
  /* A side chat widens the conversation by its own width, as in the Reader
     (`sideColumnWidth`); the conversation's own width is kept for when it closes. */
  const [sideChatOpen, setSideChatOpen] = useState(false);
  const [sideColumnDragged, setSideColumnDragged] = useState<number | null>(null);
  const sideChatWanted = useRef(false);
  const onSideChatChange = useCallback((open: boolean) => {
    sideChatWanted.current = open;
    // A tab switch reports one conversation closing and the next opening in one commit.
    queueMicrotask(() => setSideChatOpen(sideChatWanted.current));
  }, []);
  const railColumn = sideChatOpen
    ? sideColumnWidth({
        column: railChatWidth,
        dragged: sideColumnDragged,
        ceiling: railCeiling,
        room: railViewport - MEMORY_CHAT.page,
        floor: MEMORY_CHAT.min,
        viewport: railViewport,
      })
    : railChatWidth;
  const constrainRailWidth = useCallback(
    (next: number) => sideChatOpen
      ? Math.max(MEMORY_CHAT.min, Math.min(next, sideColumnCeiling(rightColumnCeiling(window.innerWidth, MEMORY_CHAT.ceiling), window.innerWidth), window.innerWidth - MEMORY_CHAT.page))
      : memoryChatColumn(next, window.innerWidth),
    [sideChatOpen],
  );
  const [error, setError] = useState<MemoryOperationError | null>(null);
  const [lintError, setLintError] = useState("");
  const [lintNotice, setLintNotice] = useState(false);
  const [linting, setLinting] = useState(false);
  // Fetched only when the Health tab is open, and again after a check: it is
  // the one payload that costs a figures and an events query, and the shell's
  // overview is fetched on every mount.
  const [health, setHealth] = useState<MemoryHealth | null>(null);
  const [healthCandidates, setHealthCandidates] = useState<
    BackfillCandidate[] | null
  >(null);
  const [healthCandidatesFailed, setHealthCandidatesFailed] = useState(false);
  const [healthFailed, setHealthFailed] = useState(false);
  const [queueFailed, setQueueFailed] = useState(false);
  const [backlogDismissed, setBacklogDismissed] = useState(false);
  const [queue, setQueue] = useState<MaintenanceSnapshot | null>(null);
  const [draining, setDraining] = useState(false);
  const [plan, setPlan] = useState<MemoryReorganization | null>(null);
  const [refiling, setRefiling] = useState(false);
  /* The line shown while a page rewrite runs; empty when none is. On the
     shell because the notice layer is fixed to the window, not to a page. */
  const [rewriting, setRewriting] = useState("");
  const [rewriteTitle, setRewriteTitle] = useState("");
  const [rewriteNotes, setRewriteNotes] = useState<Record<string, string>>({});
  const rewriteAbort = useRef<AbortController | null>(null);
  useEffect(() => () => rewriteAbort.current?.abort(), []);
  const [planningMessage, setPlanningMessage] = useState("");
  // A title changes what a domain means without changing its stable slug. Keep
  // that semantic change visible until the reader has reviewed page placement
  // and refreshed the affected domain page; a plain reload must not pretend the graph
  // has already caught up.
  const [renamedDomains, setRenamedDomains] = useState<Set<string>>(new Set());
  // What this tab has watched land, so the card can say "3 of 5" rather than
  // only "2 left". It is a count of what this session saw finish, not a claim
  // about the account's history — reloading starts it at zero, and the total
  // moves with it, which is the honest reading of a queue joined midway.
  const [filedHere, setFiledHere] = useState(0);
  // The failures a dismissed card showed. Each is one failure, not one job: a
  // document tried again and failed again is news, and so is a new run.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  /**
   * The Update card, derived from the account's queue rather than from a loop
   * in this component. Filing is durable work now, so every tab shows the same
   * run and a reload rejoins it instead of concluding it died.
   */
  const backfill: BackfillState = backfillFromQueue(
    queue && { ...queue, jobs: queue.jobs.filter((job) => !dismissed.has(failureKey(job))) },
    filedHere,
    memoryStages(),
  );
  // What the card says, derived rather than stored for the same reason the
  // card is: the tab that watched a run end is no longer the only one
  // entitled to say how it went.
  const run = describeRun(backfill);
  /* A notice the reader has looked away from shrinks to its one line rather
     than holding the middle of the window for the length of a long pass. */
  const [noticesCollapsed, setNoticesCollapsed] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const [askConversation, setAskConversation] = useState<ConversationSummary | undefined>();
  const [askRequestId, setAskRequestId] = useState("");
  const [askMode, setAskMode] = useState<"closed" | "composer" | "rail">(
    initialAsk || Boolean(initialQuestion) ? "rail" : "closed",
  );
  // The router reuses this shell, so `useState` above never sees a later
  // address: a conversation opened from Settings or search while Memory is
  // already up would otherwise change the URL and nothing else.
  // Read from the live address rather than the prop, which a link back to the
  // same `?ask=1` after the rail was closed would leave unchanged.
  const routedAsk = useSearchParams().get("ask") === "1";
  const [routeAsk, setRouteAsk] = useState(routedAsk);
  if (routeAsk !== routedAsk) {
    setRouteAsk(routedAsk);
    if (routedAsk) setAskMode("rail");
  }
  const [, setChatFullscreen] = useState(false);
  /* Bumped when Ask Delphi is pressed with the rail conversation already up.
     The panel reads its parity, so no timer here has to agree with the CSS. */
  const [chatNudge, setChatNudge] = useState(0);
  const [askSeed, setAskSeed] = useState(
    initialQuestion.slice(0, MAX_SEEDED_QUESTION),
  );
  const [askImageIds, setAskImageIds] = useState<string[]>([]);
  // Only a submitted composer pick overrides the conversation. URL and Health
  // questions have no pick, so they leave its saved persona to the server.
  const [askPersonaId, setAskPersonaId] = useState<string | undefined>();
  /** The composer's model, effort and web search for the question it sent. */
  const [askChoice, setAskChoice] = useState<ComposerChoice | undefined>();
  const [model, setModel] = useState(DEFAULT_APP_CONFIG.defaultModel);
  const [effort, setEffort] = useState(DEFAULT_APP_CONFIG.defaultReasoningEffort);
  /* The Ask composer's draft persona. Every mounted chat owns its own — a
     persona belongs to a conversation — but a composer writes a turn before the
     conversation exists, so it seeds the first request and the server stores it
     from there. */
  const [draftPersonaId, setDraftPersonaId] = useState(DEFAULT_PERSONA_ID);
  const [personas, setPersonas] = useState<PersonaSummary[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPane, setSettingsPane] = useState<SettingsPane>("projects");
  /** Open the sheet on its AI connection view, from Health's check. */
  const [settingsConnection, setSettingsConnection] = useState(false);
  /* Re-run after a persona is written, deleted or installed in Settings: the
     menu that sent the reader there has to show what they just made. */
  const loadPersonas = useCallback(
    () =>
      api<{ official: PersonaSummary[]; mine: PersonaSummary[] }>("/api/personas")
        .then((catalog) => setPersonas([...catalog.official, ...catalog.mine]))
        .catch(() => setPersonas([])),
    [],
  );
  const openPersonaSettings = () => {
    setSettingsPane("persona");
    setSettingsOpen(true);
  };
  const [notice, setNotice] = useState<Notice>("");


  const reload = useCallback(
    async (
      { reportError = true }: { reportError?: boolean } = {},
    ): Promise<boolean> => {
      try {
        // The overview lists only domains that hold a page; the domain records
        // are the full set, including one the reader named a moment ago. Read
        // both so a new domain shows at count 0 instead of looking like Create
        // did nothing. The records are optional: without them the overview's
        // own list still draws every domain that has pages.
        const [next, records] = await Promise.all([
          api<MemoryOverview>("/api/memory"),
          api<{ domains: MemoryOverview["domains"] }>("/api/memory/domains")
            .catch(() => null),
        ]);
        setOverview(records?.domains ? { ...next, domains: records.domains } : next);
        return true;
      } catch (failure) {
        if (reportError) {
          setError({
            message:
              failure instanceof Error ? failure.message : "Could not load",
            retry: "reload",
          });
        }
        return false;
      }
    },
    [],
  );

  /**
   * Delete one concept page, or a source page whose document is gone. The
   * server turns every link to it into plain words and logs the deletion; the
   * reader lands on the map, at its domain.
   */
  const deletePage = async (page: MemoryPage) => {
    try {
      await api(`/api/memory/pages/${encodeURIComponent(page.slug)}`, { method: "DELETE" });
      window.dispatchEvent(new Event(MEMORY_PAGES_CHANGED));
      await reload();
      focusOn(page.domain);
    } catch (failure) {
      setError({ message: failure instanceof Error ? failure.message : "Could not delete the page" });
    }
  };

  // The shell outlives PageView navigation. A drain can finish while another
  // tab still holds our job, so completion comes from that job's queue row.
  const rewritePage = async (page: MemoryPage, note: string): Promise<boolean> => {
    if (rewriteAbort.current) return false;
    const controller = new AbortController();
    rewriteAbort.current = controller;
    setError(null);
    setRewriteTitle(`Rewriting ${page.title}`);
    setRewriting("Queueing this rewrite…");
    try {
      const job = await api<MaintenanceJob>(`/api/memory/pages/${encodeURIComponent(page.slug)}/rewrite`, {
        method: "POST",
        body: JSON.stringify({ note }),
        signal: controller.signal,
      });
      requestMemoryMaintenance(true);
      await waitForMemoryRewrite(job.id, controller.signal, setRewriting);
      await reload();
      setRewriteNotes((current) => ({ ...current, [page.slug]: "" }));
      return true;
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError({ message: failure instanceof Error ? failure.message : "Could not rewrite the page" });
      }
      return false;
    } finally {
      if (rewriteAbort.current === controller) rewriteAbort.current = null;
      if (!controller.signal.aborted) setRewriting("");
    }
  };
  useEffect(() => {
    setUnauthorizedHandler(() => setError({ message: "Local session unavailable. Quit and reopen Delphi to reconnect.", retry: "reload" }));
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    // Wrapped rather than called: `reload` sets state, and calling it in the
    // effect body would do so synchronously on mount.
    const timer = window.setTimeout(() => {
      void reload();
      void api<User>("/api/auth/me")
        .then((account) => setUser(account))
        .catch(() => setUser(null));
      void api<ProjectSummary[]>("/api/projects")
        .then(setProjects)
        .catch(() => setProjects([]));
      void api<AppConfig>("/api/config")
        .then((next) => {
          setConfig(next);
          setModel(next.defaultModel || next.models[0] || "");
          setEffort(next.defaultReasoningEffort || next.reasoningEfforts[0] || "");
        })
        .catch(() => setConfig(DEFAULT_APP_CONFIG));
      void loadPersonas();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload, loadPersonas]);

  useEffect(() => {
    if (!user) return;
    startMemoryMaintenance(config.memoryEnabled);
    // A page a quit app left at its first window is read whole wherever the app opens.
    startCaptures();
  }, [config.memoryEnabled, user]);

  const pageUpdatedAt =
    overview?.pages.find((page) => page.slug === slug)?.updatedAt ?? "";

  useEffect(() => {
    let live = true;
    // Resolved through a promise even when the answer is "nothing", so no
    // state is set synchronously in the effect body.
    (slug
      ? api<MemoryPageDetail>(
          `/api/memory/pages/${encodeURIComponent(slug)}`,
        )
      : Promise.resolve(null)
    )
      .then((payload) => {
        if (!live) return;
        setDetail(payload);
        setResolvedSlug(slug);
      })
      .catch(() => {
        // A page that is gone is an ordinary case here, not a failure: an
        // address or an old answer may still name it. The pane says so rather
        // than showing an error.
        if (!live) return;
        setDetail(null);
        setResolvedSlug(slug);
      });
    return () => {
      live = false;
    };
    // `pageUpdatedAt` re-fetches when a pass rewrites the page under the same
    // slug — otherwise the open page keeps showing the old text while the
    // sidebar already lists what just landed.
  }, [slug, pageUpdatedAt]);

  const pages = overview?.pages ?? [];
  const known = useMemo(() => new Set(pages.map((page) => page.slug)), [pages]);
  const linkable = useMemo(() => knownPages(pages), [pages]);
  const events = overview?.events ?? [];
  // Fixed when the page opens rather than read during render: a clock read in
  // a render is impure, and "changed this week" quietly meaning something else
  // after a tab has been open for two days is worse than it being slightly
  // stale.
  const [openedAt] = useState(() => Date.now());

  // What a recent pass touched — feeds the census under Ask, and the dots in
  // the tree. Through `eventEdits` rather than `event.pages`, so the one place
  // that reconciles the new shape with the old is shared with the Log.
  const changed = useMemo(() => {
    const since = openedAt - CHANGED_WINDOW_MS;
    const slugs = new Set<string>();
    for (const event of events) {
      if (new Date(event.createdAt).getTime() < since) continue;
      for (const edit of eventEdits(event)) slugs.add(edit.slug);
    }
    return slugs;
  }, [events, openedAt]);

  const tree = useMemo(
    () =>
      buildMemoryTree(pages, overview?.links ?? [], overview?.domains ?? [], {
        changedSlugs: changed,
      }),
    [pages, overview?.links, overview?.domains, changed],
  );

  // The breadcrumb is read off the tree the sidebar draws rather than
  // recomputed, so the two can never disagree about where a page sits.
  const trail = useMemo(() => (slug ? treePath(tree, slug) : []), [tree, slug]);

  // Bare `/memory` is not a deliberate "nothing selected" — it is the
  // way into the wiki, and an empty reader pane that asks you to pick is just
  // a click the first entry already answered. Open whatever the sidebar
  // shows first so the address and the list agree from the first paint after
  // the overview lands. A `?page=` that arrived in the URL is left alone.
  // The page the address names, adopted whenever the address starts naming a
  // different one. `initialSlug` seeds `slug` only at mount, and /graph and
  // /memory render this same component at the same position — so
  // React reuses the instance across that navigation and every "Open page"
  // from a graph node arrived at a shell whose state still said "no page",
  // where the fallback below then opened whichever page sorts first. Every
  // node opened `language-models`. The address is the record (invariant 21),
  // so a change to it is adopted rather than merely seeded, with the URL as
  // the fallback for a navigation that has not re-rendered the server
  // component yet.
  useEffect(() => {
    const named =
      initialSlug ??
      (typeof window === "undefined"
        ? null
        : new URLSearchParams(window.location.search).get("page"));
    if (!named || !isMemorySlug(named)) return;
    // Deferred for the reason the fallback below is: setting state in an
    // effect body cascades a second render before paint.
    const timer = window.setTimeout(() => setSlug(named), 0);
    return () => window.clearTimeout(timer);
  }, [initialSlug, section]);

  useEffect(() => {
    if (slug !== null || pages.length === 0) return;
    // The first *page*, not the first tree node: a domain root may be a heading
    // with no page behind it, and opening one of those lands on the missing-page card.
    const first = treeSlugs(tree).find((candidate) => known.has(candidate));
    if (!first) return;
    // Functional, because the guard above ran when the effect did and this
    // runs a tick later: the address-recovery effect above schedules its own
    // timer first, and a plain `setSlug(first)` would overwrite the page the
    // reader actually asked for. Whoever names a page first wins.
    const timer = window.setTimeout(() => setSlug((current) => current ?? first), 0);
    return () => window.clearTimeout(timer);
  }, [slug, pages.length, tree, known]);

  // This browser's memory of the wiki, kept for the entry points that have no
  // page to name: the Find control on the graph route sends the reader back to
  // what they were reading rather than to whichever page sorts first.
  useEffect(() => {
    if (section !== "wiki" || !slug || !user?.username) return;
    rememberMemoryPage(user.username, slug);
  }, [section, slug, user?.username]);

  // The address is the record of what is open, exactly as it is in the reader.
  // Replace rather than push: browsing a wiki is not a history of decisions.
  // `ask=1` keeps a reload inside the Spotlight overlay; `q` is never written
  // back — once consumed it must not survive a refresh (invariant 46).
  // Graph and Health keep their own routes while the composer is up; rewriting
  // them here made the address bar lie and still left no rail to dock in.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (section !== "wiki") return;
    const params = new URLSearchParams();
    if (slug) params.set("page", slug);
    const conversation = new URLSearchParams(window.location.search).get("conversation");
    if (conversation && askMode === "rail") params.set("conversation", conversation);
    if (askMode === "rail") params.set("ask", "1");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      qs ? `/memory?${qs}` : "/memory",
    );
  }, [slug, askMode, section]);

  // The map and Health keep their own address and only carry the flag, so a
  // reload reopens the conversation that was beside them.
  useEffect(() => {
    if (typeof window === "undefined" || section === "wiki") return;
    const url = new URL(window.location.href);
    if (askMode === "rail") url.searchParams.set("ask", "1");
    else {
      url.searchParams.delete("ask");
      url.searchParams.delete("conversation");
    }
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [askMode, section]);

  useEffect(() => {
    if (section !== "wiki" || !slug || !config.memoryEnabled) return;
    let cancelled = false;
    void api<MemoryNeighborhood>(
      `/api/memory/neighborhood?slug=${encodeURIComponent(slug)}&hops=${config.memoryRelatedHops}`,
    ).then((value) => { if (!cancelled) setNeighborhood(value); })
      .catch(() => { if (!cancelled) setNeighborhood(null); });
    return () => { cancelled = true; };
  }, [slug, section, config.memoryEnabled, config.memoryRelatedHops, overview]);
  const currentNeighborhood = neighborhood?.center?.slug === slug ? neighborhood : null;

  // Read when a page is opened, not a dependency of `open`: the page body is
  // built from `open`, so a new one on every Ask open, send and close remounted
  // the prose and lost its markers, diagrams and selection.
  const askModeRef = useRef(askMode);
  useEffect(() => { askModeRef.current = askMode; }, [askMode]);
  const open = useCallback(
    (next: string) => {
      const target = memorySlug(next);
      if (!target) return;
      // Graph and Health are their own routes, and this shell's slug is not
      // what they render — setting it there changed nothing a reader could
      // see, which is how "Open page" on a graph node became a dead button.
      // Off the wiki, opening a page is a navigation.
      if (section !== "wiki") {
        const params = new URLSearchParams({ page: target });
        if (askModeRef.current === "rail") {
          params.set("ask", "1");
          const conversation = new URLSearchParams(window.location.search).get("conversation");
          if (conversation) params.set("conversation", conversation);
        }
        router.push(`/memory?${params}`);
        return;
      }
      // This shell deliberately survives page changes. Routing only the query
      // string updates the address but does not remount this client component,
      // so its state must be the authority for what the pane renders. The URL
      // effect above mirrors the new slug with replaceState after React paints.
      setSlug(target);
    },
    [router, section],
  );

  const openAsk = useCallback(
    ({
      question = "",
      imageIds = [],
      personaId,
      choice,
      conversation, requestId,
    }: {
      conversation?: ConversationSummary; requestId?: string;
      question?: string;
      imageIds?: string[];
      personaId?: string;
      choice?: ComposerChoice;
    } = {}) => {
      setAskPersonaId(personaId);
      setAskChoice(choice);
      // The conversation the composer resolved travels with its question;
      // without it the seed lands in whichever chat the rail opens on.
      setAskConversation(conversation);
      setAskRequestId(requestId ?? "");
      // The map and Health dock the conversation as a page does, so a
      // question is answered where it was asked.
      setAskImageIds(imageIds);
      setAskSeed((question ?? "").slice(0, MAX_SEEDED_QUESTION));
      setAskMode(question ? "rail" : "composer");
    },
    [],
  );

  const closeAsk = useCallback(() => {
    setAskMode("closed");
    setChatFullscreen(false);
    setAskSeed("");
    setAskPersonaId(undefined);
    setAskChoice(undefined);
    setAskImageIds([]);
  }, []);

  // Abandoned on unmount rather than left running: there is nowhere to keep it.
  // The server files documents one request at a time and each one is idempotent,
  // so a run that stops halfway is resumed by pressing Update again — it is only
  // the counter that is lost, never the work.
  useEffect(() => () => abort.current?.abort(), []);

  const dismissUpdate = () => setPlan(null);

  const renameDomain = async (domain: string, title: string): Promise<boolean> => {
    try {
      await api(`/api/memory/domains/${encodeURIComponent(domain)}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      setRenamedDomains((current) => new Set(current).add(domain));
      // The rename queued a domain rewrite — its old name is still the frame of
      // its domain page's prose — so ask for the queue to be run.
      requestMemoryMaintenance(config.memoryEnabled);
      // A pending proposal was made against the old meaning and is no longer
      // reviewable. The renamed record itself is durable already.
      setPlan(null);
      await reload();
      // The name is what pages are filed against, so a new one is the moment
      // to ask where they belong — the same thing a new domain does.
      void proposeRefile();
      return true;
    } catch (failure) {
      setError({
        message:
          failure instanceof Error ? failure.message : "Could not rename that domain",
      });
      return false;
    }
  };

  /**
   * Drop a domain that holds nothing.
   *
   * Both backends refuse this the moment a page still sits in the domain, so the
   * only thing it can destroy is the label and the domain page written to stand behind
   * it — nothing the reader wrote. The rename that a *filled* domain offers
   * instead is the deliberate asymmetry: a name can always be corrected, and
   * removing a heading that pages depend on would leave them filed under an
   * domain no record covers.
   */
  const deleteDomain = async (domain: string) => {
    try {
      await api(`/api/memory/domains/${encodeURIComponent(domain)}`, {
        method: "DELETE",
      });
      // Nothing left to regraph on this name's account.
      setRenamedDomains((current) => {
        if (!current.has(domain)) return current;
        const next = new Set(current);
        next.delete(domain);
        return next;
      });
      // A proposal that names this domain as a destination can no longer be
      // applied — same argument as a rename.
      setPlan(null);
      await reload();
    } catch (failure) {
      setError({
        message:
          failure instanceof Error ? failure.message : "Could not remove that domain",
      });
    }
  };

  /**
   * Name a domain, pin it to the top of the tree, then offer to re-file into it.
   *
   * The empty domain stays visible so Create confirms immediately; the refile
   * proposal is what fills it. Position is one below the current
   * minimum so a brand-new name lands first without reshuffling the rest.
   */
  const createDomain = async (title: string) => {
    try {
      const positions = (overview?.domains ?? []).map((domain) => domain.position);
      const position = (positions.length ? Math.min(...positions) : 0) - 1;
      await api("/api/memory/domains", {
        method: "POST",
        body: JSON.stringify({ title, position }),
      });
      // A new domain has no domain page yet; creating it queued the pass that writes one.
      requestMemoryMaintenance(config.memoryEnabled);
      await reload();
      void proposeRefile();
    } catch (failure) {
      setError({
        message:
          failure instanceof Error ? failure.message : "Could not create that domain",
      });
    }
  };

  const proposeRefile = async () => {
    setRefiling(true);
    setPlanningMessage("Reviewing page placement…");
    setError(null);
    try {
      setPlan(await requestReorganization(setPlanningMessage));
    } catch (failure) {
      setError({
        message: failure instanceof Error ? failure.message : "The check failed",
        retry: "refile",
      });
    } finally {
      setRefiling(false);
      setPlanningMessage("");
    }
  };

  /**
   * File one document, reporting what happened rather than throwing.
   *
   * The stream is read to its end for the terminal frame — this is the one
   * caller of this route that cares how it went, since the automatic ones fire
   * on a single document the reader watched happen and this one is a hundred
   * they did not.
   */




  const applyMoves = async (
    moves: MemoryMove[],
    refreshDomains: string[] = [],
  ): Promise<boolean> => {
    // One request for the whole accepted set: a reorganization is one decision,
    // and applied a page at a time it can stop halfway and leave the wiki in a
    // shape the reader did not choose.
    const byDomain = new Map<string, string[]>();
    const affected = new Set(refreshDomains);
    for (const move of moves) {
      byDomain.set(move.to, [...(byDomain.get(move.to) ?? []), move.slug]);
      affected.add(move.from);
      affected.add(move.to);
    }
    for (const [domain, slugs] of byDomain) {
      await api("/api/memory/pages/move", {
        method: "POST",
        body: JSON.stringify({ slugs, domain }),
      });
    }
    if (moves.length) await reload();
    // Both ends of a move changed membership and a renamed domain needs its
    // framing revised, but neither is this component's job any more: the
    // storage layer queues a `domain` job for every domain a change touched,
    // so all that is left is to ask for the queue to be run. It used to be a
    // `POST` route fired from here, which meant a domain whose pages had
    // moved kept a domain page describing where they used to be unless the reader
    // happened to be inside the Update flow — and a tab closed mid-pass lost
    // the rewrite entirely.
    requestMemoryMaintenance(config.memoryEnabled);
    return true;
  };

  const acceptUpdate = async () => {
    const moves = plan?.moves ?? [];
    dismissUpdate();
    try {
      const graphed = await applyMoves(moves, [...renamedDomains]);
      if (!graphed) return;
      setRenamedDomains(new Set());
    } catch (failure) {
      setError({
        message: failure instanceof Error ? failure.message : "The update failed",
        retry: "refile",
      });
    }
  };

  /**
   * The queue, read from its own route rather than folded into `/health`.
   *
   * Stuck work is not a property of the graph's shape, and `/health` is already
   * a two-tier contract — arithmetic over the records, plus the last model
   * check. Both reads are model-free and touch no object store, so asking for
   * two is cheap; muddling them into one payload is not.
   */
  // One read at a time, and one more after it if anything asked meanwhile.
  // Jobs start, end and fail within moments of each other, and with reads
  // overlapping an older answer could land last and put back the snapshot the
  // newer one had just corrected.
  const queueRead = useRef<{ running: Promise<void> | null; again: boolean }>({ running: null, again: false });
  const loadQueue = useCallback((): Promise<void> => {
    const read = queueRead.current;
    if (read.running) {
      read.again = true;
      return read.running;
    }
    read.running = (async () => {
      do {
        read.again = false;
        try {
          setQueue(await api<MaintenanceSnapshot>("/api/memory/maintenance"));
          setQueueFailed(false);
        } catch {
          setQueue(null);
          setQueueFailed(true);
        }
      } while (read.again);
    })().finally(() => {
      read.running = null;
    });
    return read.running;
  }, []);

  /** The backlog and the counters again, without the loading state a first read shows. */
  const recountHealth = useCallback(async () => {
    const [healthResult, candidatesResult] = await Promise.allSettled([
      api<MemoryHealth>("/api/memory/health"),
      api<{ papers: BackfillCandidate[] }>("/api/memory/backfill/papers"),
    ]);
    // A failed recount keeps what is on screen; the next Health load decides.
    if (healthResult.status === "fulfilled") {
      setHealth(healthResult.value);
      setHealthFailed(false);
    }
    if (candidatesResult.status === "fulfilled") {
      setHealthCandidates(candidatesResult.value.papers);
      setHealthCandidatesFailed(false);
    }
  }, []);

  /**
   * Follow the queue while it drains, wherever the drain was started from.
   *
   * Someone reading Health is reading a report on work that is moving; without
   * this the counts were a photograph taken when the tab opened.
   */
  useEffect(
    () =>
      onMemoryFiled(() => {
        setFiledHere((count) => count + 1);
        void loadQueue();
        // The backlog too, where Health is showing it: a document the pump
        // filed stayed "new" there until the page was opened again.
        if (section === "health") void recountHealth();
      }),
    [loadQueue, recountHealth, section],
  );

  // And when a job starts or fails, which files nothing: otherwise the job
  // being written reads as queued, with no stage, until it ends.
  useEffect(() => onMemoryQueue(() => void loadQueue()), [loadQueue]);

  /*
   * Re-render when a running job says what it is doing.
   *
   * A counter rather than the map itself: `memoryStages()` is one mutable
   * module-level map by design — the drain writes into it from wherever it was
   * started — so storing it in state would compare equal to itself on every
   * change. The tick is the state; the map is read at render.
   */
  const [, noteStageChange] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => onMemoryStage(noteStageChange), [noteStageChange]);

  const loadHealth = useCallback(async () => {
    setHealthCandidatesFailed(false);
    // Started with the counts rather than after them: the backlog arriving
    // first showed a queued document as new until the queue caught up.
    const queueRead = loadQueue();
    const [healthResult, candidatesResult] = await Promise.allSettled([
      api<MemoryHealth>("/api/memory/health"),
      api<{ papers: BackfillCandidate[] }>("/api/memory/backfill/papers"),
    ]);
    // The counters and the library backlog are independent disclosures. One
    // failing must not erase the other.
    setHealth(healthResult.status === "fulfilled" ? healthResult.value : null);
    setHealthFailed(healthResult.status === "rejected");
    setHealthCandidates(
      candidatesResult.status === "fulfilled"
        ? candidatesResult.value.papers
        : null,
    );
    setHealthCandidatesFailed(candidatesResult.status === "rejected");
    await queueRead;
  }, [loadQueue]);

  /**
   * Hand the backlog to the queue, then start it moving.
   *
   * This used to run the filing itself, three workers deep, inside this
   * component — so the one operation in the product that takes minutes per
   * document was also the only one tied to the reader staying on the page.
   * Navigating from Health to a wiki page unmounted the workers mid-request and
   * the reader came back to "0 filed, 3 could not be read" describing work that
   * had been going fine. Enqueued instead, each document is a leased job with
   * the retry schedule and the failure record every other maintenance kind
   * already had, and it survives navigation, reload and a closed tab.
   *
   * The drain that follows is only *starting* it, not owning it: leaving now
   * stops this drain and no work, because the pump picks the queue up again on
   * the next mount, on focus, on becoming visible, and every five minutes.
   */
  const fileAllFromHealth = async (paperIds?: string[]) => {
    setDraining(true);
    try {
      await api<{ queued: number }>("/api/memory/backfill/papers", {
        method: "POST",
        ...(paperIds ? { body: JSON.stringify({ paperIds }) } : {}),
      });
      await loadQueue();
      await drainMemoryMaintenance();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not queue the filing");
    } finally {
      setDraining(false);
      await Promise.all([loadQueue(), recountHealth()]);
    }
  };

  /**
   * Call off filing the reader started and has changed their mind about.
   *
   * The one control that commits an account to an unbounded amount of model
   * spend had no way back: one press queues a job per out-of-date document and
   * the pump drains them for the rest of the session. It reaches the document
   * being written too — the drain stands down at its next stage boundary —
   * which is what makes the button worth pressing during a short run, where
   * everything there is to stop is already in flight.
   */
  const cancelQueue = useCallback(async () => {
    setDraining(true);
    try {
      await api<{ cancelled: number }>("/api/memory/maintenance/cancel", {
        method: "POST",
      });
    } catch {
      // The queue is the record; the next read shows what is actually left.
    } finally {
      setDraining(false);
      await loadQueue();
    }
  }, [loadQueue]);

  /** Run the queue now, while the reader watches, and show what changed. */
  const drainQueue = useCallback(async () => {
    setDraining(true);
    try {
      await drainMemoryMaintenance();
    } catch {
      // The queue records its own failures; this only drives it.
    } finally {
      setDraining(false);
      await Promise.all([loadQueue(), recountHealth(), reload({ reportError: false })]);
    }
  }, [loadQueue, recountHealth, reload]);

  /**
   * Put jobs that gave up back in the queue, and run them.
   *
   * A retry resets a job's attempt count, which is what moves it to the front
   * of the next round — a job is claimed least-attempted first. Only the jobs
   * named: a job still waiting out its backoff is not a failure to revive, and
   * reviving one would spend its wait for nothing. A row another tab revived
   * first answers 409, and one stopped or deleted meanwhile 404: neither is a
   * failure of this press. Whatever the answers, the queue is read again.
   */
  const retryJobs = useCallback(
    async (ids: string[]) => {
      setDraining(true);
      let refusal: unknown = null;
      let revived = 0;
      for (const id of ids) {
        try {
          await api(`/api/memory/maintenance/jobs/${id}/retry`, { method: "POST" });
          revived += 1;
        } catch (failure) {
          if (!(failure instanceof ApiError && (failure.status === 404 || failure.status === 409))) refusal = failure;
        }
      }
      if (refusal && revived === 0) {
        setError({ message: refusal instanceof Error ? refusal.message : "Could not retry that" });
      }
      await drainQueue();
    },
    [drainQueue],
  );

  /** The settings sheet, open on its AI connection view. */
  const openAiConnection = useCallback(() => {
    setSettingsPane("advanced");
    setSettingsConnection(true);
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    if (section !== "health") return;
    const timer = window.setTimeout(() => void loadHealth(), 0);
    return () => window.clearTimeout(timer);
  }, [section, loadHealth]);

  // The map says when documents are waiting, so the backlog does not depend on
  // somebody opening Health to find it. Deferred behind the first paint: the
  // list is a walk over every project and the map must not wait on it.
  useEffect(() => {
    if (section !== "graph") return;
    const timer = window.setTimeout(() => {
      void api<{ papers: BackfillCandidate[] }>("/api/memory/backfill/papers")
        .then((payload) => setHealthCandidates(payload.papers))
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [section]);

  const runLint = async () => {
    setLintError("");
    setLintNotice(false);
    setLinting(true);
    // Placement is the other half of a health check: claims are compared by
    // the lint below, and where pages sit is reviewed beside it. Independent
    // calls with their own failure notices, so neither waits on the other.
    void proposeRefile();
    try {
      // Streamed like every other derived artifact, but there is nothing worth
      // showing mid-flight here — the result is the whole point — so the body
      // is drained for its terminal frame rather than painted turn by turn.
      // Failure must not look like success: without the `ok` / `error` checks
      // a 503 or mid-stream failure still reloaded the overview and cleared
      // "Checking…", leaving contradictions empty while the tab claimed the
      // run finished.
      const response = await fetch(`${API_BASE}/api/memory/lint`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok || !response.body) {
        throw new Error(
          response.status === 503
            ? "No model provider is configured"
            : "The check failed",
        );
      }
      let failed = "";
      let completed: SseEvent | null = null;
      for await (const payload of readSseStream(response.body)) {
        if (payload.type === "error") {
          failed = String(payload.message || "The check failed");
        } else if (payload.type === "done") {
          completed = payload;
        }
      }
      if (failed) throw new Error(failed);
      if (!completed) throw new Error("The check ended without a result");
      setLintNotice(true);
      await reload();
      // Both tiers again: the findings are new, and the computed half is read
      // with them.
      await loadHealth();
    } catch (failure) {
      setLintError(
        failure instanceof Error ? failure.message : "The check failed",
      );
    } finally {
      setLinting(false);
    }
  };

  const openPaperFromAccount = async (projectId: string, paperId: string, focus?: CitedPlace) => {
    if (!user) return;
    let project: Project | null = null;
    try {
      project = await api<Project>(`/api/projects/${projectId}`);
    } catch (failure) {
      if (!(failure instanceof ApiError && failure.status === 404)) {
        setNotice(failure instanceof Error ? failure.message : "Could not open that document");
        return;
      }
    }
    const paper = project?.papers.find((entry) => entry.id === paperId);
    if (!project || !paper) {
      setNotice(hint("That document has moved or left your library. Reopen this page to find it."));
      return;
    }
    router.push(documentPath(user.username, project, paper) + focusQuery(focus));
  };

  const movePaperFromAccount = async (
    fromProjectId: string,
    paperId: string,
    toProjectId: string,
    position?: number,
  ) => {
    await api(`/api/projects/${fromProjectId}/papers/${paperId}/move`, {
      method: "POST",
      body: JSON.stringify({ project_id: toProjectId, position }),
    });
    setProjects(await api<ProjectSummary[]>("/api/projects"));
  };

  // A filing can outlive the page that started it. Keep every phase in the
  // same fixed top layer used by document processing, independent of route.
  // Only on the map, and only while nothing is already being filed: Health
  // lists the same backlog in its own panel, and a running queue is the answer
  // to it rather than a second thing to announce.
  const backlog =
    section === "graph" && healthCandidates && !backlogDismissed &&
    !draining && !backfill.running
      ? planBackfill(healthCandidates)
      : null;
  const backlogWaiting = Boolean(backlog && backlog.total > 0);
  const operationNoticesActive = Boolean(
    refiling || rewriting || plan || backlogWaiting || run || error || lintNotice,
  );
  /*
   * Looking away shrinks the run's card, finished or not.
   *
   * The gate used to be `backfill.running` alone, which covered every card
   * except the one that stays on screen longest: a run this tab had just
   * finished. So the result of a filing sat expanded over the page until it
   * was dismissed by hand.
   */
  const collapseNotices = useCallback(() => setNoticesCollapsed(true), []);
  useDismissOnOutsideActivity(
    !noticesCollapsed && Boolean(run),
    ".kb-operation-notice-layer",
    collapseNotices,
  );
  const pageOperationNotices = operationNoticesActive ? (
    <div className="kb-operation-notice-layer">
      {refiling ? (
        <MemoryOperationProgress message={planningMessage} />
      ) : rewriting ? (
        <MemoryOperationProgress
          title={rewriteTitle}
          message={rewriting}
        />
      ) : plan ? (
        <UpdateBanner
          reorganization={plan}
          onAccept={() => void acceptUpdate()}
          onDismiss={dismissUpdate}
        />
      ) : backlog && backlogWaiting ? (
        <BacklogNotice
          plan={backlog}
          library={healthCandidates?.length ?? 0}
          onFile={() => void fileAllFromHealth()}
          onDismiss={() => setBacklogDismissed(true)}
        />
      ) : null}
      {run ? (
        <BackfillProgress
          state={backfill}
          run={run}
          collapsed={noticesCollapsed}
          busy={draining}
          onExpand={() => setNoticesCollapsed(false)}
          onCollapse={collapseNotices}
          cancellable={queue?.cancellable ?? 0}
          onStop={() => void cancelQueue()}
          onRetry={(ids) => void retryJobs(ids)}
          onConnect={openAiConnection}
          onOpen={({ projectId, paperId }) => {
            if (projectId && paperId) void openPaperFromAccount(projectId, paperId);
          }}
          onDismiss={() => {
            // What was read goes; Health still lists what gave up.
            const read = (queue?.jobs ?? []).map(failureKey).filter(Boolean);
            setDismissed((before) => new Set([...before, ...read]));
            setFiledHere(0);
          }}
        />
      ) : null}
      {error ? (
        <MemoryOperationErrorNotice
          error={error.message}
          onDismiss={() => setError(null)}
          onRetry={
            error.retry === "reload"
              ? () => {
                  setError(null);
                  void reload();
                }
              : error.retry === "refile"
                ? () => {
                    setError(null);
                    void proposeRefile();
                  }
                : undefined
          }
        />
      ) : null}
      {lintNotice ? (
        <HealthCheckNotice
          onDismiss={() => setLintNotice(false)}
        />
      ) : null}
    </div>
  ) : null;

  /* The overlay is the card, not a different column. Dropping the split while
     expanded made collapse re-play the rail's entry — the column growing from
     related-width to chat-width, the same motion as sending a first question. */
  const railHasChat = askMode === "rail";
  /* A docked conversation goes with the reader between the map, Health and a
     page: the address that takes them there says it is open and which one. */
  const withChat = (href: string) => {
    if (!railHasChat || typeof window === "undefined") return href;
    const params = new URLSearchParams({ ask: "1" });
    const conversation = new URLSearchParams(window.location.search).get("conversation");
    if (conversation) params.set("conversation", conversation);
    return `${href}${href.includes("?") ? "&" : "?"}${params}`;
  };

  /** Map and Health are routes; the toggle is a navigation between them. */
  const goView = (view: MemoryView) => {
    if (view === "health") router.push(withChat("/memory/health"));
    else if (section === "graph") setFocusDomain(null);
    else {
      const domain = section === "wiki" ? detail?.page.domain : focusDomain;
      router.push(withChat(domain ? `/memory/graph?domain=${encodeURIComponent(domain)}` : "/memory/graph"));
    }
  };
  /** A domain picked in the rail: the map zooms onto it, from anywhere. */
  const focusOn = (domain: string | null) => {
    if (section === "graph") setFocusDomain(domain);
    else router.push(withChat(domain ? `/memory/graph?domain=${encodeURIComponent(domain)}` : "/memory/graph"));
  };
  const focusTitle = focusDomain
    ? tree.find((node) => node.slug === focusDomain)?.title ??
      overview?.domains.find((domain) => domain.slug === focusDomain)?.title ??
      focusDomain
    : "";
  const counts = healthCounts(queue, health, healthCandidates);
  // A list whose row has gone closes with it, and stays closed.
  const openHealthList = healthList && counts[healthList] > 0 ? healthList : null;
  if (healthList && !openHealthList) setHealthList(null);
  const domainRail = (view: MemoryView, footer?: ReactNode) => (
    <MemoryRail
      view={view}
      footer={footer}
      onView={goView}
      tree={tree}
      focus={focusDomain}
      onFocus={focusOn}
      openSlug={null}
      onOpen={open}
      onRenameDomain={renameDomain}
      onDeleteDomain={(domain) => void deleteDomain(domain)}
      onCreateDomain={(title) => void createDomain(title)}
    />
  );

  /* The docked conversation, the same card beside a page, the map and Health.
     One element so the three layouts cannot drift; on the map and Health it
     also keeps its place in the tree, so the toggle between them does not
     remount it. */
  const chatRail = railHasChat ? (
      <>
        <PanelDivider
          side="right"
          cssVar="--kb-chat-width"
          label="Resize the conversation"
          value={railColumn}
          min={MEMORY_CHAT.min}
          max={sideChatOpen ? sideColumnCeiling(railCeiling, railViewport) : railCeiling}
          constrain={constrainRailWidth}
          onChange={(width) => {
            if (sideChatOpen) {
              setSideColumnDragged(width);
              return;
            }
            railChatDragged.current = true;
            setRailChatWidth(width);
          }}
        />
        <aside className="kb-related-rail">
          {/* The same surface the reader gets. That is the point: the
              wiki's conversation was a second implementation of the
              same thing, and every capability it lacked — images,
              `@`-mentions, a stored cancellation — it lacked only
              because it was the smaller copy. */}
          <ChatPanel
            key="general"
            project={null}
            paper={null}
            context="general"
            // A question typed beside a page names it; one asked beside
            // the map or Health names none.
            openPageSlug={section === "wiki" && slug ? slug : undefined}
            onContextChange={() => {}}
            config={config}
            onNotice={setNotice}
            onOpenPage={open}
            seedQuestion={askSeed}
            seedRequestId={askRequestId}
            seedConversation={askConversation}
            seedPersonaId={askPersonaId}
            seedChoice={askChoice}
            seedImageIds={askImageIds}
            onSeedConsumed={() => {
              setAskConversation(undefined);
              setAskRequestId("");
              setAskSeed("");
              setAskPersonaId(undefined);
              setAskChoice(undefined);
              setAskImageIds([]);
            }}
            onClose={closeAsk}
            onFullscreenChange={setChatFullscreen}
            onSideChatChange={onSideChatChange}
            personas={personas}
            onManagePersonas={openPersonaSettings}
            nudge={chatNudge}
            // A citation in an answer opens its document in the reader, with
            // this conversation docked beside it to follow the next one.
            onCitation={(target, cited, hit) => {
              const home = cited as Partial<DashboardDocument>;
              if (!user || !home.projectSlug) return;
              const path = documentPath(user.username, { slug: home.projectSlug }, cited, { chat: "general" });
              router.push(path + focusQuery({ page: hit?.page ?? target.pages[0], section: target.anchor, box: hit?.rect }).replace(/^\?/, "&"));
            }}
          />
        </aside>
      </>
  ) : null;

  return (
    // Pages, Graph and Health are one-screen workspaces. Their shell owns the
    // window height; only the panes that contain lists scroll internally.
    <div
      className={[
        "kb-shell",
        section === "wiki" ? "kb-shell-pages" : "kb-shell-memory",
        // The split exists to make room for the chat *in* the rail. Expanded,
        // the card leaves the flow but the column stays, so shrinking back
        // lands on a slot that never moved.
        railHasChat ? "kb-rail-split" : "",
        section === "wiki" && !railHasChat ? "kb-no-rail" : "",
        section === "graph" ? "kb-shell-graph" : "",
        section === "health" ? "kb-shell-health" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <TopBar
        className="kb-topbar"
        user={user}
        onOpenSettings={() => {
          setSettingsPane("projects");
          setSettingsOpen(true);
        }}
        actions={
          <AskDelphiButton
            docked={railHasChat}
            onOpen={() => {
              /* Same rule as the Reader: a conversation already on screen
                 answers the press itself rather than being covered by a
                 composer the reader would then have to dismiss. */
              if (railHasChat) {
                setChatNudge((count) => count + 1);
                return;
              }
              openAsk();
            }}
          />
        }
      />

      {pageOperationNotices}

      <div className="kb-frame">
      <div className="kb-column">

      {section === "wiki" ? (
        <div
          className="kb-body"
          style={{ "--kb-chat-width": `${railColumn}px` } as CSSProperties}
        >
          {/* A page is laid over the map like a sheet of paper. The rail
              beside it holds the page's links and a local map, with the way
              back to the full map at its foot. */}
          <div className="kb-memory-rail-slot">
            <MemoryRail view="page" onView={goView}>
              <RelatedMemoryRail
                layout="memory"
                currentSlug={slug}
                pages={currentNeighborhood?.pages ?? []}
                links={currentNeighborhood?.links ?? []}
                domains={currentNeighborhood?.domains ?? []}
                hops={config.memoryRelatedHops}
                distances={currentNeighborhood?.distances ?? {}}
                onOpen={open}
                onWholeGraph={() => goView("map")}
              />
            </MemoryRail>
          </div>
          <div className="kb-reading-column">
            <PageView
              key={slug ?? "none"}
              detail={detail}
              resolved={resolvedSlug === slug}
              slug={slug}
              linkable={linkable}
              trail={trail}
              noteWordLimit={config.memoryRewriteNoteMaxWords}
              rewritePending={Boolean(rewriting)}
              rewriteNote={rewriteNotes[slug ?? ""] ?? ""}
              onRewriteNote={(note) => {
                if (slug) setRewriteNotes((current) => ({ ...current, [slug]: note }));
              }}
              onRewrite={rewritePage}
              onDelete={deletePage}
              onOpenDocument={(projectId, paperId, focus) => void openPaperFromAccount(projectId, paperId, focus)}
              onOpen={open}
            />
          </div>
          {chatRail}
        </div>
      ) : null}

      {/* One frame for the map and Health: the toggle swaps what is in the
          middle and leaves the rail and a docked conversation where they are. */}
      {section !== "wiki" ? (
        <div
          className="kb-memory"
          style={{ "--kb-chat-width": `${railColumn}px` } as CSSProperties}
        >
          {section === "health" ? domainRail("health", (
            <HealthStatus
              status={railStatus({
                counts,
                queue,
                queueFailed,
                health,
                healthFailed,
                candidates: healthCandidates,
                candidatesFailed: healthCandidatesFailed,
                running: backfill.running || draining,
              })}
              showing={openHealthList}
              onShow={(list) => setHealthList((current) => (current === list ? null : list))}
              onFile={(paperIds) => void fileAllFromHealth(paperIds)}
              onStop={() => void cancelQueue()}
            />
          )) : domainRail("map")}
          {section === "graph" ? (
          <main className="kb-memory-main" key="map">
            {focusDomain ? (
              <nav className="kb-map-crumb" aria-label="Map position">
                <button type="button" onClick={() => setFocusDomain(null)}>
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
                  All domains
                </button>
                <strong>{focusTitle}</strong>
              </nav>
            ) : null}
            <GraphView
              revision={overview?.revision ?? 0}
              pages={pages}
              links={overview?.links ?? []}
              domains={overview?.domains ?? []}
              onOpen={open}
              ready={overview !== null}
              focusDomain={focusDomain}
              onFocusDomain={setFocusDomain}
            />
          </main>
          ) : (
          <main className="kb-memory-main" key="health">
            <HealthPane
              health={health}
              events={overview?.events ?? []}
              pages={pages}
              linting={linting || refiling}
              error={lintError}
              queue={queue}
              busy={draining}
              candidates={healthCandidates}
              showing={openHealthList}
              onClose={() => setHealthList(null)}
              onLint={runLint}
              onConnect={openAiConnection}
              onRetryDocument={(id) => void fileAllFromHealth([id])}
              onRetryJob={(job) => void retryJobs([job.id])}
              onOpen={open}
            />
          </main>
          )}
          {chatRail}
        </div>
      ) : null}
      </div>
      </div>

      {askMode === "composer" ? (
        <AskComposer
          initialContext="general"
          onSeeHistory={() => setAskMode("rail")}
          contextOptions={["general"]}
          targetFor={() => ({ context: "general" })}
          config={config}
          model={model}
          onModelChange={setModel}
          effort={effort}
          onEffortChange={setEffort}
          personas={personas}
          personaId={draftPersonaId}
          onPersonaChange={setDraftPersonaId}
          onManagePersonas={openPersonaSettings}
          onClose={closeAsk}
          onNotice={setNotice}
          onSend={({ prompt, imageIds, personaId, choice, conversation, requestId }) => {
            openAsk({ question: prompt, imageIds, personaId, choice, conversation, requestId });
          }}
        />
      ) : null}

      {settingsOpen && user ? (
        <SettingsModal
          user={user}
          onUserChange={setUser}
          initialPane={settingsPane}
          initialConnection={settingsConnection}
          config={config}
          onPersonasChanged={() => void loadPersonas()}
          projects={projects}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsConnection(false);
          }}
          onOpenPaper={(projectId, paperId) => {
            void openPaperFromAccount(projectId, paperId);
          }}
          onNavigate={(href) => router.push(href)}
          onMovePaper={movePaperFromAccount}
          onReordered={async () => {
            setProjects(await api<ProjectSummary[]>("/api/projects"));
          }}
          onNotice={setNotice}
          maxPapers={config.maxPapersPerProject}
        />
      ) : null}
      {notice ? <Toast notice={notice} onDismiss={() => setNotice("")} /> : null}
    </div>
  );
}


function UpdateBanner({
  reorganization,
  onAccept,
  onDismiss,
}: {
  reorganization: MemoryReorganization;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const moves = reorganization.moves;
  const titles = new Map(
    reorganization.domains.map((domain) => [domain.slug, domain.title]),
  );
  const method = reorganization.method.trim();
  const moveCount = moves.length;
  const canAct = moveCount > 0;
  const title = canAct
    ? `${moveCount} page${moveCount === 1 ? " looks" : "s look"} misfiled`
    : "Nothing looks misfiled.";
  const detail = canAct ? "Nothing moves until you say so." : method || null;
  const primaryLabel = `Apply ${moveCount} move${moveCount === 1 ? "" : "s"}`;

  return (
    <aside
      className="processing-document-banner kb-update-banner"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <NoticeMark state="info" />
      <div className="kb-update-banner-body">
        <div className="kb-update-banner-copy">
          <p className="kb-update-banner-title">{title}</p>
          {detail ? (
            <p className="kb-update-banner-detail">{detail}</p>
          ) : null}
        </div>
        {moveCount > 0 ? (
          <ul className="kb-update-banner-moves">
            {moves.map((move) => (
              <li key={move.slug}>
                <div className="kb-update-banner-move-title">{move.title}</div>
                <div className="kb-update-banner-move-arrow">
                  {titles.get(move.from) ?? move.from} →{" "}
                  {titles.get(move.to) ?? move.to}
                </div>
                <div className="kb-update-banner-move-why">{move.why}</div>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="kb-update-banner-actions">
          {canAct ? (
            <button
              type="button"
              className="primary-button"
              onClick={onAccept}
            >
              {primaryLabel}
            </button>
          ) : null}
          <button type="button" className="secondary-button" onClick={onDismiss}>
            {canAct ? "Not now" : "Close"}
          </button>
        </div>
      </div>
    </aside>
  );
}

function HealthCheckNotice({ onDismiss }: { onDismiss: () => void }) {
  // A finished check is a confirmation, and leaves on its own: the line along
  // its bottom edge drains over a few seconds (paused while hovered) and its
  // end dismisses the card.
  return (
    <aside
      className="kb-notice-card kb-health-notice"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <NoticeMark state="done" />
      <div className="kb-notice-copy">
        <strong>Health check complete</strong>
        <span>Contradictions and live health counts are up to date.</span>
      </div>
      <div className="kb-operation-error-actions">
        <button
          type="button"
          className="kb-backfill-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss health check result"
        >
          <DismissMark />
        </button>
      </div>
      <i
        className="kb-health-notice-life"
        aria-hidden="true"
        onAnimationEnd={(event) => {
          if (event.animationName === "kb-notice-drain") onDismiss();
        }}
      />
    </aside>
  );
}

function MemoryOperationErrorNotice({
  error,
  onDismiss,
  onRetry,
}: {
  error: string;
  onDismiss: () => void;
  onRetry?: () => void;
}) {
  const timedOut = /(?:\b524\b|timed? out|timeout)/i.test(error);
  const unreachable = /failed to fetch|networkerror/i.test(error);
  const providerMissing = error === "No model provider is configured";
  const title = timedOut
    ? "The update took too long"
    : unreachable
      ? "Delphi could not be reached"
      : providerMissing
        ? "A model provider is required"
        : "This action did not finish";
  const detail = timedOut
    ? "Cloudflare stopped waiting before Delphi answered. Anything already completed remains saved; retry the update to continue."
    : unreachable
      ? "Check the connection and try again. Your Memory was not changed by this request."
      : providerMissing
        ? "Open Delphi → AI Connection to connect a subscription or API key before updating your Memory."
        : error.length > 220
          ? `${error.slice(0, 217)}…`
          : error;
  return (
    <aside
      className="kb-notice-card kb-operation-error"
      role="alert"
      aria-live="assertive"
    >
      <NoticeMark state="attention" />
      <div className="kb-notice-copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <div className="kb-operation-error-actions">
        {onRetry ? (
          <button type="button" className="secondary-button" onClick={onRetry}>
            Try again
          </button>
        ) : null}
        <button
          type="button"
          className="kb-backfill-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss error"
        >
          <DismissMark />
        </button>
      </div>
    </aside>
  );
}

/** One long model pass, in the layer every other long pass uses. */
function MemoryOperationProgress({
  title = "Checking your Memory",
  message,
}: {
  title?: string;
  message: string;
}) {
  return (
    <aside
      className="kb-notice-card kb-operation-progress"
      role="status"
      aria-live="polite"
    >
      <NoticeMark state="running" />
      <div className="kb-notice-copy">
        <strong>{title}</strong>
        <span>{message || "Reviewing page placement…"}</span>
        <small>This can take a minute. You can keep this page open.</small>
      </div>
    </aside>
  );
}

/**
 * The mark inside `.kb-backfill-dismiss`: a close cross, or a bar when the
 * button shrinks a run rather than dismissing it. A path and not a `×` or `–`
 * glyph, for the reason the empty-domain remove button is one: the glyphs sit
 * off their line box, so the mark rode visibly low in its circle.
 */
function DismissMark({ shrink = false }: { shrink?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path
        d={shrink ? "M4.5 8h7" : "M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5"}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * A notice shrunk to its one line.
 *
 * Every card in this layer holds the middle of the window, which is right
 * while the reader is deciding something and wrong for the twenty minutes a
 * library takes to file. Looking away collapses it to this; pressing it brings
 * the card back. The mark stays, because the mark is the state.
 */
/** Documents waiting to be filed, announced on the map. */
function BacklogNotice({
  plan,
  library,
  onFile,
  onDismiss,
}: {
  plan: BackfillPlan;
  library: number;
  onFile: () => void;
  onDismiss: () => void;
}) {
  return (
    <aside
      className="processing-document-banner kb-update-banner"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <NoticeMark state="info" />
      <div className="kb-update-banner-body">
        <div className="kb-update-banner-copy">
          <p className="kb-update-banner-title">
            {plan.total} document{plan.total === 1 ? " is" : "s are"} waiting to be filed
          </p>
          <p className="kb-update-banner-detail">{describePlan(plan, library)}</p>
        </div>
        <div className="kb-update-banner-actions">
          <button type="button" className="primary-button" onClick={onFile}>
            {describePlanAction(plan)}
          </button>
          <button type="button" className="secondary-button" onClick={onDismiss}>
            Not now
          </button>
        </div>
      </div>
    </aside>
  );
}

function CollapsedNotice({
  state,
  label,
  detail,
  progress,
  onExpand,
}: {
  state: NoticeState;
  label: string;
  detail: string;
  /** 0–100 while a run is going: drawn as a line along the pill's bottom
   *  edge, so a shrunk run still reports without being opened. */
  progress?: number;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      className="kb-notice-pill"
      onClick={onExpand}
      aria-expanded={false}
    >
      <NoticeMark state={state} size="small" />
      <strong>{label}</strong>
      <span>{detail}</span>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="m3.5 6.25 4.5 4.5 4.5-4.5" />
      </svg>
      {progress !== undefined ? (
        <i className="kb-notice-pill-progress" aria-hidden="true">
          <b style={{ width: `${progress}%` }} />
        </i>
      ) : null}
    </button>
  );
}

/** Progress for a filing run already accepted from the Update banner, and its result. */
function BackfillProgress({
  state,
  run,
  collapsed,
  busy,
  onExpand,
  onCollapse,
  cancellable,
  onStop,
  onRetry,
  onConnect,
  onOpen,
  onDismiss,
}: {
  state: BackfillState;
  run: RunSummary;
  collapsed: boolean;
  /** A retry or a drain is in flight, so the verbs wait for it. */
  busy: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  cancellable: number;
  onStop?: () => void;
  onRetry: (jobIds: string[]) => void;
  onConnect: () => void;
  onOpen: (document: RunDocument) => void;
  onDismiss: () => void;
}) {
  /* Three workers is the pool, so a fourth row means a document has finished
     and another has started. The count is not a truncation the reader has to
     accept — pressing it shows every document in flight. */
  const [showAll, setShowAll] = useState(false);
  const percent = Math.round(backfillFraction(state) * 100);
  const live = run.phase === "running";
  /* Documents waiting out a retry are still the queue's, so Stop stays while
     any are left, even once others have failed. */
  const unfinished = state.running || state.retrying.length > 0;
  const mark: NoticeState = live ? "running" : run.phase === "failed" ? "attention" : "done";
  /* Try all only when the documents to try again span causes: with one, that
     cause's own Try again says the same thing beside the reason. */
  const retryable = state.failures.filter((failure) => FAILURE_CAUSES[failure.cause].fix === "retry");
  const tryAll = !live && new Set(retryable.map((failure) => failure.cause)).size > 1;
  if (collapsed) {
    return (
      <CollapsedNotice
        state={mark}
        label={run.pill.label}
        detail={run.pill.detail}
        progress={state.running ? percent : undefined}
        onExpand={onExpand}
      />
    );
  }
  return (
    <section
      className={run.phase === "failed" ? "kb-backfill has-failures" : "kb-backfill"}
      role="status"
      aria-live="polite"
    >
      <div className="kb-backfill-head">
        {/* The mark is the state. A run in progress climbs, a run with
            failures alerts, a clean one rises — the same three animations
            every other surface in the product uses for those three things,
            where this card used to draw a "!" or a "✓" of its own. */}
        <NoticeMark state={mark} />
        <div className="kb-backfill-copy">
          <p className="kb-backfill-title">{run.title}</p>
          <p className="kb-backfill-detail">{run.detail}</p>
        </div>
        <div className="kb-backfill-actions">
          {/* Where a reader actually looks when they want this to stop: the
              card reporting the run, not a pane they would have to navigate
              to. It says "Stop" rather than "Cancel" because it cannot undo —
              pages already written stay written. The document in flight does
              stop, at its next stage boundary, with nothing half-filed behind
              it: a pass commits its pages and its event in one write at the
              end, so one abandoned partway leaves the document as it was.

              Gated on the server's count, the rule the cancel itself applies:
              a run whose last documents are all in flight has nothing left to
              call off, and a button that removes nothing is a lie in
              precisely the moments a reader leans on it. */}
          {unfinished && cancellable > 0 && onStop ? (
            <button type="button" className="secondary-button" onClick={onStop}>
              Stop
            </button>
          ) : null}
          {tryAll ? (
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => onRetry(retryable.map((failure) => failure.jobId))}
            >
              Try all {retryable.length}
            </button>
          ) : null}
          {/* A run in progress is shrunk, never dismissed: it is still
              happening, and a card the reader can throw away would leave the
              work with nowhere to report. */}
          <button
            type="button"
            className="kb-backfill-dismiss"
            onClick={live ? onCollapse : onDismiss}
            aria-label={live ? "Shrink update notice" : "Dismiss update result"}
          >
            <DismissMark shrink={live} />
          </button>
        </div>
      </div>
      {state.running ? (
        <>
          <div className="kb-backfill-bar">
            <span style={{ width: `${percent}%` }} />
          </div>
          {/* The server's latest stage for each concurrent document, said
              without the provider's vocabulary and without repeating the
              title that is already in the row. Three at a time is the whole
              worker pool; anything past that is a queue length, not a list. */}
          {state.filing.length > 0 ? (
            <ul className="kb-backfill-filing">
              {(showAll ? state.filing : state.filing.slice(0, 3)).map((title) => (
                <li key={title}>
                  <i className="kb-backfill-filing-spin" aria-hidden="true" />
                  <strong>{title}</strong>
                  <span>
                    {describeFilingStage(state.stages[title] || "", title) ||
                      "Starting…"}
                  </span>
                </li>
              ))}
              {state.filing.length > 3 ? (
                <li className="kb-backfill-filing-more">
                  <button type="button" onClick={() => setShowAll((open) => !open)}>
                    {showAll
                      ? "Show fewer"
                      : `+${state.filing.length - 3} more in progress`}
                  </button>
                </li>
              ) : null}
            </ul>
          ) : null}
        </>
      ) : null}
      {state.failures.length > 0 || state.retrying.length > 0 ? (
        <RunFailures
          failures={state.failures}
          retrying={state.retrying}
          busy={busy}
          onRetry={onRetry}
          onConnect={onConnect}
          onOpen={onOpen}
        />
      ) : null}
    </section>
  );
}


/**
 * Where this page came from, folded shut.
 *
 * Provenance is what a reader checking a claim wants constantly available and
 * what a reader *reading* wants out of the way — which is exactly what a
 * disclosure is for. Collapsed, it is one line between two hairlines: the
 * markers the page cites and the document they are from, and how many Memory
 * pages refer to this one. Open, one column: the cited passages grouped by the
 * section they sit in, then the pages that refer here.
 */
/** Where in its document a citation points, as the reader's focus query takes it. */
type CitedPlace = { page?: number | null; section?: string | null; box?: PdfRect | null };

/** `?focusPage=` or `?focusSection=`, the same query a digest's citation opens. */
function focusQuery(focus?: CitedPlace): string {
  if (focus?.page && focus.box) return `?focusPage=${focus.page}&focusBox=${focusBox(focus.box)}`;
  if (focus?.page) return `?focusPage=${focus.page}`;
  if (focus?.section) return `?focusSection=${encodeURIComponent(focus.section.replace(/^#|^§/, ""))}`;
  return "";
}

/** An outside source's marker: it opens what the page said when it was captured. */
function ExternalMarker({ id, evidenceId, section }: { id: number; evidenceId: string; section?: string | null }) {
  const [opened, setOpened] = useState(0);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="digest-citation digest-citation-external" onClick={() => { setOpened(opened + 1); setOpen(true); }}>
        E{id}
      </button>
      {open ? <CapturedSourceView key={opened} evidenceId={evidenceId} section={section ?? null} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * A page's `[E#]` markers as what they cite: a document's passage opens the
 * reader at its page or section, a captured outside source opens the capture.
 * They read "(E1, E2)" and used to go nowhere, so the one thing that says where
 * a claim came from could not be checked from the page that made it. A
 * `derived` claim names no source, and a document no longer in the library or
 * a capture no longer kept has nowhere to open, so those stay text.
 */
function citeMarkers(
  detail: MemoryPageDetail,
  onOpenDocument: (projectId: string, paperId: string, focus?: CitedPlace) => void,
): CiteMarker {
  const byId = new Map(detail.page.citations.map((citation) => [citation.id, citation]));
  return (id) => {
    const citation = byId.get(id);
    if (!citation) return null;
    if (citation.claimType === "external" && citation.evidenceId) {
      if (citation.captured === false) return null;
      return <ExternalMarker id={id} evidenceId={citation.evidenceId} section={citation.section} />;
    }
    const paperId = citation.paperId;
    if (citation.claimType === "derived" || !paperId) return null;
    const source = detail.sources.find((entry) => entry.paperId === paperId);
    const projectId = source?.projectId;
    if (!projectId || !source.available) return null;
    const place = citation.page ? `p. ${citation.page}` : citation.section ? `§${citation.section.replace(/^#|^§/, "")}` : "";
    const href = `#E${id}`;
    return (
      <a
        className="digest-citation"
        href={href}
        title={[source.title, place].filter(Boolean).join(", ")}
        onClick={(event) => {
          event.preventDefault();
          onOpenDocument(projectId, paperId, { page: citation.page, section: citation.section });
        }}
      >
        E{id}
      </a>
    );
  };
}

function Provenance({
  detail,
  onOpen,
  onOpenDocument,
  cite,
}: {
  detail: MemoryPageDetail;
  onOpen: (slug: string) => void;
  onOpenDocument: (projectId: string, paperId: string) => void;
  cite: CiteMarker;
}) {
  const [open, setOpen] = useState(false);
  const { page, sources, backlinks } = detail;
  const authors = detail.authors ?? [];
  const groups = sourceGroups(page.citations, sources);
  const counts = provenanceCounts(groups, authors, backlinks.length);
  if (!counts.length && !page.citations.length) return null;

  return (
    <section className={open ? "kb-provenance is-open" : "kb-provenance"} aria-label="Where this page comes from">
      <button
        type="button"
        className="kb-provenance-toggle"
        aria-expanded={open}
        title={deletedCounts(groups, authors) || undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <svg className="kb-provenance-twist" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
        {/* One count per group, in the order they open. */}
        <span className="kb-provenance-lead">
          {counts.length
            ? counts.map(({ count, noun }, index) => (
                <Fragment key={noun}>
                  {index ? <span className="kb-provenance-dot-sep" aria-hidden="true"> · </span> : null}
                  <b>{count}</b> {noun}
                </Fragment>
              ))
            : "Delphi’s inference"}
        </span>
      </button>

      {open ? (
        <div className="kb-provenance-body">
          {groups.documents.length || groups.outside.length || groups.rest.length ? (
            <div className="kb-provenance-group">
              <h3>Sources</h3>
              <ol className="kb-provenance-entries">
                {groups.documents.map(({ source, sections }) => (
                  <ProvenanceEntry
                    key={source.paperId}
                    kind="document"
                    name={source.title ?? "A document no longer in your library"}
                    removed={!source.available}
                    onOpen={source.projectId ? () => onOpenDocument(source.projectId!, source.paperId) : undefined}
                  >
                    <Passages sections={sections} cite={cite} removed={!source.available} />
                  </ProvenanceEntry>
                ))}
                {groups.outside.map(({ evidenceId, captured, sections }) => (
                  <ProvenanceEntry
                    key={evidenceId}
                    kind="outside"
                    removed={!captured}
                    name={captured ? <OutsideSourceLink evidenceId={evidenceId} /> : "Outside source, no longer kept"}
                  >
                    <Passages sections={sections} cite={cite} removed={!captured} />
                  </ProvenanceEntry>
                ))}
              </ol>
              {groups.rest.length ? <Passages sections={groups.rest} cite={cite} /> : null}
            </div>
          ) : null}
          {authors.length ? (
            <div className="kb-provenance-group">
              <h3>Written by</h3>
              <ol className="kb-provenance-entries">
                {authors.map((author) => (
                  <ProvenanceEntry
                    key={`${author.kind}-${author.id}`}
                    kind={author.kind === "document" ? "document" : "chat"}
                    name={authorName(author)}
                    removed={author.removed}
                    onOpen={author.kind !== "chat" && author.projectId ? () => onOpenDocument(author.projectId!, author.id) : undefined}
                    at={author.firstAt}
                  >
                    {author.note ? <span className="kb-provenance-entry-note">{author.note}</span> : null}
                  </ProvenanceEntry>
                ))}
              </ol>
            </div>
          ) : null}
          {backlinks.length ? (
            <div className="kb-provenance-group">
              <h3>Referenced by</h3>
              <ul className="kb-provenance-references">
                {backlinks.map((entry) => (
                  <li key={entry.slug}>
                    <button type="button" className="kb-provenance-reference" onClick={() => onOpen(entry.slug)}>
                      <span
                        className="kb-provenance-dot"
                        style={{ background: `var(--kb-node-${entry.kind})` }}
                        aria-hidden="true"
                      />
                      {entry.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The quiet delete dialog every destructive confirmation shares, for one
 * concept page or a source page whose document is gone.
 */
function DeletePageModal({
  page,
  linkedFrom,
  onClose,
  onDelete,
}: {
  page: MemoryPage;
  linkedFrom: number;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  // On the body, so the dim covers the window and not only the page panel.
  return (
    <ModalLayer>
      <div className="modal-backdrop" onMouseDown={onClose}>
        <div
          className="modal is-quiet delete-modal"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="delete-page-title"
          aria-describedby="delete-page-description"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="delete-modal-heading">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="modal-warning-icon" src="/brand/animations/delphi-warning-alert.gif" alt="" />
            <h2 id="delete-page-title">Delete page?</h2>
          </div>
          <p className="modal-subject" title={page.title}>{page.title}</p>
          <p id="delete-page-description">
            Removes the page and its history. Cannot be undone.
            {linkedFrom ? ` Links to it on ${linkedFrom} page${linkedFrom === 1 ? "" : "s"} become plain words.` : ""}
            {page.kind === "source"
              ? " Pages written from its document stay."
              : " Its documents stay in your library, so a later filing may write about this again."}
          </p>
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onDelete().finally(onClose);
              }}
            >
              Delete page
            </button>
          </div>
        </div>
      </div>
    </ModalLayer>
  );
}

const ENTRY_ICONS = {
  document: <><path d="M4 1.8h5.5L12.5 5v9.2H4z" /><path d="M9.3 1.8V5.2h3.2" /></>,
  chat: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  outside: <><circle cx="8" cy="8" r="5.6" /><path d="M2.4 8h11.2M8 2.4c1.6 1.6 2.4 3.5 2.4 5.6S9.6 12 8 13.6M8 2.4C6.4 4 5.6 5.9 5.6 8S6.4 12 8 13.6" /></>,
  removed: <path d="M4.5 8h7" />,
};

/**
 * One row of Provenance: a source or an author, by name, with what sits under
 * it. A row whose document opens is a link; one the reader has deleted keeps
 * its name, greyed, and opens nothing.
 */
function ProvenanceEntry({
  kind,
  name,
  removed = false,
  onOpen,
  at,
  children,
}: {
  kind: "document" | "chat" | "outside";
  name: ReactNode;
  removed?: boolean;
  onOpen?: () => void;
  at?: string;
  children?: ReactNode;
}) {
  return (
    <li className={removed ? "kb-provenance-entry is-removed" : "kb-provenance-entry"}>
      <span className={`kb-provenance-entry-tile is-${removed ? "removed" : kind}`} aria-hidden="true">
        <svg viewBox="0 0 16 16">{ENTRY_ICONS[removed ? "removed" : kind]}</svg>
      </span>
      {onOpen && !removed ? (
        <button type="button" className="kb-provenance-entry-name" onClick={onOpen}>{name}</button>
      ) : (
        <span className="kb-provenance-entry-name" title={removed ? "Deleted" : undefined}>{name}</span>
      )}
      {at ? <time dateTime={at}>{authorDate(at)}</time> : <span />}
      {children}
    </li>
  );
}

/** A source's passages, by section, each marker opening what it cites. */
function Passages({ sections, cite, removed = false }: { sections: Array<{ section: string; ids: number[] }>; cite: CiteMarker; removed?: boolean }) {
  return (
    <ul className="kb-provenance-passages">
      {sections.map(({ section, ids }) => (
        <li key={section}>
          <span className="kb-provenance-markers">
            {ids.map((id) => (
              <span key={id} className={removed ? "kb-provenance-marker is-removed" : "kb-provenance-marker"}>{cite(id) ?? `E${id}`}</span>
            ))}
          </span>
          <span className="kb-provenance-section">{section}</span>
        </li>
      ))}
    </ul>
  );
}

function PageView({
  detail,
  resolved,
  slug,
  linkable,
  trail,
  noteWordLimit,
  onOpen,
  rewritePending,
  rewriteNote,
  onRewriteNote,
  onRewrite,
  onDelete,
  onOpenDocument,
}: {
  detail: MemoryPageDetail | null;
  /** Whether the fetch for this exact slug has come back. */
  resolved: boolean;
  slug: string | null;
  /** The pages its links can open, drawn by their title and kind. */
  linkable: KnownPages;
  trail: TreeNode[];
  noteWordLimit: number;
  onOpen: (slug: string) => void;
  rewritePending: boolean;
  rewriteNote: string;
  onRewriteNote: (note: string) => void;
  onRewrite: (page: MemoryPage, note: string) => Promise<boolean>;
  onDelete: (page: MemoryPage) => Promise<void>;
  onOpenDocument: (projectId: string, paperId: string, focus?: CitedPlace) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  // Built once a page, so the memoised body is not drawn again on every render.
  const cite = useMemo<CiteMarker>(
    () => (detail ? citeMarkers(detail, onOpenDocument) : () => null),
    // `onOpenDocument` is a fresh arrow each render; the page is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail],
  );

  const noteWords = rewriteNote.trim().split(/\s+/).filter(Boolean).length;
  const noteTooLong = noteWords > noteWordLimit;
  const rewritePage = async () => {
    if (rewritePending || noteTooLong || !detail) return;
    await onRewrite(detail.page, rewriteNote.trim());
  };

  if (!slug) {
    // Reached only while the overview is still loading, or when the wiki is
    // empty — the shell opens the first sidebar page as soon as there is one.
    return <main className="kb-page kb-page-empty" />;
  }
  if (!detail && !resolved) {
    // The request is still open. Saying nothing is the only honest thing to
    // say about a page whose existence is not known yet.
    return <main className="kb-page kb-page-empty" />;
  }
  if (!detail) {
    return (
      <main className="kb-page kb-page-empty">
        <h2>{slug}</h2>
        <p>This page no longer exists.</p>
      </main>
    );
  }

  const page = detail.page;
  // Only once its document has left the library: until then the page goes with it.
  const documentRemoved = page.kind === "source" && detail.document?.projectId === null;

  return (
    <main className="kb-page">
      <header className="kb-page-header">
        {/* Where the page sits and what it is, in one line of small capitals,
            with the way back to its document at the far end. */}
        <div className="kb-page-meta">
          {trail.map((step) => (
            <Fragment key={step.slug}>
              {step.openable ? (
                <button type="button" className="kb-page-trail" onClick={() => onOpen(step.slug)}>
                  {step.title}
                </button>
              ) : (
                <span className="kb-page-trail">{step.title}</span>
              )}
              <span className="kb-page-meta-dot" aria-hidden="true" />
            </Fragment>
          ))}
          <span className={`kb-kind kb-kind-${page.kind}`}>
            {KIND_LABELS[page.kind]}
          </span>
          {/* A source page is one document's page, so it opens that document —
              from its own provenance, whether or not it cites passages. */}
          {page.kind === "source" && detail.document?.projectId ? (
            <button
              type="button"
              className="kb-page-open-document"
              onClick={() => onOpenDocument(detail.document!.projectId!, detail.document!.paperId)}
            >
              Open document
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9" /></svg>
            </button>
          ) : null}
          {/* A concept, or a source page its deleted document left behind: one
              whose document stands goes with that document, and a domain's
              page with its domain. */}
          {page.kind === "concept" || documentRemoved ? (
            <button type="button" className="kb-page-open-document" onClick={() => setDeleting(true)}>
              {documentRemoved ? "Delete page (document removed)" : "Delete page"}
            </button>
          ) : null}
        </div>
        <h2>{page.title}</h2>
        {/* Not when the body opens with it: a source page's summary is its first
            paragraph, and printed here it read the same sentences twice. */}
        {page.summary && !summaryRepeatsBody(page.summary, page.body) ? (
          <p className="kb-page-summary">{plainSummary(page.summary)}</p>
        ) : null}
      </header>

      <Provenance detail={detail} onOpen={onOpen} onOpenDocument={onOpenDocument} cite={cite} />
      {deleting ? (
        <DeletePageModal
          page={page}
          linkedFrom={detail.backlinks.length}
          onClose={() => setDeleting(false)}
          onDelete={() => onDelete(page)}
        />
      ) : null}

      {/* The offer to write the page again, as one block: a small mark, then
          what a rewrite does, and under it the reader's optional note with the
          button at the end of the same row. The sentence is the only thing that
          makes a second attempt differ from the first; it reaches the author as
          labelled guidance, never as evidence. The offer is made whatever
          wrote the page, so the line says what the press does, not that the
          page is behind. Only a concept page with a document behind it can be
          written again. */}
      {page.kind === "concept" && page.sourcePaperId ? (
        <section className="kb-rewrite" aria-label="Rewrite this page">
          <span className="kb-rewrite-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5" /></svg>
          </span>
          {/* Not "with today's engine": the offer is on every concept page,
              and on a page written a minute ago that read as "this is out of
              date". */}
          <p className="kb-rewrite-line">
            <strong>Rewrite this page.</strong> Same sources, fresh wording;
            its links and evidence stay.
          </p>
          <form
            className="kb-rewrite-ask"
            onSubmit={(submit) => {
              submit.preventDefault();
              void rewritePage();
            }}
          >
            <label className="kb-rewrite-field">
              <input
                type="text"
                value={rewriteNote}
                disabled={rewritePending}
                onChange={(change) => onRewriteNote(change.target.value)}
                placeholder="Optional: what should be different?"
                aria-label="Why this page should be written again"
                aria-invalid={noteTooLong}
              />
              <span
                className={noteTooLong ? "kb-rewrite-count is-over" : "kb-rewrite-count"}
                aria-live="polite"
              >
                {noteWords}/{noteWordLimit}
              </span>
            </label>
            <button type="submit" className="kb-rewrite-button" disabled={rewritePending || noteTooLong}>
              Rewrite page
            </button>
          </form>
        </section>
      ) : null}

      {/* The digest's reading type and classes, so a Memory page and a digest
          set lists, tables, code and maths the same way. */}
      <article className="kb-prose prose-reading message-markdown">
        <MemoizedMemoryBody
          body={page.body}
          figures={page.figures}
          pages={linkable}
          onOpen={onOpen}
          cite={cite}
        />
      </article>
    </main>
  );
}

function GraphView({
  revision,
  pages,
  links,
  domains,
  onOpen,
  ready,
  focusDomain,
  onFocusDomain,
}: {
  revision: number;
  pages: MemoryPageSummary[];
  links: Array<{ from: string; to: string }>;
  domains: Array<{ slug: string; title: string }>;
  onOpen: (slug: string) => void;
  ready: boolean;
  focusDomain: string | null;
  onFocusDomain: (slug: string | null) => void;
}) {
  return (
    <MemoryGraphCanvas
      revision={revision}
      pages={pages}
      links={links}
      domains={domains}
      onOpen={onOpen}
      ready={ready}
      legend={[]}
      focusDomain={focusDomain}
      onFocusDomain={onFocusDomain}
    />
  );
}



/**
 * One row per page a pass touched, grouped by the day it ran.
 *
 * The day is the unit of the card — every edit that landed on Tuesday shares
 * one bordered surface. Pass grouping is gone on purpose: "filed three pages"
 * was never something a reader could click, and separate cards per pass made a
 * busy day read as a stack of floating strips.
 *
 * The action pills that used to sit above it are gone too. They filtered a
 * column nobody narrows — the log is read newest-first for what just happened,
 * not queried — and the badge on each row already says which action it was.
 *
 * Every fact on a row except the note has always existed at write time and
 * used to be thrown away: the title, the kind, and whether the page was
 * created or revised (`revision == 1`). Merged is wired in the badge for a
 * future consolidate pass; nothing emits it yet.
 */
function logKindSuffix(kind: MemoryKind | null): string | null {
  if (!kind) return null;
  // A domain page reads as "domain", not "domain page" — one word for the
  // page, the record and the job.
  if (kind === "domain") return "domain";
  return `${KIND_LABELS[kind].toLowerCase()} page`;
}

function logActionLabel(action: MemoryEdit["action"]): string {
  if (action === "created") return "Created";
  if (action === "merged") return "Merged";
  if (action === "deleted") return "Deleted";
  return "Revised";
}

function logRowTitle(edit: MemoryEdit): string {
  if (edit.action === "merged" && edit.mergedFrom) {
    return `${edit.slug} ← ${edit.mergedFrom}`;
  }
  return edit.title;
}

/**
 * How many rows the log shows before the rest goes behind a count.
 *
 * A row budget rather than a day one: a single Update pass files forty pages
 * in a minute, so "the last three days" is four rows on a quiet base and two
 * hundred on the day the reader ran a backfill — the two histories that most
 * want the same treatment.
 */
const LOG_ROWS_SHOWN = 14;

type ActivityFilter = "all" | "created" | "revised";

type ActivityRow = {
  key: string;
  time: string;
  slug: string | null;
  title: string;
  kind: MemoryKind | null;
  action: MemoryEdit["action"];
  note: string;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;


/** The three lists Health can open, in the order the panel and the pane name them. */
const HEALTH_LISTS: Array<{ list: HealthList; label: string; head: string; tone: "honey" | "sand"; icon: string }> = [
  { list: "stuck", label: "Stuck", head: "Stuck", tone: "honey", icon: "M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2ZM6.4 5.8v4.4M9.6 5.8v4.4" },
  { list: "dropped", label: "Pages not written", head: "Not written", tone: "honey", icon: "M4 1.8h5.5L12.5 5v9.2H4zM6.2 9.5h4.1" },
  { list: "contradictions", label: "Contradictions", head: "Contradictions", tone: "sand", icon: "M2.5 5.5h9M9 3l2.5 2.5L9 8M13.5 10.5h-9M7 8l-2.5 2.5L7 13" },
];

const listOf = (list: HealthList) => HEALTH_LISTS.find((entry) => entry.list === list)!;

function StopGlyph() {
  return (
    <svg className="kb-health-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="1.5" />
    </svg>
  );
}

/**
 * The Delphi mark, still, in a tile tinted for what the row says: honey for
 * work that did not finish, sand for work that only wants a look.
 */
function MarkTile({ tone }: { tone: "honey" | "sand" }) {
  return (
    <span className={`kb-health-tile is-${tone}`} aria-hidden="true">
      <DelphiMark />
    </span>
  );
}

/** The mark itself; `kb-health-live` pulses it while work goes on. */
function DelphiMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 120 120" aria-hidden="true">
      <circle cx="60" cy="40" r="21" />
      <path className="kb-health-tile-gap" d="M60 44 L98 98 H22 Z" />
      <path className="kb-health-tile-peak" d="M60 44 L98 98 H22 Z" />
    </svg>
  );
}

/** A document, in a honey tile: it can be filed again. */
function DocumentTile() {
  return (
    <span className="kb-health-tile is-honey" aria-hidden="true">
      <svg viewBox="0 0 16 16" className="kb-health-tile-document">
        <path d="M4 1.8h5.5L12.5 5v9.2H4z" />
        <path d="M9.3 1.8V5.2h3.2" />
      </svg>
    </span>
  );
}

/**
 * Health's rail foot: one status button, and only when it has something to
 * say (`railStatus`). Filing carries its own stop; File is the verb itself;
 * Memory unhealthy opens a panel of what went wrong, each row opening its
 * list in the pane, where the fix sits beside the thing it fixes. Filing or
 * waiting documents join the panel's foot only when they overlap with it.
 */
function HealthStatus({
  status,
  showing,
  onShow,
  onFile,
  onStop,
}: {
  status: RailStatus;
  showing: HealthList | null;
  onShow: (list: HealthList) => void;
  onFile: (paperIds?: string[]) => void;
  onStop: () => void;
}) {
  const [open, setOpen] = useState(false);
  const unhealthy = status.kind === "unhealthy";
  if (open && !unhealthy) setOpen(false);
  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutsideActivity(open, ".kb-health-status, .kb-health-list", close);

  if (status.kind === "healthy") return null;

  const stop = (left: number, compact: boolean) => (
    <button
      type="button"
      className={compact ? "kb-health-status-stop" : "kb-health-verb"}
      aria-label="Stop filing"
      title={`Stop filing · ${left} left`}
      onClick={onStop}
    >
      <StopGlyph />
      {compact ? null : "Stop"}
    </button>
  );
  // Refiling a document Memory already holds from an older pass costs as much
  // as filing a new one, so the name says which it is.
  const fileLabel = (waiting: Waiting) => {
    if (!waiting) return "File all waiting documents";
    const all = `File ${plural(waiting.paperIds.length, "document")}`;
    if (!waiting.outdated) return all;
    const some = waiting.outdated === waiting.paperIds.length ? "" : `${waiting.outdated} `;
    return `${all}, ${some}already filed by an older pass`;
  };
  const fileTitle = (waiting: Waiting) =>
    waiting ? fileLabel(waiting) : "The waiting documents couldn’t be counted, so this files whatever Memory still owes.";

  if (status.kind === "filing") {
    const { left } = status.filing;
    return (
      <div className="kb-health-status">
        <div className="kb-health-status-button" role="status" title={left ? `${left} left to file` : "Filing"}>
          <span className="kb-health-status-mark">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={MARKS.running} alt="" />
          </span>
          <span>Filing</span>
          {left > 0 ? <span className="kb-health-count">{left}</span> : null}
        </div>
        {left > 0 ? stop(left, true) : null}
      </div>
    );
  }

  if (status.kind === "waiting") {
    const { waiting } = status;
    return (
      <div className="kb-health-status">
        <button
          type="button"
          className="kb-health-status-button"
          aria-label={fileLabel(waiting)}
          title={fileTitle(waiting)}
          onClick={() => onFile(waiting?.paperIds)}
        >
          <span className="kb-health-status-mark">
            {waiting ? (
              <span className="kb-health-status-number">{waiting.paperIds.length}</span>
            ) : (
              <svg viewBox="0 0 16 16" className="kb-health-tile-document" aria-hidden="true">
                <path d="M4 1.8h5.5L12.5 5v9.2H4z" />
                <path d="M9.3 1.8V5.2h3.2" />
              </svg>
            )}
          </span>
          <span>{waiting ? "File" : "File all"}</span>
          <span className="kb-activity-spacer" />
          <svg className="kb-health-glyph" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 3v10l8.5-5z" />
          </svg>
        </button>
      </div>
    );
  }

  const { counts, filing, waiting } = status;
  return (
    <div className="kb-health-status">
      <button
        type="button"
        className="kb-health-status-button is-unhealthy"
        aria-expanded={open}
        aria-controls={open ? "kb-health-status-panel" : undefined}
        onClick={() => setOpen(!open)}
      >
        <span className="kb-health-status-mark">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={MARKS.attention} alt="" />
        </span>
        <span>Memory unhealthy</span>
        <span className="kb-activity-spacer" />
        <Chevron up />
      </button>
      {open ? (
        <div className="kb-health-status-panel" id="kb-health-status-panel" role="region" aria-label="Why Memory is unhealthy">
          <div className="kb-health-status-rows">
            {HEALTH_LISTS.filter(({ list }) => counts[list] > 0).map(({ list, label, tone, icon }) => (
              <button
                key={list}
                type="button"
                className={`kb-health-status-row${showing === list ? " is-open" : ""}`}
                aria-expanded={showing === list}
                aria-controls={showing === list ? `kb-health-${list}` : undefined}
                onClick={() => onShow(list)}
              >
                <span className={`kb-health-icon is-${tone}`} aria-hidden="true">
                  <svg viewBox="0 0 16 16"><path d={icon} /></svg>
                </span>
                <span>{label}</span>
                <b>{counts[list]}</b>
                <Chevron />
              </button>
            ))}
          </div>
          {filing ? (
            <div className="kb-health-status-foot">
              <span className="kb-health-icon is-sand" aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={MARKS.running} alt="" />
              </span>
              <span>Filing</span>
              {filing.left > 0 ? <span className="kb-health-count">{filing.left}</span> : null}
              {filing.left > 0 ? stop(filing.left, false) : null}
            </div>
          ) : waiting !== undefined ? (
            <div className="kb-health-status-foot">
              <span className="kb-health-icon is-sand" aria-hidden="true">
                <svg viewBox="0 0 16 16"><path d="M4 1.8h5.5L12.5 5v9.2H4zM9.3 1.8V5.2h3.2" /></svg>
              </span>
              <span>Waiting</span>
              {waiting ? <span className="kb-health-count">{waiting.paperIds.length}</span> : null}
              <button
                type="button"
                className="kb-health-verb is-primary"
                aria-label={fileLabel(waiting)}
                title={fileTitle(waiting)}
                onClick={() => onFile(waiting?.paperIds)}
              >
                {waiting ? "File" : "File all"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One list the panel opened, in the activity card's own chrome. */
function HealthListCard({
  list,
  summary,
  onClose,
  children,
}: {
  list: HealthList;
  summary: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { head } = listOf(list);
  return (
    <section className="kb-health-list" id={`kb-health-${list}`} aria-label={head}>
      <header className="kb-health-list-head">
        <span className="kb-memory-label">{head}</span>
        <span className="kb-activity-total">{summary}</span>
        <span className="kb-activity-spacer" />
        <button type="button" className="kb-health-close" aria-label="Close this list" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <div className="kb-health-list-body">{children}</div>
    </section>
  );
}

/** A job that gave up: what it was, why it stopped, and Try again beside it. */
function StuckJob({ job, busy, onRetry }: { job: MaintenanceJob; busy: boolean; onRetry: () => void }) {
  return (
    <div className="kb-health-row">
      <MarkTile tone="honey" />
      <div className="kb-health-row-copy">
        <span className="kb-health-row-title">
          <strong>{job.label}</strong>
          <small>{jobTag(job)}</small>
        </span>
        <span className="kb-health-row-meta">{gaveUpLine(job)}</span>
        <p className="kb-health-row-reason">{failureSentence(causeOf(job))}</p>
        {job.lastError ? <TechnicalDetail text={job.lastError} /> : null}
      </div>
      <button type="button" className="kb-health-verb is-primary" aria-label={`Try again: ${job.label}`} onClick={onRetry} disabled={busy}>
        Try again
      </button>
    </div>
  );
}

/**
 * Memory's Health view: what the passes did, day by day, and above it the
 * list the rail's status opened — jobs that gave up, pages a document's last
 * job could not write, or contradictions a check recorded.
 */
function HealthPane({
  health,
  events,
  pages,
  linting,
  error,
  queue,
  busy,
  candidates,
  showing,
  onClose,
  onLint,
  onConnect,
  onRetryDocument,
  onRetryJob,
  onOpen,
}: {
  health: MemoryHealth | null;
  events: MemoryEvent[];
  pages: MemoryPageSummary[];
  linting: boolean;
  error: string;
  queue: MaintenanceSnapshot | null;
  busy: boolean;
  candidates: BackfillCandidate[] | null;
  showing: HealthList | null;
  onClose: () => void;
  onLint: () => void;
  onConnect: () => void;
  onRetryDocument: (id: string) => void;
  onRetryJob: (job: MaintenanceJob) => void;
  onOpen: (slug: string) => void;
}) {
  const check = health?.lastCheck ?? null;
  const contradictions = check?.contradictions ?? [];
  const dropped = notWritten(queue, health, candidates);
  const stuck = (queue?.jobs ?? []).filter(gaveUp);
  const bySlug = useMemo(() => new Map(pages.map((page) => [page.slug, page])), [pages]);
  const titleOf = (slug: string) => bySlug.get(slug)?.title ?? slug.replaceAll("-", " ");
  const droppedDocuments = Array.from(new Set(dropped.map((item) => item.paperId)));

  return (
    <div className="kb-health kb-activity">
      {error ? (
        <HealthCheckFailure error={error} running={linting} onRetry={onLint} onConnect={onConnect} />
      ) : null}

      {showing === "stuck" ? (
        <HealthListCard list="stuck" summary={`${plural(stuck.length, "job")} gave up`} onClose={onClose}>
          {stuck.map((job) => (
            <StuckJob key={job.id} job={job} busy={busy} onRetry={() => onRetryJob(job)} />
          ))}
        </HealthListCard>
      ) : null}
      {showing === "dropped" ? (
        <HealthListCard
          list="dropped"
          summary={`${plural(dropped.length, "page")} from ${plural(droppedDocuments.length, "document")}`}
          onClose={onClose}
        >
          <p className="kb-health-list-note">
            The check against the source refused each of these twice, so
            nothing was written for it. Trying again refiles the whole
            document; the rest of it stays in Memory meanwhile.
          </p>
          {droppedDocuments.map((paperId) => {
            const findings = dropped.filter((item) => item.paperId === paperId);
            const document = candidates?.find((item) => item.paperId === paperId);
            const title = document?.title ?? "A document in your library";
            const filedAt = findings.find((item) => item.filedAt)?.filedAt;
            return (
              <div className="kb-health-group" key={paperId}>
                <div className="kb-health-row is-centered">
                  <DocumentTile />
                  <span className="kb-health-row-copy">
                    <strong className="kb-health-row-name">{title}</strong>
                    <span className="kb-health-row-meta">
                      {[filedAt ? `Filed ${dayLabel(filedAt)}` : "", `${plural(findings.length, "page")} not written`].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="kb-health-verb is-primary"
                    aria-label={`Try again: ${title}`}
                    disabled={busy}
                    onClick={() => onRetryDocument(paperId)}
                  >
                    Try again
                  </button>
                </div>
                <ul className="kb-health-pages">
                  {findings.map((finding) => (
                    <li key={finding.slug}>
                      <span className="kb-health-page-mark" aria-hidden="true" />
                      <span className="kb-health-row-copy">
                        {/* An edit that was refused left its page as it was, so
                            that page opens; a page that was never created has
                            nothing to open. */}
                        {bySlug.has(finding.slug) ? (
                          <button type="button" className="kb-health-go" onClick={() => onOpen(finding.slug)}>
                            {finding.title || finding.slug}
                            <Chevron />
                          </button>
                        ) : (
                          <span className="kb-health-row-title">
                            <strong>{finding.title || finding.slug}</strong>
                            <small>New page</small>
                          </span>
                        )}
                        <span className="kb-health-row-meta">{finding.reason}</span>
                        {finding.quote ? <q className="kb-health-quote">{finding.quote}</q> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </HealthListCard>
      ) : null}
      {showing === "contradictions" ? (
        <HealthListCard
          list="contradictions"
          summary={`${contradictions.length} found by the health check ${dayLabel(check?.createdAt)}`}
          onClose={onClose}
        >
          {contradictions.map((finding, index) => (
            <div key={index} className="kb-health-row is-wide">
              <span className="kb-health-tile is-sand" aria-hidden="true">
                <svg viewBox="0 0 16 16" className="kb-health-tile-document">
                  <path d={listOf("contradictions").icon} />
                </svg>
              </span>
              <div className="kb-health-row-copy">
                <strong className="kb-health-row-name">{finding.claim}</strong>
                <span className="kb-health-row-meta">{finding.detail}</span>
                {/* Each page with the words it says, side by side, so the
                    disagreement can be read before either page is opened. */}
                <div className="kb-health-sides">
                  {finding.pages.map((slug, at) => (
                    <div key={slug} className="kb-health-side">
                      <button type="button" className="kb-health-go" onClick={() => onOpen(slug)}>
                        <span className={`kb-health-side-dot${at % 2 ? " is-second" : ""}`} aria-hidden="true" />
                        {titleOf(slug)}
                        <Chevron />
                      </button>
                      {(finding.quotes ?? [])
                        .filter((quote) => quote.page === slug)
                        .map((quote, line) => (
                          <q key={line} className="kb-health-quote">{quote.quote}</q>
                        ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </HealthListCard>
      ) : null}

      <HealthLog
        events={events}
        pages={pages}
        onOpen={onOpen}
        check={
          <button
            type="button"
            className="kb-health-verb"
            onClick={onLint}
            disabled={linting}
            title={
              check
                ? `Compares claims and reviews where pages are filed · checked ${dayLabel(check.createdAt)}`
                : "Compares claims and reviews where pages are filed · never run"
            }
          >
            {linting ? <><DelphiMark className="kb-health-live" />Checking…</> : "Run health check"}
          </button>
        }
      />
    </div>
  );
}

/**
 * The activity itself: two weeks as bars, then every edit by day.
 *
 * A bar is a day and a filter: pressing one shows just that day. The rows are
 * what changed, on which page, and whether it was written or revised; a row
 * opens its page.
 */
function HealthLog({
  events,
  pages,
  onOpen,
  check,
}: {
  events: MemoryEvent[];
  pages: MemoryPageSummary[];
  onOpen: (slug: string) => void;
  check?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [pickedDay, setPickedDay] = useState<number | null>(null);
  // The page list fills in a title for an event that recorded only a slug.
  const bySlug = useMemo(
    () => new Map(pages.map((page) => [page.slug, page])),
    [pages],
  );
  const entries = useMemo(
    () =>
      events.map((event) => ({
        at: event.createdAt,
        edits: eventEdits(event, bySlug),
        event,
      })),
    [events, bySlug],
  );
  const bars = useMemo(() => dailyEditCounts(entries, 14), [entries]);
  const total = bars.reduce((sum, bar) => sum + bar.count, 0);
  const tallest = Math.max(1, ...bars.map((bar) => bar.count));
  // Grouped by the day of the *pass*, so the rows of one event never straddle
  // a heading — an edit has no clock of its own.
  const days = useMemo(() => groupEditsByDay(entries), [entries]);

  if (events.length === 0) {
    return (
      <section className="kb-activity-card">
        <header className="kb-activity-head">
          <span className="kb-memory-label">Activity</span>
          <span className="kb-activity-spacer" />
          {check}
        </header>
        <p className="kb-activity-total kb-activity-empty">Nothing has been filed yet.</p>
      </section>
    );
  }

  const rowsOf = (entry: (typeof entries)[number]): ActivityRow[] => {
    const at = new Date(entry.at);
    const time = Number.isNaN(at.getTime())
      ? ""
      : at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
    // A pass that filed nothing — a lint that found the base healthy — is
    // still something that happened, and its one line is the whole of it.
    if (entry.edits.length === 0) {
      return [{ key: `${entry.at}-bare`, time, slug: null, title: "", kind: null, action: null, note: entry.event.summary }];
    }
    return entry.edits.map((edit) => ({
      key: `${entry.at}-${edit.slug}`,
      time,
      slug: edit.slug,
      title: logRowTitle(edit),
      kind: edit.action === "merged" ? null : edit.kind,
      action: edit.action,
      note: edit.note || entry.event.summary,
    }));
  };
  const keep = (row: ActivityRow) =>
    filter === "all" || row.action === filter;
  const dayStart = pickedDay === null ? null : bars[pickedDay]?.start ?? null;

  let budget = expanded ? Infinity : LOG_ROWS_SHOWN;
  let hidden = 0;
  const shown: Array<{ key: string; label: string; count: number; rows: ActivityRow[] }> = [];
  for (const day of days) {
    if (dayStart !== null && day.key !== new Date(dayStart).toISOString()) continue;
    const rows = day.entries.flatMap(rowsOf).filter(keep);
    if (!rows.length) continue;
    const visible = rows.slice(0, Math.max(0, budget));
    hidden += rows.length - visible.length;
    budget -= visible.length;
    if (visible.length) shown.push({ key: day.key, label: day.label, count: rows.length, rows: visible });
  }

  return (
    <section className="kb-activity-card">
      <header className="kb-activity-head">
        <span className="kb-memory-label">Activity</span>
        <span className="kb-activity-total">
          {total} edit{total === 1 ? "" : "s"} in the last two weeks
        </span>
        <span className="kb-activity-spacer" />
        {pickedDay !== null ? (
          <button type="button" className="kb-activity-day-pill" onClick={() => setPickedDay(null)}>
            {new Date(bars[pickedDay].start).toLocaleDateString(undefined, { weekday: "long" })}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
          </button>
        ) : null}
        <div
          className="segmented kb-activity-filter"
          role="radiogroup"
          aria-label="Show"
          style={{ "--segment-count": 3, "--segment-index": ["all", "created", "revised"].indexOf(filter) } as CSSProperties}
        >
          {(["all", "created", "revised"] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              role="radio"
              aria-checked={filter === entry}
              className={filter === entry ? "active" : ""}
              onClick={() => setFilter(entry)}
            >
              {entry === "all" ? "All" : entry === "created" ? "Created" : "Revised"}
            </button>
          ))}
        </div>
        {check}
      </header>
      <div className="kb-activity-bars" aria-label="Edits per day, last two weeks">
        {bars.map((bar, index) => {
          const today = index === bars.length - 1;
          const picked = pickedDay === index;
          return (
            <button
              key={bar.start}
              type="button"
              disabled={!bar.count}
              aria-pressed={picked}
              title={`${bar.count} edit${bar.count === 1 ? "" : "s"}`}
              className={[picked ? "is-picked" : "", bar.count ? "has-edits" : "", today ? "is-today" : ""].filter(Boolean).join(" ")}
              onClick={() => setPickedDay(picked ? null : index)}
            >
              <span className="kb-activity-bar-track">
                <span
                  className="kb-activity-bar"
                  style={{ height: bar.count ? `${Math.max(10, (bar.count / tallest) * 100)}%` : undefined }}
                />
              </span>
              <span className="kb-activity-bar-label">
                {today ? "Today" : new Date(bar.start).toLocaleDateString(undefined, { weekday: "narrow" })}
              </span>
            </button>
          );
        })}
      </div>
      <div className="kb-log">
        {shown.map((day) => (
          <section key={day.key} className="kb-activity-day">
            <header>
              <h3>{day.label}</h3>
              <span>{day.count} edit{day.count === 1 ? "" : "s"}</span>
            </header>
            <div className="kb-activity-rows">
              {day.rows.map((row) => {
                const edit = (
                  <>
                    <span className="kb-activity-time">{row.time}</span>
                    <span className={`kb-activity-dot kb-activity-dot-${row.action ?? "none"}`} aria-hidden="true" />
                    <span className="kb-activity-main">
                      <span className="kb-activity-title">
                        <strong>{row.title}</strong>
                        {row.kind ? <small>{logKindSuffix(row.kind)}</small> : null}
                      </span>
                      <span className="kb-activity-note">{row.note}</span>
                    </span>
                    {row.action ? (
                      <span className={`kb-log-badge kb-log-badge-${row.action}`}>{logActionLabel(row.action)}</span>
                    ) : <span />}
                  </>
                );
                // A page deleted since has nothing to open.
                if (row.slug && !bySlug.has(row.slug)) return <p key={row.key} className="kb-activity-row is-bare">{edit}</p>;
                return row.slug ? (
                  <button key={row.key} type="button" className="kb-activity-row" onClick={() => onOpen(row.slug as string)}>
                    {edit}
                    <svg className="kb-activity-go" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
                  </button>
                ) : (
                  <p key={row.key} className="kb-activity-row is-bare">
                    <span className="kb-activity-time">{row.time}</span>
                    <span className="kb-activity-dot kb-activity-dot-none" aria-hidden="true" />
                    <span className="kb-activity-main">
                      <span className="kb-activity-note">{row.note}</span>
                    </span>
                  </p>
                );
              })}
            </div>
          </section>
        ))}
        {shown.length === 0 ? (
          <div className="kb-health-more">
            <span>
              {filter === "all" ? "Nothing was filed" : `No pages were ${filter}`}
              {pickedDay !== null
                ? ` on ${new Date(bars[pickedDay].start).toLocaleDateString(undefined, { weekday: "long" })}`
                : ""}.
            </span>
            <button type="button" className="kb-health-verb" onClick={() => { setFilter("all"); setPickedDay(null); }}>
              Show all edits
            </button>
          </div>
        ) : null}
        {hidden > 0 ? (
          <div className="kb-health-more">
            <button type="button" className="kb-health-verb" onClick={() => setExpanded(true)}>
              Show {plural(hidden, "earlier edit")}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * A health check that did not finish, where the lists sit. A missing AI
 * connection is not a failure — nothing went wrong and there is something to
 * do — so it says so on a sand tile and goes straight to the connection.
 */
function HealthCheckFailure({
  error,
  running,
  onRetry,
  onConnect,
}: {
  error: string;
  running: boolean;
  onRetry: () => void;
  onConnect: () => void;
}) {
  if (error === "No model provider is configured") {
    return (
      <aside className="kb-health-card" role="alert">
        <div className="kb-health-row is-centered">
          <MarkTile tone="sand" />
          <div className="kb-health-row-copy">
            <strong className="kb-health-row-name">Checking for contradictions needs an AI connection</strong>
            <span className="kb-health-row-meta">The live counts still work. Connect a subscription or an API key, then run the check.</span>
          </div>
          <button type="button" className="kb-health-verb is-primary" onClick={onConnect}>
            Open AI connection
          </button>
        </div>
      </aside>
    );
  }
  return (
    <aside className="kb-health-card" role="alert">
      <div className="kb-health-row">
        <MarkTile tone="honey" />
        <div className="kb-health-row-copy">
          <strong className="kb-health-row-name">The health check didn’t finish</strong>
          <span className="kb-health-row-meta">Your Memory wasn’t changed. Run it again; if it stops a second time, the detail below says where.</span>
          <TechnicalDetail text={error} />
        </div>
        {/* Running it again clears this card: the check's own button says it is working. */}
        <button type="button" className="kb-health-verb is-primary" disabled={running} onClick={onRetry}>
          Run it again
        </button>
      </div>
    </aside>
  );
}
