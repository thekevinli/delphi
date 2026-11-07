"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { SettingsModal, type SettingsPane } from "./SettingsModal";
import { CreateProjectModal } from "./CreateProjectModal";
import { DashboardRail } from "./DashboardRail";
import { MemoryIcon } from "./MemoryIcon";
import { MemoryGraphCanvas } from "./MemoryGraphCanvas";
import { Onboarding } from "./Onboarding";
import { Toast, type Notice } from "./Notice";
import { GraphMark, LoadingWords, SkeletonBar, SweepText } from "./Loading";
import {
  API_BASE, api, setUnauthorizedHandler,
  type AppConfig, type DashboardConversation, type DashboardData, type DashboardDocument,
  type DashboardProject, type MemoryOverview, type Project, type ProjectSummary, type User,
} from "../lib/api";
import {
  DASHBOARD_THREAD_LIMIT, SHELF_DOCUMENT_LIMIT, conversationContext,
  conversationDestination, horizontalWheelDelta, shelfCaption, shortRelativeTime,
} from "../lib/dashboard";
import { pageTitle } from "../lib/page-title";
import { documentPath, projectPath } from "../lib/routes";
import { accentAt, accentInk, accentTint } from "../lib/project-color";
import { startMemoryMaintenance } from "../lib/memory-maintenance";
import { startCaptures } from "../lib/capture-queue";
import TitleText from "./TitleText";

function documentHref(username: string, document: DashboardDocument) {
  return documentPath(
    username,
    { slug: document.projectSlug },
    { slug: document.slug },
  );
}

function sourceHost(document: DashboardDocument) {
  if (!document.url) return "saved webpage";
  try {
    return new URL(document.url).hostname.replace(/^www\./, "");
  } catch {
    return "saved webpage";
  }
}

function ThumbnailFallback({ document }: { document: DashboardDocument }) {
  if (document.kind === "web") {
    return <span className="dashboard-thumb-webcard" aria-hidden="true">
      <span className="dashboard-thumb-browserbar"><i /><i /><i /><b>{sourceHost(document)}</b></span>
      <span className="dashboard-thumb-webbody">
        <span className="dashboard-thumb-globe"><i /><i /></span>
        <span className="dashboard-thumb-lines"><i /><i /><i /></span>
      </span>
    </span>;
  }
  return <span className="dashboard-thumb-pdfcard" aria-hidden="true">
    <span className="dashboard-thumb-pdfhead"><b>PDF</b><i /></span>
    <span className="dashboard-thumb-pdftitle"><i /><i /></span>
    <span className="dashboard-thumb-pdfcopy"><i /><i /><i /><i /></span>
    <span className="dashboard-thumb-pdffooter">01</span>
  </span>;
}

