"use client";

/**
 * The conversation panel.
 *
 * Owns the visible composer, transcript and tools. Conversation sessions keep
 * drafts and stream ownership outside the mounted view, so switching tabs or
 * scopes never redirects an answer or aborts background work.
 */

import { ConversationRail, conversationQuery, conversationsChanged } from "./chat/ConversationRail";
import { conversationKey, sessionFor, sessionCell, type ConversationSummary } from "../lib/conversation-session";
import { useConversationField } from "../lib/use-conversation";
import { transcriptScroll } from "../lib/transcript-scroll";
import { isCapacityWait } from "../lib/backfill";
import { usePlanCapacity } from "./chat/PlanCapacity";
import { ModeTag } from "./chat/ModeTag";
import { ChatMode, nextChatMode, isModeShortcut } from "../lib/chat-mode";
import { chatEffort } from "../lib/chat-model-policy";
import {
  type ClipboardEvent,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type MutableRefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  API_BASE,
  isWebPdf,
  api,
  type AppConfig,
  type ChatImage,
  type ChatMessage,
  type ChatThreadRead,
  type ComposerChoice,
  type ChatViewport,
  type DashboardData,
  type DashboardDocument,
  isDone,
  type MemoryPageSummary,
  type PersonaSummary,
  type Paper,
  type Project,
} from "../lib/api";
import {
  applyTraceEvent,
  EMPTY_LIVE_TRACE,
  isAnswerTrace,
  type LiveTrace,
  type TraceEvent,
} from "../lib/answer-trace";
import { cutOffNotice, incompleteOf } from "../lib/answer-ending";
import { normalizeSources, storedSources } from "../lib/web-sources";
import { AnswerSources } from "./AnswerSources";
import { readSseStream } from "../lib/sse";
import { requestMemoryMaintenance } from "../lib/memory-maintenance";
import { MEMORY_PAGES_CHANGED, knownPages, samePages, type KnownPages } from "../lib/memory";
import { citationCandidates, type CitationTarget, mentionedPapers, paperAliases } from "../lib/citations";
import { routeCitation } from "../lib/citation-route";
import { librarySectionOwners, sectionOwnerLookup } from "../lib/anchor-index";
import type { LocatorHit } from "../lib/locator-index";
import {
  AnswerFlow,
  ComposerToggle,
  EFFORT_LABELS,
  modelLabel,
  ModelPill,
  SUPPORTED_MODELS,
  PersonaPill,
  SelectedPassage,
} from "./ChatBits";
import { MemoAssistantMessage } from "./markdown";
import { DEFAULT_PERSONA_ID } from "../lib/personas";
import {
  compactPaperMentionTokens,
  expandPaperMentionTokens,
  paperMentionToken,
} from "../lib/paper-mention";
import { ConversationScopeMenu, ConversationWindowControls, type ContextChats } from "./chat/ConversationMenus";
import { MemoizedMemoryBody } from "./MemoryMarkdown";
import { ArtifactAsk } from "./InlineArtifact";
import {
  availableContexts,
  chatRequestScope,
  COMPOSER_PLACEHOLDER,
  COMPOSER_PLACEHOLDER_SHORT,
  SIDE_CHAT_HINT,
  scopeLabel,
  type ChatContext,
  type ChatTarget,
} from "../lib/chat-scope";
import { imageDropHint, isAcceptedImageFile } from "../lib/file-drag";
import { useImageDrop } from "../lib/use-file-drop";
import {
  handleComposerPaste,
  MentionField,
  type MentionFieldHandle,
  type MentionTab,
} from "./chat/MentionField";
import { hint, type Notice } from "./Notice";
import { SideChat } from "./chat/SideChat";
import { chatOwnsZoom, useStoredZoom, zoomDirection } from "../lib/use-text-zoom";
import { SIDE_COMMAND, closeSideChat, openSideChat, sideBounds, sideChatExtra, sideCommand, sideSplit } from "../lib/side-chat";

/**
 * One thumbnail in the strip above the composer, in the order it was attached.
 *
 * The strip — not the draft text — is the record of what this question carries,
 * so an image can be attached without touching a half-typed sentence. A token
 * is only written when the reader asks for one by @-mentioning an earlier
 * image, and `viaToken` is what lets deleting that text take the thumbnail with
 * it: an attachment the reader cannot see themselves remove is one they will
 * not believe is gone.
 */
type ComposerImage = {
  localId: string;
  previewUrl: string;
  image?: ChatImage;
  /** Present until send: a dropped file is not a conversation's yet. */
  file?: File;
  uploading: boolean;
  error?: string;
  viaToken?: boolean;
};

/**
 * The one thing a row has to say about an expiring image — and only near the
 * end.
 *
 * An upload date and a far-off expiry date are two more lines of grey text in a
 * menu whose whole job is to be skimmed, and neither changes the decision being
 * made. The clock only becomes information once it is about to matter, so it is
 * silent until then and pointed when it speaks.
 */
const EXPIRY_NOTICE_DAYS = 7;
/*
 * How long the card spends travelling between the rail and full screen.
 *
 * One number for both directions, and it is the *only* one: the movement is
 * driven from JavaScript against measured boxes (see `flyCard`), so nothing in
 * the stylesheet has to be kept in step with it. Written in CSS, the two ends
 * of the journey were a guess — the expanded size is a share of the window and
 * the docked size is whatever the reader has dragged their rail to, so the
 * card grew past its target and came back, and collapsing landed it on the
 * grid track's width rather than on the rail's, then shrank again once the
 * class came off. Both were the same mistake: animating toward a geometry
 * nobody had measured.
 */
const FULLSCREEN_MOVE_MS = 280;
const FULLSCREEN_MOVE_EASE = "cubic-bezier(0.32, 0.08, 0.24, 1)";
// One empty list for every Memory answer, so a render does not remount them.
const NO_FIGURES: [] = [];
/** Side chat widths the reader dragged, docked and expanded, for this app session. */
const sideDragged: Record<"docked" | "expanded", number | null> = { docked: null, expanded: null };
const SIDE_COMMANDS = [SIDE_COMMAND];
/** Whether any chat has had an answer this app session; until one has, every
    empty composer shows `SIDE_CHAT_HINT`, and the first answer retires it in all of them. */
let answeredThisSession = false;
const answeredListeners = new Set<() => void>();
function markAnswered() {
  if (answeredThisSession) return;
  answeredThisSession = true;
  answeredListeners.forEach((listener) => listener());
}
function useAnsweredThisSession() {
  return useSyncExternalStore(
    (listener) => { answeredListeners.add(listener); return () => { answeredListeners.delete(listener); }; },
    () => answeredThisSession,
    () => answeredThisSession,
  );
}
/** Longer than the column's 340ms grow, so a card that will have room never flashes an overlay. */
const SIDE_SETTLE_MS = 420;

function expiryNote(expiresAt: string): string | null {
  const days = Math.ceil(
    (new Date(expiresAt).getTime() - Date.now()) / 86_400_000,
  );
  if (days > EXPIRY_NOTICE_DAYS) return null;
  if (days <= 1) return "Expires today";
  return `Expires in ${days} days`;
}

export function ChatPanel(props: Omit<ComponentProps<typeof ConversationChatPanel>, "conversation" | "conversationTabs" | "conversationChats" | "ensureConversation" | "conversationTools"> & { seedConversation?: ConversationSummary }) {
  const target: ChatTarget = props.context === "general" ? { context: "general" }
    : { context: "document", projectId: props.project?.id ?? "", paperId: props.paper?.id ?? "" };
  return <ConversationRail target={target} seedConversation={props.seedConversation} titleMaxCharacters={props.config.conversationTitleMaxCharacters} onNotice={props.onNotice} onClose={props.onClose}>
    {({ conversation, tabs, tools, chats, ensureConversation }) => <ConversationChatPanel {...props}
      key={conversationKey(conversation)} conversation={conversation} conversationTabs={tabs} conversationChats={chats}
      ensureConversation={ensureConversation} conversationTools={tools}
      seedQuestion={!props.seedConversation || props.seedConversation.id === conversation.id ? props.seedQuestion : ""} />}
  </ConversationRail>;
}

