"use client";
import { mergeAnnotationRead } from "../lib/web-annotation-state";

import { describeModelWait } from "../lib/backfill";
import {
  CSSProperties,
  Fragment,
  type FormEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  API_BASE,
  ApiError,
  api,
  setUnauthorizedHandler,
  type AppConfig,
  type ChatViewport,
  type ComposerChoice,
  DEFAULT_APP_CONFIG,
  type DashboardDocument,
  type DigestDetail,
  Highlight,
  Note,
  isDone,
  isStagedUpload,
  isWebPaper,
  isWebPdf,
  Paper,
  type ResearchDigest,
  type StagedUpload,
  type UploadResult,
  Project,
  ProjectSummary,
  type ReaderResolution,
  User,
  type ViewportEvidence,
  type MemoryDependentPage,
  type MemoryDocumentNeighborhood,
  type PersonaSummary,
} from "../lib/api";

import { SettingsModal, type SettingsPane } from "./SettingsModal";
import { CreateProjectModal } from "./CreateProjectModal";
import { ModalLayer } from "./ModalLayer";
import { DEFAULT_PERSONA_ID } from "../lib/personas";
import { readSseStream } from "../lib/sse";
import { followPointer, suppressClickAfterDrop } from "../lib/pointer-gesture";

import { type CitationTarget } from "../lib/citations";
import { loadPdfEngine } from "../lib/pdf-engine";
import type { LocatorHit } from "../lib/locator-index";
import { forgetProjectAnchors } from "../lib/anchor-index";
import { evidencePassageQuote } from "../lib/evidence-passage";
import { accentRamp, onAccent, onRampStep, projectAccent } from "../lib/project-color";
import { ChatPanel } from "./ChatPanel";
import { PanelDivider } from "./PanelDivider";
import { RelatedMemoryRail } from "./RelatedMemoryRail";
import type { ConversationSummary } from "../lib/conversation-session";
import { AskComposer, type AskDraft } from "./chat/AskComposer";
import { AskDelphiButton } from "./chat/AskDelphiButton";
import { ProjectSetup } from "./ProjectSetup";
import {
  chatIsDocked,
  chatParam,
  contextFromParam,
  scopeKey,
  availableContexts,
  type ChatContext,
  type ChatTarget,
} from "../lib/chat-scope";
import DigestPane, { type DigestActivity } from "./DigestPane";
import { ReaderMenu, ReaderMenuItem, ReaderMenuRule, ReaderMenuZoom } from "./ReaderMenu";
import { chatOwnsZoom, useStoredZoom, zoomDirection } from "../lib/use-text-zoom";
import { PAGE_ZOOM_STEPS } from "../lib/page-zoom";
import ReaderViewToggle, { digestMark, type ReaderView } from "./ReaderViewToggle";
import { TopBar } from "./TopBar";
import { NoticeMark, Toast, hint, type Notice } from "./Notice";
import { useFilingSetback, useFilingStep, useLibraryFiling } from "./FilingProgress";
import { OutdatedPage, UnfiledDocument, useDocumentFiling } from "./DocumentFiling";
import { LoadingCaption, PagesMark } from "./Loading";
import {
  clearTrail,
  popTrail,
  pushTrail,
  trailWithin,
  type TrailEntry,
} from "../lib/citation-trail";
import { pageTitle } from "../lib/page-title";
import { MEMORY_PAGES_CHANGED } from "../lib/memory";
import { CHAT_COLUMN, READER_CHAT_CEILING, defaultChatColumn, rightColumnCeiling, rightColumnScale } from "../lib/right-column";
import { sideColumnCeiling, sideColumnWidth } from "../lib/side-chat";
import { carriesFiles, carriesPdf, isPdfFile } from "../lib/file-drag";
import {
  onMemoryFiled,
  readerIsBeside,
  requestMemoryMaintenance,
  startMemoryMaintenance,
} from "../lib/memory-maintenance";
import { onCaptured, requestCaptures, startCaptures } from "../lib/capture-queue";
import {
  documentPath,
  parseReaderPath,
  projectPath,
  readerApiPath,
  readFocusBox,
} from "../lib/routes";
import {
  type EvidenceViewport,
  GlobeIcon,
  type PageFocus,
  PageViewer,
  type PageViewerHandle,
} from "./PageViewer";
import {
  clampZoom,
  type PdfFocus,
  PdfViewer,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from "./PdfViewer";

/** Width of the collapsed library column: 52px rail plus its 6px margins. */
const RAIL_COLUMN = 64;

/**
 * Below this the window is not wide enough for three columns at once.
 *
 * A laptop window at half the screen lands around 700–950px, and the grid used
 * to answer that by overflowing: two fixed side columns plus a 360px reader
 * floor summed past the viewport and pushed the chat panel off the right edge,
 * where nothing scrolled it back. So the library opens as its rail below this
 * width. Explicitly expanding it restores its column beside the reader.
 */
const COMPACT_WIDTH = 1180;

/**
 * The narrowest the reader may be squeezed to. Enforced by the side panels
 * giving way — never as a grid track floor, which the window would simply
 * overflow rather than honour.
 */
const MIN_READER_COLUMN = 372;
const MIN_CHAT_COLUMN = 320;
const MIN_MEMORY_COLUMN = 192;
// Grid padding and both divider tracks also consume horizontal space.
const READER_CHROME_WIDTH = 68;
// Use available CSS pixels, so window size and display scaling both count.
// Its 336px cap grows with the column's ceiling on a large display.
const defaultMemoryWidth = (viewport: number) =>
  Math.round(Math.max(MIN_MEMORY_COLUMN, Math.min(336 * rightColumnScale(viewport), (280 * viewport) / 1512)));
/**
 * One ceiling for the right column, whichever pane is in it.
 *
 * A second, narrower ceiling for the rail-only state was tried and removed:
 * once the graph kept its type and its dots at fixed pixel sizes and answered
 * extra room with *more pages* instead, a wide rail stopped being wasted space
 * and became a bigger map. The empty column that ceiling was protecting
 * against no longer exists, and two bounds to keep in step is complexity
 * bought for nothing.
 *
 * `READER_CHAT_CEILING` is a laptop's ceiling. A large display grows it with
 * the window (`rightColumnCeiling`), because a laptop's column on a 2560px
 * window leaves a screen that can afford far more.
 */
const maxChatColumn = (viewport: number) =>
  rightColumnCeiling(viewport, READER_CHAT_CEILING);
/* How long the docked chat takes to leave. Kept in step with the transition on
   `.kb-chat-rail.is-leaving` in globals.css — the timer only decides when the
   address changes, so a mismatch shows as a panel that disappears mid-slide. */
const CHAT_EXIT_MS = 260;
const MIN_LIBRARY_COLUMN = 220;
const MAX_LIBRARY_COLUMN = 480;
const PANEL_SETTLE_MS = 360;

/**
 * How long the drop overlay outlives the last sign of a drag.
 *
 * Long enough to bridge the gap while the pointer crosses between this document
 * and the reader frame's, short enough that a file dragged out of the window
 * and never brought back does not leave the overlay hanging.
 */
const DROP_SETTLE_MS = 140;

/** What the reader asked to add before any project existed, carried into setup. */
type SetupSeed = { files: File[]; urls: string[] };

/** An address with the docked conversation named, so a reload reopens that tab. */
function withConversation(path: string, conversation: string | null): string {
  if (!conversation) return path;
  return `${path}${path.includes("?") ? "&" : "?"}conversation=${encodeURIComponent(conversation)}`;
}

/** The host of a web document, for the library rail's second line. */
function hostOf(url: string | undefined): string {
  if (!url) return "web page";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "web page";
  }
}

