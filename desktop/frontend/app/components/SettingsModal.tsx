"use client";

/**
 * The settings sheet opened from the account menu.
 *
 * Shared by all three shells so the profile button is the same control
 * everywhere — one sheet, not three products. It used to be the *account*
 * sheet and carried the only link into Memory, which made it a
 * navigation surface by accident; document navigation now starts in the library.
 * Memory's diagnostic destinations now live here deliberately, beside the
 * three account-management panes, instead of in permanent page chrome.
 *
 * The shell is `settings-*`. The projects pane wears the same group-and-card
 * pattern as Chats and Plans but keeps its `account-*` names for everything
 * the drag reads or styles, because that geometry is a working system.
 */

import {
  CSSProperties,
  Fragment,
  PointerEvent as ReactPointerEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  API_BASE,
  api,
  isDone,
  type AppConfig,
  type DashboardConversation,
  type Paper,
  type Persona,
  type Project,
  type ProjectSummary,
  type User,
} from "../lib/api";
import { Skeleton, SkeletonBar } from "./Loading";
import { PersonaPane, PersonaDetail } from "./settings/PersonaPane";
import { PersonaEditor } from "./settings/PersonaEditor";
import { PersonaMarketplace } from "./settings/PersonaMarketplace";
import { conversationSource } from "../lib/account-menu";
import { conversationDestination, groupByDay, relativeTime } from "../lib/dashboard";
import TitleText from "./TitleText";
import { projectAccent } from "../lib/project-color";
import { followPointer, suppressClickAfterDrop } from "../lib/pointer-gesture";
import { projectPath } from "../lib/routes";
import { PAPER_MARK_LABEL, paperMark } from "../lib/paper-kind";
import { KindMark } from "./KindMark";
import { MemoryIcon } from "./MemoryIcon";
import { PersonaIcon } from "./PersonaIcon";
import { AiConnectionRow, AiConnectionView, useAiConnection, type ServiceTier } from "./AiConnectionSetting";
import type { Notice } from "./Notice";

type Pane = "projects" | "chats" | "plans" | "persona" | "advanced";

/**
 * Which section a shell wants opened.
 *
 * Exported because the chat's persona menu asks for one by name: the sheet is
 * mounted per shell, so "manage personas" has to travel up as a pane rather
 * than opening anything itself.
 */
export type SettingsPane = Pane;

/**
 * One locally hosted plan, as `/desktop/plans/list` reports it.
 *
 * `url` is null for two quite different reasons — the plan was archived, or its
 * localhost slot never bound — and the pane says which, because "archived" and
 * "not currently served" mean different things to a reader looking for a link.
 */
type SavedPlan = {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  archived: boolean;
  url: string | null;
};

/** What a paper drop asks of the server, in the stored order the routes take. */
type DropPlan =
  | { kind: "move"; projectId: string; position: number }
  | { kind: "order"; paperIds: string[] };