function ConversationChatPanel({
  conversation,
  conversationTabs,
  conversationChats,
  ensureConversation,
  conversationTools,
  project,
  paper,
  context,
  onContextChange,
  config,
  onNotice,
  onCitation,
  onDigestStatus,
  onOpenPage,
  seedQuestion,
  seedRequestId,
  seedChoice,
  seedSelectedText,
  seedImageIds,
  seedReferencedPaperIds,
  seedPersonaId,
  openPageSlug,
  onSeedConsumed,
  onClose,
  onFullscreenChange,
  initialFullscreen = false,
  dockedBoxRef: dockedBoxProp,
  leaving = false,
  nudge = 0,
  personas,
  onManagePersonas,
  getViewport,
  viewportOffHome,
  onEvidenceCitation,
  onSideChatChange,
}: {
  conversation: ConversationSummary;
  conversationTabs: ReactNode;
  conversationChats: ContextChats;
  ensureConversation: () => Promise<ConversationSummary>;
  conversationTools: ReactNode;

  project: Project | null;
  paper: Paper | null;
  /**
   * Which evidence this conversation is asked against. The component is keyed
   * on `scopeKey(target)` by its parent, so this never changes under a mounted
   * surface — switching context mounts a different conversation.
   */
  context: ChatContext;
  /** With a conversation, that chat of the other context opens as it switches. */
  onContextChange: (value: ChatContext, conversationId?: string) => void;
  config: AppConfig;
  onNotice: (notice: Notice) => void;
  /**
   * The reader's own affordances, and why they are optional rather than
   * branched on inside.
   *
   * Citations open a document, the viewport is the page a reader is looking
   * at, and the persona row edits the *project's* persona — none of which the
   * account-wide conversation has. Passing them or not is how a shell says
   * which it is, so this component never has to ask.
   */
  onCitation?: (target: CitationTarget, cited: Paper, hit: LocatorHit | null) => void;
  onDigestStatus?: (paperId: string, digest: NonNullable<Paper["digest"]>) => void;
  /** Opening a wiki page from an answer. Only the wiki shell can do this. */
  onOpenPage?: (slug: string) => void;
  /**
   * A question to ask once, as soon as the thread has loaded.
   *
   * Sent exactly once and then reported consumed, because the address that
   * carried it must not survive a reload — a refresh would otherwise spend a
   * second model call and append a duplicate turn to an append-only thread.
   */
  seedQuestion?: string;
  seedRequestId?: string;
  /**
   * Chat or Plan, the model, effort and web search the Ask composer showed when
   * this question was sent. Seeded like the persona: they answer this question,
   * and the conversation's own pills, moved to match, own the choice after it.
   * A question that never passed through the composer carries none.
   */
  seedChoice?: ComposerChoice;
  /** A passage Reply quoted before this surface existed, sent with the seed. */
  seedSelectedText?: string;
  /** Images already uploaded against this scope by the floating composer. */
  seedImageIds?: string[];
  /** Documents the floating composer `@`-mentioned in the seeded question. */
  seedReferencedPaperIds?: string[];
  /**
   * The persona the Ask composer was set to when this question was written.
   *
   * Applied before the seeded question is sent, so a persona picked in the
   * composer is the one that answers it. It is only a seed: once the
   * conversation exists, its own pill owns the choice.
   */
  seedPersonaId?: string;
  /** The Memory page this conversation sits beside, on the Memory view. */
  openPageSlug?: string;
  onSeedConsumed?: () => void;
  /** Present when this surface is a dismissable panel rather than a column. */
  onClose?: () => void;
  onFullscreenChange?: (open: boolean) => void;
  /**
   * Expanded or docked at mount, and where "docked" is on the screen.
   *
   * Both exist for the same reason the context pill takes a `previous`: this
   * surface is **remounted** when the scope changes, so anything it discovers
   * for itself is lost the moment the reader switches context. Owning the flag
   * internally meant expanding the panel and then choosing Project dropped it
   * back into the rail, which is not what changing the subject asks for. The
   * box has to outlive the remount too, or the card has nowhere to collapse
   * back to and the exit becomes a jump.
   */
  initialFullscreen?: boolean;
  dockedBoxRef?: MutableRefObject<DOMRect | null>;
  /** Playing its exit: still mounted, on its way out. */
  leaving?: boolean;
  /**
   * A counter the shell bumps to say "it is already open, here it is".
   *
   * A counter rather than a boolean, and read as its parity rather than as its
   * value: the two classes carry the same keyframes under different names, so
   * every press swaps which one applies and the browser restarts the animation.
   * A boolean would need a timer to clear it, and a timer that disagreed with
   * the CSS would either cut the stamp short or swallow the next one.
   */
  nudge?: number;
  /**
   * Every persona this account can answer as: the officials and its own.
   * Which one *this* conversation is held in is not a prop — it is a property
   * of the conversation, loaded with the thread and owned here.
   */
  personas: PersonaSummary[];
  /** Opens Settings → Persona. Absent on a shell with no settings sheet. */
  onManagePersonas?: () => void;
  getViewport?: (quote?: string) => Promise<ChatViewport | null> | ChatViewport | null;
  viewportOffHome?: boolean;
  onEvidenceCitation?: (
    target: CitationTarget,
    cited: Paper,
    evidence: NonNullable<ChatMessage["viewportEvidence"]>,
    hit: LocatorHit | null,
  ) => void;
  /**
   * Whether this conversation's side chat is open, so the shell can widen
   * the docked column for it. Reported on every change and as false on
   * unmount: switching tabs mounts another conversation, which reports its own.
   */
  onSideChatChange?: (open: boolean) => void;
}) {
  const session = sessionFor(conversationKey(conversation));
  const identity = sessionCell(session, "identity", conversation);
  const submission = sessionCell(session, "submission", false);
  const capacity = usePlanCapacity(`${context}:${project?.id ?? ""}:${paper?.id ?? ""}`);
  const [messages, setMessages] = useConversationField<ChatMessage[]>(session, "messages", []);
  const [draft, setDraft] = useConversationField(session, "draft", "");
  /* Seeded rather than pushed in by an effect: the floating composer can be
     opened by Reply while no chat is docked, and the quote has to be in place
     before the seeded question is sent — `send` reads this state. */
  const [selectedText, setSelectedText] = useConversationField(session, "selectedText", seedSelectedText ?? "");
  const [quoteExpanded, setQuoteExpanded] = useState(false);
  const [messageSelection, setMessageSelection] = useState<
    { text: string; x: number; y: number } | null
  >(null);
  const [quoteClipped, setQuoteClipped] = useState(false);
  // A ref callback rather than an effect: it runs after layout, so the clamped
  // height is already known and we can say whether anything is hidden.
  const measureQuote = useCallback((node: HTMLParagraphElement | null) => {
    if (node) setQuoteClipped(node.scrollHeight - node.clientHeight > 2);
  }, []);
  // /api/config answers after the first render, so an untouched selection has
  // to fall back to whatever the server ends up offering — same pattern as the
  // model, with no local hardcoded default.
  // A surface mounted to answer a composer's question starts on its pills, so
  // they never show the defaults for the moment before the seed is sent.
  const [chatMode, setChatMode] = useConversationField<ChatMode>(session, "chatMode", seedChoice?.mode ?? ChatMode.Chat);
  const planMode = chatMode === ChatMode.Plan;
  const [chosenEffort, setChosenEffort] = useConversationField(session, "chosenEffort", seedChoice?.effort ?? "");
  const [chosenModel, setChosenModel] = useConversationField(session, "chosenModel", seedChoice?.model ?? "");
  // One resolution for the pills and for a seeded request, so a question sent
  // with the composer's choice uses exactly what the pills then show.
  const resolveModel = (chosen: string) =>
    config.models.includes(chosen) ? chosen : config.defaultModel;
  const resolveEffort = (forModel: string, chosen: string) =>
    chatEffort(forModel, chosen, config.modelReasoningEfforts, config.defaultReasoningEffort);
  const model = resolveModel(chosenModel);
  const effort = resolveEffort(model, chosenEffort);
  const [streaming, setStreaming] = useConversationField(session, "streaming", false);
  const answered = useAnsweredThisSession();
  const [sideOpen] = useConversationField(session, "sideOpen", false);
  const [savingPlan, setSavingPlan] = useConversationField(session, "savingPlan", false);
  const savingPlanRef = sessionCell(session, "savingPlan", false);
  const [streamingMode, setStreamingMode] = useConversationField<ChatMode>(session, "streamingMode", ChatMode.Chat);
  const [trace, setTrace] = useConversationField<LiveTrace>(session, "trace", EMPTY_LIVE_TRACE);
  const [referencedPaperIds, setReferencedPaperIds] = useConversationField<string[]>(session, "referencedPaperIds", []);
  const [images, setImages] = useConversationField<ChatImage[]>(session, "images", []);
  const [editing, setEditing] = useState(false);
  const composerSnapshotRef = useRef<{
    draft: string;
    images: ComposerImage[];
    referencedPaperIds: string[];
    selectedText: string;
    chosenModel: string;
    chosenEffort: string;
  } | null>(null);
  // A thumbnail can 404 for reasons its record doesn't carry (bytes lost to
  // an interrupted write, a reaper racing a read) even while unexpired and
  // still listed. The browser's own broken-image glyph doesn't tell the
  // reader that — this tracks which ids failed so the UI can say so instead.
  const [brokenImageIds, setBrokenImageIds] = useState<Set<string>>(new Set());
  const markImageBroken = (imageId: string) =>
    setBrokenImageIds((current) => {
      if (current.has(imageId)) return current;
      const next = new Set(current);
      next.add(imageId);
      return next;
    });
  const [composerImages, setComposerImages] = useConversationField<ComposerImage[]>(session, "composerImages", () =>
    [],
  );
  const [threadLoaded, setThreadLoaded] = useConversationField(session, "threadLoaded", false);
  const [fullscreen, setFullscreen] = useState(initialFullscreen);
  /** The conversation's text size: Cmd+plus, minus and zero while the chat has the reader's attention. */
  const [textZoom, stepTextZoom] = useStoredZoom("delphi.chat-zoom");
  useEffect(() => {
    const change = (event: Event) => {
      const direction = zoomDirection(event);
      if (direction !== null && chatOwnsZoom()) stepTextZoom(direction);
    };
    window.addEventListener("delphi-page-zoom", change);
    return () => window.removeEventListener("delphi-page-zoom", change);
  }, [stepTextZoom]);
  const [collapsing, setCollapsing] = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* The card itself, and the box it occupies when docked. Expanding is a
     measured move between two real rectangles, so both have to be readable
     from here. */
  const cardRef = useRef<HTMLElement>(null);
  const ownDockedBoxRef = useRef<DOMRect | null>(null);
  const dockedBoxRef = dockedBoxProp ?? ownDockedBoxRef;
  const flightRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Take the inline geometry back off, so the card is sized by the stylesheet
     again the moment it has stopped moving. Leaving it on would pin an
     expanded card to the viewport it was expanded in. */
  const settleCard = useCallback(() => {
    if (flightRef.current) {
      clearTimeout(flightRef.current);
      flightRef.current = null;
    }
    const card = cardRef.current;
    if (!card) return;
    card.style.transition = "";
    card.style.position = "";
    card.style.margin = "";
    card.style.left = "";
    card.style.top = "";
    card.style.width = "";
    card.style.height = "";
  }, []);
  /*
   * Move the card from one measured box to another — a FLIP, minus the scale.
   *
   * `transform` would be cheaper and is wrong here: the two boxes differ far
   * more in width than in height, so a scaled card is a card of squashed text.
   * Animating `left`/`top`/`width`/`height` costs a layout a frame and lays
   * the paragraphs out honestly at every width it passes through.
   *
   * `settle` says who takes the inline styles off. Expanding, it is this
   * timer, once the card has arrived at the geometry the stylesheet would give
   * it anyway. Collapsing, it must be the class change — clearing on a timer
   * of the same length is a race, and losing it snaps the card back to full
   * screen for a frame before it disappears.
   */
  const flyCard = useCallback(
    (from: DOMRect, to: DOMRect, settle: boolean) => {
      const card = cardRef.current;
      if (!card) return;
      if (flightRef.current) {
        clearTimeout(flightRef.current);
        flightRef.current = null;
      }
      card.style.transition = "none";
      card.style.position = "fixed";
      card.style.margin = "0";
      card.style.left = `${from.left}px`;
      card.style.top = `${from.top}px`;
      card.style.width = `${from.width}px`;
      card.style.height = `${from.height}px`;
      // Commit the starting frame. Without this read the browser only ever
      // sees the destination and there is nothing to transition from.
      void card.getBoundingClientRect();
      const ease = FULLSCREEN_MOVE_EASE;
      card.style.transition = [
        `left ${FULLSCREEN_MOVE_MS}ms ${ease}`,
        `top ${FULLSCREEN_MOVE_MS}ms ${ease}`,
        `width ${FULLSCREEN_MOVE_MS}ms ${ease}`,
        `height ${FULLSCREEN_MOVE_MS}ms ${ease}`,
      ].join(", ");
      card.style.left = `${to.left}px`;
      card.style.top = `${to.top}px`;
      card.style.width = `${to.width}px`;
      card.style.height = `${to.height}px`;
      if (settle) flightRef.current = setTimeout(settleCard, FULLSCREEN_MOVE_MS);
    },
    [settleCard],
  );
  const enterFullscreen = useCallback(
    (next: boolean) => {
      // Where it is now, before the class that moves it is applied.
      if (next) {
        dockedBoxRef.current = cardRef.current?.getBoundingClientRect() ?? null;
        setCollapsing(false);
      }
      setFullscreen(next);
      onFullscreenChange?.(next);
    },
    [dockedBoxRef, onFullscreenChange],
  );
  /* Expanding: the class is already on, so the card's own box *is* the target.
     Nothing is assumed about how big that is — which is what stopped it
     overshooting to the full viewport and coming back. */
  /* Whether this pass is the surface's first. A scope switch remounts the
     whole panel, and one that mounts already expanded has not *travelled* —
     replaying the flight there would make changing the subject look like the
     card being expanded again from a rail it never went back to. */
  const firstLayoutRef = useRef(true);
  useLayoutEffect(() => {
    const first = firstLayoutRef.current;
    firstLayoutRef.current = false;
    if (!fullscreen) {
      settleCard();
      return;
    }
    if (first) return;
    const card = cardRef.current;
    const from = dockedBoxRef.current;
    if (!card || !from) return;
    flyCard(from, card.getBoundingClientRect(), true);
  }, [dockedBoxRef, fullscreen, flyCard, settleCard]);
  /* `is-collapsing` has to survive the paint that drops `is-fullscreen`.
     Clearing both in one tick let the rail interpolate height from the
     overlay's 100vh. This effect must not share a dependency list with the
     expand flight: putting `collapsing` there re-ran that flight the moment
     collapse started, so the card shrank, grew back to the overlay, then
     shrank again when the class finally came off. */
  useLayoutEffect(() => {
    if (fullscreen || !collapsing) return;
    const frame = requestAnimationFrame(() => setCollapsing(false));
    return () => cancelAnimationFrame(frame);
  }, [collapsing, fullscreen]);
  /*
   * Leaving full screen is a movement, not a swap.
   *
   * The card is `position: fixed` while expanded, so dropping the class put it
   * back in the rail on the next frame with nothing in between — and clicking
   * the backdrop appeared to do nothing at all until the eye caught up. It now
   * spends `FULLSCREEN_MOVE_MS` collapsing toward the rail's own geometry
   * before the class comes off, so the card shrinks into the place it is about
   * to occupy.
   */
  const leaveFullscreen = useCallback(() => {
    if (collapseTimer.current) return;
    const card = cardRef.current;
    const home = dockedBoxRef.current;
    // Back to the box it left, exactly. The class comes off at the end of the
    // journey rather than the start, so there is no frame in which the card is
    // some third size belonging to neither state. `is-collapsing` stays on
    // across that class change — see the effect above — so the rail does not
    // interpolate from the overlay's 100vh on the way in.
    if (card && home) flyCard(card.getBoundingClientRect(), home, false);
    setCollapsing(true);
    collapseTimer.current = setTimeout(() => {
      collapseTimer.current = null;
      enterFullscreen(false);
    }, FULLSCREEN_MOVE_MS);
  }, [dockedBoxRef, enterFullscreen, flyCard]);
  useEffect(
    () => () => {
      if (collapseTimer.current) clearTimeout(collapseTimer.current);
      if (flightRef.current) clearTimeout(flightRef.current);
    },
    [],
  );
  /* Escape leaves full screen and stops there. It does not go on to close the
     panel: on the Reader that key already dismisses note cards and popovers,
     and one press should undo one thing. */
  useEffect(() => {
    if (!fullscreen) return;
    /* React's own `KeyboardEvent` is imported into this file and shadows the
       DOM one, which is not what `addEventListener` hands us. */
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) leaveFullscreen();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [fullscreen, leaveFullscreen]);
  /* The editor holds the draft; this is the mirror the send path reads and the
     handle that empties it. */
  const composerRef = sessionCell<MentionFieldHandle | null>(session, "composer", null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /* The strip, as a ref: a second drop landing before the first has
     re-rendered would otherwise read a stale length and blow past the cap. */
  const composerImagesRef = useRef<ComposerImage[]>(composerImages);
  const streamAbortRef = sessionCell<AbortController | null>(session, "controller", null);
  const streamRequestIdRef = sessionCell<string | null>(session, "requestId", null);
  const seededRef = sessionCell(session, "seeded", "");
  const projectId = project?.id;
  const paperId = paper?.id;
  /**
   * Which conversation this mount is, as one value.
   *
   * Every request below derives its ids from this rather than reading
   * `project`/`paper` again, so a scope can never be half-applied. A Memory
   * conversation beside a document carries it as `open`: named on the
   * question, never part of which thread this is.
   */
  const target: ChatTarget =
    context === "general"
      ? {
          context: "general",
          ...(projectId && paperId ? { open: { projectId, paperId } } : {}),
          ...(openPageSlug ? { page: openPageSlug } : {}),
        }
      : { context: "document", projectId: projectId ?? "", paperId: paperId ?? "" };
  const scopeParams = () => new URLSearchParams(conversationQuery(target, identity.current));
  /* Which scopes this mount can even offer. A project is the signal: the wiki
     mounts with none, and without one there is no document and no project to
     narrow to — so General is not merely the default there, it is the only
     honest option. Hardcoding `inReader: true` put a Document chip on the
     wiki's pill that could never resolve to anything. */
  const contextOptions = availableContexts({
    inReader: Boolean(projectId),
    hasPaper: Boolean(paperId),
  });
  const isGeneral = context === "general";
  /** Memory asked beside a document: the one case that scope names one. */
  const besideDocument = isGeneral && Boolean(projectId && paperId);
  /**
   * The persona this conversation is held in.
   *
   * Owned here rather than by the shell, which is the whole of "per
   * conversation": a shell hosts several conversations at once — a docked
   * reader chat, a project chat, the account-wide one — and one string up
   * there would have been all of them sharing a persona again, which is the
   * thing being fixed. `null` means the reader has not chosen and the stored
   * thread has not said, so the default answers.
   */
  const [personaId, setPersonaId] = useConversationField<string | null>(session, "personaId", null);
  /** Set once the reader picks, so a late thread load cannot overwrite them. */
  const personaChosenRef = sessionCell(session, "personaChosen", false);
  /** One engagement per conversation visit, so its title is written once per visit rather than per question. */
  const engagementId = sessionCell(session, "engagementId", crypto.randomUUID().replaceAll("-", "_"));
  /**
   * Remember the choice before anything has been asked in it.
   *
   * The stream stamps whichever persona answered, so this only covers the gap
   * between picking and sending — but without it, choosing a persona and
   * reloading loses it, and the pill contradicts itself on the next visit.
   * Fire-and-forget: the menu closes on the click, and a failed write is worth
   * a notice rather than a blocked control.
   */
  const choosePersona = (next: string) => {
    personaChosenRef.current = true;
    setPersonaId(next);
    if (!scopeReady || identity.current.provisional) return;
    void api(`/api/chat/persona?${scopeParams()}`, {
      method: "PUT",
      body: JSON.stringify({ persona_id: next }),
    }).catch(() => onNotice("Could not remember that persona"));
  };
  /** Whether this scope has the ids its requests need. */
  const scopeReady = isGeneral || Boolean(projectId && paperId);
  // The pages a `[[slug]]` can open. An answer in either scope names Memory
  // pages by slug, and a link is drawn by its page's title and kind — a name
  // with no page is plain text — so the pages have to be known before one is
  // rendered. Metadata only. Read again when an answer finishes: a page filed
  // since the panel opened can be the one the answer names. And again when the
  // reader deletes pages (`MEMORY_PAGES_CHANGED`), or a name stays a dead link.
  // A panel that mounts mid-answer still reads once, and a read is dropped
  // only by a newer one or by unmounting, never by an answer starting.
  const [linkable, setLinkable] = useState<KnownPages>(() => new Map());
  const [pagesChanged, setPagesChanged] = useState(0);
  useEffect(() => {
    const changed = () => setPagesChanged((count) => count + 1);
    window.addEventListener(MEMORY_PAGES_CHANGED, changed);
    return () => window.removeEventListener(MEMORY_PAGES_CHANGED, changed);
  }, []);
  const pageReads = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!config.memoryEnabled || (streaming && pageReads.current > 0)) return;
    const read = ++pageReads.current;
    void api<MemoryPageSummary[]>("/api/memory/pages")
      .then((pages) => {
        if (!mounted.current || read !== pageReads.current) return;
        const next = knownPages(pages);
        setLinkable((known) => samePages(known, next));
      })
      .catch(() => undefined);
  }, [config.memoryEnabled, streaming, pagesChanged]);
  /**
   * Every document in the account, for a Memory conversation: its answers cite
   * papers in any project, and a citation is followed into the one that holds
   * it. Records only, read as the pages above are, and again when an answer
   * finishes, since it may cite a document filed meanwhile.
   */
  const [library, setLibrary] = useState<DashboardDocument[]>([]);
  const libraryReads = useRef(0);
  useEffect(() => {
    if (!isGeneral || (streaming && libraryReads.current > 0)) return;
    const read = ++libraryReads.current;
    void api<DashboardData>("/api/dashboard")
      .then((data) => {
        if (!mounted.current || read !== libraryReads.current) return;
        const next = data.projects.flatMap((item) => item.documents);
        const key = (documents: DashboardDocument[]) =>
          documents.map((item) => `${item.projectId}/${item.id}/${item.slug}/${item.projectSlug}/${item.title}`).join("\n");
        setLibrary((known) => (key(known) === key(next) ? known : next));
      })
      .catch(() => undefined);
  }, [isGeneral, streaming]);
  /** The documents this conversation's citations are placed among, and the one on screen. */
  const citable = useMemo<Paper[]>(() => (isGeneral ? library : project?.papers ?? []), [isGeneral, library, project?.papers]);
  const here = useMemo<Paper | null>(() => {
    if (!isGeneral) return paper;
    if (!besideDocument || !paper) return null;
    return library.find((item) => item.id === paper.id)
      ?? (project ? { ...paper, projectId: project.id, projectName: project.name, projectSlug: project.slug } : null);
  }, [isGeneral, besideDocument, paper, library, project]);
  // What an answer's Sources list names besides the web: the passages its
  // citations can be followed into, in this conversation's library.
  const referenceScope = useMemo(
    () => ({ pages: linkable, papers: citable, aliases: paperAliases(citable), current: here?.title }),
    [linkable, citable, here?.title],
  );
  /**
   * What this scope lets an `@` reach.
   *
   * A Document or Project question may name the project's other active
   * documents; the account-wide one may not, because there is no project to
   * resolve a reference against and the server refuses one there — offering
   * the menu would be offering a reference that cannot exist. Images are
   * reusable in every scope, which is why General still gets the menu, with
   * the Images tab alone and no tab strip to choose between.
   */
  const mentionablePapers = isGeneral
    ? []
    : (project?.papers ?? [])
        .filter((item) => item.id !== paperId)
        .filter((item) => !isDone(item));
  const mentionTabs: MentionTab[] = isGeneral
    ? ["images"]
    : ["papers", "images"];

  const updateComposerImages = (
    next: (items: ComposerImage[]) => ComposerImage[],
  ) => {
    composerImagesRef.current = next(composerImagesRef.current);
    setComposerImages(composerImagesRef.current);
  };

  const restoreComposerSnapshot = () => {
    const resume = composerSnapshotRef.current;
    composerSnapshotRef.current = null;
    if (!resume) return false;
    const resumeIds = new Set(resume.images.map((item) => item.localId));
    for (const item of composerImagesRef.current) {
      if (item.file && !resumeIds.has(item.localId)) {
        URL.revokeObjectURL(item.previewUrl);
      }
    }
    setDraft(resume.draft);
    setSelectedText(resume.selectedText);
    setReferencedPaperIds(resume.referencedPaperIds);
    setChosenModel(resume.chosenModel);
    setChosenEffort(resume.chosenEffort);
    updateComposerImages(() => resume.images);
    return true;
  };

  /* A failed upload keeps its tile so the reader knows it failed, but it holds
     no slot: nothing was attached. */
  const attachedCount = (items: ComposerImage[]) =>
    items.filter((item) => !item.error).length;
  const attachedImages = composerImages
    .map((item) => item.image)
    .filter((image): image is ChatImage => Boolean(image));
  const referencedPapers = referencedPaperIds
    .map((id) => project?.papers.find((item) => item.id === id))
    .filter((item): item is Paper => Boolean(item));
  // Every scope can carry an image now, including the account-wide one.
  const canAttach = scopeReady;
  const attachmentsFull =
    attachedCount(composerImages) >= config.chatImageMaxPerQuestion;
  /* Keyed on the scope being answerable, not on there being a project: the
     account-wide conversation carries images too, and gating on `projectId`
     left its thumbnails pointed at the empty string. */
  const imageUrl = (imageId: string, variant: "image" | "thumbnail") =>
    scopeReady
      ? `${API_BASE}/api/chat/images/${imageId}/${variant}?${scopeParams()}`
      : "";
  const switchScope = (next: ChatContext, conversationId?: string) => {
    if (next !== context) onContextChange(next, conversationId);
  };
  /**
   * The draft mirror, and the two things that follow from it.
   *
   * A reference and an image token are both spoken for by the text: deleting
   * the chip has to take the thing it named with it, or the question carries
   * an attachment the reader believes they removed.
   */
  const onDraftChange = (value: string) => {
    setDraft(value);
    setReferencedPaperIds((ids) =>
      ids.filter((id) => {
        const item = project?.papers.find((paperItem) => paperItem.id === id);
        return item ? value.includes(paperMentionToken(item.title)) : false;
      }),
    );
    // Only a mention-inserted image is spoken for by the text; an uploaded
    // one lives in the strip and survives any edit.
    updateComposerImages((items) =>
      items.filter(
        (item) =>
          !item.viaToken ||
          !item.image ||
          value.includes(`@[Image #${item.image.number}]`),
      ),
    );
  };

  const onPaperMention = (mentionedPaper: Paper) => {
    setReferencedPaperIds((items) =>
      items.includes(mentionedPaper.id) ? items : [...items, mentionedPaper.id],
    );
  };

  const onImageMention = (image: ChatImage) => {
    const already = composerImagesRef.current.some(
      (item) => item.image?.id === image.id,
    );
    if (!already && attachmentsFull) {
      onNotice(
        hint(`Up to ${config.chatImageMaxPerQuestion} images can travel with one question.`),
      );
      return false;
    }
    updateComposerImages((items) =>
      already
        ? items.map((item) =>
            item.image?.id === image.id ? { ...item, viaToken: true } : item,
          )
        : [
            ...items,
            {
              localId: image.id,
              previewUrl: imageUrl(image.id, "thumbnail"),
              image,
              uploading: false,
              viaToken: true,
            },
          ],
    );
    return true;
  };

  const attachFiles = async (files: File[]) => {
    if (!files.length) return;
    if (!scopeReady) {
      onNotice(hint("Open a document or project chat before attaching an image."));
      return;
    }
    const accepted = files.filter((file) =>
      isAcceptedImageFile(file, config.chatImageMaxSourceMb),
    );
    if (accepted.length !== files.length) {
      onNotice(
        hint(`Images must be PNG, JPEG, or static WebP and under ${config.chatImageMaxSourceMb} MB.`),
      );
    }
    for (const file of accepted) {
      if (attachedCount(composerImagesRef.current) >= config.chatImageMaxPerQuestion) {
        onNotice(
          hint(`Up to ${config.chatImageMaxPerQuestion} images can travel with one question.`),
        );
        break;
      }
      const localId = crypto.randomUUID();
      const previewUrl = URL.createObjectURL(file);
      updateComposerImages((items) => [
        ...items,
        { localId, previewUrl, file, uploading: false },
      ]);
    }
  };

  const imageDrop = useImageDrop((files) => {
    void attachFiles(files);
  });

  const removeComposerImage = async (item: ComposerImage) => {
    updateComposerImages((items) =>
      items.filter((candidate) => candidate.localId !== item.localId),
    );
    if (item.file) URL.revokeObjectURL(item.previewUrl);
    if (!item.image) return;
    if (item.viaToken) {
      composerRef.current?.removeToken(`@[Image #${item.image.number}]`);
    }
    // An image a past question already carries stays in the thread: deleting it
    // would blank the thumbnail on a message the reader can still scroll to.
    if (item.image.used) return;
    try {
      await api(
        `/api/chat/images/${item.image.id}?${scopeParams()}`,
        { method: "DELETE" },
      );
      setImages((items) => items.filter((image) => image.id !== item.image?.id));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not remove image");
    }
  };

  useEffect(() => {
    if (!scopeReady || threadLoaded) return;
    if (conversation.provisional) { setThreadLoaded(true); return; }
    let active = true;
    const query = scopeParams();
    void api<ChatThreadRead>(`/api/chat?${query}`)
      .then((result) => {
        // Prepended, never assigned. A seeded question is sent as soon as the
        // thread is ready and can beat this request home; assigning would
        // throw away the turn already streaming and leave the delta handler
        // writing into an empty array. History is what came *before* whatever
        // is on screen, so prepending is also simply the correct operation.
        if (active) setMessages((current) => [...result.messages, ...current]);
        if (active) setImages(result.images);
        // The same race, for the same reason: this response can land after the
        // reader has already picked from the menu. What is stored is history,
        // so it may only fill a choice that has not been made — never overwrite
        // one. A `null` is "never chosen", which resolves to the default.
        if (active && !personaChosenRef.current && result.personaId) {
          setPersonaId(result.personaId);
        }
        if (active) setThreadLoaded(true);
      })
      .catch((error) => {
        if (active) {
          onNotice(
            error instanceof Error ? error.message : "Could not load chat",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [conversation.id, conversation.generation, threadLoaded, onNotice]);

  /**
   * The one-shot seed, sent once the thread is on screen.
   *
   * Guarded by a ref *and* reported consumed: the ref stops a re-render from
   * re-asking, and telling the parent lets it drop the address that carried
   * the question, which is what stops a reload spending another model call.
   */
  useEffect(() => {
    // A seed that lands while this conversation is still answering waits for
    // the answer rather than being consumed by a send that would refuse it.
    if (seededRef.current === (seedRequestId || seedQuestion) || !seedQuestion || !threadLoaded || streaming) return;
    seededRef.current = seedRequestId || seedQuestion;
    // Two jobs, and only one of them is the request. `choosePersona` moves the
    // pill and persists the pick for later turns; it cannot affect this send,
    // whose `personaId` was captured when this render ran. The request gets the
    // persona passed to it directly, below.
    const seededPersona =
      seedPersonaId && !personaChosenRef.current ? seedPersonaId : undefined;
    if (seededPersona) choosePersona(seededPersona);
    seedImagesRef.current = seedImageIds?.length ? seedImageIds : null;
    seedReferencesRef.current = seedReferencedPaperIds?.length
      ? seedReferencedPaperIds
      : null;
    // The same two jobs for the composer's other pills. This surface may have
    // been mounted before the question arrived, so its pills move here too;
    // the send gets the choice directly because these updates land after it.
    if (seedChoice) {
      setChatMode(seedChoice.mode);
      setChosenModel(seedChoice.model);
      setChosenEffort(seedChoice.effort);
    }
    onSeedConsumed?.();
    void send(seedQuestion, undefined, {
      choice: seedChoice,
      personaId: seededPersona,
      selectedText: seedSelectedText ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedQuestion, seedRequestId, threadLoaded, streaming]);

  useEffect(() => {
    const listener = (event: Event) => {
      const text = (event as CustomEvent<string>).detail;
      setSelectedText(text);
      setQuoteExpanded(false);
      composerRef.current?.focus();
    };
    window.addEventListener("delphi-reply", listener);
    return () => window.removeEventListener("delphi-reply", listener);
  }, []);

  // Let a user select text inside any message bubble — most usefully an
  // unclear assistant answer — and reply to it, the same way a selection in
  // the PDF panel does.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onPointerUp = () => {
      window.setTimeout(() => {
        const selection = window.getSelection();
        const text = selection?.toString().trim();
        if (!selection || !text || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        const anchor =
          range.commonAncestorContainer instanceof Element
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentElement;
        if (!anchor?.closest(".message")) return;
        if (anchor.closest(".composer, .message-edit")) return;
        const box = range.getBoundingClientRect();
        setMessageSelection({
          text,
          x: box.left + box.width / 2,
          y: box.top - 10,
        });
      }, 0);
    };
    node.addEventListener("mouseup", onPointerUp);
    return () => node.removeEventListener("mouseup", onPointerUp);
  }, []);

  useEffect(() => {
    const onSelectionChange = () => {
      if (!window.getSelection()?.toString().trim()) setMessageSelection(null);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  const replyToMessageSelection = () => {
    if (!messageSelection) return;
    window.dispatchEvent(
      new CustomEvent("delphi-reply", { detail: messageSelection.text }),
    );
    window.getSelection()?.removeAllRanges();
    setMessageSelection(null);
  };

  /**
   * Keep the newest turn in view — as a movement only when it *is* one.
   *
   * A single smooth scroll served both "a token arrived" and "a thread just
   * loaded", and the second is not a scroll at all: opening a conversation
   * flew the whole transcript past the reader from the top, which reads as an
   * animation being performed at them rather than as the view settling. The
   * first placement is therefore instant, and so is any jump further than a
   * screen — beyond that distance a smooth scroll is a blur, not a sense of
   * where you are. Only the short hop that streaming produces is animated.
   */
  const placedRef = useRef(false);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const saved = session.cells.get("scrollTop")?.current as number | undefined;
    const next = transcriptScroll({
      placed: placedRef.current, historyLoaded: threadLoaded, saved,
      scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, scrollTop: node.scrollTop,
    });
    if (!next) return;
    node.scrollTo({ top: next.top, behavior: "instant" });
    placedRef.current = next.placed;
  }, [messages, session, threadLoaded]);
  // What settles after a render (a Sources fold read once the answers have
  // painted, an image) keeps a reader who was at the end there. "At the end"
  // is judged against the height before the change: scroll anchoring may
  // already have moved the view by part of it.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    let height = node.scrollHeight;
    const observer = new ResizeObserver(() => {
      if (placedRef.current && node.scrollTop >= height - node.clientHeight - 2) {
        node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
      }
      height = node.scrollHeight;
    });
    for (const child of node.children) observer.observe(child);
    return () => observer.disconnect();
  }, [messages]);
  // The transcript's scrollbar gutter is the platform's width (none with
  // overlay scrollbars), so the composer is told it to match the turns' edges.
  useEffect(() => {
    const node = scrollRef.current, card = cardRef.current;
    if (!node || !card) return;
    const measure = () => card.style.setProperty("--chat-scrollbar", `${node.offsetWidth - node.clientWidth}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const node = scrollRef.current;
    const remember = () => { if (node) sessionCell(session, "scrollTop", 0).current = node.scrollTop; };
    node?.addEventListener("scroll", remember);
    return () => { remember(); node?.removeEventListener("scroll", remember); };
  }, [session]);

  /**
   * Images the floating composer already uploaded for this question.
   *
   * They are consumed by the seeded send and then forgotten: they belong to
   * that one turn, and the composer here starts empty for the next.
   */
  const seedImagesRef = useRef<string[] | null>(null);
  /* Same one-shot handling as the images: a reference belongs to the turn it
     was written in, and the composer here starts clean for the next. */
  const seedReferencesRef = useRef<string[] | null>(null);

    const sendTurn = async (
    forcedPrompt?: string,
    /** The question this one replaces. `retry` asks the same question again
     *  as it was asked, taking nothing from the composer. */
    replacement?: { requestId?: string; retry?: boolean },
    /**
     * The seeded Ask question's composer choice, persona and quote, overriding
     * this surface's state for this one request.
     *
     * Only the seed needs it. `choosePersona` and the pill setters schedule
     * state updates; none has landed by the time the seed effect calls this in
     * the same tick, so the request would otherwise carry the *previous* pills
     * — and an explicit persona id outranks the stored one server-side, so it
     * would win. Passing them here is what makes the composer's picks the ones
     * that answer the question they were written with, rather than a race
     * between a re-render and a round-trip.
     */
    seed?: { choice?: ComposerChoice; personaId?: string; selectedText: string; keepComposer?: boolean },
  ) => {
    const requestModel = seed?.choice ? resolveModel(seed.choice.model) : model;
    const requestEffort = seed?.choice ? resolveEffort(requestModel, seed.choice.effort) : effort;
    // The editor owns compact atomic labels; the model receives full titles.
    const prompt = expandPaperMentionTokens(
      forcedPrompt ?? draft,
      referencedPapers,
    )
      .trim();
    if (!prompt || !scopeReady || streaming || capacity.waiting) return;
    const fromComposer = !forcedPrompt || Boolean(replacement && !replacement.retry);
    // Edits use the visible composer mode; suggestions and questions without a
    // composer choice are Chat.
    const planning = fromComposer ? planMode : seed?.choice?.mode === ChatMode.Plan;
    // Room for the plan is settled before a new chat is created: creating one
    // remounts this panel under its new key, and a capacity check begun in the
    // panel being unmounted is cancelled by its cleanup — the send stopped
    // silently, with no dialog. Storage does not depend on the conversation.
    if (planning && !await capacity.ensure()) return;
    try { identity.current = await ensureConversation(); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Could not create conversation"); return; }
    const seededReferences = seedReferencesRef.current;
    seedReferencesRef.current = null;
    /* A suggestion or a seeded Ask question is a finished prompt: it must
       not pick up whatever happens to be sitting in the composer. An edit
       reuses that composer, so its attachments, quote and mentions travel. */
    const activeReferenceIds = fromComposer
      ? referencedPaperIds
      : (seededReferences ?? []);
    // A seed brings its own quote, never the chip this surface happens to hold.
    const quote = seed ? seed.selectedText : selectedText;
    let viewport: ChatViewport | null = null;
    try { if (context === "document") viewport = await getViewport?.(quote) ?? null; }
    catch (reason) { onNotice(reason instanceof Error ? reason.message : "Could not read the selected page revision"); return; }
    if (composerImagesRef.current.some((item) => item.uploading)) {
      onNotice("Wait for image uploads to finish before sending.");
      return;
    }
    const stagedItems = fromComposer
      ? composerImagesRef.current.filter((item) => item.file)
      : [];
    const mentionedImages = fromComposer
      ? composerImagesRef.current
          .map((item) => item.image)
          .filter((image): image is ChatImage => Boolean(image))
      : [];
    const uploaded: ChatImage[] = [];
    if (stagedItems.length) {
      updateComposerImages((items) =>
        items.map((item) =>
          item.file ? { ...item, uploading: true, error: undefined } : item,
        ),
      );
      try {
        for (const item of stagedItems) {
          const form = new FormData();
          form.set("image", item.file!);
          uploaded.push(
            await api<ChatImage>(`/api/chat/images?${scopeParams()}`, {
              method: "POST",
              body: form,
            }),
          );
        }
      } catch (error) {
        updateComposerImages((items) =>
          items.map((item) =>
            item.file
              ? {
                  ...item,
                  uploading: false,
                  error:
                    error instanceof Error ? error.message : "Upload failed",
                }
              : item,
          ),
        );
        onNotice(error instanceof Error ? error.message : "Upload failed");
        return;
      }
    }
    // The strip is the attachment list, so a reply sent from the reader — which
    // has no composer behind it — carries none of it.
    const activeImages = fromComposer ? [...mentionedImages, ...uploaded] : [];
    const seeded = seedImagesRef.current;
    seedImagesRef.current = null;
    const activeImageIds = seeded ?? activeImages.map((image) => image.id);
    // A seed's images were uploaded by the composer, so the thread this surface
    // loaded before sending already lists them; the turn shows them from there.
    const messageImages = seeded
      ? images.filter((image) => seeded.includes(image.id))
      : activeImages;
    // The account-wide scope has no project to resolve a reference against,
    // and the server refuses one there — so there is nothing to record.
    const messageReferencedPapers = (project?.papers ?? [])
      .filter((item) => activeReferenceIds.includes(item.id))
      .map((item) => ({ id: item.id, title: item.title }));
    const requestId = seed && seedRequestId ? seedRequestId : crypto.randomUUID().replaceAll("-", "_");
    const userMessage: ChatMessage = {
      role: "user",
      content: prompt,
      selectedText: quote || undefined,
      referencedPapers: messageReferencedPapers,
      referencedImages:
        messageImages.map((image) => ({
          id: image.id,
          number: image.number,
        })),
      model: requestModel,
      reasoningEffort: requestEffort,
      requestId,
      viewportUrl: viewport?.url,
    };
    // An edit replaces the last question, so the stale answer after it has to
    // leave the transcript before this prompt is appended — otherwise the
    // failed or outdated reply stays on screen under a question it no longer
    // answers. Earlier turns are left alone.
    const replaceFrom = replacement
      ? (() => {
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].role === "user") return i;
          }
          return messages.length;
        })()
      : messages.length;
    setMessages((items) => [
      ...items.slice(0, replaceFrom),
      userMessage,
      { role: "assistant", content: "", model: requestModel },
    ]);
    setImages((items) => {
      const merged = [...items];
      for (const image of uploaded) {
        if (!merged.some((item) => item.id === image.id)) merged.push(image);
      }
      return merged
        .map((image) =>
          activeImageIds.includes(image.id)
            ? {
                ...image,
                used: true,
                firstUseExcerpt: image.firstUseExcerpt ?? prompt.slice(0, 240),
              }
            : image,
        )
        .sort((a, b) => a.number - b.number);
    });
    setEditing(false);
    // A retry was not written in the composer, so it leaves what is there.
    if (!replacement?.retry && !seed?.keepComposer && !restoreComposerSnapshot()) {
      setDraft("");
      composerRef.current?.clear();
      setSelectedText("");
      setReferencedPaperIds([]);
      for (const item of composerImagesRef.current) {
        if (item.file) URL.revokeObjectURL(item.previewUrl);
      }

      updateComposerImages(() => []);
    }
    setTrace({ ...EMPTY_LIVE_TRACE, startedAt: Date.now() });
    setStreamingMode(planning ? ChatMode.Plan : ChatMode.Chat);
    savingPlanRef.current = false;
    setSavingPlan(false);
    session.values.set("failed", false);
    setStreaming(true);
    const controller = new AbortController();
    streamAbortRef.current = controller;
    streamRequestIdRef.current = requestId;
    try {
      const sendRequest = () => fetch(
        `${API_BASE}/api/chat/stream`,
        {
          method: "POST",
          signal: controller.signal,
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            desktop_mode: planning ? ChatMode.Plan : ChatMode.Chat,
            ...chatRequestScope(target),
            conversation_id: identity.current.id, generation: identity.current.generation,
            referenced_paper_ids: isGeneral ? [] : activeReferenceIds,
            referenced_image_ids: activeImageIds,
            // Memory takes a quoted passage only with the document it is from.
            selected_text: isGeneral && !besideDocument ? null : quote || null,
            reasoning_effort: requestEffort,
            model: requestModel,
            // Every scope, not just general. Sending it only for general left
            // the reader scopes relying on the server reading the stored pick,
            // which `chat_stream` did not do — so they answered as the default
            // whatever the pill showed. Absent means "use the conversation's",
            // which is what a thread nobody has chosen a persona in wants.
            // Only a pick made here, never an id this surface loaded: a
            // persona deleted since would be named explicitly and 404 (inv. 26).
            persona_id: seed?.personaId ?? (personaChosenRef.current ? personaId : null) ?? undefined,
            request_id: requestId,
            replace_request_id: replacement
              ? replacement.requestId || requestId
              : undefined,
            // Refresh the title from this request and response, including a
            // retry after an earlier title request was interrupted.
            engagement_id: engagementId.current,
            viewport,
          }),
        },
      );
      let response = await sendRequest();
      while (planning && response.status === 409) {
        const conflict = await response.clone().json().catch(() => null);
        if (conflict?.code !== "plan_capacity") break;
        // Storage filled after the first check. If this panel was remounted in
        // the meantime it can no longer ask, and the send ends here, cleanly,
        // rather than waiting on a dialog nobody can see; Stop ends it too.
        if (!await capacity.ensure(controller.signal)) {
          if (controller.signal.aborted) throw new DOMException("Stopped", "AbortError");
          throw new Error("Planning paused. Your request is preserved above; send it again when ready.");
        }
        response = await sendRequest();
      }
      if (!response.ok || !response.body) {
        // The server's own reason — "still answering" says wait, not retry.
        const refusal = await response.json().catch(() => null) as { detail?: unknown } | null;
        throw new Error(typeof refusal?.detail === "string" ? refusal.detail : "The model request could not start");
      }
      // The question is stored and the chat has its first title: show it now.
      conversationsChanged();
      for await (const payload of readSseStream(response.body)) {
        if (payload.type === "delta") {
          setMessages((items) => {
            const next = [...items];
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, content: last.content + payload.text };
            return next;
          });
        }
        if (payload.type === "progress") {
          if (payload.stage === "plan_save") {
            savingPlanRef.current = true;
            setSavingPlan(true);
          }
          // Stage reports carry no meaning for the reader, so the line keeps
          // cycling its phrases; a capacity wait only earns the tooltip.
          const waitingForCapacity = isCapacityWait(String(payload.message ?? ""));
          setTrace((current) =>
            current.waitingForCapacity === waitingForCapacity ? current : { ...current, waitingForCapacity },
          );
          if (
            payload.paperId &&
            ["file_upload", "digest_generate", "model_wait", "model_stream"].includes(
              payload.stage,
            )
          ) {
            onDigestStatus?.(payload.paperId, {
              status: "pending",
            });
          }
          if (payload.digestStatus && payload.digest) {
            onDigestStatus?.(payload.paperId, payload.digest);
          }
        }
        if (payload.type === "trace") {
          // The record of how the answer is being reached, one change at a
          // time. The backend builds it and stores it; this only keeps up.
          // `reasoning` and `status` say the same things for a client with a
          // waiting line alone, and are not read here.
          setTrace((current) => ({
            ...current,
            waitingForCapacity: false,
            stretches: applyTraceEvent(current.stretches, payload as unknown as TraceEvent),
          }));
        }
        if (payload.type === "done") {
          markAnswered();
          if (isAnswerTrace(payload.trace)) {
            // Exactly what was stored, attached to the message rather than
            // held beside it, so a reload renders identically.
            const stored = payload.trace;
            setMessages((items) => {
              const next = [...items];
              const last = next[next.length - 1];
              if (last?.role === "assistant") {
                next[next.length - 1] = { ...last, trace: stored };
              }
              return next;
            });
          }
          if (payload.viewportEvidence) {
            setMessages((items) => {
              const next = [...items];
              const last = next[next.length - 1];
              if (last?.role === "assistant") {
                next[next.length - 1] = {
                  ...last,
                  viewportEvidence: payload.viewportEvidence,
                };
              }
              return next;
            });
          }
          // What the answer cites from the web, as it was stored with it.
          const cited = normalizeSources(payload.sources);
          if (cited.length) {
            setMessages((items) => items.map((message, index) =>
              index === items.length - 1 && message.role === "assistant" ? { ...message, sources: cited } : message));
          }
          // Cut off before it finished: marked exactly as it was stored, so
          // the notice a reader sees now is the one a reload shows.
          const incomplete = incompleteOf(payload.incomplete);
          if (incomplete) {
            setMessages((items) => items.map((message, index) =>
              index === items.length - 1 && message.role === "assistant" ? { ...message, incomplete } : message));
          }
          // The assistant append already created durable work. Closing this
          // tab only expires a lease; the next foreground mount resumes it.
          requestMemoryMaintenance(config.memoryEnabled);
        }
        if (payload.type === "error") throw new Error(payload.message);
      }
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      const message = cancelled
        ? (planning ? "Planning stopped. Send your next request in Plan mode to continue from the saved draft." : "Request cancelled.")
        : `Request failed: ${
            error instanceof Error ? error.message : "Chat failed"
          }`;
      setMessages((items) => {
        const next = [...items];
        const last = next[next.length - 1];
        if (last?.role === "assistant") {
          next[next.length - 1] = {
            ...last,
            content: last.content
              ? `${last.content}\n\n${message}`
              : message,
            cancelled,
            error: !cancelled,
          };
        }
        return next;
      });
      session.values.set("failed", !cancelled);
      if (!cancelled) onNotice(message);
    } finally {
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
        streamRequestIdRef.current = null;
      }
      // An answer that finished carries its stored record already. One that was
      // stopped or failed keeps what this tab saw of it, so the work it did
      // before then stays under what it wrote.
      const finished = session.values.get("trace") as LiveTrace | undefined;
      if (finished?.stretches.length) {
        setMessages((items) => {
          const last = items[items.length - 1];
          if (last?.role !== "assistant" || !last.content || last.trace) return items;
          return [...items.slice(0, -1), { ...last, trace: finished.stretches }];
        });
      }
      setTrace(EMPTY_LIVE_TRACE);
      setStreaming(false);
      conversationsChanged();
      savingPlanRef.current = false;
      setSavingPlan(false);
    }
  };

  /**
   * Which click we are answering. Resolving a citation reads the cited
   * document, so a second click — or leaving the paper — can easily land
   * before the first one's answer does, and the stale answer must not then
   * navigate on top of it.
   */
  const citationClick = useRef(0);
  // Changing paper or project invalidates anything still in flight as surely as
  // a second click does.
  useEffect(() => () => {
    citationClick.current += 1;
  }, [paper?.id, project?.id]);

  const openSideFromComposer = useCallback(() => {
    openSideChat(session);
    setDraft("");
    composerRef.current?.clear();
  }, [session, setDraft]);

  const send = async (...args: Parameters<typeof sendTurn>) => {
    // `/side`, alone or with a question, opens the side chat instead of sending.
    const command = !args[0] && !args[1] && !editing && !planMode ? sideCommand(draft).open : null;
    if (command) {
      openSideChat(session, command.question);
      setDraft("");
      composerRef.current?.clear();
      return;
    }
    if (submission.current) return;
    submission.current = true;
    try { await sendTurn(...args); }
    finally { submission.current = false; }
  };
  // An interrupted, empty or oversized diagram offers to ask for it again,
  // without the composer's quote and without clearing what is being typed.
  const askArtifact = (prompt: string) => { void send(prompt, undefined, { selectedText: "", keepComposer: true }); };

  const handleCitation = useCallback(
    (
      target: CitationTarget,
      evidence?: ChatMessage["viewportEvidence"],
      answer = "",
    ) => {
      if (!isGeneral && !project) return;
      const click = ++citationClick.current;
      // A Memory conversation's library spans projects, so each document is
      // read from its own; a document conversation's is the project's.
      const home = (cited: Paper) => (cited as Partial<DashboardDocument>).projectId ?? project?.id;
      void routeCitation(
        target,
        citable,
        here,
        (cited) =>
          `${API_BASE}/api/projects/${home(cited)}/papers/${cited.id}/${isWebPdf(cited) ? "page" : "file"}`,
        mentionedPapers(answer, citable),
        // A superseded click stops the scan it started: the next one is waiting
        // on the same single-threaded extraction.
        () => citationClick.current !== click,
        isGeneral ? librarySectionOwners(library) : sectionOwnerLookup(project!.id, citable),
      ).then((route) => {
        if (!route || citationClick.current !== click) return;
        if (evidence && onEvidenceCitation) onEvidenceCitation(target, route.paper, evidence, route.hit);
        else onCitation?.(target, route.paper, route.hit);
      });
    },
    [onCitation, onEvidenceCitation, isGeneral, project, citable, here, library],
  );
  // One opener per answer, kept across renders: a fresh closure per row would
  // draw every finished answer again on each keystroke and streamed token.
  const latestCitation = useRef(handleCitation);
  useLayoutEffect(() => {
    latestCitation.current = handleCitation;
  }, [handleCitation]);
  const [citationOpeners] = useState(() => new WeakMap<ChatMessage, (target: CitationTarget) => void>());
  const citationFor = (message: ChatMessage) => {
    let open = citationOpeners.get(message);
    if (!open) {
      open = (target) => latestCitation.current(target, message.viewportEvidence, message.content);
      citationOpeners.set(message, open);
    }
    return open;
  };
  /**
   * Whether a citation in this answer has anywhere to go (`citationCandidates`).
   * A Memory answer's may name a paper the library does not hold, and any
   * answer may cite the pages of a PDF it read on the web; such a citation is
   * drawn as the prose it is rather than as a link that does nothing.
   */
  const followers = useMemo(
    () => new WeakMap<ChatMessage, (target: CitationTarget) => boolean>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [citable, here?.id],
  );
  const followableFor = (message: ChatMessage) => {
    let follows = followers.get(message);
    if (!follows) {
      const mentioned = mentionedPapers(message.content, citable);
      follows = (target) => citationCandidates(target, citable, here, mentioned).length > 0;
      followers.set(message, follows);
    }
    return follows;
  };

  const lastUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") return i;
    }
    return -1;
  })();

  /* Ask the last question again, as it was asked. The cut-off answer is
     replaced, like an edit's, so the thread never holds both; the quote, the
     mentioned papers and the images travel from the stored question, not from
     whatever the composer holds now. */
  const retryLast = () => {
    if (streaming || lastUserIndex < 0) return;
    const original = messages[lastUserIndex];
    seedReferencesRef.current = (original.referencedPapers ?? []).map((item) => item.id);
    seedImagesRef.current = (original.referencedImages ?? []).map((item) => item.id);
    void send(
      original.content,
      { requestId: original.requestId, retry: true },
      { selectedText: original.selectedText ?? "" },
    );
  };

  const startEdit = () => {
    if (streaming || lastUserIndex < 0) return;
    const original = messages[lastUserIndex];
    composerSnapshotRef.current = {
      draft,
      images: composerImagesRef.current.map((item) => ({ ...item })),
      referencedPaperIds: [...referencedPaperIds],
      selectedText,
      chosenModel,
      chosenEffort,
    };
    const papers = original.referencedPapers ?? [];
    setDraft(compactPaperMentionTokens(original.content, papers));
    setReferencedPaperIds(papers.map((item) => item.id));
    setSelectedText(original.selectedText ?? "");
    if (original.model) setChosenModel(original.model);
    if (original.reasoningEffort) setChosenEffort(original.reasoningEffort);
    updateComposerImages(() =>
      (original.referencedImages ?? []).flatMap((reference) => {
        const image = images.find((item) => item.id === reference.id);
        if (!image) return [];
        return [
          {
            localId: image.id,
            previewUrl: imageUrl(image.id, "thumbnail"),
            image,
            uploading: false,
            viaToken: original.content.includes(`@[Image #${reference.number}]`),
          },
        ];
      }),
    );
    setEditing(true);
  };

  const cancelEdit = () => {
    restoreComposerSnapshot();
    setEditing(false);
  };

  useLayoutEffect(() => {
    if (!editing) return;
    const scroller = scrollRef.current;
    const card = scroller?.querySelector(".message.is-editing");
    if (!scroller || !(card instanceof HTMLElement)) return;
    /* Parking the editor against the viewport also scrolled every
       ancestor, and `.kb-ask-modal` is one (`overflow: hidden`). That
       slid the header — the scope pill, the eraser, the expander — off
       the top of the card. Only the transcript should move. */
    const top =
      card.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(0, top - 22) });
  }, [editing]);

  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      cancelEdit();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [editing]);

  const sendEdited = () => {
    const requestId = messages[lastUserIndex]?.requestId;
    if (!draft.trim() || lastUserIndex < 0) return;
    void send(undefined, { requestId });
  };

  /* Two openers per scope, each a question only that scope can answer, so the
     pair says what the Context pill means. Memory's are about the reading as a
     whole, and name the document open beside it by title: the request carries
     that document's digest, and the title is what the answer and the thread's
     history should say. Project's second is the one a lone document cannot
     answer. */
  const suggestions = isGeneral
    ? [
        paper
          ? { label: "What’s new here", prompt: `Given what I’ve already read, what is new in “${paper.title}”?` }
          : { label: "Themes in my reading", prompt: "What themes run through what I’ve read?" },
        paper
          ? { label: "Related work in Memory", prompt: `Are there some related work to “${paper.title}” already in my Memory?` }
          : { label: "Most connected work", prompt: "Which documents in my Memory connect to the most others?" },
      ]
    : [
        { label: "Summarize this paper", prompt: "Give me the TL;DR of this document." },
        { label: "Connect to this project", prompt: "How does this document relate to the others in this project?" },
      ];
  const composerEnabled = scopeReady;
  /* One wording for every scope — the Context pill in the header already says
     which one this is, and it is also the control that changes it. The
     exception is the one state the pill cannot express: a document scope with
     no document chosen yet. The in-place editor reuses this same card and
     never grows a second Context pill: the turn being edited already has a
     scope. */
  /* The one genuine fork between the reader's chat and the wiki's: an answer
     about the wiki is drawn as a wiki page is, with its diagrams. Both name
     Memory pages as `[[slugs]]` and cite documents by the same rules — a
     Memory answer's library is the whole account's — so the fork is a
     renderer and not a component. The side chat draws its answers with it too. */
  const renderAnswerText = (text: string, message: ChatMessage, live: boolean) =>
    isGeneral ? (
      <MemoizedMemoryBody
        body={text}
        figures={NO_FIGURES}
        pages={linkable}
        onOpen={onOpenPage}
        webLinks
        artifacts
        streaming={live}
        sources={storedSources(message.sources)}
        papers={citable}
        onCitation={onCitation ? citationFor(message) : undefined}
        followable={followableFor(message)}
      />
    ) : (
      <MemoAssistantMessage
        content={text}
        streaming={live}
        papers={project?.papers}
        sources={storedSources(message.sources)}
        pages={linkable}
        onOpenPage={onOpenPage}
        onCitation={citationFor(message)}
        followable={followableFor(message)}
      />
    );

  /* The side chat's share of the card: measured, because the docked width is
     whatever the shell gave the column, and laid over the main chat when the
     card is too narrow for both. */
  const surface = fullscreen ? "expanded" : "docked";
  const [cardWidth, setCardWidth] = useState(0);
  const [, setSideDragged] = useState(sideDragged);
  const headerRef = useRef<HTMLElement>(null);
  const [sideTop, setSideTop] = useState(0);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!sideOpen || !card) return;
    const measure = () => {
      setCardWidth(card.getBoundingClientRect().width);
      const header = headerRef.current;
      if (header) setSideTop(header.offsetTop + header.offsetHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, [sideOpen, fullscreen]);
  const viewportWidth = typeof window === "undefined" ? 1512 : window.innerWidth;
  const split = sideOpen && cardWidth ? sideSplit(cardWidth, sideDragged[surface], viewportWidth, surface) : null;
  /* The shell widens the column for the side chat; the pane enters once the
     card has room for both, rather than as an overlay for the frames the
     column takes to grow. A card that never gets the room shows it as one. */
  const [sideSettled, setSideSettled] = useState(false);
  const sideOverlaid = !split || split.overlay;
  useEffect(() => {
    if (!sideOpen) { setSideSettled(false); return; }
    if (!sideOverlaid) { setSideSettled(true); return; }
    const timer = setTimeout(() => setSideSettled(true), SIDE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [sideOpen, sideOverlaid]);
  const sideShown = sideOpen && sideSettled;
  const sideChange = useRef(onSideChatChange);
  sideChange.current = onSideChatChange;
  useEffect(() => { sideChange.current?.(sideOpen); }, [sideOpen]);
  useEffect(() => () => sideChange.current?.(false), []);

  const placeholder =
    !isGeneral && !paper
      ? "Choose a document to begin…"
      : fullscreen ? COMPOSER_PLACEHOLDER : COMPOSER_PLACEHOLDER_SHORT;
  // Not in the edit card, which offers no `/side`.
  const sideHint = !answered && (isGeneral || Boolean(paper));

  const composerCard = (placement: "docked" | "edit") => {
    const isEdit = placement === "edit";
    return (
      <div
        className={`composer${planMode ? " composer-plan" : ""}${isEdit ? " composer-edit" : ""}${
          imageDrop.active ? " image-drop" : ""
        }`.trim()}
        {...imageDrop.handlers}
        onKeyDownCapture={(event) => {
          if (!streaming && composerEnabled && isModeShortcut(event)) {
            event.preventDefault(); event.stopPropagation();
            setChatMode(nextChatMode);
          }
        }}
        /* Pastes inside the editor are the editor's own; this catches an
           image dropped on the strip or the toolbar around it. */
        onPaste={(event: ClipboardEvent<HTMLDivElement>) => {
          handleComposerPaste(event, null, (files) => {
            void attachFiles(files);
          });
        }}
      >
        {composerImages.length ? (
          <div className="composer-images" aria-label="Attached images">
            {composerImages.map((item) => (
              <div
                className={[
                  "composer-image",
                  item.uploading ? "uploading" : "",
                  item.error ? "error" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={item.localId}
                title={item.error ?? "Attached image"}
              >
                {/* Authenticated, expiring user content cannot use the static image optimizer. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={item.previewUrl} alt="Attached image" />
                {item.uploading ? (
                  <span className="image-upload-state" aria-hidden="true" />
                ) : null}
                <button
                  type="button"
                  aria-label="Remove this image"
                  disabled={item.uploading}
                  onClick={() => void removeComposerImage(item)}
                >
                  <svg
                    width="9"
                    height="9"
                    viewBox="0 0 10 10"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M2 2l6 6M8 2 2 8"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {imageDrop.active ? (
          <p className="composer-drop-hint" role="status">
            {canAttach
              ? imageDropHint(config.chatImageMaxPerQuestion)
              : "Open a document before attaching an image"}
          </p>
        ) : null}
        {selectedText ? (
          <div className={`selection-chip ${quoteExpanded ? "expanded" : ""}`}>
            {/* Keyed so the ref re-measures whenever the quote changes. */}
            <p key={selectedText} ref={measureQuote}>
              {selectedText}
            </p>
            {quoteClipped || quoteExpanded ? (
              <div className="selection-chip-meta">
                <button
                  type="button"
                  onClick={() => setQuoteExpanded((value) => !value)}
                >
                  {quoteExpanded ? "Show less" : "Show all"}
                </button>
              </div>
            ) : null}
            <button
              className="selection-chip-clear"
              aria-label="Remove quoted passage"
              onClick={() => setSelectedText("")}
            >
              ×
            </button>
          </div>
        ) : null}
        <MentionField
          handleRef={composerRef}
          papers={mentionablePapers}
          images={images}
          paintPapers={referencedPapers}
          paintImages={attachedImages}
          tabs={mentionTabs}
          imageUrl={imageUrl}
          brokenImageIds={brokenImageIds}
          onImageBroken={markImageBroken}
          expiryNote={expiryNote}
          placeholder={planMode ? "What should we plan?" : sideHint && !isEdit ? SIDE_CHAT_HINT : placeholder}
          disabled={!composerEnabled}
          autoFocus={isEdit}
          initialDraft={draft}
          onDraftChange={onDraftChange}
          onPaperMention={onPaperMention}
          onImageMention={onImageMention}
          onSubmit={() => (isEdit ? sendEdited() : void send())}
          onPasteImages={(files) => void attachFiles(files)}
          commands={isEdit || planMode ? undefined : SIDE_COMMANDS}
          onCommand={openSideFromComposer}
        />
        <div className="composer-row">
          <div className="composer-controls">
            <div className="composer-secondary-controls">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                multiple
                hidden
                onChange={(event) => {
                  void attachFiles(Array.from(event.target.files ?? []));
                  // Re-picking the same file fires no change event unless the
                  // input forgets it first.
                  event.target.value = "";
                }}
              />
              <ComposerToggle
                label={
                  attachmentsFull
                    ? `Limit reached (${config.chatImageMaxPerQuestion} per question)`
                    : "Attach an image"
                }
                className="attach-image-button"
                disabled={attachmentsFull || !canAttach}
                onActivate={() => imageInputRef.current?.click()}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M11.6 4.2 5.9 9.9a1.6 1.6 0 0 0 2.3 2.3l5.6-5.7a3.1 3.1 0 0 0-4.4-4.4L3.6 7.9a4.6 4.6 0 0 0 6.5 6.5l4.3-4.3"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </ComposerToggle>
            </div>
            <div className="composer-primary-controls">
              <ModelPill
                models={config.models.map((item) => ({
                  value: item,
                  label: modelLabel(item),
                }))}
                model={model}
                onModelChange={setChosenModel}
                efforts={config.reasoningEfforts.map((value) => ({
                  value,
                  label: EFFORT_LABELS[value] ?? value,
                }))}
                modelEfforts={config.modelReasoningEfforts}
                effort={effort}
                onEffortChange={setChosenEffort}
                /* Docked, the surface sits in a rail with the page to its left,
                   so the effort menu opens that way or it runs off the edge. As
                   a reader column there is room on the usual side. Edit sits
                   at the left of the transcript, so leftward is the clip. */
              />
              {/* The persona sits in the tool row beside the model, because it
                  is the same kind of decision — who is answering, in what voice —
                  and the reader reads the two together. It used to be a separate
                  strip under the composer, which put a second row of chrome
                  between the field and the transcript for one control.

                  One control, every scope. There used to be two: this drop-up in
                  the account-wide chat, and a button in every reader scope that
                  opened a modal onto the *project's* persona. A persona belongs
                  to the conversation now, so there is nothing left for the scope
                  to branch on. */}
              <PersonaPill
                personas={personas}
                value={personaId ?? config.defaultPersona ?? DEFAULT_PERSONA_ID}
                fallbackId={config.defaultPersona ?? DEFAULT_PERSONA_ID}
                onChange={choosePersona}
                onManage={onManagePersonas}
              />
            </div>
          </div>
          <div className="composer-send-group">
            {isEdit ? (
              <button
                type="button"
                className="message-edit-cancel"
                aria-label="Cancel edit"
                onClick={cancelEdit}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
            ) : null}
            <button
              className={`send-button ${!isEdit && streaming ? "stopping" : ""}`}
              disabled={savingPlan || (isEdit ? streaming || !draft.trim() : !streaming && !draft.trim())}
              onClick={() => {
                if (isEdit) {
                  sendEdited();
                  return;
                }
                if (!streaming) {
                  void send();
                  return;
                }
                if (savingPlanRef.current) return;
                const requestId = streamRequestIdRef.current;
                streamAbortRef.current?.abort();
                if (scopeReady && requestId) {
                  void api(`/api/chat/cancel`, {
                    method: "POST",
                    body: JSON.stringify({
                      request_id: requestId.replaceAll("-", "_"),
                      ...chatRequestScope(target),
                      conversation_id: identity.current.id, generation: identity.current.generation,
                    }),
                  }).catch(() => {});
                }
              }}
              aria-label={savingPlan ? "Finishing save…" : isEdit ? "Send" : streaming ? "Stop" : "Send"}
              title={savingPlan ? "Finishing save…" : isEdit ? "Send" : streaming ? "Stop" : "Send"}
            >
              {!isEdit && streaming ? (
                <span className="send-stop-glyph" aria-hidden="true" />
              ) : (
                <svg width="13" height="13" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                  <path
                    d="M7.5 12V3M7.5 3L3.5 7M7.5 3L11.5 7"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
        {!config.providerConfigured ? (
          <small className="provider-note">
            AI connection unavailable · open Delphi → AI Connection
          </small>
        ) : null}
      </div>
    );
  };

  return (
    /* The rail wrapper belongs to this component, not to the shell that mounts
       it. Fullscreen is a fixed backdrop over the whole viewport, and the two
       ways out of it — a click on the backdrop, Escape — have to be handled by
       whoever owns `fullscreen`. Hoisting the wrapper into the shells dropped
       both, so an expanded chat could only be left by finding the expander
       again, and a click outside fell through to nothing. */
    <section
      className={`kb-chat-rail landed${fullscreen ? " is-fullscreen" : ""}${
        collapsing ? " is-collapsing" : ""
      }${leaving ? " is-leaving" : ""}${
        nudge ? (nudge % 2 ? " is-nudged-odd" : " is-nudged-even") : ""
      }`}
      aria-label={`${scopeLabel(context)} chat`}
      onClick={(event) => {
        /* Only the backdrop itself. A click that started inside the card and
           ended on it — a drag off the end of a selection — must not collapse
           the panel out from under the reader. */
        if (fullscreen && event.target === event.currentTarget) leaveFullscreen();
      }}
    >
      <aside
        ref={cardRef}
        className={`kb-ask-modal chat-surface${sideShown ? " has-side" : ""}${sideShown && split?.overlay ? " side-overlay" : ""}`}
        style={{
          "--chat-zoom": textZoom / 100,
          ...(sideOpen ? {
            "--side-width": `${split?.side ?? sideChatExtra(viewportWidth, surface)}px`,
            "--side-top": `${sideTop}px`,
            "--side-extra": `${sideChatExtra(viewportWidth, "expanded")}px`,
          } : {}),
        } as CSSProperties}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="conversation-header" ref={headerRef}>
          <ConversationScopeMenu context={context} options={contextOptions}
            projectId={project?.id} paperId={paper?.id} onSelect={switchScope} chats={conversationChats} />
          {conversationTabs}
          {/* Chat or Plan, announced on this row; only Plan is shown, as it changes what a send does. */}
          <ModeTag mode={chatMode} />
          <ConversationWindowControls fullscreen={fullscreen}
            onExpand={onFullscreenChange ? () => fullscreen ? leaveFullscreen() : enterFullscreen(true) : undefined}
            onClose={onClose} />
        </header>
        {conversationTools}
        {viewportOffHome ? (
          <p className="chat-viewport-note">
            {context === "document"
              ? "Using the page you’re viewing."
              : "This context uses saved documents—save this page to include it."}
          </p>
        ) : null}
        <ArtifactAsk.Provider value={streaming ? null : askArtifact}>
        <div
          className={`messages${editing ? " is-editing-message" : ""}`}
          ref={scrollRef}
        >
          {!messages.length ? (
            <div className="chat-empty">
              <span className="agent-orbit">
                <img src="/brand/delphi-mark.svg" alt="" />
              </span>
              <div className="suggestions">
                {suggestions.map((suggestion, index) => (
                  <button key={suggestion.label} onClick={() => void send(suggestion.prompt)}>
                    <svg className="suggestion-icon" viewBox="0 0 20 20" aria-hidden="true">{index === 0 ? <path d="M4 5h12M4 10h12M4 15h8" /> : <><circle cx="10" cy="10" r="3" /><path d="M10 2v2m0 12v2M2 10h2m12 0h2" /></>}</svg>
                    <span>{suggestion.label}</span>
                    <svg className="suggestion-arrow" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 14 14 6M6 6h8v8" /></svg>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message, index) => (
              <article
                key={index}
                className={`message ${message.role} ${
                  message.error ? "error" : message.cancelled ? "cancelled" : ""
                }${
                  message.role === "user" && index === lastUserIndex
                    ? " is-latest"
                    : ""
                }${
                  message.role === "user" && index === lastUserIndex && editing
                    ? " is-editing"
                    : ""
                }`}
              >
                {message.role === "user" && index === lastUserIndex && editing ? (
                  composerCard("edit")
                ) : (
                  <>
                {message.selectedText ? <SelectedPassage text={message.selectedText} /> : null}
                {message.referencedImages?.length ? (
                  <div className="message-images">
                    {message.referencedImages.map((reference) => {
                      const attached = images.find((image) => image.id === reference.id);
                      const gone = `Image #${reference.number} · ${attached ? "Image unavailable" : "Image expired"}`;
                      return attached && !brokenImageIds.has(reference.id) ? (
                        <a
                          key={reference.id}
                          href={imageUrl(reference.id, "image")}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open Image #${reference.number}`}
                        >
                          {/* Authenticated, expiring user content cannot use the static image optimizer. */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={imageUrl(reference.id, "thumbnail")}
                            alt={`Image #${reference.number}`}
                            onError={() => markImageBroken(reference.id)}
                          />
                        </a>
                      ) : (
                        <span
                          className="message-image-expired"
                          key={reference.id}
                          role="img"
                          aria-label={gone}
                          title={gone}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m4 4 16 16" /></svg>
                          #{reference.number}
                        </span>
                      );
                    })}
                  </div>
                ) : null}
                <div className={message.role === "assistant" ? "kb-chat-turn" : "message-bubble"}>
                {message.role === "assistant" ? (
                  <AnswerFlow
                    content={message.content}
                    trace={
                      isAnswerTrace(message.trace)
                        ? message.trace
                        : index === messages.length - 1 && streaming ? trace.stretches : []
                    }
                    onOpenResult={(result) => { if (result.slug) onOpenPage?.(result.slug); }}
                    live={streaming && index === messages.length - 1}
                    // Plan mode keeps writing what the reader does not see
                    // after its introduction, so the line stays under it.
                    keepWaiting={streamingMode === ChatMode.Plan}
                    startedAt={trace.startedAt}
                    waitingForCapacity={trace.waitingForCapacity}
                    renderText={(text) => renderAnswerText(text, message, streaming && index === messages.length - 1)}
                  />
                ) : null}
                {message.role === "assistant" && !(streaming && index === messages.length - 1) ? (
                  <AnswerSources
                    content={message.content}
                    sources={storedSources(message.sources)}
                    scope={referenceScope}
                    onOpenPage={onOpenPage}
                    evidence={message.viewportEvidence}
                    onCitation={onCitation ? handleCitation : undefined}
                  />
                ) : null}
                {message.role === "assistant" && message.incomplete ? (
                  <p className="message-cutoff" role="status">
                    <span>{cutOffNotice(message.incomplete.reason)}</span>
                    {index === messages.length - 1 && !streaming ? (
                      <button type="button" onClick={retryLast}>Retry</button>
                    ) : null}
                  </p>
                ) : null}
                {message.role === "user" ? (
                <div>
                  {message.content}
                  {index === lastUserIndex &&
                  !editing &&
                  !streaming ? (
                    <button
                      type="button"
                      className="message-edit"
                      aria-label="Edit message"
                      onClick={startEdit}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 20h4l10.5-10.5a2.828 2.828 0 1 0-4-4L4 16v4" />
                        <path d="m13.5 6.5 4 4" />
                      </svg>
                    </button>
                  ) : null}
                </div>
                ) : null}
                </div>
                  </>
                )}
              </article>
            ))
          )}
        </div>
        </ArtifactAsk.Provider>
        {messageSelection ? (
          <div
            className="selection-menu single"
            style={{ left: messageSelection.x, top: messageSelection.y }}
          >
            <button onClick={replyToMessageSelection}>Reply ↵</button>
          </div>
        ) : null}
        {capacity.panel}
        {!editing ? composerCard("docked") : null}
        {sideShown ? (
          <SideChat
            session={session}
            ensureConversation={async () => (identity.current = await ensureConversation())}
            scope={chatRequestScope(target)}
            model={model}
            effort={effort}
            personaId={personaChosenRef.current ? personaId : null}
            width={split?.side ?? sideChatExtra(viewportWidth, surface)}
            overlay={Boolean(split?.overlay)}
            bounds={sideBounds(cardWidth, viewportWidth)}
            onResize={(width) => {
              sideDragged[surface] = width;
              setSideDragged({ ...sideDragged });
            }}
            onClose={() => {
              closeSideChat(session);
              composerRef.current?.focus();
            }}
            renderText={renderAnswerText}
            onNotice={(message) => onNotice(message)}
          />
        ) : null}
      </aside>
    </section>
  );
}