function DashboardThumbnail({ document }: { document: DashboardDocument }) {
  const [failed, setFailed] = useState(false);
  const showImage = document.thumbnailAvailable && !failed;
  return <span className={`dashboard-thumb ${document.kind === "web" ? "web" : "pdf"}`}>
    {showImage ? <>
      {/* Authenticated API bytes are not compatible with Next's image optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${API_BASE}/api/projects/${document.projectId}/papers/${document.id}/thumbnail?v=${document.thumbnailVersion ?? 0}&t=${encodeURIComponent(document.thumbnailAttemptedAt ?? "")}`}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </> : <ThumbnailFallback document={document} />}
  </span>;
}

/**
 * A section whose name is its door: the label itself opens the detail behind
 * it — every thread, the full Memory map — with no icon beside it. On hover or
 * focus the chat's waiting light passes over the word, and that is the only
 * affordance: no background, no outline.
 */
function SectionTitle({ title, label, onClick, href }: {
  title: string;
  label: string;
  onClick?: () => void;
  href?: string;
}) {
  const word = <SweepText text={title} />;
  return <h2>{href
    ? <Link href={href} className="dashboard-section-link" aria-label={label}>{word}</Link>
    : <button type="button" className="dashboard-section-link" aria-label={label} onClick={onClick}>{word}</button>}</h2>;
}

/**
 * A section's one action, as an icon a comfortable step to the right of its
 * label rather than a word pushed to the far edge: the page already carries a
 * lot of text. Its words live in a small tooltip and its accessible name; the
 * plus turns a quarter on hover.
 */
function SectionAction({ label, onClick }: {
  label: string;
  onClick: () => void;
}) {
  return <button type="button" className="dashboard-section-action is-add" aria-label={label} data-tip={label} onClick={onClick}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
  </button>;
}

/**
 * A project is a shelf: its name in a column of its own, then its documents
 * standing side by side on a floor of the project's tint. Rows, not columns,
 * because that is how a library groups like with like — and a reader scrolling
 * down the page meets each project's name before its papers.
 *
 * A cover shows only its source and length; the title comes up on hover or
 * focus, two lines at most. The row scrolls sideways (up to
 * `SHELF_DOCUMENT_LIMIT`) with no arrow: the cover cut by the right edge is
 * what says there is more.
 */
function ProjectShelf({ project, onOpen, onOpenProject }: {
  project: DashboardProject;
  onOpen: (document: DashboardDocument) => void;
  onOpenProject: () => void;
}) {
  const row = useRef<HTMLUListElement>(null);
  const color = accentAt(project.accentIndex);
  const documents = project.documents.slice(0, SHELF_DOCUMENT_LIMIT);

  // Native and non-passive: React's onWheel cannot preventDefault, so a
  // horizontal flick would still become browser back/forward. Vertical-dominant
  // wheels are left alone so they keep scrolling the page.
  useEffect(() => {
    const shelf = row.current;
    if (!shelf) return;
    const onWheel = (event: WheelEvent) => {
      if (shelf.scrollWidth <= shelf.clientWidth) return;
      const delta = horizontalWheelDelta(event.deltaX, event.deltaY, event.shiftKey);
      if (!delta) return;
      event.preventDefault();
      shelf.scrollLeft += delta;
    };
    shelf.addEventListener("wheel", onWheel, { passive: false });
    return () => shelf.removeEventListener("wheel", onWheel);
  }, []);

  return <section className="dashboard-shelf" aria-label={project.name}
    style={{ "--shelf-ink": accentInk(color), "--shelf-tint": accentTint(color) } as React.CSSProperties}>
    <div className="dashboard-shelf-label">
      <button type="button" className="dashboard-shelf-name" onClick={onOpenProject}>
        {project.name}<span className="dashboard-shelf-count" aria-label={`${project.totalCount} documents`}>{project.totalCount}</span>
      </button>
      <button type="button" className="dashboard-shelf-open" onClick={onOpenProject} aria-label={`Open ${project.name}`}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </button>
    </div>
    <ul className="dashboard-shelf-row" ref={row} aria-label={`${project.name} documents`}>
      {documents.map((document) => {
        const title = pageTitle(document.title);
        return <li key={document.id}>
          <button type="button" className="dashboard-shelf-cover" onClick={() => onOpen(document)} aria-label={title}>
            <span className="dashboard-shelf-stand">
              <span className="dashboard-shelf-floor" aria-hidden="true" />
              <DashboardThumbnail document={document} />
            </span>
            <span className="dashboard-shelf-caption" aria-hidden="true">
              <span className="dashboard-shelf-meta">{shelfCaption(document)}</span>
              <span className="dashboard-shelf-title">{title}</span>
            </span>
          </button>
        </li>;
      })}
    </ul>
  </section>;
}

/**
 * One row per recent thread: where it lives ("project > what it was about")
 * with when in the corner, then the thread's own title. The rows share one
 * card, so a thread is a line in a list rather than a tile of its own.
 */
function ThreadCard({ conversation, color, onOpen }: {
  conversation: DashboardConversation;
  color: string;
  onOpen: () => void;
}) {
  const memoryChat = conversation.kind === "memory_chat";
  const context = conversationContext(conversation);
  return <button className="dashboard-thread" onClick={onOpen}
    style={{ "--project-tint": accentTint(color), "--project-ink": accentInk(color) } as React.CSSProperties}>
    <span className="dashboard-thread-meta">
      {memoryChat
        ? <span className="dashboard-conversation-memory"><MemoryIcon className="dashboard-conversation-source-icon" />Memory</span>
        : <span className="dashboard-thread-project" title={conversation.projectName ?? undefined}>{conversation.projectName}</span>}
      <svg className="dashboard-thread-crumb" viewBox="0 0 8 8" aria-hidden="true"><path d="M3 1.5 5.5 4 3 6.5" /></svg>
      <span className="dashboard-thread-context">{conversation.kind === "document_chat" ? pageTitle(context) : context}</span>
      <time dateTime={conversation.lastEngagedAt} title={new Date(conversation.lastEngagedAt).toLocaleString()}>{shortRelativeTime(conversation.lastEngagedAt)}</time>
    </span>
    <strong><TitleText title={conversation.title} /></strong>
  </button>;
}

/**
 * The Memory graph is what Delphi remembers, so it is the Dashboard's motif: the
 * real graph, small and in pastels, with nothing on the card but the graph and
 * its fit control. With Memory off the panel still stands, and says what
 * would fill it.
 */
function MemoryPanel({ enabled, onOpen }: {
  enabled: boolean;
  onOpen: (slug: string) => void;
}) {
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [failed, setFailed] = useState(false);
  /** The domain whose name was pressed on the card: the card zooms onto it
   *  and names its pages, and the fit control zooms back out. */
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    api<MemoryOverview>("/api/memory")
      .then((value) => { if (active) setOverview(value); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [enabled]);
  return <section className="dashboard-section dashboard-memory" aria-label="Memory">
    <div className="dashboard-section-title">
      {enabled ? <SectionTitle title="Memory" label="Memory, open the map" href="/memory/graph" /> : <h2>Memory</h2>}
    </div>
    <div className="dashboard-memory-card">
      <div className="dashboard-memory-graph">
        {!enabled ? <p className="dashboard-memory-note">Turn on Memory to see how your reading connects.</p>
          : failed ? <p className="dashboard-memory-note">Memory is unavailable right now.</p>
          : overview && !overview.pages.length ? <p className="dashboard-memory-note">Pages appear here as you read and ask.</p>
          : <MemoryGraphCanvas compact revision={overview?.revision ?? 0} pages={overview?.pages ?? []}
              links={overview?.links ?? []} domains={overview?.domains ?? []} onOpen={onOpen}
              ready={Boolean(overview)} legend={[]} focusDomain={focus} onFocusDomain={setFocus} />}
      </div>
    </div>
  </section>;
}

/** Covers drawn on the outlined shelf; the last ones fade, as a row runs on. */
const SHELF_OUTLINE_COVERS = [1, 1, 1, 0.7, 0.35];

/** A thread row's outline: the project label and its context, then the title. */
function ThreadOutline() {
  return <div className="dashboard-thread-outline">
    <div className="dashboard-thread-meta">
      <SkeletonBar width="64px" height={14} tone="tint" />
      <SkeletonBar width="38%" height={8} />
      <SkeletonBar width="34px" height={8} className="dashboard-thread-outline-time" />
    </div>
    <div className="dashboard-thread-outline-title"><SkeletonBar width="62%" height={11} tone="strong" /></div>
  </div>;
}

/**
 * The Dashboard before its data: the real arrangement, with the section names
 * drawn for real — they never change — and only what fills them outlined.
 * Threads and the shelf show their shape; the Memory card grows the graph in
 * place, as it will once the map is on its way.
 */
function DashboardLoading() {
  return <div className="dashboard-loading" role="status">
    <LoadingWords text="Loading your Delphi" />
    <div className="dashboard-top">
      <section className="dashboard-section dashboard-threads">
        <div className="dashboard-section-title"><h2>Recent threads</h2></div>
        <div className="dashboard-conversations skeleton">
          {Array.from({ length: DASHBOARD_THREAD_LIMIT }, (_, index) => <ThreadOutline key={index} />)}
        </div>
      </section>
      <section className="dashboard-section dashboard-memory">
        <div className="dashboard-section-title"><h2>Memory</h2></div>
        <div className="dashboard-memory-card">
          <div className="dashboard-memory-graph"><div className="kb-graph-loading"><GraphMark /></div></div>
        </div>
      </section>
    </div>
    <section className="dashboard-section dashboard-projects">
      <div className="dashboard-section-title"><h2>Projects</h2></div>
      <div className="dashboard-shelves skeleton">
        <div className="dashboard-shelf is-outline">
          <div className="dashboard-shelf-label">
            <SkeletonBar width="70%" height={10} tone="strong" />
            <SkeletonBar width="40%" height={8} />
          </div>
          <div className="dashboard-shelf-outline-row">
            {SHELF_OUTLINE_COVERS.map((opacity, index) => <span key={index}
              className="skeleton-bar dashboard-shelf-outline-cover" style={{ opacity }} />)}
          </div>
        </div>
      </div>
    </section>
  </div>;
}

export function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice>("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPane, setSettingsPane] = useState<SettingsPane>("projects");
  const [creatingProject, setCreatingProject] = useState(false);
  const openSettings = (pane: SettingsPane) => { setSettingsPane(pane); setSettingsOpen(true); };
  const [loading, setLoading] = useState(true);
  /** Whether this visit is a first run: the server decides, from the account's
   *  onboarding record, not from whether any project happens to exist. */
  const [onboarding, setOnboarding] = useState(false);

  const refresh = useCallback(async () => {
    const dashboard = await api<DashboardData>("/api/dashboard");
    setData(dashboard);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setError("Local session unavailable. Quit and reopen Delphi to reconnect."));
    Promise.all([
      api<User>("/api/auth/me", {}, { allow401: true }),
      // Where to land first, then the library: resolving an interrupted
      // onboarding may have just deleted its projects.
      api<{ onboarding: boolean }>("/api/onboarding/resolve", { method: "POST" })
        .then(async (landing) => [landing, await api<DashboardData>("/api/dashboard")] as const),
      api<AppConfig>("/api/config"),
    ]).then(([me, [landing, dashboard], appConfig]) => {
      setUser(me); setData(dashboard); setConfig(appConfig); setOnboarding(landing.onboarding);
      startMemoryMaintenance(appConfig.memoryEnabled);
      // A page a quit app left at its first window is read whole wherever the app opens.
      startCaptures();
    }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : "Dashboard unavailable");
    }).finally(() => setLoading(false));
    return () => setUnauthorizedHandler(null);
  }, [router]);

  // Back into palette order before it leaves the Dashboard: `projectAccent`
  // takes its index from the list it is handed, and the settings sheet must
  // colour a project the way the library rail does — the carousel's recency
  // order is a fact about this one surface.
  const projects: ProjectSummary[] = (data?.projects ?? [])
    .slice()
    .sort((a, b) => a.accentIndex - b.accentIndex)
    .map((project) => ({
      id: project.id, name: project.name, slug: project.slug,
      paperCount: project.totalCount, updatedAt: "",
    }));
  /** A project's colour follows the project, never its position in the rail. */
  const accentForProject = (projectId: string | undefined): string => {
    const project = data?.projects.find((item) => item.id === projectId);
    return accentAt(project ? project.accentIndex : 0);
  };

  const openPaper = async (projectId: string, paperId: string) => {
    const project = await api<Project>(`/api/projects/${projectId}`);
    const paper = project.papers.find((item) => item.id === paperId);
    if (user && paper) router.push(documentPath(user.username, project, paper));
  };

  return (
    <main className={`dashboard-shell${onboarding ? " is-onboarding" : ""}`}>
      {/* A first run is the onboarding alone: no rail beside it, no headline over
          it and no empty sections under it. The window still needs somewhere to
          be dragged from, which the rail otherwise provides. It stays up until
          its last screen finishes the attempt, whatever projects it has made. */}
      {user && data && config && onboarding ? <>
        <div className="desktop-window-drag" aria-hidden="true" />
        <Onboarding config={config} onFinish={async () => {
          await refresh();
          setOnboarding(false);
        }} />
      </> : <>
      <DashboardRail
        user={user}
        onOpenSettings={() => openSettings("projects")}
      />
      <div className="dashboard-wrap">
        {loading ? <DashboardLoading /> : null}
        {error ? <div className="dashboard-state dashboard-error">{error}<button onClick={() => location.reload()}>Try again</button></div> : null}
        {user && data ? <>
          <div className="dashboard-top">
            <section className="dashboard-section dashboard-threads" aria-label="Recent threads">
              <div className="dashboard-section-title">
                {data.conversations.length
                  ? <SectionTitle title="Recent threads" label="Recent threads, see all" onClick={() => openSettings("chats")} />
                  : <h2>Recent threads</h2>}
              </div>
              <div className="dashboard-conversations">
                {data.conversations.slice(0, DASHBOARD_THREAD_LIMIT).map((conversation) => <ThreadCard
                  key={conversation.id} conversation={conversation}
                  color={accentForProject(conversation.projectId ?? undefined)}
                  onOpen={() => router.push(conversationDestination(user.username, conversation))} />)}
                {!data.conversations.length ? <p className="dashboard-empty dashboard-conversations-empty">Your recent conversations will appear here.</p> : null}
              </div>
            </section>
            <MemoryPanel enabled={Boolean(config?.memoryEnabled)}
              onOpen={(slug) => router.push(`/memory?page=${encodeURIComponent(slug)}`)} />
          </div>

          <section className="dashboard-section dashboard-projects">
            <div className="dashboard-section-title">
              <h2>Projects</h2>
              <SectionAction label="New project" onClick={() => setCreatingProject(true)} />
            </div>
            <div className="dashboard-shelves">
              {data.projects.map((project) => <ProjectShelf key={project.id} project={project}
                onOpen={(document) => router.push(documentHref(user.username, document))}
                onOpenProject={() => router.push(projectPath(user.username, project))} />)}
            </div>
          </section>
        </> : null}
      </div>
      </>}
      {settingsOpen && user && config ? <SettingsModal
        user={user} onUserChange={setUser} projects={projects} config={config} initialPane={settingsPane}
        /* The Dashboard has no composer, so nothing here reads the catalog —
           the reader picks a persona in a chat, and that shell reloads its own. */
        onClose={() => setSettingsOpen(false)} onOpenPaper={(projectId, paperId) => void openPaper(projectId, paperId)}
        onNavigate={(href) => router.push(href)}
        onMovePaper={async (from, paperId, to, position) => { await api(`/api/projects/${from}/papers/${paperId}/move`, { method: "POST", body: JSON.stringify({ project_id: to, position }) }); await refresh(); }}
        onReordered={refresh} onNotice={setNotice}
        maxPapers={config.maxPapersPerProject}
      /> : null}
      {creatingProject && user ? <CreateProjectModal
        onClose={() => setCreatingProject(false)}
        onCreate={async (name) => {
          const created = await api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name }) });
          setCreatingProject(false);
          // Straight into filling it, on the reader's setup.
          router.push(`${projectPath(user.username, created)}?setup=1`);
        }}
      /> : null}
      {notice ? <Toast notice={notice} onDismiss={() => setNotice("")} /> : null}
    </main>
  );
}