/** A stack of sheets. */
function ProjectsPaneIcon() {
  return (
    <svg viewBox="0 0 20 20" className="settings-nav-icon" fill="none" aria-hidden="true">
      <path
        d="M3.2 6.6 10 3.4l6.8 3.2L10 9.8 3.2 6.6Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M3.2 10.4 10 13.6l6.8-3.2M3.2 14 10 17.2l6.8-3.2" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** A speech bubble. */
function ChatsPaneIcon() {
  return (
    <svg viewBox="0 0 20 20" className="settings-nav-icon" fill="none" aria-hidden="true">
      <path
        d="M3.4 3.8h13.2v9.4H7.9L3.4 16.8V3.8Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A page with a folded corner. */
function PlansPaneIcon() {
  return (
    <svg viewBox="0 0 20 20" className="settings-nav-icon" fill="none" aria-hidden="true">
      <path
        d="M11.4 2.9H5.6v14.2h8.8V5.9l-3-3Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M11.4 2.9v3h3M8 10.2h4M8 13h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PersonaPaneIcon() {
  return <PersonaIcon className="settings-nav-icon" size={20} />;
}

/** Two sliders: the settings nobody needs every day. */
function AdvancedPaneIcon() {
  return (
    <svg viewBox="0 0 20 20" className="settings-nav-icon" fill="none" aria-hidden="true">
      <path d="M3.5 6h7M14.5 6h2M3.5 14h2M9.5 14h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="12.5" cy="6" r="1.7" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="7.5" cy="14" r="1.7" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/** Rows outlined while a pane's list loads; the last ones fade, as a list runs on. */
const LIST_OUTLINE_ROWS = [
  { title: "58%", opacity: 1 },
  { title: "44%", opacity: 1 },
  { title: "52%", opacity: 0.55 },
  { title: "40%", opacity: 0.25 },
];

/** Projects, Chats and Plans while their lists load: the same outlined rows. */
function ListOutline({ label }: { label: string }) {
  return <Skeleton label={label} className="account-list-outline">
    {LIST_OUTLINE_ROWS.map(({ title, opacity }, index) => <div key={index} className="account-list-outline-row" style={{ opacity }}>
      <SkeletonBar width="4px" height={30} tone="tint" />
      <span className="account-list-outline-text">
        <SkeletonBar width={title} height={9} tone="strong" />
        <SkeletonBar width="30%" height={7} />
      </span>
    </div>)}
  </Skeleton>;
}

const PANES: Array<{ id: Pane; label: string; Icon: () => ReactElement }> = [
  { id: "projects", label: "Projects", Icon: ProjectsPaneIcon },
  { id: "chats", label: "Chats", Icon: ChatsPaneIcon },
  { id: "plans", label: "Plans", Icon: PlansPaneIcon },
  { id: "persona", label: "Persona", Icon: PersonaPaneIcon },
  /* Model and Memory are one pane: each was two or three rows, and a rail
     entry apiece made them look as weighty as Projects. */
  { id: "advanced", label: "Advanced", Icon: AdvancedPaneIcon },
];

export function SettingsModal({
  user,
  onUserChange,
  initialPane = "projects",
  initialConnection = false,
  config,
  onPersonasChanged,
  projects,
  currentProjectId,
  currentPaperId,
  onClose,
  onOpenPaper,
  onNavigate,
  onMovePaper,
  onReordered,
  onNotice,
  maxPapers,
}: {
  user: User;
  onUserChange: (user: User) => void;
  /** Which section to open on. Defaults to Projects, as the sheet always did. */
  initialPane?: Pane;
  /** Open straight onto the AI connection view, as a "connect" verb elsewhere asks. */
  initialConnection?: boolean;
  config: AppConfig;
  /**
   * A persona was written, deleted or installed.
   *
   * The shells fetch the catalog once on mount and hand it to every composer,
   * so without this a persona created here does not appear in the menu that
   * sent the reader to write it — which is the first thing anybody tries.
   */
  onPersonasChanged?: () => void;
  projects: ProjectSummary[];
  /** Capacity of a project, so a full one refuses a drop before the server does. */
  maxPapers: number;
  currentProjectId?: string;
  currentPaperId?: string;
  onClose: () => void;
  onOpenPaper: (projectId: string, paperId: string) => void;
  /**
   * Go to an address. The sheet has no router of its own, and every shell that
   * mounts it already has one — the same reason `onOpenPaper` is a prop.
   */
  onNavigate: (href: string) => void;
  onMovePaper: (
    fromProjectId: string,
    paperId: string,
    toProjectId: string,
    position?: number,
  ) => Promise<void>;
  /** An in-sheet reorder also changes the library behind it. */
  onReordered: () => Promise<void>;
  onNotice: (notice: Notice) => void;
}) {
  const [pane, setPane] = useState<Pane>(initialPane);
  /* Persona management, all three of its states. `market` swaps the whole body
     for the shelf; `personaDetail` widens the sheet by one column; `editing`
     replaces the listing with the form. They are states of one pane rather than
     separate dialogs so "‹ Back" returns to where the reader was, and so the
     sheet keeps one Escape handler and one width transition. */
  const [market, setMarket] = useState(false);
  const [personaDetail, setPersonaDetail] = useState<Persona | null>(null);
  const [editing, setEditing] = useState<
    (Partial<Persona> & { content: string }) | null | undefined
  >(undefined);
  const [personaReloads, setPersonaReloads] = useState(0);
  const [library, setLibrary] = useState<Project[]>([]);
  /** Active first, done last — the same order the rows and the drop-index
      math must agree on. */
  const sortedAccountPapers = (papers: Paper[]) => [
    ...papers.filter((entry) => !isDone(entry)),
    ...papers
      .filter((entry) => isDone(entry))
      .sort((a, b) => (a.doneAt ?? "").localeCompare(b.doneAt ?? "")),
  ];
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [libraryError, setLibraryError] = useState("");
  const [plans, setPlans] = useState<SavedPlan[] | null>(null);
  const [plansError, setPlansError] = useState("");
  const [copiedPlan, setCopiedPlan] = useState("");
  const [conversations, setConversations] = useState<DashboardConversation[] | null>(
    null,
  );
  const [conversationsError, setConversationsError] = useState("");

  const [changingTier, setChangingTier] = useState(false);
  const aiConnection = useAiConnection();
  /* Changing the AI connection turns the whole sheet over to it, rail and
     all, the same way the persona marketplace does — one dialog, one Escape. */
  const [connectionView, setConnectionView] = useState(initialConnection);
  const [tierError, setTierError] = useState("");
  /** The OpenAI service tier, an account preference set beside the OpenAI key. */
  const tier: ServiceTier = {
    value: user.useStandardTier ? "standard" : "flex",
    pending: changingTier,
    error: tierError,
    change: async (choice) => {
      const useStandardTier = choice === "standard";
      if (useStandardTier === user.useStandardTier) return;
      setChangingTier(true);
      setTierError("");
      try {
        const updated = await api<{ useStandardTier: boolean }>("/api/auth/preferences", {
          method: "PATCH",
          body: JSON.stringify({ use_standard_tier: useStandardTier }),
        });
        onUserChange({ ...user, ...updated });
      } catch (error) {
        setTierError(error instanceof Error ? error.message : "Could not update the service tier.");
      } finally {
        setChangingTier(false);
      }
    },
  };

  /**
   * Re-read every project in full.
   *
   * The sheet shows papers, which the project list does not carry, so it loads
   * details of its own. Reordering inside the sheet has to refresh them without
   * waiting for the list identity to change — nothing about a reorder does.
   */
  const readLibrary = useCallback(
    () =>
      Promise.all(projects.map((item) => api<Project>(`/api/projects/${item.id}`))),
    [projects],
  );

  /**
   * Dragging a paper to a new home.
   *
   * The same gesture and feedback as the library rail's (`Library` in
   * `Workspace.tsx`), because it is the same mental action. What the sheet adds
   * is reach: every project's papers are on show, so the gap can open in any of
   * them, and one drag both reorders a list and files a paper somewhere else.
   */
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    projectId: string;
    paperId: string;
    startX: number;
    startY: number;
    /** Whether moving before the hold means "drag" (mouse) or "scroll" (touch). */
    dragOnMove: boolean;
    active: boolean;
    drop: { projectId: string; index: number } | null;
    timer: ReturnType<typeof setTimeout>;
    frame: number | null;
    lastClientX: number;
    lastClientY: number;
    /** Stops following the pointer (`followPointer`). */
    stop: () => void;
  } | null>(null);
  // The pointer's last position, for the autoscroll loop. A ref because the
  // loop runs between pointer events — the whole reason it exists is that
  // holding still at the bottom edge has to keep scrolling.
  const pointerYRef = useRef(0);
  const autoScrollRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const [pressingPaperId, setPressingPaperId] = useState<string | null>(null);
  const [draggingPaperId, setDraggingPaperId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  /** Which gap the paper is over: a project *and* a position inside it. */
  const [drop, setDrop] = useState<{
    projectId: string;
    index: number;
  } | null>(null);
  const [movingPaperId, setMovingPaperId] = useState<string | null>(null);

  const stopAutoScroll = () => {
    if (autoScrollRef.current !== null) {
      cancelAnimationFrame(autoScrollRef.current);
      autoScrollRef.current = null;
    }
  };

  /**
   * Keep scrolling while the pointer sits near an edge.
   *
   * A frame loop rather than a nudge per `pointermove`: the list is taller than
   * the sheet, so the destination is very often off-screen, and a reader who has
   * dragged to the bottom edge and stopped moving is exactly the reader who
   * needs it to keep going.
   */
  const runAutoScroll = () => {
    autoScrollRef.current = null;
    const body = bodyRef.current;
    if (!body || !dragRef.current?.active) return;
    const bounds = body.getBoundingClientRect();
    const edge = 72;
    const above = pointerYRef.current - bounds.top;
    const below = bounds.bottom - pointerYRef.current;
    const ramp = (distance: number) =>
      Math.round(Math.min(1, Math.max(0, (edge - distance) / edge)) * 18);
    const velocity = above < edge ? -ramp(above) : below < edge ? ramp(below) : 0;
    if (velocity) body.scrollTop += velocity;
    autoScrollRef.current = requestAnimationFrame(runAutoScroll);
  };

  // A drag interrupted by an unmount — Escape, or the move navigating — must
  // not leave a frame loop running against a detached element, or the window
  // listening for its pointer.
  useEffect(() => () => {
    dragRef.current?.stop();
    stopAutoScroll();
  }, []);

  const liftPaper = (gesture: NonNullable<typeof dragRef.current>) => {
    if (dragRef.current !== gesture || gesture.active) return;
    clearTimeout(gesture.timer);
    gesture.active = true;
    // Set the moment the drag begins, not when it ends: a click that follows
    // the drop is the one that used to close the sheet and open the paper the
    // reader was still holding (`suppressClickAfterDrop`).
    suppressClickRef.current = true;
    setDraggingPaperId(gesture.paperId);
    setDragOffset({ x: 0, y: 0 });
    if (autoScrollRef.current === null) {
      autoScrollRef.current = requestAnimationFrame(runAutoScroll);
    }
  };

  const beginPaperDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    projectId: string,
    paperId: string,
  ) => {
    if (movingPaperId || (event.pointerType === "mouse" && event.button !== 0)) {
      return;
    }
    pointerYRef.current = event.clientY;
    setPressingPaperId(paperId);
    const gesture = {
      projectId,
      paperId,
      startX: event.clientX,
      startY: event.clientY,
      /**
       * Whether moving early means "drag" or means "scroll".
       *
       * A finger has one gesture for both, so touch has to wait out the hold —
       * moving first is how the sheet is scrolled. A mouse has a wheel, so
       * there is nothing for a press-and-move to be *except* a drag, and making
       * it wait was the bug: the destination is usually above the paper, the
       * reader moves within the first 360ms, and the gesture was thrown away
       * and replayed as a click on the paper they were still holding.
       */
      dragOnMove: event.pointerType !== "touch",
      active: false,
      drop: null as { projectId: string; index: number } | null,
      timer: setTimeout(() => undefined, 0),
      frame: null as number | null,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      stop: (() => undefined) as () => void,
    };
    // The hold still lifts the paper on its own, so a reader who presses and
    // waits sees the same affordance as in the library rail.
    gesture.timer = setTimeout(() => liftPaper(gesture), 360);
    dragRef.current = gesture;
    gesture.stop = followPointer(event.nativeEvent, event.currentTarget, {
      move: (move) => movePaperDrag(gesture, move),
      end: (how) => (how === "cancel" ? cancelPaperDrag(gesture) : endPaperDrag(gesture)),
    });
  };

  const movePaperDrag = (gesture: NonNullable<typeof dragRef.current>, event: PointerEvent) => {
    if (dragRef.current !== gesture) return;
    pointerYRef.current = event.clientY;
    if (!gesture.active) {
      const travelled = Math.hypot(
        event.clientX - gesture.startX,
        event.clientY - gesture.startY,
      );
      // Under the slop this is still a click being made — a mouse wobbles a
      // pixel or two between press and release, and that must stay a click.
      if (travelled <= 7) return;
      if (gesture.dragOnMove) {
        liftPaper(gesture);
      } else {
        gesture.stop();
        clearTimeout(gesture.timer);
        dragRef.current = null;
        setPressingPaperId(null);
        return;
      }
    }
    event.preventDefault();
    setDragOffset({
      x: event.clientX - gesture.startX,
      y: event.clientY - gesture.startY,
    });

    // The dragged card itself tracks every pointer event above, for a 1:1
    // feel. Which *gap* is open is different: resolving it reads the rows'
    // live layout, and that layout is itself mid-animation from the last
    // gap opening or closing. Reading it on every raw pointer event fed that
    // animation back into itself — a row shifting under the cursor as a gap
    // opened would cross the pointer's own hit-test boundary and flip the
    // target straight back, which is the jitter. One resolve per frame gives
    // the transition a chance to settle before the next hit-test runs.
    gesture.lastClientX = event.clientX;
    gesture.lastClientY = event.clientY;
    if (gesture.frame !== null) return;
    gesture.frame = requestAnimationFrame(() => {
      gesture.frame = null;
      if (dragRef.current === gesture) resolvePaperDrop(gesture);
    });
  };

  const resolvePaperDrop = (gesture: NonNullable<typeof dragRef.current>) => {
    const clientX = gesture.lastClientX;
    const clientY = gesture.lastClientY;
    const under = document.elementsFromPoint(clientX, clientY);
    const card = under.find(
      (element) =>
        element instanceof HTMLElement && element.dataset.accountProject,
    );
    const over =
      card instanceof HTMLElement ? (card.dataset.accountProject ?? null) : null;
    const project = library.find((entry) => entry.id === over);
    // A full project takes no drop, for the same reason it is greyed out in the
    // picker: the server would refuse, and a rejected drop is a bad way to
    // learn about a limit. Its own project is exempt — nothing is being added
    // to it, the paper is only changing places.
    // Counted from the papers: a project's own record carries no count, and
    // the server refuses a done paper into a full project like any other.
    const room =
      over === gesture.projectId ||
      (!!project &&
        project.papers.length < config.maxPapersTotalPerProject &&
        project.papers.filter((entry) => !isDone(entry)).length < maxPapers);
    if (!project || !room) {
      gesture.drop = null;
      setDrop(null);
      return;
    }

    /**
     * Which gap the paper is hovering over, not merely which project.
     *
     * This is the whole of the "push away": the gap is a real element in the
     * flow, so opening it moves the papers below it *and* every project heading
     * after them, together, on one spring. Anchored to the row under the
     * pointer rather than to a running total, because the list reflows as the
     * gap opens and a total would chase its own shift.
     */
    const row = under.find(
      (element) => element instanceof HTMLElement && element.dataset.accountPaper,
    );
    /* The open gap is as tall as a row, so the pointer spends real time over
       it. It has no row under it to anchor to, and it is already the answer. */
    const gap = under.find(
      (element) => element instanceof HTMLElement && element.dataset.accountSlot,
    );
    const orderedProjectPapers = sortedAccountPapers(project.papers);
    // Done papers sit last whatever the order, so no gap opens among them, and
    // a done paper has no place to change within its own card.
    const activeCount = orderedProjectPapers.filter((entry) => !isDone(entry)).length;
    if (over === gesture.projectId && orderedProjectPapers.some((entry) => entry.id === gesture.paperId && isDone(entry))) {
      gesture.drop = null;
      setDrop(null);
      return;
    }
    let index = activeCount;
    if (gap instanceof HTMLElement && gesture.drop?.projectId === project.id) {
      index = gesture.drop.index;
    } else if (row instanceof HTMLElement) {
      const position = orderedProjectPapers.findIndex(
        (item) => item.id === row.dataset.accountPaper,
      );
      if (position >= 0) {
        const bounds = row.getBoundingClientRect();
        const mid = bounds.top + bounds.height / 2;
        // A dead zone around the midpoint, wide enough to absorb the row's
        // own reflow when a gap open or closes nearby (up to ~26px of
        // height). Without it, crossing the midpoint opens a gap, the row
        // shifts under the still-stationary cursor, that shift crosses the
        // midpoint back the other way, and the gap closes — repeating for as
        // long as the cursor sits near the boundary.
        const settled =
          gesture.drop?.projectId === project.id ? gesture.drop.index : null;
        const hysteresis = 16;
        if (settled === position) {
          index = clientY < mid + hysteresis ? position : position + 1;
        } else if (settled === position + 1) {
          index = clientY < mid - hysteresis ? position : position + 1;
        } else {
          index = clientY < mid ? position : position + 1;
        }
      }
    } else if (clientY < (card as HTMLElement).getBoundingClientRect().top + 44) {
      // Over the project's heading: the gap belongs at the top, which is also
      // where an empty project's only gap is.
      index = 0;
    }
    const next = { projectId: project.id, index: Math.min(index, activeCount) };
    gesture.drop = next;
    setDrop((current) =>
      current?.projectId === next.projectId && current.index === next.index
        ? current
        : next,
    );
  };

  /**
   * The gap the reader saw, translated into the order the routes take.
   *
   * A card shows its active papers in stored order and then the done ones by
   * when they were finished, while both routes take the stored order, where a
   * done paper can sit anywhere — so an index counted on the card is not an
   * index into it. The gap is anchored to the active paper shown after it
   * instead: the paper goes in just before that one, or just after the last
   * active paper when none follows, and done papers keep their stored places.
   *
   * Null when the card would look the same afterwards, as it does for the two
   * gaps beside the paper's own seat, which never open: a drop that shows no
   * move must not make one.
   */
  const planDrop = (
    fromProjectId: string,
    paperId: string,
    landing: { projectId: string; index: number },
  ): DropPlan | null => {
    const papers = library.find((item) => item.id === landing.projectId)?.papers ?? [];
    const shown = sortedAccountPapers(papers);
    const lifted = shown.findIndex((item) => item.id === paperId);
    // Counted with the paper in its own card, so a gap past its seat is one
    // seat further down than it will be once the paper has left it.
    const at = lifted >= 0 && landing.index > lifted ? landing.index - 1 : landing.index;
    const anchor = shown
      .filter((item) => item.id !== paperId)
      .slice(at)
      .find((item) => !isDone(item));
    const rest = papers.filter((item) => item.id !== paperId);
    const position = anchor
      ? rest.indexOf(anchor)
      : rest.findLastIndex((item) => !isDone(item)) + 1;
    if (landing.projectId !== fromProjectId) {
      return { kind: "move", projectId: landing.projectId, position };
    }
    if (lifted < 0) return null;
    const next = [...rest];
    next.splice(position, 0, shown[lifted]);
    const unchanged = sortedAccountPapers(next).every(
      (item, index) => item.id === shown[index].id,
    );
    return unchanged ? null : { kind: "order", paperIds: next.map((item) => item.id) };
  };

  /**
   * Put the paper where the gap was.
   *
   * Two endpoints because they are two different facts: filing a paper into
   * another project is a move, and sliding it up its own list is a reorder,
   * which already has a route and its own dense-position guarantees. The drag
   * does not care which — it showed one gap, and both land in it.
   */
  const applyDrop = async (fromProjectId: string, paperId: string, plan: DropPlan) => {
    if (plan.kind === "move") {
      await onMovePaper(fromProjectId, paperId, plan.projectId, plan.position);
      return;
    }
    await api(`/api/projects/${fromProjectId}/papers/order`, {
      method: "PUT",
      body: JSON.stringify({ paper_ids: plan.paperIds }),
    });
    setLibrary(await readLibrary());
    await onReordered();
  };

  /** The paper lands where the drag last saw it, however the release was heard. */
  const endPaperDrag = (gesture: NonNullable<typeof dragRef.current>) => {
    if (dragRef.current !== gesture) return;
    // A move whose frame had not come yet still counts.
    if (gesture.active && gesture.frame !== null) resolvePaperDrop(gesture);
    gesture.stop();
    clearTimeout(gesture.timer);
    if (gesture.frame !== null) cancelAnimationFrame(gesture.frame);
    dragRef.current = null;
    stopAutoScroll();
    if (gesture.active) suppressClickAfterDrop(suppressClickRef);
    setPressingPaperId(null);
    setDraggingPaperId(null);
    setDrop(null);
    setDragOffset({ x: 0, y: 0 });
    const landing = gesture.drop;
    if (!gesture.active || !landing) return;
    const plan = planDrop(gesture.projectId, gesture.paperId, landing);
    if (!plan) return;
    setMovingPaperId(gesture.paperId);
    void applyDrop(gesture.projectId, gesture.paperId, plan)
      .catch((error: unknown) =>
        onNotice(error instanceof Error ? error.message : "Move failed"),
      )
      .finally(() => setMovingPaperId(null));
  };

  const cancelPaperDrag = (gesture: NonNullable<typeof dragRef.current>) => {
    if (dragRef.current !== gesture) return;
    gesture.stop();
    clearTimeout(gesture.timer);
    if (gesture.frame !== null) cancelAnimationFrame(gesture.frame);
    dragRef.current = null;
    stopAutoScroll();
    suppressClickRef.current = false;
    setPressingPaperId(null);
    setDraggingPaperId(null);
    setDrop(null);
    setDragOffset({ x: 0, y: 0 });
  };

  useEffect(() => {
    let active = true;
    readLibrary()
      .then((items) => {
        if (active) {
          setLibrary(items);
          setLibraryError("");
        }
      })
      .catch((error) => {
        if (active) setLibraryError(error.message);
      })
      .finally(() => {
        if (active) setLoadingLibrary(false);
      });
    return () => {
      active = false;
    };
  }, [readLibrary]);

  /**
   * Chats, the first time that pane is looked at.
   *
   * Not on open: the sheet lands on Projects, and on the filesystem backend
   * this read walks every paper to migrate legacy thread files as it goes. A
   * reader who opened the sheet to change their preferences should not pay for a
   * list they never asked to see. Fetched once and kept — the guard is
   * `conversations === null` rather than a loading flag, so a failed read
   * retries on the next visit to the pane instead of being remembered as an
   * empty list.
   */
  /**
   * Saved plans, read once per visit to the pane. Same `null`-means-unread
   * shape as the chats list above, for the same reason.
   */
  useEffect(() => {
    if (pane !== "plans" || plans !== null) return;
    let active = true;
    fetch("/desktop/plans/list", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Plans unavailable");
        return response.json() as Promise<{ plans: SavedPlan[] }>;
      })
      .then((body) => {
        if (!active) return;
        setPlans(body.plans);
        setPlansError("");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setPlansError(error instanceof Error ? error.message : "Plans unavailable");
      });
    return () => {
      active = false;
    };
  }, [pane, plans]);

  useEffect(() => {
    if (pane !== "chats" || conversations !== null) return;
    let active = true;
    api<DashboardConversation[]>("/api/conversations")
      .then((items) => {
        if (!active) return;
        setConversations(items);
        setConversationsError("");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setConversationsError(
          error instanceof Error ? error.message : "Conversations unavailable",
        );
      });
    return () => {
      active = false;
    };
  }, [pane, conversations]);

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);



  const totalPapers = projects.reduce(
    (total, item) => total + item.paperCount,
    0,
  );

  const leaveForPaper = (projectId: string, paperId: string) => {
    // Navigation is the action after this dialog, so dismiss the dialog before
    // the route changes. Otherwise the new reader appears to load "behind"
    // an account sheet that no longer has anything to do with the user's task.
    onClose();
    onOpenPaper(projectId, paperId);
  };

  /** The project itself, not its first paper: it opens wherever a project does. */
  const leaveForProject = (target: Project) => {
    onClose();
    onNavigate(projectPath(user.username, target));
  };

  /** Same order, same reason — the sheet goes before the destination arrives. */
  const leaveForConversation = (conversation: DashboardConversation) => {
    onClose();
    onNavigate(conversationDestination(user.username, conversation));
  };

  const leaveForMemory = (href: string) => {
    onClose();
    onNavigate(href);
  };

  return (
    <div className="modal-backdrop account-backdrop settings-backdrop" onMouseDown={onClose}>
      <section
        className={`account-modal settings-modal${
          personaDetail && !market && editing === undefined ? " is-detail" : ""
        }${market ? " is-market" : ""}${pane === "persona" && !market && !connectionView ? " is-persona" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {/* An SVG cross, not the × glyph: a character sits on its own baseline
            inside a line box, so centring it in a 32px square took a
            hand-tuned padding that only held at one font size. Two strokes
            centred on the viewBox cannot be off-centre. */}
        <button
          className="account-close"
          onClick={onClose}
          aria-label="Close settings"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" fill="none">
            <path
              d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>

        {market ? (
          <PersonaMarketplace
            onBack={() => setMarket(false)}
            onInstalled={async () => {
              setPersonaReloads((count) => count + 1);
              onPersonasChanged?.();
            }}
            onNotice={onNotice}
          />
        ) : connectionView && aiConnection.state ? (
          <AiConnectionView connection={aiConnection} onBack={() => setConnectionView(false)} tier={tier} />
        ) : (
        <>
        {/* Identity heads the rail rather than the sheet: the panes to its
            right are five different subjects, and a banner across both
            columns would claim to head all of them. */}
        <nav className="settings-nav" aria-label="Settings sections">
          <header className="settings-identity">
            <img src="/brand/delphi-mark.svg" alt="" width="32" height="32" />
            <h2 id="account-modal-title">Settings</h2>
          </header>
          {PANES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={
                pane === entry.id ? "settings-nav-item is-active" : "settings-nav-item"
              }
              aria-current={pane === entry.id ? "page" : undefined}
              onClick={() => setPane(entry.id)}
            >
              <entry.Icon />
              {entry.label}
            </button>
          ))}
        </nav>

        {/* One scroll container for whichever pane is showing. It keeps the
            ref the projects drag autoscrolls against, which is why the panes
            are switched inside it rather than each bringing its own. */}
        <div className="account-modal-body settings-pane" ref={bodyRef}>
          {pane === "projects" ? <>
          <div className="account-section-heading is-inline">
            <h3>Projects</h3>
            <span>
              {projects.length} {projects.length === 1 ? "project" : "projects"} ·{" "}
              {totalPapers} {totalPapers === 1 ? "paper" : "papers"}
            </span>
          </div>
          <div
            className={`account-project-list ${
              draggingPaperId ? "is-dragging" : ""
            }`}
          >
            {loadingLibrary ? (
              <ListOutline label="Loading your library" />
            ) : null}
            {libraryError ? (
              <div className="form-error">{libraryError}</div>
            ) : null}
            {!loadingLibrary && !library.length && !libraryError ? (
              <div className="account-list-state">
                Projects and papers will appear here as you add them.
              </div>
            ) : null}
            {/* The Chats pane's pattern with the project in place of the day:
                a small-caps label over one white card of hairline rows. */}
            {library.map((item) => {
              const color = projectAccent(item.id, projects);
              const sortedPapers = sortedAccountPapers(item.papers);
              /* Where the lifted paper sits in this card, if it is this card's.
                 The two gaps either side of it are the place it already has, and
                 its outline marks that — opening one would promise a move that
                 changes nothing. */
              const liftedAt = sortedPapers.findIndex(
                (entry) => entry.id === draggingPaperId,
              );
              const gapOpen = (index: number) =>
                drop?.projectId === item.id &&
                drop.index === index &&
                !(liftedAt >= 0 && (index === liftedAt || index === liftedAt + 1));
              return (
                <section
                  key={item.id}
                  data-account-project={item.id}
                  aria-label={item.name}
                  className={[
                    "settings-group account-project",
                    drop?.projectId === item.id ? "drop-target" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ "--project-color": color } as CSSProperties}
                >
                  <div className="account-project-heading">
                    <span className="account-project-dot" aria-hidden="true" />
                    <h4>{item.name}</h4>
                    <span
                      className="account-project-count"
                      aria-label={`${item.papers.length} ${
                        item.papers.length === 1 ? "paper" : "papers"
                      }`}
                    >
                      {item.papers.length}
                    </span>
                    <button
                      type="button"
                      className="account-open-project"
                      aria-label={`Open ${item.name}`}
                      title="Open project"
                      onClick={() => leaveForProject(item)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9" /></svg>
                    </button>
                  </div>
                  <div className="settings-card account-paper-list">
                    {/* A gap before every row and one after the last, all
                        mounted for the whole drag and all closed but one.
                        Mounted, because an element that appears already open
                        cannot transition — and the transition is the point:
                        the gap is in normal flow, so opening it pushes this
                        project's papers *and* every project heading below them
                        down together, on one spring. Moving the open state from
                        one gap to its neighbour reads as the gap sliding. */}
                    {draggingPaperId ? (
                      <span
                        data-account-slot="0"
                        className={`account-drop-slot is-first ${
                          gapOpen(0) ? "open" : ""
                        }`}
                        aria-hidden="true"
                      />
                    ) : null}
                    {sortedPapers.map((itemPaper, paperIndex) => {
                      const open =
                        item.id === currentProjectId &&
                        itemPaper.id === currentPaperId;
                      const done = isDone(itemPaper);
                      const mark = paperMark(itemPaper);
                      return (
                      <Fragment key={itemPaper.id}>
                      {/* The seat is the row's place in the card: it keeps the
                          hairline and, while its paper is in the air, the
                          outline of what was lifted out of it. */}
                      <div
                        data-account-paper={itemPaper.id}
                        className={`account-paper-seat${
                          draggingPaperId === itemPaper.id ? " is-lifted" : ""
                        }`}
                      >
                      <button
                        type="button"
                        className={[
                          "account-paper-row",
                          open ? "active" : "",
                          done ? "done" : "",
                          pressingPaperId === itemPaper.id ? "press-pending" : "",
                          draggingPaperId === itemPaper.id ? "dragging" : "",
                          movingPaperId === itemPaper.id ? "moving" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        style={
                          {
                            "--paper-drag-x": `${dragOffset.x}px`,
                            "--paper-drag-y": `${dragOffset.y}px`,
                          } as CSSProperties
                        }
                        title="Drag onto another project to move it there"
                        aria-current={open ? "page" : undefined}
                        aria-grabbed={draggingPaperId === itemPaper.id}
                        onPointerDown={(event) =>
                          beginPaperDrag(event, item.id, itemPaper.id)
                        }
                        onClick={(event) => {
                          if (suppressClickRef.current) {
                            suppressClickRef.current = false;
                            event.preventDefault();
                            return;
                          }
                          leaveForPaper(item.id, itemPaper.id);
                        }}
                      >
                        {/* The line under the title says the kind in words, so
                            the mark itself is decoration to a screen reader. */}
                        <KindMark kind={mark} />
                        <span className="account-paper-text">
                          <strong>{itemPaper.title}</strong>
                          <span className="account-paper-meta">
                            {open ? (
                              <span className="account-paper-open">Open now</span>
                            ) : null}
                            {done ? (
                              <span className="account-paper-done">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg>
                                Done
                              </span>
                            ) : null}
                            <span>{PAPER_MARK_LABEL[mark]}</span>
                          </span>
                        </span>
                      </button>
                      </div>
                      {draggingPaperId ? (
                        <span
                          data-account-slot={paperIndex + 1}
                          className={`account-drop-slot ${
                            gapOpen(paperIndex + 1) ? "open" : ""
                          }`}
                          aria-hidden="true"
                        />
                      ) : null}
                      </Fragment>
                      );
                    })}
                    {!item.papers.length ? (
                      <span className="account-empty-project">
                        No papers yet
                      </span>
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>
          </> : null}

          {pane === "plans" ? (
            <>
              <div className="account-section-heading is-inline">
                <h3>Plans</h3>
                <span>
                  {plans
                    ? `${plans.filter((plan) => plan.url).length} of 3 hosted`
                    : ""}
                </span>
              </div>
              <p className="settings-pane-lede">
                Saved from Plan mode; every plan stays readable through Delphi
                MCP by its ID.
              </p>
              {!plans && !plansError ? (
                <ListOutline label="Loading your plans" />
              ) : null}
              {plansError ? <div className="form-error">{plansError}</div> : null}
              {plans && !plans.length ? (
                <div className="account-list-state">
                  Plans appear here once Delphi has saved one from a chat in plan mode.
                </div>
              ) : null}
              {(
                [
                  ["Hosted locally", (plans ?? []).filter((plan) => plan.url)],
                  ["Not hosted", (plans ?? []).filter((plan) => !plan.url)],
                ] as const
              ).map(([heading, group]) => group.length ? (
                <section key={heading} className="settings-group">
                  <h4>{heading}</h4>
                  <div className="settings-card">
                    {group
                      .slice()
                      .sort((a, b) =>
                        Number(a.archived) - Number(b.archived) ||
                        b.createdAt.localeCompare(a.createdAt),
                      )
                      .map((plan) => {
                        /* The id is not decoration: `get_plan` takes the exact
                           UUID, and an archived or unhosted plan has no link at
                           all, so telling a reader it is "available through MCP"
                           is only actionable with the id in hand. */
                        const id = (
                          <button
                            type="button"
                            className="settings-plan-id"
                            title={`Copy ${plan.id} for Delphi MCP`}
                            onClick={(event) => {
                              event.preventDefault();
                              void navigator.clipboard
                                ?.writeText(plan.id)
                                .then(() => setCopiedPlan(plan.id))
                                .catch(() => onNotice?.("Could not copy the plan ID"));
                            }}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></svg>
                            {copiedPlan === plan.id ? "Copied" : plan.id.slice(0, 8)}
                          </button>
                        );
                        const text = (
                          <span className="settings-plan-text">
                            <strong>{plan.title}</strong>
                            <small>
                              {plan.url
                                ? `rev ${plan.revision} · ${relativeTime(plan.createdAt)}`
                                : plan.archived
                                  ? "Archived · kept for Delphi MCP"
                                  : "Hosting unavailable · retrieve through Delphi MCP"}
                            </small>
                          </span>
                        );
                        const tile = (
                          <span className="settings-row-tile is-plan" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" /><path d="M9 12h6M9 16h6" /></svg>
                          </span>
                        );
                        /* A hosted plan is a link to its own localhost origin,
                           which the main process sends to the real browser; an
                           archived or unserved one is a plain row, and must not
                           read as something that can be opened. */
                        return plan.url ? (
                          <a
                            key={plan.id}
                            className="settings-plan-row"
                            href={plan.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {tile}
                            {text}
                            {id}
                            <svg className="settings-plan-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9" /></svg>
                          </a>
                        ) : (
                          <div key={plan.id} className="settings-plan-row is-unhosted">
                            {tile}
                            {text}
                            {id}
                          </div>
                        );
                      })}
                  </div>
                </section>
              ) : null)}
            </>
          ) : null}

          {pane === "chats" ? (
            <>
              <div className="account-section-heading is-inline">
                <h3>Chats</h3>
                <span>
                  {conversations
                    ? `${conversations.length} conversation${conversations.length === 1 ? "" : "s"}`
                    : ""}
                </span>
              </div>
              {!conversations && !conversationsError ? (
                <ListOutline label="Loading your chats" />
              ) : null}
              {conversationsError ? (
                <div className="form-error">{conversationsError}</div>
              ) : null}
              {conversations && !conversations.length ? (
                <div className="account-list-state">
                  Conversations appear here once you have asked something.
                </div>
              ) : null}
              {/* Grouped by day, so no row carries a time of its own: the
                  title is what the reader is scanning for, and it takes the
                  weight. Where it was asked sits under it, quietly. */}
              {groupByDay(conversations ?? [], (conversation) => conversation.lastEngagedAt).map(({ day, items }) => (
                <section key={day} className="settings-group">
                  <h4>{day}</h4>
                  <div className="settings-card">
                    {items.map((conversation) => {
                      const [collection, ...rest] = conversationSource(conversation);
                      return (
                        <button
                          key={conversation.id}
                          type="button"
                          className="settings-chat-row"
                          title={relativeTime(conversation.lastEngagedAt)}
                          onClick={() => leaveForConversation(conversation)}
                        >
                          {/* The title, which is what the Dashboard's hints
                              show — model-written once per conversation, and
                              the reader's own opening words until then. */}
                          <strong>{conversation.title}</strong>
                          <span className="settings-chat-source" title={[collection, ...rest].join(" · ")}>
                            {/* The collection wears the project's accent, from
                                the same `projectAccent` the switcher dot, the
                                library glyph and the projects pane already read
                                — a reader who knows Scaling Law is orange should
                                not have to re-learn it one pane over. A Memory
                                chat wears Memory's coral. */}
                            <span
                              className="settings-chat-project"
                              style={{
                                "--project-color": conversation.projectId
                                  ? projectAccent(
                                      conversation.projectId,
                                      projects,
                                    )
                                  : conversation.kind === "memory_chat"
                                    ? "var(--coral)"
                                    : undefined,
                              } as CSSProperties}
                            >
                              <i className="settings-chat-dot" aria-hidden="true" />
                              {collection}
                            </span>
                            {rest.map((part) => (
                              <span key={part}>{part}</span>
                            ))}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </>
          ) : null}

          {pane === "persona" ? (
            editing !== undefined ? (
              <PersonaEditor
                persona={editing}
                config={config}
                onCancel={() => setEditing(undefined)}
                onSaved={async () => {
                  setEditing(undefined);
                  setPersonaDetail(null);
                  setPersonaReloads((count) => count + 1);
                  onPersonasChanged?.();
                }}
                onNotice={onNotice}
              />
            ) : (
              <PersonaPane
                config={config}
                onNotice={onNotice}
                onBrowse={() => {
                  setPersonaDetail(null);
                  setMarket(true);
                }}
                detail={personaDetail}
                onDetailChange={setPersonaDetail}
                reloadToken={personaReloads}
                onEdit={setEditing}
              />
            )
          ) : null}

          {pane === "advanced" ? (
            <>
              <div className="account-section-heading">
                <h3>Advanced</h3>
              </div>
              {/* Model first: the connection is what a reader comes here to
                  change; Memory is the diagnostics after. The OpenAI tier is
                  set beside the OpenAI key, the one thing it bills. */}
              <section className="settings-group" aria-labelledby="settings-model-label">
                <h4 id="settings-model-label">Model</h4>
                <div className="settings-card">
                  <AiConnectionRow connection={aiConnection} onOpen={() => setConnectionView(true)} tier={tier.value} />
                </div>
              </section>
              <section className="settings-group" aria-labelledby="settings-memory-label">
                <h4 id="settings-memory-label">Memory</h4>
                <div className="settings-card">
                  <button
                    type="button"
                    className="settings-row settings-link-row"
                    onClick={() => leaveForMemory("/memory/graph")}
                  >
                    <span className="settings-row-tile is-graph"><MemoryIcon className="settings-row-glyph" /></span>
                    <span className="settings-row-text">
                      <strong>Map</strong>
                      <small>How your pages and domains connect</small>
                    </span>
                    <svg className="settings-row-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
                  </button>
                  <button
                    type="button"
                    className="settings-row settings-link-row"
                    onClick={() => leaveForMemory("/memory/health")}
                  >
                    <span className="settings-row-tile is-health">
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l3-7 4 14 3-7h4" /></svg>
                    </span>
                    <span className="settings-row-text">
                      <strong>Health</strong>
                      <small>Findings, lint and filing history</small>
                    </span>
                    <svg className="settings-row-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
                  </button>
                  <a
                    className="settings-row settings-link-row"
                    href={`${API_BASE}/api/export`}
                  >
                    <span className="settings-row-tile is-export">
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
                    </span>
                    <span className="settings-row-text">
                      <strong>Export</strong>
                      <small>Everything, as a folder with an index page</small>
                    </span>
                    <svg className="settings-row-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
                  </a>
                </div>
              </section>
            </>
          ) : null}
        </div>

        {/* The third column. Declared as a 0px track in the base rule so the
            track count never changes and the widening interpolates; it holds a
            scroll of its own, which is why it is a sibling of the pane rather
            than something nested inside its scroller. */}
        {personaDetail && editing === undefined ? (
          <PersonaDetail
            persona={personaDetail}
            onClose={() => setPersonaDetail(null)}
          />
        ) : null}
        </>
        )}
      </section>
    </div>
  );
}