export function Workspace() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString() ? `?${searchParams}` : "";
  const [user, setUser] = useState<User | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [config, setConfig] = useState(DEFAULT_APP_CONFIG);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  /**
   * The loaded detail for whichever project the URL names. Not "the selected
   * project" — there is no such state any more. It is a cache of one, refilled by
   * the effect below whenever the address changes.
   */
  const [detail, setDetail] = useState<Project | null>(null);
  const [resolution, setResolution] = useState<{
    key: string;
    value: ReaderResolution;
  } | null>(null);
  // The complete visible route matters: a late 404 for the route just left
  // must not make the next valid document look unavailable.
  const [missingRouteKey, setMissingRouteKey] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [annotationLoadError, setAnnotationLoadError] = useState("");
  const [annotationReload, setAnnotationReload] = useState(0);
  const [annotationToolbar, setAnnotationToolbar] = useState<HTMLDivElement | null>(null);
  /** Unsaved note text by highlight, shared by every card and list, so a failed save or a closed card loses nothing. */
  const [annotationDrafts] = useState(() => new Map<string, string>());
  const annotationDocument = useRef("");
  /** Highlights deleted this visit; a late read must not bring them, or their notes, back. */
  const annotationDeletes = useRef(new Set<string>());
  const [libraryTab, setLibraryTab] = useState<"papers" | "projects">("papers");
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState<Notice>("");
  const [libraryWidth, setLibraryWidth] = useState(264);
  const [viewportWidth, setViewportWidth] = useState(1512);
  /**
   * The Reader opens on Related Memory, not on a chat.
   *
   * A reader who came to read gets the panel that says where this document
   * sits in what they already know; a conversation is something they ask for,
   * from the bar, and it docks *above* that rail rather than replacing it.
   */
  const [askOpen, setAskOpen] = useState(false);

  const [chatFullscreen, setChatFullscreen] = useState(false);
  /* Closing the chat is an animation, and the address is the record of what is
     open (invariant 21) — so the panel plays its exit *before* the navigation
     that unmounts it, rather than vanishing on the frame the URL changes.
     Related Memory rises into the space it leaves, which is the whole point
     of docking one above the other. */
  const [chatClosing, setChatClosing] = useState(false);
  const chatCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (chatCloseTimer.current) clearTimeout(chatCloseTimer.current);
    },
    [],
  );
  /** The Ask composer's pills as they were when its question was sent. */
  const [askChoice, setAskChoice] = useState<ComposerChoice | undefined>();
  const [askSeed, setAskSeed] = useState("");
  const [askConversation, setAskConversation] = useState<ConversationSummary>();
  const [askRequestId, setAskRequestId] = useState("");
  const [askInitialContext, setAskInitialContext] = useState<ChatContext | null>(null);
  const [askImageIds, setAskImageIds] = useState<string[]>([]);
  const [askReferenceIds, setAskReferenceIds] = useState<string[]>([]);
  /* The passage Reply was pressed on while no conversation was docked. It rides
     the floating composer to the chat that is about to open. */
  const [askQuote, setAskQuote] = useState("");
  /* Bumped when Ask Delphi is pressed with a conversation already on screen.
     The panel reads its parity, so no timer here has to agree with the CSS. */
  const [chatNudge, setChatNudge] = useState(0);
  const [seedQuote, setSeedQuote] = useState("");
  const [personas, setPersonas] = useState<PersonaSummary[]>([]);
  /**
   * Which persona the Ask composer starts a *new* conversation in.
   *
   * The one place two persona states legitimately coexist. Every mounted chat
   * owns its own — a persona belongs to a conversation — but the Ask composer
   * writes a turn before the conversation exists, so it has nothing to read.
   * The draft rides on the first request, the server stores it, and from the
   * second turn on the conversation is the authority.
   */
  const [draftPersonaId, setDraftPersonaId] = useState(DEFAULT_PERSONA_ID);
  const [askModel, setAskModel] = useState("");
  const [askEffort, setAskEffort] = useState("");
  /**
   * The wiki's shape, for the rail. Fetched from the `/graph` route — never
   * `GET /api/memory`, which carries the event log too, and nothing on the
   * reader's own open-a-document path reads that.
   */
  const [memoryGraph, setMemoryGraph] =
    useState<MemoryDocumentNeighborhood | null>(null);
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);
  const [panelAnimating, setPanelAnimating] = useState(false);
  const [libraryAnimating, setLibraryAnimating] = useState(false);
  const [chatAnimating, setChatAnimating] = useState(false);
  const panelAnimationTimerRef = useRef<number | null>(null);
  const beginPanelAnimation = useCallback((animateLibrary = false, animateChat = false) => {
    if (panelAnimationTimerRef.current !== null) {
      window.clearTimeout(panelAnimationTimerRef.current);
    }
    setLibraryAnimating(animateLibrary);
    setChatAnimating(animateChat);
    setPanelAnimating(true);
    panelAnimationTimerRef.current = window.setTimeout(() => {
      panelAnimationTimerRef.current = null;
      setPanelAnimating(false);
      setLibraryAnimating(false);
      setChatAnimating(false);
      window.dispatchEvent(new Event("delphi-panel-resize-end"));
    }, PANEL_SETTLE_MS);
  }, []);
  /**
   * Related Memory scales with the window and keeps a manual width once
   * dragged. A narrow conversation opens only a little wider than memory.
   *
   * Two remembered widths, not one, because the column holds two different
   * things. With a conversation docked it is mostly transcript and wants the
   * room; with only Related Memory it is a map and a list, neither of which
   * gets better past a point — a single 420 left the reader paying for space
   * the graph could not use. Each is remembered separately so a drag in one
   * state does not silently move the other. The grid follows the window
   * directly rather than chasing every resize with a new transition.
   */
  const [chatColumnWidth, setChatColumnWidth] = useState(CHAT_COLUMN);
  const [railColumnWidth, setRailColumnWidth] = useState(280);
  const memoryWidthDragged = useRef(false);
  const chatWidthDragged = useRef(false);
  /* A side chat widens the docked column by its own width, or to the width
     the reader dragged it to while one was open. The column's own width is
     left alone, so closing the side chat goes back to it. */
  const [sideChatOpen, setSideChatOpen] = useState(false);
  const [sideColumnDragged, setSideColumnDragged] = useState<number | null>(null);
  const sideChatWanted = useRef(false);
  const sideChatShown = useRef(false);
  // Where a citation sent the reader, and the paper to offer them back. A PDF
  // is located by page and a web page by section anchor, so the two focuses are
  // separate rather than one shape with half its fields null.
  const [pdfFocus, setPdfFocus] = useState<
    (PdfFocus & { paperId: string }) | null
  >(null);
  const [pageFocus, setPageFocus] = useState<
    (PageFocus & { paperId: string }) | null
  >(null);
  const [addDocumentOpen, setAddDocumentOpen] = useState(false);
  // Filling a project: open over the reader for a project just made, or one
  // with nothing in it. A source chosen before any project existed waits in
  // the seed, as the browser's own File or the typed address, and is spent
  // once by the setup that follows the project's creation.
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupSeed, setSetupSeed] = useState<SetupSeed>({ files: [], urls: [] });
  const setupOpenRef = useRef(false);
  setupOpenRef.current = setupOpen;
  const [settingsPane, setSettingsPane] = useState<SettingsPane>("projects");
  /* Managing personas is a settings errand, and the sheet is mounted per shell
     — so the chat's menu asks upward rather than opening anything itself. */
  const openPersonaSettings = () => {
    setSettingsPane("persona");
    setSettingsOpen(true);
  };
  // `null` is "no modal"; an empty string is "blocked, destination unknown" —
  // a scripted navigation is cross-origin, so it cannot be read.
  const [blockedLink, setBlockedLink] = useState<string | null>(null);
  const pageViewerRef = useRef<PageViewerHandle>(null);
  const [viewportOffHome, setViewportOffHome] = useState(false);
  const [saveViewportTarget, setSaveViewportTarget] =
    useState<ChatViewport | null>(null);
  // Kept per document rather than as one number reset on every switch, so
  // returning to a paper finds it at the size it was left at.
  const [zoomByPaper, setZoomByPaper] = useState<Record<string, number>>({});
  /** The digest's text size, one for every digest and kept across launches. */
  const [digestZoom, stepDigestZoom] = useStoredZoom("delphi.digest-zoom");
  /**
   * The way back out of a citation jump.
   *
   * A stack, not a slot: following A → B → C used to overwrite the memory of A,
   * so the trail only ever led back one step. Held here rather than in the URL
   * because it describes how the reader arrived, not where they are — and it
   * survives navigation because this component does.
   */
  const [trail, setTrail] = useState<TrailEntry[]>([]);
  const focusNonce = useRef(0);
  // Logging out and discovering an expired session both make `user` null, but only
  // the latter should preserve the document in `?next=`. A ref takes effect before
  // the state update can run the signed-out redirect against the old URL.

  /**
   * Everything about "where am I" is read from the address, not stored beside it.
   * There is no `setProject`/`setPaper` anywhere below, which is the whole point:
   * a second source of truth is what let a refresh forget the open document.
   */
  const route = useMemo(() => parseReaderPath(pathname), [pathname]);
  const routeKey = route && route.kind !== "root" ? pathname : null;
  const resolved =
    routeKey && resolution?.key === routeKey ? resolution.value : null;
  const routeProjectId = resolved?.project.id ?? null;
  const routePaperId = resolved?.paperId ?? null;
  const project = detail && detail.id === routeProjectId ? detail : null;
  const paper =
    project?.papers.find((item) => item.id === routePaperId) ?? null;
  /**
   * Which conversation is open, read off the address on every render.
   *
   * The URL is the only record of this (invariant 21): there is no
   * `setContext`, and the chat surface is keyed on it, so a refresh reopens the
   * same conversation and a change of context mounts a different one.
   */
  const chatContext = contextFromParam(searchParams.get("chat"), {
    hasPaper: Boolean(routePaperId),
  });
  /**
   * Whether a conversation is docked, read off the address like everything
   * else about what is open (invariant 21).
   *
   * Local state here was a real bug: a Dashboard row links straight at a
   * conversation, and arriving with `?chat=` in hand opened the document with
   * the panel shut, which reads as the link having done nothing.
   */
  const chatOpen = chatIsDocked(searchParams.get("chat"));
  const setChatOpen = (open: boolean) => {
    if (!project) return;
    if (open) setChatClosing(false);
    router.replace(
      pathTo(
        { projectId: project.id, paperId: paper?.id ?? null },
        open ? chatContext : null,
      ),
    );
  };
  /* Which of the two widths the column is currently showing. The closing flag
     is in here so the column narrows *while* the chat slides out rather than
     after it, which is one movement instead of two. */
  const chatDocked = chatOpen && !chatClosing;
  const beginChatAnimation = (opening: boolean) => {
    window.dispatchEvent(new CustomEvent("delphi-panel-resize-start", {
      detail: { grow: opening ? 0 : Math.max(0, chatWidth - railColumnWidth) },
    }));
    beginPanelAnimation(false, true);
  };
  // Both composer actions must arm the grid transition before navigation
  // changes its width, and hold the reader's raster until the rail settles.
  const openChatFromComposer = (context: ChatContext) => {
    if (!project) return;
    if (chatCloseTimer.current) {
      clearTimeout(chatCloseTimer.current);
      chatCloseTimer.current = null;
    }
    if (!chatDocked) beginChatAnimation(true);
    setChatClosing(false);
    router.replace(pathTo({ projectId: project.id, paperId: paper?.id ?? null }, context));
  };
  // A project just made arrives with `?setup=1`, from here or the Dashboard:
  // its setup opens once the project has loaded, and the flag leaves the
  // address so a reload lands on the project rather than asking again.
  const setupRequested = searchParams.get("setup") === "1";
  useEffect(() => {
    if (!setupRequested || !project) return;
    setSetupOpen(true);
    router.replace(pathname);
  }, [setupRequested, project, router, pathname]);

  // What the drop overlay promises: room left in the project the file joins.
  const dropRoom = project
    ? config.maxPapersPerProject - project.papers.filter((item) => !isDone(item)).length
    : 0;
  const sideColumn = chatDocked && sideChatOpen;
  const chatWidth = !chatDocked ? railColumnWidth : sideColumn ? sideColumnWidth({
    column: chatColumnWidth,
    dragged: sideColumnDragged,
    ceiling: maxChatColumn(viewportWidth),
    room: viewportWidth - (libraryCollapsed ? RAIL_COLUMN : libraryWidth) - READER_CHROME_WIDTH - MIN_READER_COLUMN,
    floor: MIN_CHAT_COLUMN,
    viewport: viewportWidth,
  }) : chatColumnWidth;
  const setChatWidth = !chatDocked ? setRailColumnWidth : sideColumn ? setSideColumnDragged : setChatColumnWidth;
  // What the column shows, for a side chat closing: it gives back what it took, drag and clamp included.
  const shownColumn = useRef({ docked: chatDocked, width: chatWidth, own: chatColumnWidth });
  shownColumn.current = { docked: chatDocked, width: chatWidth, own: chatColumnWidth };
  /* Reported by the chat after every commit. A tab switch reports the old
     conversation closing and the new one's state in the same commit, so the
     change is settled a microtask later and only a real one moves the column. */
  const onSideChatChange = useCallback((open: boolean) => {
    sideChatWanted.current = open;
    queueMicrotask(() => {
      const next = sideChatWanted.current;
      if (next === sideChatShown.current) return;
      sideChatShown.current = next;
      // A chat closing takes its side chat with it, in the one movement it already plays.
      const { docked, width, own } = shownColumn.current;
      if (docked) {
        window.dispatchEvent(new CustomEvent("delphi-panel-resize-start", {
          detail: { grow: next ? 0 : Math.max(0, width - own) },
        }));
        beginPanelAnimation(false, true);
      }
      setSideChatOpen(next);
    });
  }, [beginPanelAnimation]);
  // Keep the preferred width, but let the library minimum yield to the reader.
  const libraryWidthLimit = Math.max(RAIL_COLUMN, viewportWidth - chatWidth - READER_CHROME_WIDTH - MIN_READER_COLUMN);
  const visibleLibraryWidth = Math.min(libraryWidth, libraryWidthLimit);
  /**
   * Where a Reply goes.
   *
   * With a conversation docked the panel is mounted and listening, so the
   * passage lands in its quote chip exactly as it always has. With none, the
   * event had nobody to hear it and Reply silently did nothing — so the
   * floating composer opens instead, carrying the quote, and hands it on to the
   * chat that mounts when the question is sent.
   */
  const reply = (text: string) => {
    // A docked conversation takes the passage itself; the composer is only for
    // starting a chat when none is on screen.
    if (chatDocked) {
      window.dispatchEvent(new CustomEvent("delphi-reply", { detail: text }));
      return;
    }
    setAskInitialContext("document");
    setAskQuote(text);
    setAskOpen(true);
  };
  /** Play the exit, then drop `?chat=`. `CHAT_EXIT_MS` matches the CSS. */
  const closeChat = () => {
    if (chatCloseTimer.current) return;
    setChatClosing(true);
    /* pdf.js re-lays-out on every frame a neighbouring column is in motion,
       which is what made the exit feel heavy rather than smooth. Freeze the
       reader's own layout for the length of the movement, exactly as a divider
       drag does. */
    beginChatAnimation(false);
    chatCloseTimer.current = setTimeout(() => {
      chatCloseTimer.current = null;
      setChatFullscreen(false);
      /* `chatClosing` is deliberately *not* cleared here. The navigation this
         call starts is asynchronous, so for a frame or two afterwards the
         address still says a chat is open — and clearing the flag in the same
         tick made `chatDocked` true again, which re-opened the panel at full
         width and then played the whole exit a second time when the URL
         finally landed. It is cleared where a chat is opened instead, which is
         the only moment it can be wrong. */
      setChatOpen(false);
    }, CHAT_EXIT_MS);
  };
  /** This mount's conversation, as one value the key and the props both read. */
  const chatTarget: ChatTarget =
    chatContext === "general"
      ? { context: "general" }
      : {
          context: "document",
          projectId: routeProjectId ?? "",
          paperId: routePaperId ?? "",
        };
  /**
   * The wiki page written *from* the open document, if there is one.
   *
   * A document is a source, so its page is the one the rail centres on. When
   * nothing points back at it the document simply is not filed yet, which the
   * rail says outright rather than silently drawing somebody else's
   * neighbourhood.
   *
   * Which of its pages that is, is the server index's decision — every
   * page a pass filed while reading the document carries the same paper as
   * provenance, so the first match is not the document's own page.
   *
   * **"No page" and "no graph yet" are different answers**, which is why the
   * graph's arrival is a state of its own. Both spell as `null` here, and the
   * rail read that single `null` as "not filed" — so every Reader open began
   * by telling the reader their document was not in their Memory, and then
   * corrected itself a moment later for the documents that were. A panel that
   * has to take back what it just said is worse than one that waits.
   */
  const currentMemoryGraph =
    memoryGraph?.paperId === routePaperId ? memoryGraph : null;
  const paperPage = currentMemoryGraph?.sourcePage ?? null;
  const activeProjectId = project?.id;
  const activePaperId = paper?.id;

  /**
   * The rail's data and the persona list, both deferred.
   *
   * `setTimeout(0)` for the same reason the wiki defers its own fetches: this
   * is beside a document the reader came to read, so it must not be part of
   * what makes the document appear.
   */
  const loadMemoryGraph = useCallback(async () => {
    if (!config.memoryEnabled || !routePaperId) {
      setMemoryGraph(null);
      return;
    }
    setMemoryGraph(null);
    await api<MemoryDocumentNeighborhood>(
      `/api/memory/documents/${encodeURIComponent(routePaperId)}/neighborhood?hops=${config.memoryRelatedHops}`,
    )
      .then(setMemoryGraph)
      .catch(() => undefined);
  }, [
    config.memoryEnabled,
    config.memoryRelatedHops,
    routePaperId,
  ]);

  /* Re-run after a persona is written, deleted or installed in Settings: the
     menu that sent the reader there has to show what they just made. */
  const loadPersonas = useCallback(
    () =>
      api<{ official: PersonaSummary[]; mine: PersonaSummary[] }>("/api/personas")
        .then((catalog) => setPersonas([...catalog.official, ...catalog.mine]))
        .catch(() => undefined),
    [],
  );

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => {
      void loadMemoryGraph();
      void loadPersonas();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [user, loadMemoryGraph, loadPersonas]);
  useEffect(() => {
    if (user) startMemoryMaintenance(config.memoryEnabled);
  }, [config.memoryEnabled, user]);
  // A page added at its first window is read whole in the background, and a
  // quit or paused app finishes what it left at the next launch. Each capture
  // settled replaces its record here, which swaps the open copy in place
  // (`PageViewer`'s `copy`), and lets the filing it held go ahead.
  useEffect(() => {
    if (!user) return;
    startCaptures();
    return onCaptured(({ projectId, paperId, paper }) => {
      if (paper) {
        setDetail((current) =>
          current?.id === projectId
            ? { ...current, papers: current.papers.map((item) => (item.id === paperId ? paper : item)) }
            : current,
        );
      }
      fileDocument();
    });
  }, [user]);
  /**
   * The rail is a view of the graph the maintenance queue writes into, so it
   * follows whatever that queue files — including the pass that files the open
   * document while the reader is sitting in front of it.
   */
  useEffect(() => onMemoryFiled(() => void loadMemoryGraph()), [
    loadMemoryGraph,
  ]);

  /*
   * One filing record per open document, read above the fork rather than
   * inside either card.
   *
   * Both cards need it and they are mutually exclusive, so asking twice would
   * be two requests for one fact and two ideas about whether a pass is already
   * queued. It is a new request on the Reader's path for a document that *is*
   * filed, which it was not before — the record is the only thing that knows a
   * page was written by a pass Delphi has replaced, and there is no way to
   * offer that without asking. The hook defers it and neither card renders
   * anything until it has answered, for the reason the rail's own fetch is
   * deferred: this sits beside a document the reader came to read.
   */
  const documentFiling = useDocumentFiling({
    paper,
    projectId: project?.id ?? null,
    enabled: config.memoryEnabled,
    onFiled: loadMemoryGraph,
    onNotice: setNotice,
  });
  useEffect(() => setViewportOffHome(false), [routeProjectId, routePaperId]);
  useEffect(() => {
    if (!user || !activeProjectId || !activePaperId) return;
    void api<void>(
      `/api/projects/${activeProjectId}/papers/${activePaperId}/engagement`,
      { method: "POST" },
    ).catch(() => undefined);
  }, [user, activeProjectId, activePaperId]);
  /*
   * What the reader asked and noted beside a document is filed once, when
   * they leave it: for another document, for another route, or by closing its
   * chat. Read off the address like everything else about what is open, so a
   * document still loading is already the one the reader is beside. Moving
   * between its chats changes none of these, and so ends nothing.
   */
  const documentChatDocked = chatOpen && chatContext === "document";
  useEffect(() => {
    readerIsBeside({
      document:
        routeProjectId && routePaperId
          ? { projectId: routeProjectId, paperId: routePaperId, chat: documentChatDocked }
          : null,
    });
  }, [routeProjectId, routePaperId, documentChatDocked]);
  useEffect(() => () => readerIsBeside({ document: null }), []);
  /**
   * A library search hit encodes exactly where it was found —
   * `?focusPage=` or `?focusSection=`, from `libraryHitPath` — so opening one
   * lands on that page or section rather than just the document, the same
   * way a citation jump does. Left in the address rather than stripped: the
   * page it names is where the reader actually is, in the sense invariant 21
   * cares about, not a spent instruction like a citation trail — so a reload
   * or a shared link lands on the same page again instead of just the
   * document.
   *
   * The watcher just below clears `pdfFocus`/`pageFocus` on every address
   * change that was not marked deliberate first, and this effect runs in the
   * same commit as that one — so without marking *this* render's address
   * deliberate before setting the focus, the watcher would erase it again
   * before the paint it was set in ever reached the screen.
   */
  const focusPlace = useRef({ place: "", search: "" });
  useEffect(() => {
    if (!paper) return;
    const focusPage = searchParams.get("focusPage");
    const focusSection = searchParams.get("focusSection");
    if (!focusPage && !focusSection) {
      focusPlace.current = { place: "", search: "" };
      return;
    }
    // A new place in the document, or the same address navigated to again, is
    // a request for the document; the same place re-read on an unrelated
    // change of address (a chat opening) leaves the digest alone.
    const place = `${paper.id}:${focusPage}:${focusSection}`;
    if (focusPlace.current.place !== place || focusPlace.current.search === search) setDigestView(null);
    focusPlace.current = { place, search };
    citationJump.current = `${pathname}${search}`;
    focusNonce.current += 1;
    if (focusSection && isWebPaper(paper) && !isWebPdf(paper)) {
      setPdfFocus(null);
      setPageFocus({
        paperId: paper.id,
        anchor: focusSection,
        quote: null,
        nonce: focusNonce.current,
      });
    } else {
      const page = Number(focusPage);
      setPageFocus(null);
      setPdfFocus({
        paperId: paper.id,
        page: Number.isFinite(page) && page > 0 ? page : 1,
        rect: readFocusBox(searchParams.get("focusBox")),
        nonce: focusNonce.current,
      });
    }
    // `paper` is a fresh object every render (see `project?.papers.find`
    // above); keying on its id instead of the object is what keeps this from
    // re-firing, and re-scrolling, on every unrelated reload of the project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper?.id, searchParams, pathname, search]);
  /**
   * Async mutations finish against the project they started in, but the reader
   * is free to move meanwhile. Keep the live address outside those callbacks so
   * a late refresh can update project summaries without replacing the detail
   * currently on screen, and so creating a document never pulls the reader back
   * after they deliberately left.
   */
  const readerLocationRef = useRef({
    path: `${pathname}${search}`,
    projectId: routeProjectId,
    paperId: activePaperId,
  });
  useEffect(() => {
    readerLocationRef.current = {
      path: `${pathname}${search}`,
      projectId: routeProjectId,
      paperId: activePaperId,
    };
  }, [pathname, routeProjectId, search, activePaperId]);
  /**
   * Whether the address names something that cannot be opened.
   *
   * Three ways to get here, deliberately answered the same way: a path that is
   * not a document at all, a project that 404s (deleted, or never yours), and a
   * project that loads but has no such paper in it.
   */
  const missing =
    route === null ||
    Boolean(routeKey && missingRouteKey === routeKey);

  /**
   * The address names something that is not on screen yet.
   *
   * Deployed, resolving a route is a round trip to Cloud Run — anywhere from
   * 200 ms to a few seconds — and for that whole window `project` is null for
   * exactly the same reason it is null for an account with nothing in it.
   * Nothing downstream could tell those apart, so switching projects flashed
   * "No project yet" at readers with a full library. Every empty state in the
   * workspace is gated on this instead; a bare `/` counts too, because the
   * redirect to the remembered document has not run yet.
   */
  const resolving = missing
    ? false
    : routeKey
      ? !resolved
      : projects.length > 0;

  /** Only the steps taken inside the project being read are offered back. */
  const visibleTrail = useMemo(
    () => trailWithin(trail, routeProjectId),
    [trail, routeProjectId],
  );
  const bootRoute = useRef(route);
  const bootRouteKey = useRef(routeKey);
  /**
   * The one navigation allowed to keep the focus that was just set. Every other
   * move clears it, which is what stops a citation highlight from following the
   * reader somewhere it does not belong.
   */
  const citationJump = useRef<string | null>(null);

  const refreshProjects = useCallback(async () => {
    setProjects(await api<ProjectSummary[]>("/api/projects"));
  }, []);

  /** Re-read the open project, after something changed inside it. */
  const reloadDetail = useCallback(async () => {
    const wanted = readerLocationRef.current.projectId;
    if (!wanted) return;
    const loaded = await api<Project>(`/api/projects/${wanted}`);
    // The request belongs to `wanted`, not to whatever route happens to be
    // current when it resolves. A late answer must never replace that route's
    // one-slot detail cache.
    if (readerLocationRef.current.projectId === wanted) {
      setDetail(loaded);
    }
  }, []);

  /*
   * The open document's digest is written by its filing, and the Digest tab
   * reads it off the project's copy of the paper. That copy is re-read as the
   * filing moves from step to step and once it settles, so a reader waiting on
   * the tab sees the digest arrive, not "No digest" until they leave and come
   * back. A few reads per filing, and none for a document nobody is filing.
   */
  const filingOwed = Boolean(documentFiling.filing || documentFiling.record?.queued);
  const filingPaper = paper ? { id: paper.id, title: paper.title } : null;
  const filingStep = useFilingStep(filingPaper, config.memoryEnabled);
  const filingSetback = useFilingSetback(filingPaper, config.memoryEnabled) && !documentFiling.filing;
  const filingSeen = useRef<string | null>(null);
  const openPaperId = paper?.id ?? null;
  useEffect(() => {
    const seen = openPaperId && (filingOwed || filingStep !== null) ? `${openPaperId}:${filingStep ?? ""}` : null;
    const before = filingSeen.current;
    filingSeen.current = seen;
    if (openPaperId && before?.startsWith(`${openPaperId}:`) && before !== seen) {
      void reloadDetail().catch(() => undefined);
    }
  }, [openPaperId, filingOwed, filingStep, reloadDetail]);
  /*
   * A digest on its way is not offered again: one written now, from the first
   * window of a page still being read or beside the filing's own, would be
   * written a second time from the whole document.
   */
  const digestPending = !paper
    ? ""
    : paper.capture === "partial"
      ? filingOwed
        ? "Delphi is still reading the rest of this page. Filing writes its digest from all of it once that's done."
        : "Delphi is still reading the rest of this page. Generate is offered once it has all of it."
      // A filing that failed an attempt may be minutes from its retry, or
      // never retry: Generate is offered rather than waited on.
      : filingOwed && !filingSetback
        ? "Filing this document into Memory writes its digest. It opens here as soon as it's written."
        : "";

  /** Both of the above, which is what almost every mutation actually wants. */
  const reload = useCallback(async () => {
    await Promise.all([refreshProjects(), reloadDetail()]);
  }, [refreshProjects, reloadDetail]);

  const pathTo = useCallback(
    (
      ids: { projectId: string; paperId?: string | null },
      /** `null` docks nothing — the Reader's resting address. */
      chat: ChatContext | null = chatOpen ? chatContext : null,
    ) => {
      if (!user) throw new Error("A signed-in account is required for navigation");
      const targetProject =
        (detail?.id === ids.projectId ? detail : null) ??
        projects.find((item) => item.id === ids.projectId);
      if (!targetProject) {
        throw new Error("Project route metadata is unavailable");
      }
      if (!ids.paperId) return projectPath(user.username, targetProject);
      const targetPaper =
        detail?.id === ids.projectId
          ? detail.papers.find((item) => item.id === ids.paperId)
          : null;
      if (!targetPaper) throw new Error("Paper route metadata is unavailable");
      return documentPath(user.username, targetProject, targetPaper, {
        chat: chat ? chatParam(chat) : undefined,
      });
    },
    [chatContext, chatOpen, detail, projects, user],
  );

  // Warm the PDF engine while the library is still loading, so opening the
  // first paper of a session is as quick as opening the tenth.
  useEffect(() => {
    void loadPdfEngine();
  }, []);

  /**
   * Boot.
   *
   * Every leg fires at once. The resolver owns slug-to-id translation, so it can
   * run beside the account, config and project-list probes without trusting
   * visible route metadata as identity.
   *
   * `allSettled` because the resolver leg is allowed to fail — a link to a
   * document that was deleted, or was never yours, must not take the whole boot
   * down with it.
   */
  useEffect(() => {
    let live = true;
    const wantedRoute = bootRoute.current;
    const wantedKey = bootRouteKey.current;
    Promise.allSettled([
      // Being told "no session" is this probe's answer, not a session expiring
      // underneath someone, so it must not trigger the redirect installed below.
      api<User>("/api/auth/me", {}, { allow401: true }),
      api<AppConfig>("/api/config"),
      api<ProjectSummary[]>("/api/projects"),
      wantedRoute && wantedRoute.kind !== "root"
        ? api<ReaderResolution>(
            readerApiPath(wantedRoute),
            {},
            { allow401: true },
          )
        : Promise.resolve(null),
    ])
      .then(([me, appConfig, list, first]) => {
        if (!live) return;
        if (me.status !== "fulfilled") {
          setUser(null);
          return;
        }
        setUser(me.value);
        if (appConfig.status === "fulfilled") setConfig(appConfig.value);
        if (list.status === "fulfilled") setProjects(list.value);
        if (wantedKey) {
          if (first.status === "fulfilled" && first.value) {
            setResolution({ key: wantedKey, value: first.value });
            setDetail(first.value.project);
          } else {
            setMissingRouteKey(wantedKey);
          }
        }
      })
      .finally(() => live && setCheckingAuth(false));
    return () => {
      live = false;
    };
  }, []);

  /** Local sessions are restored by the main process on launch. */
  useEffect(() => {
    setUnauthorizedHandler(() => setNotice("Local session unavailable. Quit and reopen Delphi to reconnect."));
    return () => setUnauthorizedHandler(null);
  }, [router]);

  useEffect(() => {
    if (checkingAuth || user) return;
    setNotice("Local session unavailable. Quit and reopen Delphi to reconnect.");
  }, [checkingAuth, user, router, pathname, search]);

  /** Resolve each visible route, keeping late responses tied to their full key. */
  useEffect(() => {
    if (
      !user ||
      !route ||
      route.kind === "root" ||
      !routeKey ||
      resolution?.key === routeKey ||
      missingRouteKey === routeKey
    ) {
      return;
    }
    let live = true;
    const wantedKey = routeKey;
    api<ReaderResolution>(readerApiPath(route))
      .then((loaded) => {
        if (!live || pathname !== wantedKey) return;
        setMissingRouteKey(null);
        setResolution({ key: wantedKey, value: loaded });
        setDetail(loaded.project);
      })
      .catch(() => {
        if (live && pathname === wantedKey) setMissingRouteKey(wantedKey);
      });
    return () => {
      live = false;
    };
  }, [user, route, routeKey, resolution?.key, missingRouteKey, pathname]);

  /**
   * A project on its own opens its first document, so `/project` is a shareable
   * "start here" rather than a dead end. A project with no papers stays put and
   * shows the empty reader.
   */
  useEffect(() => {
    if (route?.kind !== "project" || !project) return;
    // The first document still in the working set — falling back to
    // papers[0] only when every paper is archived, so an all-done project
    // still opens something.
    const first = project.papers.find((item) => !isDone(item)) ?? project.papers[0];
    if (!first) return;
    router.replace(
      pathTo(
        { projectId: project.id, paperId: first.id },
      ),
    );
  }, [route, project, router, pathTo]);

  /** A rename retires the old mapping immediately; replace it with the new one. */
  useEffect(() => {
    if (!user || !project) return;
    // The project-route effect above is opening its first paper. Do not race
    // that navigation by replacing the address with the project route again.
    if (!paper && project.papers.length) return;
    const canonicalPath = paper
      ? documentPath(user.username, project, paper, {
          chat: chatOpen ? chatParam(chatContext) : undefined,
        })
      : projectPath(user.username, project);
    // A library-hit deep link (`focusPage`/`focusSection`, set by
    // `libraryHitPath`) is not part of what makes an address canonical the
    // way `chat=project` is — a renamed document still owns the page it
    // pointed at — so this only ever carries it through, never generates or
    // drops it. Without this, this effect stripped it on the very next
    // render, racing the effect that reads it and erasing the jump before it
    // ran.
    const focusPage = searchParams.get("focusPage");
    const focusSection = searchParams.get("focusSection");
    const focusBox = focusPage ? searchParams.get("focusBox") : null;
    const focusQuery = focusPage
      ? `focusPage=${encodeURIComponent(focusPage)}${focusBox ? `&focusBox=${encodeURIComponent(focusBox)}` : ""}`
      : focusSection
        ? `focusSection=${encodeURIComponent(focusSection)}`
        : "";
    // The open conversation is carried the same way: a Dashboard or search link
    // names one exactly, and dropping it here opened the context's default.
    const withFocus = focusQuery
      ? `${canonicalPath}${canonicalPath.includes("?") ? "&" : "?"}${focusQuery}`
      : canonicalPath;
    const canonical = withConversation(withFocus, chatOpen ? searchParams.get("conversation") : null);
    if (canonical !== `${pathname}${search}`) router.replace(canonical);
  }, [
    user,
    project,
    paper,
    pathname,
    search,
    router,
    chatContext,
    chatOpen,
    searchParams,
  ]);


  /**
   * Every move clears the citation highlight, except the citation jump that just
   * asked for one.
   *
   * Written as one watcher on the address rather than as a reset inside each way
   * of opening a document — which is exactly how the old code ended up with two
   * paths that forgot. A new way to navigate cannot miss this.
   */
  useEffect(() => {
    if (citationJump.current === `${pathname}${search}`) {
      citationJump.current = null;
      return;
    }
    citationJump.current = null;
    setPdfFocus(null);
    setPageFocus(null);
  }, [pathname, search]);

  useEffect(
    () => () => {
      if (panelAnimationTimerRef.current !== null) {
        window.clearTimeout(panelAnimationTimerRef.current);
      }
    },
    [],
  );

  /**
   * A narrow window opens onto the rail.
   *
   * Only the arrival at a narrow width closes the library — leaving it open on
   * the way back out would fight a reader who deliberately collapsed it, and
   * the rail is one click from the full panel either way. `apply` therefore
   * runs on mount and on a crossing, never on a library state change. Its
   * animation callback is stable, so opening the library while narrow does
   * not re-subscribe and slam the panel shut again.
   */
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${COMPACT_WIDTH - 1}px)`);
    const apply = () => {
      if (!query.matches) return;
      beginPanelAnimation();
      setLibraryCollapsed(true);
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [beginPanelAnimation]);

  /**
   * A window that shrinks must not leave the columns summing to more than it.
   *
   * The dividers already refuse to drag past this, but a drag is not the only
   * way to get there: a chat panel widened at full screen is still that wide
   * when the window is dragged down to half of it.
   */
  useEffect(() => {
    const clampChat = () => {
      setViewportWidth(window.innerWidth);
      // Expanded libraries occupy their own column at every window width.
      const sidebar = libraryCollapsed ? RAIL_COLUMN : libraryWidth;
      const available = window.innerWidth - sidebar - READER_CHROME_WIDTH - MIN_READER_COLUMN;
      /* Both remembered widths, not only the one on screen: the other is what
         the column will jump to the next time a chat opens or closes, and a
         width the window can no longer hold has to be clamped before then. */
      const clamp = (width: number) =>
        Math.max(MIN_CHAT_COLUMN, Math.min(
          chatWidthDragged.current ? width : window.innerWidth < COMPACT_WIDTH ? MIN_CHAT_COLUMN : defaultChatColumn(window.innerWidth),
          maxChatColumn(window.innerWidth), available,
        ));
      setChatColumnWidth(clamp);
      setRailColumnWidth((width) =>
        Math.max(
          MIN_MEMORY_COLUMN,
          Math.min(
            memoryWidthDragged.current ? width : defaultMemoryWidth(window.innerWidth),
            maxChatColumn(window.innerWidth),
            available,
          ),
        ),
      );
    };
    clampChat();
    let frame = 0;
    const resize = () => {
      // A window drag interrupts a toggle instead of chasing its transition.
      setLibraryAnimating(false);
      setChatAnimating(false);
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        clampChat();
      });
    };
    window.addEventListener("resize", resize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, [libraryCollapsed, libraryWidth]);

  useEffect(() => {
    const key = `${activeProjectId}:${activePaperId}`;
    if (annotationDocument.current !== key) {
      annotationDocument.current = key;
      setHighlights([]);
      setNotes([]);
      annotationDeletes.current = new Set();
    }
    setAnnotationLoadError("");
    if (!activePaperId || !activeProjectId) return;
    let active = true;
    const base = `/api/projects/${activeProjectId}/papers/${activePaperId}`;
    void Promise.all([api<Highlight[]>(`${base}/highlights`), api<Note[]>(`${base}/notes`)])
      .then(([marks, savedNotes]) => {
        // A retry, or a read that lands after a write it raced, merges:
        // nothing on screen is undone and nothing deleted comes back.
        if (active) {
          setHighlights(current => mergeAnnotationRead(current, marks, h => h.id, annotationDeletes.current));
          setNotes(current => mergeAnnotationRead(current, savedNotes, n => n.highlightId, annotationDeletes.current));
        }
      }).catch(reason => {
        if (active) setAnnotationLoadError(reason instanceof Error ? reason.message : "Could not load annotations");
      });
    return () => { active = false; };
  }, [activePaperId, activeProjectId, annotationReload]);

  const [uploading, setUploading] = useState(false);
  const [processingDocumentName, setProcessingDocumentName] = useState("");
  // The store-this-PDF question, held open until the reader answers it. The
  // resolver is what lets `ensureStoredForAnnotation` read as one step rather
  // than splitting the note it was about to save across two callbacks.
  const [storePrompt, setStorePrompt] = useState<{
    title: string;
    resolve: (agreed: boolean) => void;
  } | null>(null);
  const [digestActivity, setDigestActivity] = useState<Record<string, DigestActivity>>({});
  /** The open document (`project:paper`) whose digest is shown; every open starts on the document. */
  const [digestView, setDigestView] = useState<string | null>(null);
  const digestViewRef = useRef(digestView);
  /** Papers whose digest finished while the reader was not looking at it. */
  const [digestLanded, setDigestLanded] = useState<ReadonlySet<string>>(() => new Set());
  const readerKey = activeProjectId && activePaperId ? `${activeProjectId}:${activePaperId}` : null;
  const digestShown = readerKey !== null && digestView === readerKey;
  useEffect(() => { digestViewRef.current = digestView; }, [digestView]);
  useEffect(() => setDigestView(null), [readerKey]);
  const documentButtonRef = useRef<HTMLButtonElement>(null);
  /** A paper's digest metadata as last heard, from a chat or from the digest itself. */
  const setPaperDigest = useCallback((paperId: string, digest: NonNullable<Paper["digest"]>) => {
    const projectId = readerLocationRef.current.projectId;
    setDetail((current) =>
      current?.id === projectId
        ? {
            ...current,
            papers: current.papers.map((item) =>
              item.id === paperId ? { ...item, digest } : item,
            ),
          }
        : current,
    );
  }, []);
  /** Back from the digest, focus on the toggle rather than lost with the pane. */
  const showDocument = useCallback(() => {
    setDigestView(null);
    documentButtonRef.current?.focus();
  }, []);
  // Find searches the document, so it brings the document back, synchronously:
  // the find field opens in this same event, before or after this listener.
  useEffect(() => {
    if (!digestShown) return;
    const find = () => flushSync(() => setDigestView(null));
    window.addEventListener("delphi-reader-find", find);
    return () => window.removeEventListener("delphi-reader-find", find);
  }, [digestShown]);
  /**
   * A digest that turns ready while the reader is not on it, however the news
   * arrives: a reload, a chat, or a build of our own. A paper first seen ready
   * has nothing to announce, and a failure it outlived is no longer news.
   */
  const digestStatusRef = useRef(new Map<string, string>());
  useEffect(() => {
    if (!detail) return;
    const landed: string[] = [];
    for (const item of detail.papers) {
      const status = item.digest?.status ?? "missing";
      const before = digestStatusRef.current.get(item.id);
      digestStatusRef.current.set(item.id, status);
      if (status === "ready" && before !== undefined && before !== "ready") landed.push(item.id);
    }
    if (!landed.length) return;
    const unseen = landed.filter((id) => digestViewRef.current !== `${detail.id}:${id}`);
    if (unseen.length) setDigestLanded((current) => new Set([...current, ...unseen]));
    setDigestActivity((current) =>
      landed.some((id) => current[id]?.status === "failed")
        ? Object.fromEntries(Object.entries(current).filter(([id, activity]) => !(landed.includes(id) && activity.status === "failed")))
        : current,
    );
  }, [detail]);
  const showReaderView = (view: ReaderView) => {
    if (!readerKey || !activePaperId) return;
    setDigestView(view === "digest" ? readerKey : null);
    if (view === "digest" && digestLanded.has(activePaperId)) {
      setDigestLanded((current) => {
        const next = new Set(current);
        next.delete(activePaperId);
        return next;
      });
    }
  };
  // An upload that only fits compressed, waiting on an answer. The project id
  // travels with it because the reader may switch projects while deciding.
  const [staged, setStaged] = useState<{
    projectId: string;
    upload: StagedUpload;
  } | null>(null);
  const [dropActive, setDropActive] = useState(false);
  // dragenter/dragleave fire for every element crossed, so count depth rather
  // than toggling, or the overlay flickers as the pointer moves.
  const dragDepth = useRef(0);
  // The same drag, seen from inside the reader frame. Drag events never cross a
  // frame boundary, so while a file is held over a web page the count above
  // hears nothing and this is the only witness; the frame reports over
  // postMessage instead. The backend capture bridge supplies these messages.
  const frameDrag = useRef(false);
  const dropSettle = useRef<number | null>(null);

  const startDigest = useCallback(
    async (projectId: string, paperId: string, force = false) => {
      setDigestActivity((current) => ({
        ...current,
        [paperId]: { status: "preparing", message: "Preparing research digest" },
      }));
      try {
        const response = await fetch(
          `${API_BASE}/api/projects/${projectId}/papers/${paperId}/digest/stream`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force }),
          },
        );
        if (!response.ok || !response.body) {
          throw new Error("Digest generation could not start");
        }
        let completed: DigestDetail | null = null;
        for await (const payload of readSseStream(response.body)) {
          if (payload.type === "progress") {
            setDigestActivity((current) => ({
              ...current,
              [paperId]: { status: "preparing", message: describeModelWait(String(payload.message ?? "")) },
            }));
          }
          if (payload.type === "done") {
            completed = {
              paper: payload.paper as Paper,
              digest: (payload.digest as ResearchDigest | undefined) ?? null,
            };
          }
          if (payload.type === "error") throw new Error(payload.message);
        }
        if (!completed) throw new Error("Digest generation ended without a result");
        if (digestViewRef.current !== `${projectId}:${paperId}`) {
          setDigestLanded((current) => new Set(current).add(paperId));
        }
        // A completed background build refreshes one cache entry. It must never
        // navigate or replace the detail for a project the reader has since left.
        if (readerLocationRef.current.projectId === projectId) {
          setDetail((current) =>
            current?.id === projectId
              ? {
                  ...current,
                  papers: current.papers.map((item) =>
                    item.id === paperId ? completed!.paper : item,
                  ),
                }
              : current,
          );
        }
        setDigestActivity((current) => {
          const next = { ...current };
          delete next[paperId];
          return next;
        });
        return completed;
      } catch (error) {
        setDigestActivity((current) => ({
          ...current,
          [paperId]: {
            status: "failed",
            message:
              error instanceof Error ? error.message : "Digest generation failed",
          },
        }));
        return null;
      }
    },
    [],
  );

  const validatePdf = useCallback(
    (file: File) => {
      if (!isPdfFile(file)) {
        setNotice(hint("Delphi reads PDFs or webpages — that file is not one."));
        return false;
      }
      // Fail fast only above what the server would refuse outright. Between
      // the two limits it is worth sending: the server compresses it and comes
      // back with what it would cost to keep.
      if (file.size > config.maxUploadSourceMb * 1024 * 1024) {
        const megabytes = (file.size / (1024 * 1024)).toFixed(1);
        setNotice(
          `That PDF is ${megabytes} MB, too large to compress under the ${config.maxUploadMb} MB limit.`,
        );
        return false;
      }
      return true;
    },
    [config.maxUploadMb, config.maxUploadSourceMb],
  );

  const uploadPaperToProject = useCallback(
    async (file: File, destination: Project) => {
      const form = new FormData();
      form.append("file", file);
      setUploading(true);
      setProcessingDocumentName(file.name);
      try {
        const result = await api<UploadResult>(
          `/api/projects/${destination.id}/papers`,
          { method: "POST", body: form },
        );
        if (isStagedUpload(result)) {
          // Its bytes are already stored; nothing is in the project until the
          // reader answers, and turning it down deletes them.
          setStaged({ projectId: destination.id, upload: result });
          return result;
        }
        void startDigest(destination.id, result.id);
        // Importing is what files a document: the job is already queued.
        fileDocument();
        return result;
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Upload failed");
        throw error;
      } finally {
        setUploading(false);
        setProcessingDocumentName("");
      }
    },
    [startDigest],
  );

  const uploadPaper = useCallback(
    async (file?: File) => {
      if (!file || !validatePdf(file)) return;
      if (!project) {
        if (!projects.length) {
          setSetupSeed({ files: [file], urls: [] });
          setCreateProjectOpen(true);
        }
        return;
      }
      try {
        await uploadPaperToProject(file, project);
        await reload();
      } catch {
        // uploadPaperToProject already gave the reader the actionable error.
      }
    },
    [project, projects.length, reload, uploadPaperToProject, validatePdf],
  );

  const discardStaged = useCallback(async () => {
    if (!staged) return;
    setStaged(null);
    const { projectId, upload } = staged;
    try {
      await api(
        `/api/projects/${projectId}/papers/staged?token=${encodeURIComponent(upload.token)}`,
        { method: "DELETE" },
      );
    } catch {
      // The paper never joined the project, so there is nothing to tell the
      // reader about; the bytes are the server's problem from here.
    }
  }, [staged]);

  const keepStaged = useCallback(async () => {
    if (!staged) return;
    const { projectId, upload } = staged;
    setStaged(null);
    try {
      const kept = await api<Paper>(`/api/projects/${projectId}/papers/staged`, {
        method: "POST",
        body: JSON.stringify({ token: upload.token }),
      });
      await reload();
      void startDigest(projectId, kept.id);
      fileDocument();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Upload failed");
    }
  }, [reload, staged, startDigest]);

  // A reader who closes the tab mid-decision would otherwise leave stored bytes
  // no record ever points at. `keepalive` is what lets the request outlive the
  // page; it is best effort by design, not a guarantee.
  useEffect(() => {
    if (!staged) return;
    const drop = () => {
      const url = `${API_BASE}/api/projects/${staged.projectId}/papers/staged?token=${encodeURIComponent(staged.upload.token)}`;
      void fetch(url, {
        method: "DELETE",
        credentials: "include",
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener("pagehide", drop);
    return () => window.removeEventListener("pagehide", drop);
  }, [staged]);

  /**
   * Show or hide the drop overlay from whatever the two witnesses now say.
   *
   * Hiding waits a beat because the pointer crossing into or out of the reader
   * frame is a handoff between two documents: one of them reports the drag
   * ending a moment before the other reports it beginning, and taken at face
   * value that reads as the file having left the window. Showing is immediate —
   * nothing is waiting on it.
   */
  const paintDrop = useCallback(() => {
    if (dropSettle.current !== null) {
      window.clearTimeout(dropSettle.current);
      dropSettle.current = null;
    }
    if (dragDepth.current > 0 || frameDrag.current) {
      setDropActive(true);
      return;
    }
    dropSettle.current = window.setTimeout(() => {
      dropSettle.current = null;
      setDropActive(false);
    }, DROP_SETTLE_MS);
  }, []);

  /** A file crossed into, or out of, the reader frame's own document. */
  const frameDragged = useCallback(
    (over: boolean) => {
      frameDrag.current = over;
      // The pointer is inside the frame, so this document has no live drag left
      // to count. Saying so keeps an unbalanced enter/leave pair at the frame
      // boundary from pinning the overlay open for the rest of the session.
      if (over) dragDepth.current = 0;
      paintDrop();
    },
    [paintDrop],
  );

  const frameDropped = useCallback(
    async (file: File) => {
      frameDrag.current = false;
      dragDepth.current = 0;
      paintDrop();
      // The overlay normally takes the drop before the frame can (see
      // `.drop-overlay`). One released in the instant before it paints lands
      // in the frame, whose process alone may read the file: probe a byte, so
      // the reader hears what to do instead of the upload's "Failed to fetch".
      try {
        await file.slice(0, 1).arrayBuffer();
      } catch {
        setNotice(hint("Couldn't read that file here — drop it again once the window dims."));
        return;
      }
      void uploadPaper(file);
    },
    [paintDrop, uploadPaper],
  );

  // Accept a PDF dropped on the page. Without preventDefault the browser
  // navigates away to render the file, which drops the reader out of Delphi
  // entirely. Nested surfaces claim a drag before it reaches here: the
  // floating composer and its backdrop own every file while they cover the
  // page (images attach, a PDF is swallowed), and the docked composer claims
  // images only so a PDF over the rail still lands as a library add. The
  // overlay is a paper cue, not an "any file" cue, because it paints as soon
  // as a PDF enters the window.
  useEffect(() => {
    const onEnter = (event: DragEvent) => {
      // A project's setup takes its own drops; the overlay would sit on top
      // of it and add the file behind the setup's back.
      if (setupOpenRef.current) return;
      if (!carriesFiles(event) || !carriesPdf(event)) return;
      dragDepth.current += 1;
      // Symmetrically with `frameDragged`: the pointer is in this document, so
      // whatever the frame last said is stale.
      frameDrag.current = false;
      paintDrop();
    };
    const onOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (event: DragEvent) => {
      if (!carriesFiles(event) || !carriesPdf(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      paintDrop();
    };
    const onDrop = (event: DragEvent) => {
      if (setupOpenRef.current || !carriesFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      frameDrag.current = false;
      paintDrop();
      void uploadPaper(event.dataTransfer?.files?.[0]);
    };
    // The drag was abandoned — dropped on something that would not take it, or
    // cancelled outright. No leave necessarily follows, so the overlay would
    // otherwise stay up over nothing.
    const onEnd = () => {
      dragDepth.current = 0;
      frameDrag.current = false;
      paintDrop();
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", onEnd);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", onEnd);
    };
  }, [paintDrop, uploadPaper]);

  useEffect(
    () => () => {
      if (dropSettle.current !== null) window.clearTimeout(dropSettle.current);
    },
    [],
  );

  /**
   * The collapse itself, without a DOM event to inspect. The web reader calls
   * this directly: its clicks happen inside a cross-origin frame and never
   * surface as events here. Declared above the auth early-returns because hook
   * order has to hold on every render.
   */
  const setZoomFor = useCallback((paperId: string, scale: number) => {
    setZoomByPaper((current) => ({ ...current, [paperId]: clampZoom(scale) }));
  }, []);

  useEffect(() => {
    if (!paper) return;
    const change = (event: Event) => {
      const direction = zoomDirection(event);
      if (direction === null || chatOwnsZoom()) return;
      // While the digest is shown the keys size its text, never the document hidden under it.
      if (digestViewRef.current) { stepDigestZoom(direction); return; }
      // A web page's own viewer answers for it.
      if (isWebPaper(paper) && !isWebPdf(paper)) return;
      setZoomByPaper(current => ({ ...current, [paper.id]: direction === 0 ? ZOOM_MIN : clampZoom((current[paper.id] ?? ZOOM_MIN) + direction * ZOOM_STEP) }));
    };
    window.addEventListener("delphi-page-zoom", change);
    return () => window.removeEventListener("delphi-page-zoom", change);
  }, [paper, stepDigestZoom]);

  const addPageToProject = useCallback(
    async (
      destinationProjectId: string,
      url: string,
      pdfMode: "ask" | "web" | "upload" = "ask",
    ) => {
      const documentName = hostOf(url);
      setProcessingDocumentName(documentName);
      try {
        const created = await api<UploadResult>(
          `/api/projects/${destinationProjectId}/pages`,
          {
            method: "POST",
            body: JSON.stringify({ url, pdf_mode: pdfMode }),
          },
        );
        // Added at its first window; the reader waits on the rest (`PageViewer`'s reading state).
        if (!isStagedUpload(created) && created.capture === "partial") requestCaptures();
        return created;
      } finally {
        setProcessingDocumentName("");
      }
    },
    [],
  );

  /** Add a URL and open it. PDF links may stay remote or use the upload path. */
  const addPage = useCallback(
    async (url: string, pdfMode: "ask" | "web" | "upload" = "ask") => {
      if (!activeProjectId) return;
      const destinationProjectId = activeProjectId;
      const startedAt = readerLocationRef.current.path;
      const created = await addPageToProject(
        destinationProjectId,
        url,
        pdfMode,
      );
      if (isStagedUpload(created)) {
        setStaged({ projectId: destinationProjectId, upload: created });
        return;
      }
      // This is a direct user gesture. Navigate before the library refresh so
      // the new web page opens immediately, just like a newly uploaded PDF;
      // waiting for reload made the route guard observe a changed cache path
      // and left the reader on the old document.
      if (readerLocationRef.current.path !== startedAt) return;
      if (
        user &&
        project?.id === destinationProjectId
      ) {
        router.push(documentPath(user.username, project, created));
      }
      await reload();
      if (!isWebPaper(created)) void startDigest(destinationProjectId, created.id);
      fileDocument();
    },
    [
      activeProjectId,
      addPageToProject,
      reload,
      router,
      user,
      project,
      startDigest,
    ],
  );

  const saveViewport = useCallback(
    async (viewport: ChatViewport, destinationProjectId: string) => {
      if (!user) return false;
      if (viewport.kind === "image") {
        setNotice(hint("Images can be read and asked about, but cannot be saved as documents yet."));
        return false;
      }
      try {
        const created = await addPageToProject(destinationProjectId, viewport.url);
        if (isStagedUpload(created)) return false;
        await reload();
        fileDocument();
        const destination = await api<Project>(`/api/projects/${destinationProjectId}`);
        router.push(documentPath(user.username, destination, created));
        return true;
      } catch (reason) {
        setNotice(reason instanceof Error ? reason.message : "Could not save this page");
        return false;
      }
    },
    [addPageToProject, reload, router, user],
  );

  /**
   * Move the library, announcing the gesture before the DOM starts moving.
   *
   * The announcement carries how much width the reader is about to *gain*,
   * which is what lets a framed web page hold a single layout for the whole
   * animation rather than being re-laid-out on every frame of it — the reader
   * column is the flexible one, so it absorbs the whole difference. Sent
   * synchronously, ahead of the state change, so the frame is measured as it
   * still is. See `PageViewer`.
   */
  const moveLibrary = useCallback(
    (collapsed: boolean) => {
      if (collapsed === libraryCollapsed) return;
      window.dispatchEvent(
        new CustomEvent("delphi-panel-resize-start", {
          detail: {
            grow: collapsed ? Math.max(0, visibleLibraryWidth - RAIL_COLUMN) : 0,
          },
        }),
      );
      // Restart the settle boundary on reversals as well as compact entry.
      beginPanelAnimation(true);
      setLibraryCollapsed(collapsed);
    },
    [libraryCollapsed, visibleLibraryWidth, beginPanelAnimation],
  );

  const collapseForReadingNow = useCallback(() => {
    moveLibrary(true);
  }, [moveLibrary]);

  /* Where the docked card sits, kept out here for the same reason: the panel
     that has to collapse back into it may not be the one that measured it. */
  const chatDockedBoxRef = useRef<DOMRect | null>(null);
  const openMemoryPage = useCallback(
    (slug: string) => router.push(`/memory?page=${encodeURIComponent(slug)}`),
    [router],
  );

  if (checkingAuth) return <LoadingScreen />;
  if (!user) {
    return <main className="loading-screen"><p className="loading-status" role="alert">Local session unavailable. Quit and reopen Delphi to reconnect.</p></main>;
  }

  /**
   * Opening something is a navigation now, and that is the entire mechanism.
   *
   * Three functions used to do this — one per entry point — and each kept its own
   * slightly different idea of what to reset. Two of them forgot the citation
   * trail, which is how a "Back to X" pill could survive into a project that did
   * not contain X and then hand the viewers a paper id that 404s. There is one
   * way in now, so there is nothing left to forget.
   */
  const openDocument = (
    ids: { projectId: string; paperId?: string | null },
    chat: ChatContext | null = chatOpen ? chatContext : null,
  ) => {
    setLibraryTab("papers");
    setSettingsOpen(false);
    // Choosing a document is not following a citation, so the way back is no
    // longer the way the reader came. `openCitation` pushes on its own and is
    // deliberately not routed through here.
    setTrail(clearTrail);
    router.push(pathTo(ids, chat));
  };

  const selectProject = (id: string) => {
    openDocument({ projectId: id });
  };

  const deleteProject = async (id: string) => {
    await api(`/api/projects/${id}`, { method: "DELETE" });
    const next = projects.find((item) => item.id !== id) ?? null;
    await refreshProjects();
    if (routeProjectId === id) {
      setDetail(null);
      setTrail(clearTrail);
      router.push(next ? projectPath(user.username, next) : "/");
      return;
    }
    await reloadDetail();
  };

  /**
   * Delete a document. Standing on it, the reader moves on to the project's
   * first remaining document, the one the project route itself would open,
   * rather than staying on an address that names nothing.
   */
  const deletePaper = async (projectId: string, paperId: string) => {
    await api(`/api/projects/${projectId}/papers/${paperId}`, { method: "DELETE" });
    if (routeProjectId !== projectId || routePaperId !== paperId) {
      await reload();
      return;
    }
    const [loaded] = await Promise.all([
      api<Project>(`/api/projects/${projectId}`),
      refreshProjects(),
    ]);
    // The reader may have moved on while the delete was in flight; the list
    // they are on may still have been read with the document in it.
    if (readerLocationRef.current.paperId !== paperId) {
      await reloadDetail();
      return;
    }
    const next = loaded.papers.find((item) => !isDone(item)) ?? loaded.papers[0];
    setDetail(loaded);
    setTrail(clearTrail);
    // A docked chat stays docked, as it does when choosing a document.
    router.replace(
      next
        ? documentPath(user.username, loaded, next, { chat: chatOpen ? chatParam(chatContext) : undefined })
        : projectPath(user.username, loaded),
    );
  };

  /**
   * File a paper into a different project.
   *
   * The reader is very often standing on the paper being moved, and its address
   * contains the project it just left — so the navigation is part of the move,
   * not a follow-up. Everything else about the document (digest, highlights,
   * chat) travels server-side; learner notes deliberately do not.
   */
  const movePaper = async (
    fromProjectId: string,
    paperId: string,
    toProjectId: string,
    // Omitted by the picker, which has no opinion about where it lands; sent by
    // the drag, which showed the reader a gap and has to honour it.
    position?: number,
  ) => {
    const moved = await api<Project>(
      `/api/projects/${fromProjectId}/papers/${paperId}/move`,
      {
        method: "POST",
        body: JSON.stringify({ project_id: toProjectId, position }),
      },
    );
    await refreshProjects();
    const landed = moved.papers.find((item) => item.id === paperId);
    // Only follow the paper if the reader was actually on it. Moving one out of
    // the list they are reading should not drag them away from their page.
    if (landed && routePaperId === paperId) {
      setDetail(moved);
      setTrail(clearTrail);
      router.push(documentPath(user.username, moved, landed));
      return;
    }
    await reloadDetail();
  };

  const openPaper = async (projectId: string, paperId: string) => {
    const loaded =
      detail?.id === projectId
        ? detail
        : await api<Project>(`/api/projects/${projectId}`);
    const target = loaded.papers.find((item) => item.id === paperId);
    if (!target) return;
    setTrail(clearTrail);
    router.push(documentPath(user.username, loaded, target));
  };

  /** Follow a citation from the chat into the document it points at. */
  const openCitation = (
    target: CitationTarget,
    cited: Paper,
    hit: LocatorHit | null = null,
  ) => {
    setDigestView(null);
    focusNonce.current += 1;
    // Set before navigating, not after: the jump is a round trip now, and both
    // viewers already ignore a focus whose `paperId` is not the one on screen,
    // so it simply waits for its document to arrive.
    if (isWebPaper(cited) && !isWebPdf(cited)) {
      setPdfFocus(null);
      setPageFocus({
        paperId: cited.id,
        anchor: target.anchor,
        // The locator doubles as the phrase to point at once the section is on
        // screen, mirroring how a PDF jump highlights "Table 1" on its page.
        quote: target.locator?.label ?? null,
        nonce: focusNonce.current,
      });
    } else {
      const linkedPage = isWebPdf(cited)
        ? Number(/^page-(\d+)$/.exec(target.anchor ?? "")?.[1]) || 1
        : 1;
      setPageFocus(null);
      setPdfFocus({
        paperId: cited.id,
        // The resolved page wins over the cited one: a caption is on the last
        // page of "pp. 5–6" as often as the first.
        page: hit?.page ?? target.pages[0] ?? linkedPage,
        rect: hit?.rect ?? null,
        nonce: focusNonce.current,
      });
    }
    if (!project || !user || cited.id === paper?.id) return;

    // A Memory conversation reads on across documents, so the jump keeps it
    // open; a Project conversation stays with the document it was asked beside.
    // Its library is the account's, so the document may be in another project,
    // whose route the citation carries (`DashboardDocument`).
    const elsewhere = cited as Partial<DashboardDocument>;
    const destination = withConversation(
      elsewhere.projectSlug && elsewhere.projectId !== project.id
        ? documentPath(user.username, { slug: elsewhere.projectSlug }, cited, {
            chat: chatOpen ? chatParam(chatContext) : undefined,
          })
        : pathTo({ projectId: project.id, paperId: cited.id }),
      chatOpen && chatContext !== "document" ? searchParams.get("conversation") : null,
    );
    // Tell the navigation watcher this one is deliberate, so it leaves the focus
    // just set alone instead of clearing it as it does for every other move.
    citationJump.current = destination;
    if (paper) {
      setTrail((current) =>
        pushTrail(
          current,
          {
            path: `${pathname}${search}`,
            title: paper.title,
            projectId: project.id,
            paperId: paper.id,
          },
          destination,
        ),
      );
    }
    router.push(destination);
  };

  const openEvidenceCitation = async (
    target: CitationTarget,
    cited: Paper,
    evidence: ViewportEvidence,
    hit: LocatorHit | null = null,
  ) => {
    // A citation with captured evidence can still point into a PDF — and when
    // it does, the coordinate resolved for it must survive the detour. A linked
    // PDF counts: it carries the web document's contract but is drawn by
    // `PdfViewer`, so sending it down the captured-viewport path would hand a
    // page coordinate to a renderer that is not on screen.
    if (!project || cited.id !== paper?.id || !isWebPaper(cited) || isWebPdf(cited)) {
      openCitation(target, cited, hit);
      return;
    }
    try {
      const captured = await api<EvidenceViewport>(
        `/api/projects/${project.id}/papers/${cited.id}/evidence/${evidence.evidenceId}`,
      );
      const passage = evidencePassageQuote(captured, cited.url, target.anchor);
      setDigestView(null);
      if (passage) {
        setPdfFocus(null);
        setPageFocus({ paperId: cited.id, anchor: null, ...passage, nonce: ++focusNonce.current });
        return;
      }
      pageViewerRef.current?.openEvidence({ ...captured, evidenceId: evidence.evidenceId }, {
        anchor: target.anchor,
        quote: target.locator?.label ?? null,
        nonce: ++focusNonce.current,
      });
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Could not reopen citation evidence");
    }
  };

  /**
   * Clicking into the reader means the reader is reading, so the library gets
   * out of the way. Only ever collapses — clicking around while collapsed
   * should not make the panel reappear underneath the pointer.
   */
  const collapseForReading = (event: ReactMouseEvent<HTMLElement>) => {
    if (libraryCollapsed || !paper) return;
    // Leave controls alone, and never interrupt a selection in progress. The
    // annotations list and a note card are the reader working with their notes,
    // not reading on: folding the library there reflows the page under the
    // passage the reader just asked to be taken to.
    if (
      (event.target as HTMLElement).closest(
        "button, a, input, select, textarea, summary, [role='button'], .reader-menu, .selection-menu, .annotations-panel, .note-card",
      )
    ) {
      return;
    }
    if (window.getSelection()?.toString().trim()) return;
    moveLibrary(true);
  };

  /**
   * Switch between this document's thread and the project's.
   *
   * `replace`, not `push`: Back should return to the previous *document*, not
   * undo a toggle. The path is untouched — the reader keeps reading whatever is
   * open while asking across the whole project, which is the point. A chat
   * picked from the other context's list opens with it.
   */
  const setChatScope = (next: ChatContext, conversation?: string) => {
    if (!project) return;
    router.replace(withConversation(
      pathTo({ projectId: project.id, paperId: paper?.id ?? null }, next),
      conversation ?? null,
    ));
  };

  /** Walk one step back along the trail of citation jumps. */
  const returnFromCitation = () => {
    const { to, rest } = popTrail(visibleTrail);
    if (!to) return;
    setTrail(rest);
    const target = project?.papers.find((item) => item.id === to.paperId);
    if (user && project && target) {
      const query = new URLSearchParams(to.path.split("?")[1] ?? "");
      router.push(
        withConversation(
          documentPath(user.username, project, target, {
            chat: query.get("chat") === "project" ? "project" : "paper",
          }),
          query.get("chat") === "project" ? query.get("conversation") : null,
        ),
      );
      return;
    }
    router.push(to.path);
  };

  const selectPaper = (nextPaper: Paper) => {
    if (!project) return;
    // A library paper click is an explicit return to the document's bounded
    // context. This includes the paper already open: otherwise its rail chip
    // silently leaves Project mode enabled after the library has collapsed.
    // Choosing a document is a return to reading. Whatever conversation was
    // docked belonged to the document being left, so it does not follow.
    openDocument({ projectId: project.id, paperId: nextPaper.id }, null);
  };

  const addHighlight = async (selection: Omit<Highlight, "id" | "color">) => {
    if (!project || !paper) return null;
    // A highlight on a linked PDF is as durable as the address it was drawn
    // against, so nothing is written until a copy is stored. Returning null
    // also stops `startNote` opening a card over a stroke that does not exist.
    if (!(await ensureStoredForAnnotation())) return null;
    const created = await api<Highlight>(
      `/api/projects/${project.id}/papers/${paper.id}/highlights`,
      {
        method: "POST",
        body: JSON.stringify({ ...selection, color: "amber" }),
      },
    );
    if (readerLocationRef.current.projectId === project.id && readerLocationRef.current.paperId === paper.id) setHighlights((items) => [...items.filter(item => item.id !== created.id), created]);
    // Returned as well as stored: the Note button needs the id of the stroke it
    // just minted in order to anchor a note to it.
    return created;
  };

  const removeHighlight = async (highlightId: string) => {
    if (!project || !paper) return;
    await api(
      `/api/projects/${project.id}/papers/${paper.id}/highlights/${highlightId}`,
      { method: "DELETE" },
    );
    if (readerLocationRef.current.projectId !== project.id || readerLocationRef.current.paperId !== paper.id) return;
    annotationDeletes.current.add(highlightId);
    annotationDrafts.delete(highlightId);
    setHighlights((items) => items.filter((item) => item.id !== highlightId));
    // The server cascades this; mirroring it here keeps the gutter from drawing
    // an icon for a note whose stroke has already gone.
    setNotes((items) => items.filter((item) => item.highlightId !== highlightId));
  };

  /**
   * A linked PDF has no bytes here — it is re-fetched from its source on every
   * open — so an annotation against one would be a mark on a document Delphi
   * does not hold, one broken link from being unreadable.
   *
   * So this gates the annotation rather than merely advising: nothing is
   * written unless the copy was actually stored. A highlight that survived a
   * declined download would be exactly the fragile mark the question was asked
   * to prevent, and the reader would have no way of knowing which of their
   * marks were which.
   */
  const ensureStoredForAnnotation = async () => {
    if (!project || !paper || !isWebPdf(paper)) return true;
    const pages = paper.pages ?? 0;
    if (pages > config.maxPagesPerPaper) {
      // Answered from the record, before anything is fetched.
      setNotice(
        `“${paper.title}” has ${pages} pages, over Delphi's ${config.maxPagesPerPaper}-page limit, so it cannot be stored or annotated.`,
      );
      return false;
    }
    const agreed = await new Promise<boolean>((resolve) =>
      setStorePrompt({ title: paper.title, resolve }),
    );
    setStorePrompt(null);
    if (!agreed) return false;
    setProcessingDocumentName(paper.title);
    try {
      await api<Paper>(`/api/projects/${project.id}/papers/${paper.id}/store`, {
        method: "POST",
      });
      // Stored in place under the same id: its sections are now a PDF's pages.
      forgetProjectAnchors(project.id);
      // The record changed kind, so the cached project has to be re-read before
      // anything decides which viewer this document belongs in.
      await reload();
      return true;
    } catch (reason) {
      setNotice(
        reason instanceof Error ? reason.message : "Could not store this PDF",
      );
      return false;
    } finally {
      setProcessingDocumentName("");
    }
  };

  const saveNote = async (note: {
    highlightId: string;
    page: number | null;
    anchorY: number | null;
    quotedText: string;
    body: string;
  }) => {
    if (!project || !paper) throw new Error("No document is open");
    if (!(await ensureStoredForAnnotation())) throw new Error("Save cancelled. Your draft is still open.");
    try {
      const saved = await api<Note>(
        `/api/projects/${project.id}/papers/${paper.id}/notes`,
        { method: "POST", body: JSON.stringify(note) },
      );
      if (readerLocationRef.current.projectId !== project.id || readerLocationRef.current.paperId !== paper.id) return;
      // One note per anchor, so a save is an upsert on both sides.
      setNotes((items) => [
        ...items.filter((item) => item.highlightId !== saved.highlightId),
        saved,
      ]);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Could not save that note");
      throw reason;
    }
  };


  const constrainLibraryWidth = (nextWidth: number) => {
    const available = window.innerWidth - chatWidth - READER_CHROME_WIDTH - MIN_READER_COLUMN;
    return Math.max(
      RAIL_COLUMN,
      Math.min(Math.max(MIN_LIBRARY_COLUMN, nextWidth), MAX_LIBRARY_COLUMN, available),
    );
  };

  const constrainChatWidth = (nextWidth: number) => {
    // The expanded library and both dividers also consume reader space.
    const sidebar = libraryCollapsed ? RAIL_COLUMN : visibleLibraryWidth;
    const available = window.innerWidth - sidebar - READER_CHROME_WIDTH - MIN_READER_COLUMN;
    const ceiling = sideColumn
      ? sideColumnCeiling(maxChatColumn(window.innerWidth), window.innerWidth)
      : maxChatColumn(window.innerWidth);
    return Math.max(
      chatDocked ? MIN_CHAT_COLUMN : MIN_MEMORY_COLUMN,
      Math.min(nextWidth, ceiling, available),
    );
  };

  /** The digest's text size, in the reader's menu while the digest is shown. */
  const digestZoomControl = (
    <ReaderMenuZoom
      value={digestZoom}
      canOut={digestZoom > PAGE_ZOOM_STEPS[0]}
      canIn={digestZoom < PAGE_ZOOM_STEPS[PAGE_ZOOM_STEPS.length - 1]}
      onOut={() => stepDigestZoom(-1)}
      onIn={() => stepDigestZoom(1)}
      onReset={() => stepDigestZoom(0)}
      labels={{ out: "Smaller digest text (⌘−)", in: "Larger digest text (⌘+)", reset: "Reset digest text to 100%" }}
    />
  );

  return (
    <main className="workspace">
      {/* No `center`: the reader gets no search field. What Delphi searches
          from the bar is the whole wiki, and a control whose scope is wider
          than the panel it sits in has to sit somewhere that says so. */}
      {/* The reader is already the Reader, so the menu's own Reader entry
          points at where it is — the current document. */}
      <TopBar
        user={user}
        onOpenSettings={() => {
          setSettingsPane("projects");
          setSettingsOpen(true);
        }}
        actions={
          <AskDelphiButton
            docked={chatDocked}
            onOpen={() => {
              /* A conversation already docked answers the press itself: it
                 jiggles to say "I'm here" rather than being covered by a
                 composer. Close the chat to start a new one from the bar. */
              if (chatDocked) {
                setChatNudge((count) => count + 1);
                return;
              }
              setAskInitialContext(chatContext);
              setAskOpen(true);
            }}
          />
        }
      />
      <div
        className={[
          "three-panel",
          libraryCollapsed ? "library-collapsed" : "",
          panelAnimating ? "is-panel-animating" : "",
          libraryAnimating ? "is-library-animating" : "",
          chatAnimating ? "is-chat-animating" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={
          {
            // Opening the library always gives it a real column.
            "--library-width":
              libraryCollapsed
                ? `${RAIL_COLUMN}px`
                : `${visibleLibraryWidth}px`,
            "--chat-width": `${chatWidth}px`,
          } as CSSProperties
        }
      >
        <Library
          tab={libraryTab}
          setTab={setLibraryTab}
          projects={projects}
          project={project}
          paper={paper}
          maxPapers={config.maxPapersPerProject}
          uploading={uploading}
          onUpload={uploadPaper}
          onSelectProject={selectProject}
          onDeleteProject={deleteProject}
          onDeletePaper={deletePaper}
          onSelectPaper={selectPaper}
          onMovePaper={movePaper}
          onCreateProject={() => setCreateProjectOpen(true)}
          onAddWebpage={() => setAddDocumentOpen(true)}
          webEnabled={config.webDocumentsEnabled}
          memoryEnabled={config.memoryEnabled}
          onChanged={reload}
          onRenamed={() => void loadMemoryGraph()}
          collapsed={libraryCollapsed}
          onToggleCollapsed={() => moveLibrary(!libraryCollapsed)}
          onNotice={setNotice}
        />
        <PanelDivider
          side="left"
          cssVar="--library-width"
          label="Resize paper library"
          value={visibleLibraryWidth}
          min={Math.min(MIN_LIBRARY_COLUMN, libraryWidthLimit)}
          max={Math.min(MAX_LIBRARY_COLUMN, libraryWidthLimit)}
          constrain={constrainLibraryWidth}
          onChange={setLibraryWidth}
        />
        <section className="reader-panel" onClick={collapseForReading}
          style={project ? { "--project-color": projectAccent(project.id, projects) } as React.CSSProperties : undefined}>
          {project && paper ? (
            <>
              <div className="reader-heading">
                <div className="reader-heading-row">
                  <span className="eyebrow reader-project-label" title={project.name}>
                    <span>{project.name}</span>
                  </span>
                  <ReaderViewToggle
                    documentButton={documentButtonRef}
                    view={digestShown ? "digest" : "document"}
                    mark={digestMark(paper, digestActivity[paper.id], digestLanded.has(paper.id))}
                    onChange={showReaderView}
                  />
                  {/* A web page's menu is its viewer's, under the digest; the digest's zoom needs one here. */}
                  {digestShown && isWebPaper(paper) && !isWebPdf(paper) ? (
                    <span className="reader-heading-menu"><ReaderMenu>{digestZoomControl}</ReaderMenu></span>
                  ) : null}
                </div>
                {/* A webpage's title, actions and menu are its viewer's own row. */}
                {isWebPaper(paper) && !isWebPdf(paper) ? null : (
                  <div className="reader-title-row">
                    <h1>{pageTitle(paper.title)}</h1>
                    <div className="reader-actions">
                      {/* Hidden, never unmounted, under the digest: the PDF viewer portals its toolbar here. */}
                      <div className="reader-annotation-slot" ref={setAnnotationToolbar} hidden={digestShown} />
                      <ReaderMenu>
                        {digestShown ? digestZoomControl : (
                          <ReaderMenuZoom
                            value={Math.round((zoomByPaper[paper.id] ?? ZOOM_MIN) * 100)}
                            canOut={(zoomByPaper[paper.id] ?? ZOOM_MIN) > ZOOM_MIN}
                            canIn={(zoomByPaper[paper.id] ?? ZOOM_MIN) < ZOOM_MAX}
                            onOut={() => setZoomFor(paper.id, (zoomByPaper[paper.id] ?? ZOOM_MIN) - ZOOM_STEP)}
                            onIn={() => setZoomFor(paper.id, (zoomByPaper[paper.id] ?? ZOOM_MIN) + ZOOM_STEP)}
                            onReset={() => setZoomFor(paper.id, ZOOM_MIN)}
                            labels={{ out: "Zoom out", in: "Zoom in", reset: "Reset zoom" }}
                          />
                        )}
                        {/* A web document has no bytes of ours to hand back. The
                            annotated copy carries the highlights and their notes. */}
                        {isWebPaper(paper) ? null : <>
                          <ReaderMenuRule />
                          <ReaderMenuItem glyph="export" href={`${API_BASE}/api/projects/${project.id}/papers/${paper.id}/file?download=true${highlights.length ? "&annotated=true" : ""}`}>
                            {highlights.length ? "Export annotated PDF" : "Export PDF"}
                          </ReaderMenuItem>
                        </>}
                      </ReaderMenu>
                    </div>
                  </div>
                )}
              </div>
              {annotationLoadError ? <div role="alert">Annotations could not be loaded: {annotationLoadError} <button onClick={()=>setAnnotationReload(n=>n+1)}>Retry</button></div> : null}
              <div className="reader-stage">
              <div className={`reader-document${digestShown ? " is-covered" : ""}`}>
              {isWebPaper(paper) && !isWebPdf(paper) ? (
                <PageViewer
                  highlights={highlights}
                  notes={notes}
                  drafts={annotationDrafts}
                  onHighlight={addHighlight}
                  onRemoveHighlight={removeHighlight}
                  onSaveNote={saveNote}
                  ref={pageViewerRef}
                  key={`${project.id}:${paper.id}`}
                  projectId={project.id}
                  paperId={paper.id}
                  url={paper.url ?? ""}
                  title={pageTitle(paper.title)}
                  favicon={paper.favicon}
                  focus={pageFocus?.paperId === paper.id ? pageFocus : null}
                  browsingEnabled={config.webBrowsingEnabled}
                  savedPageMaxBytes={config.webSavedPageMaxBytes}
                  copy={paper.capture === "partial" ? "partial" : "whole"}
                  onEngage={collapseForReadingNow}
                  covered={digestShown}
                  onExternalAction={setBlockedLink}
                  onImportPdf={(href) => {
                    void addPage(href, "upload").catch((reason) =>
                      setNotice(reason instanceof Error ? reason.message : "Could not import PDF"),
                    );
                  }}
                  onSavePage={setSaveViewportTarget}
                  onHomeChange={setViewportOffHome}
                  // Drag events do not cross into a frame either, so the frame
                  // reports the ones it swallows and a PDF can be dropped on a
                  // web page exactly as it can be dropped on a paper.
                  onDrag={frameDragged}
                  onFileDrop={frameDropped}
                  onReply={reply}
                />
              ) : (
                <>
                  {isWebPdf(paper) ? (
                    <LinkedPdfSource url={paper.url ?? ""} />
                  ) : null}
                  <PdfViewer
                    key={`${project.id}:${paper.id}`}
                    projectId={project.id}
                    paperId={paper.id}
                    fileUrl={
                      isWebPdf(paper)
                        ? `${API_BASE}/api/projects/${project.id}/papers/${paper.id}/page`
                        : undefined
                    }
                    highlights={highlights}
                    notes={notes}
                    // Every document that reaches this viewer has stable page
                    // coordinates, including a linked PDF. HTML annotation
                    // placement belongs to PageViewer above.
                    notesEnabled
                    annotationToolbar={annotationToolbar}
                    drafts={annotationDrafts}
                    focus={pdfFocus?.paperId === paper.id ? pdfFocus : null}
                    zoom={zoomByPaper[paper.id] ?? ZOOM_MIN}
                    onHighlight={addHighlight}
                    onRemoveHighlight={removeHighlight}
                    onSaveNote={saveNote}
                    onEngage={collapseForReadingNow}
                    onReply={reply}
                  />
                </>
              )}
              </div>
              <DigestPane
                key={readerKey}
                projectId={project.id}
                paper={paper}
                documentHref={pathname}
                activity={digestActivity[paper.id]}
                pending={digestPending}
                shown={digestShown}
                onGenerate={(force) => startDigest(project.id, paper.id, force)}
                onShowDocument={showDocument}
                onStoredDigest={(digest) => setPaperDigest(paper.id, digest)}
                zoom={digestZoom}
              />
              </div>
              {visibleTrail.length ? (
                <button
                  className="return-to-paper"
                  onClick={returnFromCitation}
                  title={`Back to ${visibleTrail[visibleTrail.length - 1].title}`}
                >
                  <span className="return-to-paper-icon" aria-hidden="true">
                    ←
                  </span>
                  <span className="return-to-paper-label">
                    Back to {visibleTrail[visibleTrail.length - 1].title}
                  </span>
                </button>
              ) : null}
            </>
          ) : missing ? (
            // Kept inside the reader panel rather than replacing the page: the
            // library and the chat are still perfectly usable, and a dead end is
            // a worse answer than a wrong turn.
            <MissingDocument onGoHome={() => router.replace("/")} />
          ) : resolving || (routeKey && !project) ? (
            <ProjectLoading />
          ) : (
            <EmptyProject
              projectName={project?.name ?? null}
              onCreateProject={() => setCreateProjectOpen(true)}
              onAddDocuments={() => setSetupOpen(true)}
            />
          )}
        </section>
        <PanelDivider
          side="right"
          cssVar="--chat-width"
          label="Resize the Memory panel"
          value={chatWidth}
          min={chatDocked ? MIN_CHAT_COLUMN : MIN_MEMORY_COLUMN}
          max={sideColumn ? sideColumnCeiling(maxChatColumn(viewportWidth), viewportWidth) : maxChatColumn(viewportWidth)}
          constrain={constrainChatWidth}
          onChange={(width) => {
            if (sideColumn) {
              setChatWidth(width);
              return;
            }
            if (chatDocked) chatWidthDragged.current = true;
            else memoryWidthDragged.current = true;
            setChatWidth(width);
          }}
        />
        {/* The reader's right column. Chat is docked *above* Related
            Memory and pushes it down, rather than replacing it — the same
            arrangement the wiki uses, reproduced by DOM order rather than by a
            second mechanism. */}
        <aside className="reader-rail">
          {/* The composer and the docked chat never share the screen: while the
              composer is up the rail shows Related Memory only. */}
          {chatOpen && !askOpen ? (
            <ChatPanel
                /* Each scope mounts its own catalog and selected conversation.
                   Background answers continue in their shared sessions. */
                key={scopeKey(chatTarget)}
                project={project}
                paper={paper}
                context={chatContext}
                onContextChange={setChatScope}
                config={config}
                onNotice={setNotice}
                onCitation={openCitation}
                onEvidenceCitation={(target, cited, evidence, hit) =>
                  void openEvidenceCitation(target, cited, evidence, hit)
                }
                getViewport={(quote) => pageViewerRef.current?.getViewport(quote) ?? null}
                viewportOffHome={viewportOffHome}
                onOpenPage={openMemoryPage}
                seedQuestion={askSeed}
                seedRequestId={askRequestId}
                seedConversation={askConversation}
                seedPersonaId={draftPersonaId}
                seedChoice={askChoice}
                seedSelectedText={seedQuote}
                onSeedConsumed={() => {
                  setAskConversation(undefined);
                  setAskRequestId("");
                  setAskSeed("");
                  setSeedQuote("");
                  setAskChoice(undefined);
                }}
                seedImageIds={askImageIds}
                seedReferencedPaperIds={askReferenceIds}
                onClose={closeChat}
                onSideChatChange={onSideChatChange}
                leaving={chatClosing}
                nudge={chatNudge}
                onFullscreenChange={setChatFullscreen}
                /* Both survive the remount a scope switch performs: expanded
                   stays expanded when the reader changes the subject, and the
                   card still knows the box it has to collapse back into. */
                initialFullscreen={chatFullscreen}
                dockedBoxRef={chatDockedBoxRef}
                personas={personas}
                onManagePersonas={openPersonaSettings}
                onDigestStatus={setPaperDigest}
            />
          ) : null}
          {config.memoryEnabled && currentMemoryGraph ? (
            paperPage ? (
              <>
                {/* Above the rail, and pushed down by it, which is the same
                    arrangement the docked conversation uses (invariant 32c) —
                    DOM order rather than a second mechanism. */}
                <OutdatedPage filing={documentFiling} />
                <RelatedMemoryRail
                currentSlug={paperPage.slug}
                pages={currentMemoryGraph.pages}
                links={currentMemoryGraph.links}
                domains={currentMemoryGraph.domains}
                hops={config.memoryRelatedHops}
                distances={currentMemoryGraph.distances}
                /* With a conversation docked the rail is mostly transcript,
                   and the map would be squeezed into a strip too small to read
                   a neighbourhood from. The ordered list keeps working at any
                   height, so that is what stays — the same trade the wiki has
                   always made when its chat is open. */
                hideGraph={chatOpen && !askOpen && !chatClosing && !chatFullscreen}
                onOpen={(slug) =>
                  router.push(`/memory?page=${encodeURIComponent(slug)}`)
                }
                onWholeGraph={() => router.push("/memory/graph")}
                />
              </>
            ) : paper ? (
              <UnfiledDocument filing={documentFiling} onOpenPage={openMemoryPage} />
            ) : null
          ) : null}
        </aside>
      </div>
      {askOpen ? (
        <AskComposer
          initialContext={askInitialContext ?? chatContext}
          onSeeHistory={(context) => {
            setAskOpen(false);
            setAskQuote("");
            openChatFromComposer(context);
          }}
          quote={askQuote}
          contextOptions={availableContexts({
            inReader: true,
            hasPaper: Boolean(routePaperId),
          })}
          /* The same list the docked composer's `@` offers: active documents
             other than the one already open. What General does with it —
             nothing — is the composer's own rule. */
          papers={(project?.papers ?? []).filter(
            (item) => !isDone(item) && item.id !== paper?.id,
          )}
          targetFor={(context) =>
            context === "general"
              ? { context: "general" }
              : {
                  context: "document",
                  projectId: routeProjectId ?? "",
                  paperId: routePaperId ?? "",
                }
          }
          config={config}
          model={askModel || config.defaultModel}
          onModelChange={setAskModel}
          effort={askEffort || config.defaultReasoningEffort}
          onEffortChange={setAskEffort}
          personas={personas}
          personaId={draftPersonaId}
          onPersonaChange={setDraftPersonaId}
          onManagePersonas={openPersonaSettings}
          onClose={() => {
            setAskOpen(false);
            setAskQuote("");
          }}
          onNotice={setNotice}
          onSend={(draft: AskDraft) => {
            // The composer takes the question; the docked surface asks it. One
            // navigation carries both the context it was written in and the
            // fact that a conversation is now open.
            setAskConversation(draft.conversation);
            setAskRequestId(draft.requestId);
            setAskSeed(draft.prompt);
            // The composer's pill is the pick for the question it was written
            // with; the conversation's own pill takes over from there.
            setDraftPersonaId(draft.personaId);
            // And its mode, model, effort and web search, which the docked
            // surface would otherwise answer with its own pills.
            setAskChoice(draft.choice);
            setAskImageIds(draft.imageIds);
            setAskReferenceIds(draft.referencedPaperIds);
            setSeedQuote(draft.selectedText);
            setAskQuote("");
            setAskOpen(false);
            openChatFromComposer(draft.context);
          }}
        />
      ) : null}
      {dropActive ? (
        <div className="drop-overlay">
          <div className="drop-overlay-card">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <strong>Drop to add</strong>
            <span>
              {project
                ? dropRoom > 0
                  ? `To ${project.name} · ${dropRoom} more ${dropRoom === 1 ? "fits" : "fit"}`
                  : `${project.name} is full`
                : "Delphi will help you start a project"}
            </span>
          </div>
        </div>
      ) : null}
      {processingDocumentName ? (
        <ProcessingDocumentBanner name={processingDocumentName} />
      ) : null}
      {createProjectOpen ? (
        <CreateProjectModal
          onClose={() => {
            setCreateProjectOpen(false);
            setSetupSeed({ files: [], urls: [] });
          }}
          onCreate={async (name) => {
            const created = await api<Project>("/api/projects", {
              method: "POST",
              body: JSON.stringify({ name }),
            });
            setCreateProjectOpen(false);
            // The project now exists; the next thing to do is put documents in
            // it, which the setup asks for once the project has loaded.
            setLibraryTab("papers");
            await refreshProjects();
            router.push(`${projectPath(user.username, created)}?setup=1`);
          }}
        />
      ) : null}
      {setupOpen && project ? (
        <ProjectSetup
          project={project}
          config={config}
          initialFiles={setupSeed.files}
          initialUrls={setupSeed.urls}
          onClose={() => {
            setSetupOpen(false);
            setSetupSeed({ files: [], urls: [] });
          }}
          onDone={async (first) => {
            setSetupOpen(false);
            setSetupSeed({ files: [], urls: [] });
            await reload();
            fileDocument();
            if (first && user) router.push(documentPath(user.username, project, first));
          }}
        />
      ) : null}
      {addDocumentOpen ? (
        <AddDocumentModal
          projectName={project?.name ?? ""}
          onClose={() => setAddDocumentOpen(false)}
          onAddUrl={async (url, pdfMode) => {
            if (!projects.length) {
              setSetupSeed({ files: [], urls: [url] });
              setAddDocumentOpen(false);
              setCreateProjectOpen(true);
              return;
            }
            await addPage(url, pdfMode);
            setAddDocumentOpen(false);
          }}
        />
      ) : null}
      {staged ? (
        <CompressedUploadModal
          upload={staged.upload}
          limitMb={config.maxUploadMb}
          onKeep={keepStaged}
          onDiscard={discardStaged}
        />
      ) : null}
      {storePrompt ? (
        <StoreLinkedPdfModal
          title={storePrompt.title}
          onKeep={() => storePrompt.resolve(true)}
          onDecline={() => storePrompt.resolve(false)}
        />
      ) : null}
      {blockedLink !== null ? (
        <LinkBlockedModal
          href={blockedLink}
          onClose={() => setBlockedLink(null)}
        />
      ) : null}
      {saveViewportTarget ? (
        <SavePageModal
          viewport={saveViewportTarget}
          projects={projects}
          maxPapers={config.maxPapersPerProject}
          onClose={() => setSaveViewportTarget(null)}
          onSave={async (destinationId) => {
            if (await saveViewport(saveViewportTarget, destinationId)) {
              setSaveViewportTarget(null);
            }
          }}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsModal
          user={user}
          onUserChange={setUser}
          initialPane={settingsPane}
          config={config}
          onPersonasChanged={() => void loadPersonas()}
          projects={projects}
          currentProjectId={project?.id}
          currentPaperId={paper?.id}
          onClose={() => setSettingsOpen(false)}
          onOpenPaper={openPaper}
          onNavigate={(href) => router.push(href)}
          onMovePaper={movePaper}
          onReordered={reload}
          onNotice={setNotice}
          maxPapers={config.maxPapersPerProject}
        />
      ) : null}
      {notice ? <Toast notice={notice} onDismiss={() => setNotice("")} /> : null}
    </main>
  );
}

/**
 * Start the foreground worker for a document job the backend already queued.
 *
 * Importing a document is what files it. Marking one done changes the library
 * and queues nothing, so that action does not call this.
 *
 * Not awaited and deliberately silent: the durable job is the retry contract,
 * so a closed tab or failed request must not make the document action fail.
 */
function fileDocument() {
  requestMemoryMaintenance(true);
}

/** Where a dragged paper would land: a gap in its own project's rows, or the
    end of another project (`index` unused there). */
type RailDrop = { projectId: string; index: number };

/**
 * The collapsible project library: projects, papers, upload, and reorder.
 */
export function Library({
  tab: requestedTab,
  setTab,
  projects,
  project,
  paper,
  maxPapers,
  uploading,
  onUpload,
  onSelectProject,
  onDeleteProject,
  onDeletePaper,
  onSelectPaper,
  onMovePaper,
  onCreateProject,
  onAddWebpage,
  webEnabled,
  memoryEnabled,
  onChanged,
  onRenamed,
  onNotice,
  collapsed,
  onToggleCollapsed,
}: {
  tab: "papers" | "projects";
  setTab: (tab: "papers" | "projects") => void;
  projects: ProjectSummary[];
  project: Project | null;
  paper: Paper | null;
  /** The address names a project this panel has not been handed yet. */
  maxPapers: number;
  uploading: boolean;
  onUpload: (file?: File) => Promise<void>;
  onSelectProject: (id: string) => void;
  onDeleteProject: (id: string) => Promise<void>;
  onDeletePaper: (projectId: string, paperId: string) => Promise<void>;
  onSelectPaper: (paper: Paper) => void;
  onMovePaper: (
    fromProjectId: string,
    paperId: string,
    toProjectId: string,
  ) => Promise<void>;
  onCreateProject: () => void;
  onAddWebpage: () => void;
  webEnabled: boolean;
  memoryEnabled: boolean;
  /** Something in the library changed; re-read the list and the open project. */
  onChanged: () => Promise<void>;
  /** After a document is renamed: its Memory source page was renamed too. */
  onRenamed?: () => void;
  onNotice: (text: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const filingOf = useLibraryFiling(memoryEnabled);
  const fileRef = useRef<HTMLInputElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const addMenuCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addMenuOpenedRef = useRef<{
    at: number;
    source: "hover" | "click";
  } | null>(null);
  const paperListRef = useRef<HTMLDivElement>(null);
  /**
   * Dragging a document to a new place: up or down its own project, or onto
   * another project, which the list offers below its rows while one is held.
   *
   * The Settings sheet's gesture and its feedback — the card lifts and tilts,
   * its seat stays as an outline, a gap opens where it would land — because it
   * is the same action. The rail shows one project's papers, so another project
   * is a card that takes the paper rather than a list it can be placed into.
   */
  const paperDragRef = useRef<{
    paperId: string;
    startX: number;
    startY: number;
    /** Whether moving before the hold means "drag" (mouse) or "scroll" (touch). */
    dragOnMove: boolean;
    active: boolean;
    drop: RailDrop | null;
    timer: ReturnType<typeof setTimeout>;
    frame: number | null;
    /** A second look once a gap's spring has moved the list under the pointer. */
    settle: ReturnType<typeof setTimeout> | null;
    lastClientX: number;
    lastClientY: number;
    /** Stops following the pointer (`followPointer`). */
    stop: () => void;
  } | null>(null);
  // The pointer's last height, for the autoscroll loop, which runs between
  // pointer events: holding still at the edge has to keep scrolling.
  const pointerYRef = useRef(0);
  const autoScrollRef = useRef<number | null>(null);
  const suppressPaperClickRef = useRef(false);
  const [paperOrderOverride, setPaperOrderOverride] = useState<{
    projectId: string;
    papers: Paper[];
  } | null>(null);
  const [pressingPaperId, setPressingPaperId] = useState<string | null>(null);
  const [draggingPaperId, setDraggingPaperId] = useState<string | null>(null);
  const [paperDragOffset, setPaperDragOffset] = useState({ x: 0, y: 0 });
  /** The gap the paper is over: this project and a position, or another project. */
  const [paperDrop, setPaperDrop] = useState<RailDrop | null>(null);
  const [movingPaperId, setMovingPaperId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Paper | null>(null);
  const [moveTarget, setMoveTarget] = useState<Paper | null>(null);
  const [renameProjectTarget, setRenameProjectTarget] = useState<Pick<
    ProjectSummary,
    "id" | "name"
  > | null>(null);
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Pick<
    ProjectSummary,
    "id" | "name"
  > | null>(null);
  const accent = (id?: string) => projectAccent(id, projects);
  const [deleteTarget, setDeleteTarget] = useState<Paper | null>(null);
  const [paperMenuId, setPaperMenuId] = useState<string | null>(null);
  const [paperMenuAnchor, setPaperMenuAnchor] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    openUp: boolean;
  } | null>(null);
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);
  const [projectMenuAnchor, setProjectMenuAnchor] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    openUp: boolean;
  } | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [capacityTipProjectId, setCapacityTipProjectId] = useState<string | null>(
    null,
  );
  const tab = requestedTab;
  const allOrderedPapers =
    paperOrderOverride && paperOrderOverride.projectId === project?.id
      ? paperOrderOverride.papers
      : (project?.papers ?? []);
  const activePapers = allOrderedPapers.filter((item) => !isDone(item));
  const atCapacity = Boolean(project && activePapers.length >= maxPapers);
  const capacityTip =
    atCapacity && capacityTipProjectId === project?.id;
  const addMenuVisible = addMenuOpen && !atCapacity;
  // A finished document stays in the rail, after the ones still being read
  // and tinted as done. Finishing it says the reader has read it; it does not
  // put it away, and it does not count toward the project's limit.
  const orderedPapers = [
    ...activePapers,
    ...allOrderedPapers.filter((item) => isDone(item)),
  ];
  const railRamp = accentRamp(accent(project?.id), orderedPapers.length);
  const otherProjects = projects.filter((item) => item.id !== project?.id);
  /* The two gaps either side of the lifted paper's own seat are the place it
     already has; opening one would promise a move that changes nothing. */
  const liftedAt = activePapers.findIndex((item) => item.id === draggingPaperId);
  const gapOpen = (index: number) =>
    paperDrop !== null &&
    paperDrop.projectId === project?.id &&
    paperDrop.index === index &&
    !(liftedAt >= 0 && (index === liftedAt || index === liftedAt + 1));

  // Shared by the "..." button and a row's right-click, same reasoning as
  // openPaperMenu below.
  const toggleProjectMenu = (
    target: HTMLElement,
    projectId: string,
    point?: { x: number; y: number },
  ) => {
    if (projectMenuId === projectId) {
      setProjectMenuId(null);
      setProjectMenuAnchor(null);
      return;
    }
    const bounds = target.getBoundingClientRect();
    const anchorTop = point ? point.y : bounds.bottom;
    const anchorBottom = point ? point.y : bounds.top;
    const anchorRight = point ? point.x : bounds.right;
    const openUp =
      anchorTop + 92 > window.innerHeight && anchorBottom > 92;
    setProjectMenuAnchor({
      top: openUp ? undefined : anchorTop + 6,
      bottom: openUp ? window.innerHeight - anchorBottom + 6 : undefined,
      left: Math.max(8, Math.min(anchorRight - 124, window.innerWidth - 132)),
      openUp,
    });
    setProjectMenuId(projectId);
  };

  const projectActionsMenu = (item: Pick<ProjectSummary, "id" | "name">) =>
    projectMenuId === item.id && projectMenuAnchor
      ? createPortal(
          <div
            data-project-menu
            className={`paper-actions-menu ${
              projectMenuAnchor.openUp ? "open-up" : ""
            }`}
            style={{
              top: projectMenuAnchor.top,
              bottom: projectMenuAnchor.bottom,
              left: projectMenuAnchor.left,
            }}
            role="menu"
          >
            <button
              role="menuitem"
              onClick={() => {
                setProjectMenuId(null);
                setProjectMenuAnchor(null);
                setRenameProjectTarget(item);
              }}
            >
              Rename
            </button>
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                setProjectMenuId(null);
                setProjectMenuAnchor(null);
                setDeleteProjectTarget(item);
              }}
            >
              Remove
            </button>
          </div>,
          document.body,
        )
      : null;

  // Shared by the "..." button and a row's right-click so the two entry
  // points cannot drift apart. `point`, when given, anchors the menu at the
  // cursor instead of the button.
  const openPaperMenu = (
    target: HTMLElement,
    paperId: string,
    point?: { x: number; y: number },
  ) => {
    if (paperMenuId === paperId) {
      setPaperMenuId(null);
      setPaperMenuAnchor(null);
      return;
    }
    const buttonBounds = target.getBoundingClientRect();
    // Roughly how tall the menu is: four items and its padding. Only used to
    // decide which way it opens, so an approximation is enough — but it has
    // to grow when an item is added, or the last one lands off-screen.
    const menuHeight = 160;
    const anchorTop = point ? point.y : buttonBounds.bottom;
    const anchorBottom = point ? point.y : buttonBounds.top;
    const anchorRight = point ? point.x : buttonBounds.right;
    const openUp =
      anchorTop + menuHeight > window.innerHeight && anchorBottom > menuHeight;
    setPaperMenuAnchor({
      top: openUp ? undefined : anchorTop + 6,
      bottom: openUp ? window.innerHeight - anchorBottom + 6 : undefined,
      left: Math.max(8, Math.min(anchorRight - 140, window.innerWidth - 148)),
      openUp,
    });
    setPaperMenuId(paperId);
  };

  useEffect(() => {
    if (!paperMenuId) return;
    const closeMenu = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-paper-menu]")
      ) {
        return;
      }
      setPaperMenuId(null);
      setPaperMenuAnchor(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPaperMenuId(null);
        setPaperMenuAnchor(null);
      }
    };
    const closeAfterLayoutMoves = () => {
      setPaperMenuId(null);
      setPaperMenuAnchor(null);
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeAfterLayoutMoves);
    document.addEventListener("scroll", closeAfterLayoutMoves, true);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeAfterLayoutMoves);
      document.removeEventListener("scroll", closeAfterLayoutMoves, true);
    };
  }, [paperMenuId]);

  useEffect(() => {
    if (!projectMenuId) return;
    const closeMenu = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-project-menu]")
      ) {
        return;
      }
      setProjectMenuId(null);
      setProjectMenuAnchor(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProjectMenuId(null);
        setProjectMenuAnchor(null);
      }
    };
    const closeAfterLayoutMoves = () => {
      setProjectMenuId(null);
      setProjectMenuAnchor(null);
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeAfterLayoutMoves);
    document.addEventListener("scroll", closeAfterLayoutMoves, true);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeAfterLayoutMoves);
      document.removeEventListener("scroll", closeAfterLayoutMoves, true);
    };
  }, [projectMenuId]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const closeAddMenu = (event: PointerEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) {
        addMenuOpenedRef.current = null;
        setAddMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        addMenuOpenedRef.current = null;
        setAddMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeAddMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeAddMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [addMenuOpen]);

  useEffect(
    () => () => {
      const gesture = paperDragRef.current;
      if (gesture) {
        gesture.stop();
        clearTimeout(gesture.timer);
        if (gesture.settle !== null) clearTimeout(gesture.settle);
        if (gesture.frame !== null) cancelAnimationFrame(gesture.frame);
      }
      if (autoScrollRef.current !== null) cancelAnimationFrame(autoScrollRef.current);
      if (addMenuCloseRef.current) clearTimeout(addMenuCloseRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!atCapacity) return;
    // Capacity can arrive while the hover menu is already open (the tenth
    // upload finishes asynchronously). Clear the source state as well as
    // deriving a hidden class, or the stale open state can rotate the plus.
    if (addMenuCloseRef.current) {
      clearTimeout(addMenuCloseRef.current);
      addMenuCloseRef.current = null;
    }
    addMenuOpenedRef.current = null;
    // Schedule the React update rather than synchronously cascading a render
    // from this effect. The at-capacity class locks the visuals immediately.
    const frame = requestAnimationFrame(() => setAddMenuOpen(false));
    return () => cancelAnimationFrame(frame);
  }, [atCapacity, project?.id]);

  const stopAutoScroll = () => {
    if (autoScrollRef.current !== null) {
      cancelAnimationFrame(autoScrollRef.current);
      autoScrollRef.current = null;
    }
  };

  /**
   * Keep scrolling while the pointer sits near the list's top or bottom edge.
   * A frame loop, as in the Settings sheet: the other projects sit below the
   * rows, often out of sight, and the reader who has stopped at the edge is the
   * one who needs it to keep going.
   */
  const runAutoScroll = () => {
    autoScrollRef.current = null;
    const list = paperListRef.current;
    const gesture = paperDragRef.current;
    if (!list || !gesture?.active) return;
    const bounds = list.getBoundingClientRect();
    const edge = 48;
    const above = pointerYRef.current - bounds.top;
    const below = bounds.bottom - pointerYRef.current;
    const ramp = (distance: number) =>
      Math.round(Math.min(1, Math.max(0, (edge - distance) / edge)) * 14);
    const velocity = above < edge ? -ramp(above) : below < edge ? ramp(below) : 0;
    if (velocity) {
      list.scrollTop += velocity;
      // The rows move under a pointer that has not, so no pointer event will
      // say which gap it is over now.
      resolvePaperDrop(gesture);
    }
    autoScrollRef.current = requestAnimationFrame(runAutoScroll);
  };

  const liftPaper = (gesture: NonNullable<typeof paperDragRef.current>) => {
    if (paperDragRef.current !== gesture || gesture.active) return;
    clearTimeout(gesture.timer);
    gesture.active = true;
    // Set as the drag begins: a click that follows the drop would otherwise
    // open the paper the reader was still holding (`suppressClickAfterDrop`).
    suppressPaperClickRef.current = true;
    setDraggingPaperId(gesture.paperId);
    setPaperDragOffset({ x: 0, y: 0 });
    if (autoScrollRef.current === null) {
      autoScrollRef.current = requestAnimationFrame(runAutoScroll);
    }
  };

  const beginPaperDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    item: Paper,
  ) => {
    if (
      reordering ||
      movingPaperId ||
      // A done paper keeps its place in its own project; it can only leave.
      (isDone(item) && !otherProjects.length) ||
      (event.pointerType === "mouse" && event.button !== 0)
    ) {
      return;
    }
    pointerYRef.current = event.clientY;
    setPressingPaperId(item.id);
    const gesture = {
      paperId: item.id,
      startX: event.clientX,
      startY: event.clientY,
      // A mouse has no drag-to-scroll, so a press that travels is a drag; a
      // finger scrolls the list, and lifts a row only by holding still.
      dragOnMove: event.pointerType !== "touch",
      active: false,
      drop: null as RailDrop | null,
      timer: setTimeout(() => undefined, 0),
      frame: null as number | null,
      settle: null as ReturnType<typeof setTimeout> | null,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      stop: (() => undefined) as () => void,
    };
    gesture.timer = setTimeout(() => liftPaper(gesture), 360);
    paperDragRef.current = gesture;
    gesture.stop = followPointer(event.nativeEvent, event.currentTarget, {
      move: (move) => movePaperDrag(gesture, move),
      end: (how, last) =>
        how === "cancel" ? cancelPaperDrag(gesture) : endPaperDrag(gesture, how === "release" ? last : null),
    });
  };

  const movePaperDrag = (gesture: NonNullable<typeof paperDragRef.current>, event: PointerEvent) => {
    if (paperDragRef.current !== gesture) return;
    pointerYRef.current = event.clientY;
    if (!gesture.active) {
      const distance = Math.hypot(
        event.clientX - gesture.startX,
        event.clientY - gesture.startY,
      );
      // Under the slop it is still a click being made.
      if (distance <= 7) return;
      if (!gesture.dragOnMove) {
        gesture.stop();
        clearTimeout(gesture.timer);
        paperDragRef.current = null;
        setPressingPaperId(null);
        return;
      }
      liftPaper(gesture);
    }

    event.preventDefault();
    setPaperDragOffset({
      // The list clips what leaves it sideways, and every target in it is above
      // or below; a little sideways give is enough to read as held.
      x: Math.max(-4, Math.min(4, (event.clientX - gesture.startX) / 4)),
      y: event.clientY - gesture.startY,
    });

    // The card follows every event; the gap is resolved once a frame.
    gesture.lastClientX = event.clientX;
    gesture.lastClientY = event.clientY;
    if (gesture.frame !== null) return;
    gesture.frame = requestAnimationFrame(() => {
      gesture.frame = null;
      if (paperDragRef.current === gesture) resolvePaperDrop(gesture);
    });
  };

  const resolvePaperDrop = (gesture: NonNullable<typeof paperDragRef.current>) => {
    const commit = (next: RailDrop | null) => {
      const moved =
        gesture.drop?.projectId !== next?.projectId || gesture.drop?.index !== next?.index;
      // Opening or closing a gap moves everything below it, on a spring, under
      // a pointer that may now be still; look again once it has landed.
      if (moved) {
        if (gesture.settle !== null) clearTimeout(gesture.settle);
        gesture.settle = setTimeout(() => {
          gesture.settle = null;
          if (paperDragRef.current === gesture) resolvePaperDrop(gesture);
        }, 300);
      }
      gesture.drop = next;
      setPaperDrop((current) =>
        current?.projectId === next?.projectId && current?.index === next?.index
          ? current
          : next,
      );
    };
    const clientY = gesture.lastClientY;
    const under = document.elementsFromPoint(gesture.lastClientX, clientY);
    const marked = (key: string) =>
      under.find(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.dataset[key] !== undefined,
      );

    // Another project takes the paper at the end of its active ones. A full one
    // takes nothing: the server would refuse, and a refused drop is a bad way
    // to learn about a limit.
    const elsewhere = marked("railMoveProject");
    if (elsewhere) {
      const target = otherProjects.find(
        (entry) => entry.id === elsewhere.dataset.railMoveProject,
      );
      commit(target && target.paperCount < maxPapers ? { projectId: target.id, index: 0 } : null);
      return;
    }
    const list = paperListRef.current;
    const lifted = activePapers.findIndex((entry) => entry.id === gesture.paperId);
    // Anywhere from the other projects down is about them, never "the end of
    // this list": a gap opened up in the rows from there would push the cards
    // under a pointer that has not moved.
    const zone = list?.querySelector("[data-rail-move-zone]");
    if (
      !project ||
      !list ||
      !under.includes(list) ||
      (zone && clientY >= zone.getBoundingClientRect().top) ||
      lifted < 0
    ) {
      commit(null);
      return;
    }

    // Measured against the rows as they stand with every gap shut. The open gap
    // is the answer, so it must not move the question: anchored to the live
    // rows, the gap that opens below the pointer pushes the next row away from
    // it, the pointer is left over the gap, and the paper lands a row short of
    // where it was let go. Each row's own height is taken from the layout, and
    // the gaps above it — mid-spring or not — are taken back out.
    let shut = 0;
    let index = 0;
    for (const element of list.querySelectorAll<HTMLElement>(
      ":scope > [data-paper-slot], :scope > [data-paper-id]",
    )) {
      const bounds = element.getBoundingClientRect();
      if (element.dataset.paperSlot !== undefined) {
        shut += bounds.height;
        continue;
      }
      // Done papers sit last whatever the order, so no gap opens among them.
      if (index >= activePapers.length) break;
      if (clientY < bounds.top - shut + bounds.height / 2) break;
      index += 1;
    }
    commit({ projectId: project.id, index });
  };

  const persistPaperOrder = async (paperId: string, insertionIndex: number) => {
    if (!project) return;
    // Drag-reorder applies to the active rows only; the archived ones are
    // never touched, so the move math stays scoped to activePapers.
    const previous = activePapers;
    const fromIndex = previous.findIndex((item) => item.id === paperId);
    if (fromIndex < 0) return;
    const moved = previous[fromIndex];
    const next = previous.filter((item) => item.id !== paperId);
    const adjustedIndex = Math.max(
      0,
      Math.min(
        insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex,
        next.length,
      ),
    );
    next.splice(adjustedIndex, 0, moved);
    if (next.every((item, index) => item.id === previous[index]?.id)) return;

    const archived = allOrderedPapers.filter((item) => isDone(item));
    const fullOrder = [...next, ...archived];
    setPaperOrderOverride({ projectId: project.id, papers: fullOrder });
    setReordering(true);
    try {
      // The router validates the full id list against every paper in the
      // project, so the payload must include the archived ones even though
      // they never move.
      await api<Project>(`/api/projects/${project.id}/papers/order`, {
        method: "PUT",
        body: JSON.stringify({ paper_ids: fullOrder.map((item) => item.id) }),
      });
      await onChanged();
      setPaperOrderOverride(null);
    } catch (error) {
      setPaperOrderOverride(null);
      onNotice(
        error instanceof Error ? error.message : "Could not reorder papers",
      );
    } finally {
      setReordering(false);
    }
  };

  const clearPaperDrag = (gesture: NonNullable<typeof paperDragRef.current>) => {
    gesture.stop();
    clearTimeout(gesture.timer);
    if (gesture.settle !== null) clearTimeout(gesture.settle);
    if (gesture.frame !== null) cancelAnimationFrame(gesture.frame);
    paperDragRef.current = null;
    stopAutoScroll();
    setPressingPaperId(null);
    setDraggingPaperId(null);
    setPaperDrop(null);
    setPaperDragOffset({ x: 0, y: 0 });
  };

  /**
   * The paper lands where the pointer was let go: where the release was
   * heard, or, for a release the page learned of late (`followPointer`), where
   * the drag last saw it, since the hand has moved on by then.
   */
  const endPaperDrag = (gesture: NonNullable<typeof paperDragRef.current>, release: PointerEvent | null) => {
    if (paperDragRef.current !== gesture) return;
    // The last move's frame may not have come yet, and a release is often
    // the event right after it.
    if (gesture.active) {
      if (release) {
        gesture.lastClientX = release.clientX;
        gesture.lastClientY = release.clientY;
      }
      resolvePaperDrop(gesture);
    }
    clearPaperDrag(gesture);
    if (gesture.active) suppressClickAfterDrop(suppressPaperClickRef);
    const landing = gesture.drop;
    if (!gesture.active || !landing || !project) return;
    if (landing.projectId === project.id) {
      void persistPaperOrder(gesture.paperId, landing.index);
      return;
    }
    setMovingPaperId(gesture.paperId);
    void onMovePaper(project.id, gesture.paperId, landing.projectId)
      .catch((error: unknown) =>
        onNotice(error instanceof Error ? error.message : "Move failed"),
      )
      .finally(() => setMovingPaperId(null));
  };

  const cancelPaperDrag = (gesture: NonNullable<typeof paperDragRef.current>) => {
    if (paperDragRef.current !== gesture) return;
    clearPaperDrag(gesture);
    suppressPaperClickRef.current = false;
  };

  return (
    <aside className="library-panel">
      <div
        className="library-rail"
        aria-hidden={!collapsed}
        onClick={onToggleCollapsed}
      >
        <button
          className="rail-toggle"
          title="Expand library"
          aria-label="Expand library"
          tabIndex={collapsed ? 0 : -1}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M2.5 4h11M2.5 8h11M2.5 12h11"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <span className="rail-divider" aria-hidden="true" />
        <div className="rail-papers">
          {/* One project's documents in one project's colour: its ramp, from
              the accent at the top to a pastel at the bottom, so the chips
              read as a family rather than as the whole palette. */}
          {orderedPapers.map((item, index) => (
            <button
              key={item.id}
              className={`rail-paper ${paper?.id === item.id ? "active" : ""}`}
              style={
                {
                  "--paper-color": railRamp[index],
                  "--on-paper-color": onRampStep(accent(project?.id), railRamp[index]),
                } as CSSProperties
              }
              aria-label={pageTitle(item.title)}
              tabIndex={collapsed ? 0 : -1}
              onClick={(event) => {
                // The rail itself expands on click. A document chip is the one
                // exception: its click already has a destination, so letting it
                // bubble would change both the paper and the panel state.
                event.stopPropagation();
                onSelectPaper(item);
              }}
            >
              <span aria-hidden="true">
                {pageTitle(item.title).slice(0, 1).toUpperCase()}
              </span>
              {/* Collapsed, a chip is a single letter on a colour — which
                  reads identically whether it is a PDF or a page. The globe
                  rides the corner so the kind survives the collapse. */}
              {isWebPaper(item) ? (
                <span className="rail-paper-globe" aria-hidden="true">
                  <GlobeIcon />
                </span>
              ) : null}
              {/* Lives inside the button so hovering it keeps the chip
                  hovered, and clicking it opens the paper. */}
              <span className="rail-paper-title">{pageTitle(item.title)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="library-tabs-row">
        <div
          className="segmented library-tabs"
          style={{ "--segment-index": tab === "papers" ? 0 : 1 } as CSSProperties}
        >
          <button
            className={tab === "papers" ? "active" : ""}
            onClick={() => setTab("papers")}
          >
            Documents
          </button>
          <button className={tab === "projects" ? "active" : ""} onClick={() => setTab("projects")}>
            Projects
          </button>
        </div>
      </div>
      {tab === "papers" ? (
        <>
          <div className="project-switch" data-project-menu style={{ "--project-color": accent(project?.id) } as CSSProperties}>
            <strong>{project?.name ?? "No project yet"}</strong>
            {project ? (
              <button
                className="project-switch-more"
                title={`Actions for ${project.name}`}
                aria-label={`Actions for ${project.name}`}
                aria-haspopup="menu"
                aria-expanded={projectMenuId === project.id}
                onClick={(event) =>
                  toggleProjectMenu(event.currentTarget, project.id)
                }
              >
                <span className="ellipsis-icon" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </button>
            ) : null}
            {project ? projectActionsMenu(project) : null}
          </div>
          <div
            ref={paperListRef}
            className={`paper-list ${draggingPaperId ? "is-dragging" : ""}`}
            style={{ "--project-color": accent(project?.id) } as CSSProperties}
          >
            {/* A gap before every active row and one after the last, all
                mounted for the whole drag and all closed but one, so opening
                one is a transition: it is in the flow, and pushes the rows
                below it down on one spring. Not beside the paper's own seat,
                which already marks the place it has. */}
            {draggingPaperId ? (
              <span
                data-paper-slot="0"
                className={`paper-drop-slot ${gapOpen(0) ? "open" : ""}`}
                aria-hidden="true"
              />
            ) : null}
            {orderedPapers.map((item, index) => {
              const fixed = isDone(item) && !otherProjects.length;
              return (
              <Fragment key={item.id}>
              {isDone(item) && index === activePapers.length ? (
                <div className="paper-list-divider" aria-hidden="true" />
              ) : null}
              <div
                data-paper-id={item.id}
                className={[
                  "paper-row",
                  isDone(item) ? "done" : "",
                  fixed ? "is-fixed" : "",
                  paper?.id === item.id ? "selected" : "",
                  pressingPaperId === item.id ? "press-pending" : "",
                  draggingPaperId === item.id ? "is-lifted" : "",
                  movingPaperId === item.id ? "moving" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openPaperMenu(event.currentTarget, item.id, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
              >
                <button
                  className={`paper-row-main ${
                    draggingPaperId === item.id ? "dragging" : ""
                  }`}
                  style={
                    draggingPaperId === item.id
                      ? ({
                          "--paper-drag-x": `${paperDragOffset.x}px`,
                          "--paper-drag-y": `${paperDragOffset.y}px`,
                        } as CSSProperties)
                      : undefined
                  }
                  title={
                    fixed
                      ? undefined
                      : isDone(item)
                        ? "Drag onto another project to move it there"
                        : "Drag to reorder, or onto another project to move it"
                  }
                  aria-grabbed={draggingPaperId === item.id}
                  onPointerDown={(event) => beginPaperDrag(event, item)}
                  onClick={(event) => {
                    if (suppressPaperClickRef.current) {
                      suppressPaperClickRef.current = false;
                      event.preventDefault();
                      return;
                    }
                    onSelectPaper(item);
                  }}
                >
                  {/* The kind, where the ordinal used to be: the @-mention
                      menu names documents by title now, so the number
                      answered nothing. The grip still takes its place under
                      the pointer, to say the row can be dragged. */}
                  <span className="paper-index">
                    <span
                      className="paper-kind"
                      aria-label={isWebPaper(item) ? "Web page" : "Document"}
                    >
                      {isWebPaper(item) ? <GlobeIcon /> : <DocumentIcon />}
                    </span>
                    <span className="paper-grip" aria-hidden="true">
                      ⠿
                    </span>
                  </span>
                  <span>
                    <strong>{pageTitle(item.title)}</strong>
                    <small className="paper-metadata">
                      {isWebPaper(item)
                        ? `${hostOf(item.url)} · ${item.pages} ${
                            isWebPdf(item) ? "pp" : "sections"
                          }`
                        : `${item.pages} pp`}
                      {(() => {
                        const filing = filingOf(item);
                        return filing ? (
                          <span className={`paper-filing is-${filing}`}>
                            · {filing === "running" ? "Filing into Memory" : "In line for Memory"}
                          </span>
                        ) : null;
                      })()}
                    </small>
                  </span>
                </button>
                <div className="paper-row-actions" data-paper-menu>
                  <button
                    className="paper-more-button"
                    title={`Actions for ${pageTitle(item.title)}`}
                    aria-label={`Actions for ${pageTitle(item.title)}`}
                    aria-haspopup="menu"
                    aria-expanded={paperMenuId === item.id}
                    onClick={(event) =>
                      openPaperMenu(event.currentTarget, item.id)
                    }
                  >
                    <span className="ellipsis-icon" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                  </button>
                  {paperMenuId === item.id && paperMenuAnchor
                    ? createPortal(
                        <div
                          data-paper-menu
                          className={`paper-actions-menu ${
                            paperMenuAnchor.openUp ? "open-up" : ""
                          }`}
                          style={{
                            top: paperMenuAnchor.top,
                            bottom: paperMenuAnchor.bottom,
                            left: paperMenuAnchor.left,
                          }}
                          role="menu"
                        >
                          <button
                            role="menuitem"
                            onClick={async () => {
                              setPaperMenuId(null);
                              setPaperMenuAnchor(null);
                              if (!project) return;
                              const finishing = !isDone(item);
                              try {
                                await api(
                                  `/api/projects/${project.id}/papers/${item.id}/done`,
                                  {
                                    method: "POST",
                                    body: JSON.stringify({ done: finishing }),
                                  },
                                );
                                await onChanged();
                              } catch (error) {
                                onNotice(
                                  error instanceof Error
                                    ? error.message
                                    : "Couldn't update this paper",
                                );
                              }
                            }}
                          >
                            {isDone(item) ? "Active" : "Done"}
                          </button>
                          <button
                            role="menuitem"
                            onClick={() => {
                              setPaperMenuId(null);
                              setPaperMenuAnchor(null);
                              setRenameTarget(item);
                            }}
                          >
                            Rename
                          </button>
                          <button
                            role="menuitem"
                            disabled={projects.length < 2}
                            title={
                              projects.length < 2
                                ? "Create a second project to move this into"
                                : undefined
                            }
                            onClick={() => {
                              setPaperMenuId(null);
                              setPaperMenuAnchor(null);
                              setMoveTarget(item);
                            }}
                          >
                            Move project
                          </button>
                          <button
                            role="menuitem"
                            className="danger"
                            onClick={() => {
                              setPaperMenuId(null);
                              setPaperMenuAnchor(null);
                              setDeleteTarget(item);
                            }}
                          >
                            Remove document
                          </button>
                        </div>,
                        document.body,
                      )
                    : null}
                </div>
              </div>
              {draggingPaperId && index < activePapers.length ? (
                <span
                  data-paper-slot={index + 1}
                  className={`paper-drop-slot ${gapOpen(index + 1) ? "open" : ""}`}
                  aria-hidden="true"
                />
              ) : null}
              </Fragment>
              );
            })}
            {/* The other projects, while a paper is in the air: each one is a
                card that takes it, in the Settings sheet's vocabulary — its
                name in its colour over a card that rings and opens a gap. */}
            {draggingPaperId && otherProjects.length ? (
              <div className="paper-move-zone" data-rail-move-zone>
                <span className="paper-move-label">Move to another project</span>
                {otherProjects.map((item) => {
                  const full = item.paperCount >= maxPapers;
                  const target = paperDrop?.projectId === item.id;
                  return (
                    <section
                      key={item.id}
                      data-rail-move-project={item.id}
                      aria-label={`Move to ${item.name}`}
                      title={full ? "Project is at maximum capacity" : undefined}
                      className={[
                        "paper-move-project",
                        target ? "drop-target" : "",
                        full ? "is-full" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{ "--project-color": accent(item.id) } as CSSProperties}
                    >
                      <span className="paper-move-heading">
                        <span className="paper-move-dot" aria-hidden="true" />
                        <strong>{item.name}</strong>
                        <small>
                          {item.paperCount}/{maxPapers}
                        </small>
                      </span>
                      <span
                        className={`paper-drop-slot ${target ? "open" : ""}`}
                        aria-hidden="true"
                      />
                    </section>
                  );
                })}
              </div>
            ) : null}
            {/* An empty project says so once, in the reader panel beside this,
                with the way into its setup; the list stays empty rather than
                repeating it. */}
          </div>
          <div className="library-footer">
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              hidden
              onChange={(event) => {
                void onUpload(event.target.files?.[0]);
                if (fileRef.current) fileRef.current.value = "";
              }}
            />
            <div
              ref={addMenuRef}
              className={`quick-add ${addMenuVisible ? "open" : ""} ${
                atCapacity ? "at-capacity" : ""
              }`}
              onPointerEnter={(event) => {
                // Touch synthesizes pointer enter/leave around a tap. Let the
                // click path own touch so its menu does not close 160 ms later.
                if (event.pointerType === "touch") return;
                if (addMenuCloseRef.current) {
                  clearTimeout(addMenuCloseRef.current);
                  addMenuCloseRef.current = null;
                }
                if (atCapacity) {
                  setCapacityTipProjectId(project?.id ?? null);
                  return;
                }
                if (!addMenuOpen) {
                  addMenuOpenedRef.current = {
                    at: Date.now(),
                    source: "hover",
                  };
                  setAddMenuOpen(true);
                }
              }}
              onPointerLeave={(event) => {
                if (event.pointerType === "touch") return;
                setCapacityTipProjectId(null);
                if (
                  (!addMenuOpen && !addMenuOpenedRef.current) ||
                  addMenuCloseRef.current
                ) {
                  return;
                }
                // A small grace period makes “left meaningfully” distinct from
                // grazing the gap between the circle and its rolled-out pills.
                addMenuCloseRef.current = setTimeout(() => {
                  addMenuOpenedRef.current = null;
                  setAddMenuOpen(false);
                  addMenuCloseRef.current = null;
                }, 160);
              }}
            >
              <button
                className="quick-add-toggle"
                disabled={uploading || atCapacity}
                aria-label={
                  atCapacity
                    ? "Project is at maximum capacity"
                    : addMenuVisible
                      ? "Close add menu"
                      : "Add a source"
                }
                aria-describedby={capacityTip ? "project-capacity-tip" : undefined}
                aria-expanded={addMenuVisible}
                onClick={() => {
                  if (atCapacity) return;
                  if (!addMenuOpen) {
                    addMenuOpenedRef.current = {
                      at: Date.now(),
                      source: "click",
                    };
                    setAddMenuOpen(true);
                    return;
                  }
                  const opened = addMenuOpenedRef.current;
                  if (
                    opened?.source === "hover" &&
                    Date.now() - opened.at < 1000
                  ) {
                    return;
                  }
                  addMenuOpenedRef.current = null;
                  setAddMenuOpen(false);
                }}
              >
                <svg
                  className="quick-add-glyph"
                  width="13"
                  height="13"
                  viewBox="0 0 20 20"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M10 3.75v12.5M3.75 10h12.5"
                    stroke="currentColor"
                    strokeWidth="2.1"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              {capacityTip ? (
                <span
                  id="project-capacity-tip"
                  className="quick-add-capacity-tip"
                  role="tooltip"
                >
                  Project is at maximum capacity
                </span>
              ) : null}
              <div className="quick-add-menu" aria-hidden={!addMenuVisible}>
                {webEnabled ? (
                  <button
                    tabIndex={addMenuVisible ? 0 : -1}
                    onClick={() => {
                      addMenuOpenedRef.current = null;
                      setAddMenuOpen(false);
                      onAddWebpage();
                    }}
                  >
                    <GlobeIcon />
                    <span>Webpage</span>
                  </button>
                ) : null}
                <button
                  tabIndex={addMenuVisible ? 0 : -1}
                  onClick={() => {
                    addMenuOpenedRef.current = null;
                    setAddMenuOpen(false);
                    fileRef.current?.click();
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M4 1.8h5l3 3V14H4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                    <path d="M9 1.8V5h3M6 8h4M6 10.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                  <span>{uploading ? "Reading…" : "Document"}</span>
                </button>
              </div>
            </div>
            {/* How full the project is, as a tip rather than a sentence. */}
            {project ? (
              <span
                className="library-count"
                title={`${activePapers.length} of ${maxPapers} documents`}
              >
                {activePapers.length}/{maxPapers}
              </span>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <div className="project-list">
            {projects.map((item) => (
              <div
                key={item.id}
                data-project-id={item.id}
                className={`project-row ${project?.id === item.id ? "selected" : ""}`}
                style={
                  {
                    "--project-color": accent(item.id),
                    "--on-project-color": onAccent(accent(item.id)),
                  } as CSSProperties
                }
                onContextMenu={(event) => {
                  event.preventDefault();
                  toggleProjectMenu(event.currentTarget, item.id, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
              >
                <button
                  className="project-row-main"
                  onClick={() => void onSelectProject(item.id)}
                >
                  {/* The name in the project's own colour stands in for the
                      lettered disc; the count is a tip, not a sentence. */}
                  <strong>{item.name}</strong>
                  <small title={`${item.paperCount} of ${maxPapers} documents`}>
                    {item.paperCount}/{maxPapers}
                  </small>
                </button>
                <div className="project-row-actions" data-project-menu>
                  <button
                    className="paper-more-button"
                    title={`Actions for ${item.name}`}
                    aria-label={`Actions for ${item.name}`}
                    aria-haspopup="menu"
                    aria-expanded={projectMenuId === item.id}
                    onClick={(event) =>
                      toggleProjectMenu(event.currentTarget, item.id)
                    }
                  >
                    <span className="ellipsis-icon" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                  </button>
                  {projectActionsMenu(item)}
                </div>
              </div>
            ))}
            {!projects.length ? (
              <div className="sidebar-empty">
                Start with a project — papers live inside one, and each keeps its
                own context. Add one below.
              </div>
            ) : null}
          </div>
          <div className="library-footer">
            <button
              type="button"
              className="library-add"
              onClick={onCreateProject}
              aria-label="New project"
              title="New project"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 3.4v9.2M3.4 8h9.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </>
      )}
      {/* Every modal below is opened from the library, but the library is a
         stacking context of its own (`.library-panel` takes `z-index: 20`
         so the quick-add pills win hit-testing over a live page iframe).
         A backdrop rendered inside it ranks its `z-index: 100` against
         that 20, not against the top bar — which left the account avatar
         painted over the dim. `ModalLayer` puts them back on the body,
         where a full-window overlay belongs. */}
      <ModalLayer>
        {renameTarget && project ? (
          <RenameModal
            heading="Rename document"
            initialValue={renameTarget.title}
            maxLength={200}
            confirmLabel="Save"
            onClose={() => setRenameTarget(null)}
            onRename={async (title) => {
              try {
                await api(
                  `/api/projects/${project.id}/papers/${renameTarget.id}`,
                  {
                    method: "PATCH",
                    body: JSON.stringify({ title }),
                  },
                );
                setRenameTarget(null);
                await onChanged();
                // The backend renames the document's source page with it, so
                // Related Memory re-reads the neighbourhood to show the new name.
                onRenamed?.();
              } catch (error) {
                onNotice(error instanceof Error ? error.message : "Rename failed");
              }
            }}
          />
        ) : null}
        {renameProjectTarget ? (
          <RenameModal
            heading="Rename project"
            initialValue={renameProjectTarget.name}
            maxLength={100}
            confirmLabel="Save"
            onClose={() => setRenameProjectTarget(null)}
            onRename={async (name) => {
              try {
                await api(`/api/projects/${renameProjectTarget.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({ name }),
                });
                setRenameProjectTarget(null);
                await onChanged();
              } catch (error) {
                onNotice(error instanceof Error ? error.message : "Rename failed");
              }
            }}
          />
        ) : null}
        {moveTarget && project ? (
          <MovePaperModal
            paper={moveTarget}
            from={project}
            projects={projects}
            maxPapers={maxPapers}
            onClose={() => setMoveTarget(null)}
            onMove={async (destinationId) => {
              try {
                await onMovePaper(project.id, moveTarget.id, destinationId);
                setMoveTarget(null);
              } catch (error) {
                onNotice(error instanceof Error ? error.message : "Move failed");
              }
            }}
          />
        ) : null}
        {deleteTarget && project ? (
          <DeleteWithPagesModal
            kind="document"
            id={deleteTarget.id}
            name={deleteTarget.title}
            onClose={() => setDeleteTarget(null)}
            onDelete={async (pages) => {
              try {
                await onDeletePaper(project.id, deleteTarget.id);
                setDeleteTarget(null);
              } catch (error) {
                onNotice(error instanceof Error ? error.message : "Delete failed");
                return;
              }
              await deleteMemoryPages(pages, onNotice);
            }}
          />
        ) : null}
        {deleteProjectTarget ? (
          <DeleteWithPagesModal
            kind="project"
            id={deleteProjectTarget.id}
            name={deleteProjectTarget.name}
            onClose={() => setDeleteProjectTarget(null)}
            onDelete={async (pages) => {
              try {
                await onDeleteProject(deleteProjectTarget.id);
                setDeleteProjectTarget(null);
              } catch (error) {
                onNotice(error instanceof Error ? error.message : "Delete failed");
                return;
              }
              await deleteMemoryPages(pages, onNotice);
            }}
          />
        ) : null}
      </ModalLayer>
    </aside>
  );
}

/** Display names for the model ids the server offers. */

/** Reader zoom, in the shape a browser has taught everyone to expect. */
/** A PDF's mark in the library, drawn to the globe's size and stroke. */
function DocumentIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3.4 1.4h4.5l2.7 2.7v8.5H3.4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M7.9 1.4v2.7h2.7" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * What happens when a link in a web document is clicked.
 *
 * The frame refuses the navigation and says so here rather than silently
 * eating the click, because a link that does nothing reads as broken. The
 * offer to add the page is the point: the answer to "I want to read that" is a
 * second document, not a second tab.
 */
function LinkBlockedModal({
  href,
  onClose,
}: {
  href: string;
  onClose: () => void;
}) {
  // Explicit external gestures name a destination. A scripted escape is only
  // caught afterwards and remains intentionally unknowable cross-origin.
  let label = href;
  try {
    const parsed = new URL(href);
    label = `${parsed.host.replace(/^www\./, "")}${parsed.pathname}`;
  } catch {
    /* Show it raw; it is only a label. */
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <span className="eyebrow">External action</span>
        <h2>{href ? "Continue in the original site?" : "Reader restored"}</h2>
        <p>
          {href
            ? "This gesture opens outside Delphi. Your saved document and in-app history will stay unchanged."
            : "The page tried to navigate without a trusted click, so Delphi restored the current reading view."}
        </p>
        {href ? <p className="blocked-link-target">{label}</p> : null}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
          >
            {href ? "Cancel" : "Got it"}
          </button>
          {href ? (
          <a
            className="primary-button"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
          >
            Open externally
          </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The two ways a document gets into a project.
 *
 * Dropping a PDF anywhere in the window still works and is still the fastest
 * path; this exists because a web page has no file to drop, and a button that
 * only ever opened a file picker had nowhere to put a URL.
 */
/** An address worth sending: a host with a dot in it, scheme optional. */
function looksLikeUrl(value: string) {
  const text = value.trim();
  if (!text || /\s/.test(text)) return false;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return /^https?:$/.test(parsed.protocol) && parsed.hostname.includes(".");
  } catch {
    return false;
  }
}

function AddDocumentModal({
  projectName,
  onClose,
  onAddUrl,
}: {
  projectName: string;
  onClose: () => void;
  onAddUrl: (
    url: string,
    pdfMode?: "ask" | "web" | "upload",
  ) => Promise<void>;
}) {
  const [mode, setMode] = useState<"web" | "pdf">("web");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [pdfAction, setPdfAction] = useState<"web" | "upload" | null>(null);
  const [error, setError] = useState("");
  // Add waits for something shaped like an address, so the one button in the
  // dialog is not an invitation to submit half a word.
  const urlReady = looksLikeUrl(url);

  const submitUrl = async (event: FormEvent) => {
    event.preventDefault();
    if (!urlReady || busy) return;
    setBusy(true);
    setError("");
    try {
      await onAddUrl(url.trim());
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "pdf_url") {
        setMode("pdf");
        setBusy(false);
        return;
      }
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  const choosePdf = async (choice: "web" | "upload") => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setPdfAction(choice);
    setError("");
    try {
      await onAddUrl(url.trim(), choice);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
      setPdfAction(null);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose}>
      <form
        className="modal is-quiet"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submitUrl}
      >
        {/* No eyebrow: the title says what the dialog does and the line under
            it says where the result lands. */}
        <h2>
          {mode === "pdf" ? "Want the full PDF experience?" : "Add a webpage"}
        </h2>
        <p>
          {mode === "pdf"
            ? "Keep this as a linked document or import a local copy. Both use Delphi’s reader with selection, Reply, highlights, and chat; importing makes reopening faster and enables annotated downloads even if the source changes."
            : projectName
              ? `To ${projectName}`
              : "To this project"}
        </p>
        {mode === "web" ? (
          <>
            <label className="modal-field">
              <GlobeIcon />
              <input
                aria-label="Webpage address"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="lilianweng.github.io/posts/…"
                maxLength={2000}
                disabled={busy}
                autoFocus
                required
              />
            </label>
            {error ? <p className="modal-error">{error}</p> : null}
          </>
        ) : (
          <>
            <p className="pdf-link-target">{url}</p>
            {error ? <p className="modal-error">{error}</p> : null}
          </>
        )}
        <div className="modal-actions">
          {mode === "pdf" ? (
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void choosePdf("web")}
              >
                {busy && pdfAction === "web" ? "Reading page…" : "Keep as page"}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void choosePdf("upload")}
              >
                {busy && pdfAction === "upload"
                  ? "Importing PDF…"
                  : "Import PDF"}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </button>
              <button className="primary-button" disabled={busy || !urlReady}>
                {busy ? "Reading page…" : "Add"}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

/** Shared by papers and projects — the only difference is the wording. */
function RenameModal({
  heading,
  initialValue,
  maxLength,
  confirmLabel,
  onClose,
  onRename,
}: {
  heading: string;
  initialValue: string;
  maxLength: number;
  confirmLabel: string;
  onClose: () => void;
  onRename: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal is-quiet rename-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void onRename(value);
        }}
      >
        <h2 id="rename-title">{heading}</h2>
        <label className="modal-field">
          <input
            aria-label={heading === "Rename project" ? "Project name" : "Document title"}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            maxLength={maxLength}
            autoFocus
            required
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button">{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

/**
 * What compression cost, before the paper joins the project.
 *
 * The figures in the stored copy really are lower resolution than the ones
 * uploaded, and a reader who cares about a plate at full detail should get to
 * say so — which is why this asks rather than quietly storing the smaller file.
 * Closing it declines: the bytes are sitting in storage with nothing pointing
 * at them, so leaving without an answer is the one outcome worth ruling out.
 */
/**
 * Asked when a reader annotates a linked PDF.
 *
 * The trade is the same one `AddDocumentModal`'s PDF branch offers, so the copy
 * stays short: the interesting part is not the list of benefits, it is that
 * this document has no bytes here and the annotation is about to depend on
 * someone else's address staying up.
 */
function StoreLinkedPdfModal({
  title,
  onKeep,
  onDecline,
}: {
  title: string;
  onKeep: () => void;
  onDecline: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const decline = () => {
    if (!busy) onDecline();
  };
  return (
    <div className="modal-backdrop" onMouseDown={decline}>
      <div
        className="modal"
        role="alertdialog"
        aria-labelledby="store-linked-pdf-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="modal-warning-icon"
          src="/brand/animations/delphi-warning-alert.gif"
          alt=""
        />
        <span className="eyebrow">Linked document</span>
        <h2 id="store-linked-pdf-title">Store a copy of “{title}”?</h2>
        <p>
          Delphi reads this PDF from its source each time, so annotations on it
          are only as durable as that address.
        </p>
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={decline}
            disabled={busy}
          >
            Not now
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              setBusy(true);
              onKeep();
            }}
            disabled={busy}
          >
            {busy ? "Storing…" : "Store it"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CompressedUploadModal({
  upload,
  limitMb,
  onKeep,
  onDiscard,
}: {
  upload: StagedUpload;
  limitMb: number;
  onKeep: () => Promise<void>;
  onDiscard: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  const decline = () => {
    if (!busy) void onDiscard();
  };
  return (
    <div className="modal-backdrop" onMouseDown={decline}>
      <div
        className="modal"
        role="alertdialog"
        aria-labelledby="compressed-upload-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="eyebrow">Over the {limitMb} MB limit</span>
        <h2 id="compressed-upload-title">
          Store “{upload.title}” at {megabytes(upload.bytes)} MB?
        </h2>
        <p>
          It arrived at {megabytes(upload.uploadedBytes)} MB. Delphi re-encoded
          its figures to fit, which leaves the text, pages, and layout exactly
          as they were — figures are the only thing that loses detail.
        </p>
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={decline}
            disabled={busy}
          >
            Discard it
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              setBusy(true);
              void onKeep();
            }}
            disabled={busy}
          >
            {busy ? "Adding…" : "Add the smaller PDF"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Where a paper is going.
 *
 * A picker rather than a confirmation, because the destination *is* the
 * decision — so each row commits on its own click instead of asking twice. The
 * dot and the paper count are the same ones the library and the account modal
 * show, which is what makes "the moss one" a way to find a project.
 */
function MovePaperModal({
  paper,
  from,
  projects,
  maxPapers,
  onClose,
  onMove,
}: {
  paper: Paper;
  from: Project;
  projects: ProjectSummary[];
  maxPapers: number;
  onClose: () => void;
  onMove: (destinationId: string) => Promise<void>;
}) {
  const [moving, setMoving] = useState<string | null>(null);
  const destinations = projects.filter((item) => item.id !== from.id);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal is-quiet move-paper-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-paper-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="move-paper-title">Move document</h2>
        <p className="modal-subject" title={paper.title}>{paper.title}</p>
        <div className="move-paper-list">
          {destinations.map((item) => {
            // Listed but not offered. Hiding a full project would read as
            // "that project is gone"; the reader needs to see it is there and
            // why it cannot take this.
            const full = item.paperCount >= maxPapers;
            return (
              <button
                key={item.id}
                type="button"
                className={`move-paper-option ${full ? "is-full" : ""}`}
                style={{ "--project-color": projectAccent(item.id, projects) } as CSSProperties}
                disabled={full || Boolean(moving)}
                aria-disabled={full}
                title={full ? "Project at maximum capacity." : undefined}
                onClick={() => {
                  setMoving(item.id);
                  void onMove(item.id).finally(() => setMoving(null));
                }}
              >
                <span className="project-switch-dot" aria-hidden="true" />
                <strong>{item.name}</strong>
                <small>
                  {moving === item.id
                    ? "Moving…"
                    : `${item.paperCount}/${maxPapers}${full ? " · Full" : ""}`}
                </small>
                {full ? (
                  <span className="move-paper-full-tip" role="tooltip">
                    Project at maximum capacity.
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function SavePageModal({
  viewport,
  projects,
  maxPapers,
  onClose,
  onSave,
}: {
  viewport: ChatViewport;
  projects: ProjectSummary[];
  maxPapers: number;
  onClose: () => void;
  onSave: (destinationId: string) => Promise<void>;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal move-paper-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-page-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="eyebrow">Save page as new document</span>
        <h2 id="save-page-title">Choose a project</h2>
        <p>
          Delphi will create a pinned document for {viewport.title || hostOf(viewport.url)}.
          Your current document remains unchanged.
        </p>
        <div className="move-paper-list">
          {projects.map((item) => {
            const full = item.paperCount >= maxPapers;
            return (
              <button
                key={item.id}
                type="button"
                className={`move-paper-option ${full ? "is-full" : ""}`}
                disabled={full || Boolean(saving)}
                aria-disabled={full}
                title={full ? "Project at maximum capacity." : undefined}
                onClick={() => {
                  setSaving(item.id);
                  void onSave(item.id).finally(() => setSaving(null));
                }}
              >
                <span
                  className="project-switch-dot"
                  style={
                    {
                      "--project-color": projectAccent(item.id, projects),
                    } as CSSProperties
                  }
                />
                <strong>{item.name}</strong>
                <small>{saving === item.id ? "Saving…" : `${item.paperCount} of ${maxPapers}`}</small>
                {full ? (
                  <span className="move-paper-full-tip" role="tooltip">
                    Project at maximum capacity.
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={Boolean(saving)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Documents and projects share the same destructive confirmation layout. */
function DeleteModal({
  kind,
  name,
  action,
  waiting = false,
  children,
  onClose,
  onDelete,
}: {
  kind: "document" | "project";
  name: string;
  /** The button's words, when it deletes more than the one thing. */
  action?: string;
  /** What the dialog offers is still being read, so Delete cannot yet say what it deletes. */
  waiting?: boolean;
  children?: ReactNode;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  // A project's delete takes seconds; a second press would delete it again and
  // report a failure for a delete that worked.
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal is-quiet delete-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        aria-describedby="delete-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="delete-modal-heading">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="modal-warning-icon"
            src="/brand/animations/delphi-warning-alert.gif"
            alt=""
          />
          <h2 id="delete-title">Delete {kind}?</h2>
        </div>
        <p className="modal-subject" title={name}>{name}</p>
        <p id="delete-description">
          {kind === "project"
            ? "Deletes all project contents. Cannot be undone."
            : "Deletes highlights and chats too. Cannot be undone."}
        </p>
        {children}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={waiting || deleting}
            onClick={() => {
              setDeleting(true);
              void onDelete().finally(() => setDeleting(false));
            }}
          >
            {action ?? `Delete ${kind}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The pages a delete dialog's reader ticked, after the document or project:
 * that is what they asked for. A page that will not go stays, and says so.
 */
async function deleteMemoryPages(pages: MemoryDependentPage[], onNotice: (message: string) => void) {
  for (const page of pages) {
    try {
      await api(`/api/memory/pages/${encodeURIComponent(page.slug)}`, { method: "DELETE" });
    } catch {
      onNotice(`${page.title} is still in Memory`);
    }
  }
  if (pages.length) window.dispatchEvent(new Event(MEMORY_PAGES_CHANGED));
}

/**
 * Deleting a document or a project offers the Memory pages that stand on it
 * alone: each document's source page, and each concept written from one that
 * cites nothing outside them. Ticked unless the reader keeps one. A page that
 * also cites another document is not offered: it stays, its citation
 * dangling (invariant 41).
 */
function DeleteWithPagesModal({
  kind,
  id,
  name,
  onClose,
  onDelete,
}: {
  kind: "document" | "project";
  id: string;
  name: string;
  onClose: () => void;
  onDelete: (pages: MemoryDependentPage[]) => Promise<void>;
}) {
  // Null while the read is out, and Delete waits for it: pressed sooner, the
  // document would go and the pages it offers would silently stay.
  const [pages, setPages] = useState<MemoryDependentPage[] | null>(null);
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    // With Memory off, or the read failed, nothing is offered.
    const offer = kind === "project"
      ? `/api/memory/projects/${encodeURIComponent(id)}/dependents`
      : `/api/memory/documents/${encodeURIComponent(id)}/dependents`;
    api<{ pages: MemoryDependentPage[] }>(offer)
      .then((found) => { if (!cancelled) setPages(found.pages); })
      .catch(() => { if (!cancelled) setPages([]); });
    return () => { cancelled = true; };
  }, [kind, id]);
  const ticked = (pages ?? []).filter((page) => !kept.has(page.slug));
  const toggle = (slug: string) => setKept((current) => {
    const next = new Set(current);
    if (!next.delete(slug)) next.add(slug);
    return next;
  });
  return (
    <DeleteModal
      kind={kind}
      name={name}
      action={ticked.length ? `Delete ${kind} and ${ticked.length} page${ticked.length === 1 ? "" : "s"}` : undefined}
      waiting={pages === null}
      onClose={onClose}
      onDelete={() => onDelete(ticked)}
    >
      {pages?.length ? (
        <div className="delete-modal-memory">
          <span className="eyebrow">Also remove from Memory</span>
          {/* A project may offer dozens: the list scrolls, the buttons stay. */}
          <div className="delete-modal-memory-list">
            {pages.map((page) => (
              <label key={page.slug} className="plan-capacity-row" data-selected={kept.has(page.slug) ? undefined : ""}>
                <input type="checkbox" checked={!kept.has(page.slug)} onChange={() => toggle(page.slug)} />
                <span>
                  <strong>
                    <i style={{ background: `var(--kb-node-${page.kind})` }} aria-hidden="true" />
                    {page.title}
                  </strong>
                  <small>
                    {page.kind === "source"
                      ? kind === "project" ? "Source page" : "Its source page"
                      : `Cites only this ${kind}`}
                  </small>
                </span>
              </label>
            ))}
          </div>
          <p>
            {kind === "project"
              ? "Pages that also cite documents outside this project stay."
              : "Pages that also cite other documents stay."}{" "}
            Links to a removed page become plain words.
          </p>
        </div>
      ) : null}
    </DeleteModal>
  );
}

/**
 * The source identity stays visible when a linked PDF uses Delphi's reader.
 * This is deliberately the same quiet chrome as a web page—one address and an
 * escape hatch to the original, not a second browser toolbar.
 */
function LinkedPdfSource({ url }: { url: string }) {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    /* `hostOf` below already supplies the safe raw fallback. */
  }
  return (
    <div className="page-chrome linked-pdf-source">
      <span className="page-favicon" aria-hidden="true">
        <GlobeIcon />
      </span>
      <span className="page-address" title={url}>
        {hostOf(url)}
        <span className="page-address-path">{path}</span>
      </span>
      <div className="page-chrome-actions">
        <a
          className="icon-button"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open the original in a new tab"
          aria-label="Open the original in a new tab"
        >
          ↗
        </a>
      </div>
    </div>
  );
}

/**
 * The reader panel with nothing to show: one quiet line and the one thing to do
 * about it. Every such state reads the same, so an empty project and a link that
 * leads nowhere are told apart by their words, never by a different page.
 */
function ReaderNotice({
  children,
  action,
  onAction,
}: {
  children: ReactNode;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="reader-notice">
      <p>{children}</p>
      <button type="button" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

/**
 * Nothing to read yet. Adding documents is the setup's job, so this is the way
 * into it — not a second invitation competing with the setup for the same step.
 */
function EmptyProject({
  projectName,
  onCreateProject,
  onAddDocuments,
}: {
  projectName: string | null;
  onCreateProject: () => void;
  onAddDocuments: () => void;
}) {
  return projectName ? (
    <ReaderNotice action="Guided import" onAction={onAddDocuments}>
      Nothing to read in <b>{projectName}</b> yet.
    </ReaderNotice>
  ) : (
    <ReaderNotice action="New project" onAction={onCreateProject}>
      No projects yet.
    </ReaderNotice>
  );
}

/**
 * A document the reader cannot open.
 *
 * One sentence for every reason: deleted, never existed, or belongs to somebody
 * else. The API cannot tell those apart either — a project that is not yours
 * answers 404 exactly as a missing one does, so that a stranger with a guessed id
 * learns nothing — and this is the other half of that promise. Wording that
 * varied by cause would leak precisely what the 404 is there to withhold.
 */
function MissingDocument({ onGoHome }: { onGoHome: () => void }) {
  return (
    <ReaderNotice action="Back to your library" onAction={onGoHome}>
      We can&rsquo;t find that document.
    </ReaderNotice>
  );
}

/** A route is valid but its one-slot project cache is still catching up. */
function ProjectLoading() {
  return (
    <div className="reader-loading" role="status">
      <PagesMark />
      <LoadingCaption text="Opening…" />
    </div>
  );
}

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <div className="loading-status" role="status">
        <PagesMark />
        <LoadingCaption text="Opening Delphi…" />
      </div>
    </main>
  );
}

function ProcessingDocumentBanner({ name }: { name: string }) {
  return (
    <aside
      className="processing-document-banner"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <NoticeMark state="running" />
      <span>
        <strong title={name}>{name}</strong> is being processed
      </span>
    </aside>
  );
}
