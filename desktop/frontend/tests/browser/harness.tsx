import MathHarness from "./MathHarness";
import DisplayHarness from "./DisplayHarness";
import { AnswerFlow } from "../../app/components/AnswerTrace";
import { traceAnswer, traceFixture, traceRunning, traceWorkedOnly } from "./trace-fixture";
import { traceGoldenCases } from "./trace-golden-fixtures";
/** Test-only host for the shipped reader, using real iframe and worker code.
 *  The webpage viewer zooms itself on macOS, so there is no fixture zoom. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { activateNavigationSnapshot, commitClientNavigationState, createClientNavigationRenderSnapshot, getClientNavigationRenderContext, replaceHistoryStateWithoutNotify } from "vinext/shims/navigation";
import { chatParam, contextFromParam, scopeKey, type ChatContext, type ChatTarget } from "../../app/lib/chat-scope";
import { createRoot } from "react-dom/client";
import { PageViewer, type PageViewerHandle } from "../../app/components/PageViewer";
import { PdfViewer, type PdfFocus } from "../../app/components/PdfViewer";
import DigestPane, { type DigestActivity } from "../../app/components/DigestPane";
import PersonaHarness from "./PersonaHarness";
import SettingsProjectsHarness from "./SettingsProjectsHarness";
import LibraryHarness from "./LibraryHarness";
import AiConnectionHarness from "./AiConnectionHarness";
import MentionHarness from "./MentionHarness";
import FilingHarness, { FilingQueueHarness, FilingWorkflowHarness } from "./FilingHarness";
import { digestFixture } from "./digest-fixture";
import type { DigestDetail } from "../../app/lib/api";
import { MemoAssistantMessage } from "../../app/components/markdown";
import { API_BASE, api, type Highlight, type Note, type Paper } from "../../app/lib/api";
import { mentionedPapers, type CitationTarget } from "../../app/lib/citations";
import { routeCitation } from "../../app/lib/citation-route";
import "../../app/globals.css";
import { RelatedMemoryRail } from "../../app/components/RelatedMemoryRail";
import type { MemoryPageSummary } from "../../app/lib/api";
import { ConversationRail } from "../../app/components/chat/ConversationRail";
import { ChatPanel } from "../../app/components/ChatPanel";
import { AskComposer, type AskDraft } from "../../app/components/chat/AskComposer";
import { officialPersonas } from "./persona-fixture";
import { DEFAULT_APP_CONFIG } from "../../app/lib/api";
import { usePlanCapacity } from "../../app/components/chat/PlanCapacity";
import type { ConversationSummary } from "../../app/lib/conversation-session";
import { Toast, hint, noticeText, type Notice } from "../../app/components/Notice";
const noop = () => {};
function Harness() {
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [drafts] = useState(() => new Map<string, string>());
  const [quote, setQuote] = useState("");
  const [evidence, setEvidence] = useState("");
  const [engaged, setEngaged] = useState(0);
  const [saved, setSaved] = useState("");
  const engage = useCallback(() => setEngaged(count => count + 1), []);
  // `partial`: the document was added at its first window, and is read whole
  // when the fixture says so, as the capture queue reports it.
  const [copy, setCopy] = useState<"partial" | "whole">(mode.has("partial") ? "partial" : "whole");
  const ref = useRef<PageViewerHandle>(null);
  const base = "/api/projects/project/papers/paper";
  useEffect(() => {
    void api<Highlight[]>(`${base}/highlights`).then(setHighlights);
    void api<Note[]>(`${base}/notes`).then(setNotes);
  }, []);
  return <><div style={{ height: 48 }}>
    <button onClick={async () => setEvidence(JSON.stringify(await ref.current?.getViewport(quote)))}>Fixture send</button>
    <button onClick={() => setCopy("whole")}>Fixture whole copy</button>
    <output data-testid="quote">{quote}</output><output data-testid="evidence">{evidence}</output><output data-testid="engaged">{engaged}</output><output data-testid="saved">{saved}</output>
  </div><div style={{ width: "85vw", height: "85vh", position: "relative", display: "flex", flexDirection: "column", "--project-color": "#3e7bc9" } as CSSProperties}><PageViewer
    ref={ref} projectId="project" paperId="paper" url="https://article.example/read" title="Test article"
    highlights={highlights} notes={notes} drafts={drafts} browsingEnabled copy={copy}
    onHighlight={async value => {
      const saved = await api<Highlight>(`${base}/highlights`, { method: "POST", body: JSON.stringify({ ...value, color: "amber" }) });
      setHighlights(all => [...all.filter(h => h.id !== saved.id), saved]); return saved;
    }}
    onRemoveHighlight={async id => {
      await api(`${base}/highlights/${id}`, { method: "DELETE" });
      setHighlights(all => all.filter(h => h.id !== id)); setNotes(all => all.filter(n => n.highlightId !== id)); drafts.delete(id);
    }}
    onSaveNote={async value => {
      const saved = await api<Note>(`${base}/notes`, { method: "POST", body: JSON.stringify(value) });
      setNotes(all => [...all.filter(n => n.highlightId !== saved.highlightId), saved]);
    }}
    onReply={setQuote} onEngage={engage} onExternalAction={noop} onImportPdf={noop}
    onSavePage={value => setSaved(value.url)} onHomeChange={noop} onDrag={noop} onFileDrop={noop}
  /></div></>;
}
const NavigationContext = getClientNavigationRenderContext()!;
/** A switch of chat context as Workspace makes it: the address names the
 *  context, and the chat picked from its list if there was one. Like the app
 *  router, the destination renders before its address is committed. */
function ContextNavigation({ children }: { children: (switchTo: (context: ChatContext, conversation?: string) => void) => ReactNode }) {
  const [snapshot, setSnapshot] = useState<ReturnType<typeof createClientNavigationRenderSnapshot> | null>(null);
  useLayoutEffect(() => {
    if (!snapshot) return;
    replaceHistoryStateWithoutNotify(history.state, "", `${snapshot.pathname}?${snapshot.searchParams}`);
    commitClientNavigationState(undefined, { releaseSnapshot: true });
  }, [snapshot]);
  return <NavigationContext.Provider value={snapshot}>{children((context, conversation) => {
    const url = new URL(location.href);
    url.searchParams.set("chat", chatParam(context));
    if (conversation) url.searchParams.set("conversation", conversation); else url.searchParams.delete("conversation");
    activateNavigationSnapshot();
    setSnapshot(createClientNavigationRenderSnapshot(url.href, {}));
  })}</NavigationContext.Provider>;
}
/** The conversation tabs for one project, for `?rail`: the reader's selection, what it hands off, and what a reload reopens. */
function RailNavigationHarness() {
  return <ContextNavigation>{switchTo => <RailHarness onContextChange={switchTo} />}</ContextNavigation>;
}
function RailHarness({ onContextChange }: { onContextChange: (context: ChatContext) => void }) {
  const [seed, setSeed] = useState<ConversationSummary | undefined>();
  const [notice, setNotice] = useState("");
  const params = useSearchParams();
  const context = contextFromParam(params.get("chat"), { hasPaper: true });
  const target: ChatTarget = context === "general" ? { context } : { context, projectId: "project", paperId: "paper" };
  return <><div style={{ height: 48 }}>
    <button onClick={() => setSeed({ id: "b".repeat(32), generation: 0, title: "Chat B", empty: false })}>Fixture hand off B</button>
    {(["document", "general"] as const).map(value => <button key={value} onClick={() => onContextChange(value)}>Fixture {value}</button>)}
    <output data-testid="notice">{notice}</output>
  </div><ConversationRail key={scopeKey(target)} target={target} seedConversation={seed} titleMaxCharacters={DEFAULT_APP_CONFIG.conversationTitleMaxCharacters} onNotice={(notice) => setNotice(noticeText(notice))}>
    {({ conversation, tabs }) => <div>{tabs}<output data-testid="open">{conversation.provisional ? "provisional" : conversation.id}</output></div>}
  </ConversationRail></>;
}
/** One chat panel's plan-storage check, for `?capacity`. `Remount` replaces the
 *  panel as creating a conversation does, keeping the old panel's check, as a
 *  send already in flight keeps it. */
type Ensure = (signal?: AbortSignal) => Promise<boolean>;
function CapacityPanel({ onEnsure }: { onEnsure: (ensure: Ensure) => void }) {
  const capacity = usePlanCapacity("project");
  useEffect(() => { onEnsure(capacity.ensure); });
  return <>{capacity.panel}</>;
}
function CapacityHarness() {
  const [generation, setGeneration] = useState(0);
  const [result, setResult] = useState("");
  const current = useRef<Ensure | null>(null);
  const kept = useRef<Ensure | null>(null);
  const stop = useRef<AbortController | null>(null);
  const ask = (ensure: Ensure | null) => {
    stop.current = new AbortController();
    setResult("waiting");
    void ensure?.(stop.current.signal).then(proceed => setResult(String(proceed)));
  };
  return <div style={{ height: 48 }}>
    <button onClick={() => ask(current.current)}>Fixture ask</button>
    <button onClick={() => { kept.current = current.current; setGeneration(value => value + 1); }}>Fixture remount</button>
    <button onClick={() => ask(kept.current)}>Fixture ask old panel</button>
    <button onClick={() => stop.current?.abort()}>Fixture stop</button>
    <output data-testid="result">{result}</output>
    <CapacityPanel key={generation} onEnsure={ensure => { current.current = ensure; }} />
  </div>;
}
/** The PDF reader with the toolbar slot Workspace gives it, for `?pdf`. */
function PdfHarness() {
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [drafts] = useState(() => new Map<string, string>());
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const base = "/api/projects/project/papers/paper";
  useEffect(() => {
    void api<Highlight[]>(`${base}/highlights`).then(setHighlights);
    void api<Note[]>(`${base}/notes`).then(setNotes);
  }, []);
  return <><div className="reader-actions" style={{ height: 48, display: "flex", justifyContent: "flex-end", paddingRight: 24 }}>
    <div className="reader-annotation-slot" ref={setToolbar} />
  </div><div style={{ width: "85vw", height: "85vh", position: "relative", display: "flex", flexDirection: "column" }}><PdfViewer
    projectId="project" paperId="paper" highlights={highlights} notes={notes} notesEnabled
    annotationToolbar={toolbar} drafts={drafts} zoom={1}
    onHighlight={async value => {
      const saved = await api<Highlight>(`${base}/highlights`, { method: "POST", body: JSON.stringify({ ...value, color: "amber" }) });
      setHighlights(all => [...all.filter(h => h.id !== saved.id), saved]); return saved;
    }}
    onRemoveHighlight={async id => {
      await api(`${base}/highlights/${id}`, { method: "DELETE" });
      setHighlights(all => all.filter(h => h.id !== id)); setNotes(all => all.filter(n => n.highlightId !== id)); drafts.delete(id);
    }}
    onSaveNote={async value => {
      const saved = await api<Note>(`${base}/notes`, { method: "POST", body: JSON.stringify(value) });
      setNotes(all => [...all.filter(n => n.highlightId !== saved.highlightId), saved]);
    }}
    onReply={noop} onEngage={noop}
  /></div></>;
}
/** An answer citing two PDFs, for `?citations`: the chat's own parser, prose
 *  reading, routing and locator index, landing in the real PDF reader. The spec
 *  supplies the answer; SparseRoute is the document on screen, as it is for a
 *  chat opened on it with DenseBase @-tagged. What follows a route mirrors
 *  `Workspace.openCitation` for a PDF. */
function CitationHarness() {
  const papers = useMemo(() => [
    { id: "sparse", slug: "sparse", title: "SparseRoute: Sparse Routing at Scale", filename: "sparse.pdf", pages: 3, tokens: 0 },
    { id: "dense", slug: "dense", title: "DenseBase: Dense Baselines Revisited (2610.00002v1)", filename: "dense.pdf", pages: 3, tokens: 0 },
  ] as Paper[], []);
  const [answer, setAnswer] = useState("");
  const [open, setOpen] = useState<{ paperId: string; focus: PdfFocus | null }>({ paperId: "sparse", focus: null });
  const [drafts] = useState(() => new Map<string, string>());
  const clicks = useRef(0);
  useEffect(() => { void api<{ answer: string }>("/api/test/answer").then(value => setAnswer(value.answer)); }, []);
  const follow = (target: CitationTarget) => {
    const click = ++clicks.current;
    void routeCitation(
      target, papers, papers.find(paper => paper.id === open.paperId) ?? null,
      cited => `${API_BASE}/api/projects/project/papers/${cited.id}/file`,
      mentionedPapers(answer, papers), () => clicks.current !== click,
    ).then(route => {
      if (!route || clicks.current !== click) return;
      setOpen({ paperId: route.paper.id, focus: { page: route.hit?.page ?? target.pages[0] ?? 1, rect: route.hit?.rect ?? null, nonce: click } });
    });
  };
  return <>
    <div style={{ height: 180, overflow: "auto" }}><MemoAssistantMessage content={answer} papers={papers} onCitation={follow} /></div>
    <output data-testid="open">{open.paperId}</output>
    <div style={{ width: "85vw", height: "70vh", position: "relative", display: "flex", flexDirection: "column" }}><PdfViewer
      key={open.paperId} projectId="project" paperId={open.paperId} highlights={[]} notes={[]} drafts={drafts} zoom={1} focus={open.focus}
      onHighlight={async () => { throw new Error("Read-only fixture"); }} onRemoveHighlight={async () => {}} onSaveNote={async () => {}} onReply={noop} onEngage={noop}
    /></div>
  </>;
}
/** The Reader's right rail with a conversation docked: the docked card's frame
 * (its height is the stylesheet's alone) over the real Related Memory list, so
 * `?related-rows` can count the rows a window of a given height keeps in view. */
function RelatedRowsHarness() {
  const titles = ["Compute-optimal parameter and token allocation", "Scaling-laws", "Chimera: Designing and Chinchilla-Scaling Hybrid Visual Diffusion Transformers", "Muon optimizer", "Kaplan scaling laws", "Adam", "Learning-rate schedules", "IsoFLOP profiles"];
  const pages: MemoryPageSummary[] = ["current", ...titles].map((title, index) => ({
    id: `p${index}`, slug: index ? `page-${index}` : "current", kind: index ? "concept" : "source", domain: "scaling", title, summary: "A topic in your Memory.",
    tags: [], revision: 1, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", linkDegree: 1,
  }));
  const distances = Object.fromEntries(pages.map((page, index) => [page.slug, index ? 1 : 0]));
  return <main className="workspace"><header className="topbar" />
    <div className="three-panel library-collapsed" style={{ "--library-width": "64px", "--chat-width": "460px" } as CSSProperties}>
      <aside className="library-panel" /><div className="panel-divider panel-divider-left" /><section className="reader-panel" /><div className="panel-divider panel-divider-right" />
      <aside className="reader-rail">
        <section className="kb-chat-rail landed" aria-label="Chat"><div className="kb-ask-modal chat-surface" /></section>
        <RelatedMemoryRail currentSlug="current" pages={pages} links={pages.slice(1).map((page) => ({ from: "current", to: page.slug }))}
          domains={[{ slug: "scaling", title: "Scaling" }]} hops={1} distances={distances} hideGraph onOpen={noop} onWholeGraph={noop} />
      </aside>
    </div>
  </main>;
}
/** CSS geometry fixture: reuse the browser host without starting a chat or
 * duplicating its API mocks. PDF rendering is covered by PdfHarness above. */
function ReaderLayoutHarness() {
  return <main className="workspace"><header className="topbar" />
    <div className="three-panel library-collapsed" style={{ "--library-width": "64px", "--chat-width": "180px" } as import("react").CSSProperties}>
      <aside className="library-panel"><div className="library-rail" /></aside>
      <div className="panel-divider panel-divider-left" />
      <section className="reader-panel"><div className="reader-heading">
        <div><span className="eyebrow reader-project-label"><span>World Action Models with a very long project name</span></span><h1>Native Video–Action Pretraining</h1></div>
        <div className="reader-actions">100%</div>
      </div></section>
      <div className="panel-divider panel-divider-right" />
      <aside className="reader-rail"><div style={{ flex: "none", height: 1400 }}>Related Memory</div></aside>
    </div>
  </main>;
}
/** The digest pane in a reader-sized box, for `?digest`; `&width=` is the box's width.
 *  Generation reports as the Workspace's does: a failure becomes the activity, never a throw.
 *  The Workspace's Document toggle is `shown`, which a page citation sets back. */
function DigestHarness() {
  const [shown, setShown] = useState("digest");
  const [activity, setActivity] = useState<DigestActivity>();
  return <><output data-testid="shown">{shown}</output>
    <div className="reader-panel" style={{ width: Number(mode.get("width") ?? 1000), height: "calc(100vh - 40px)" }}>
      <DigestPane projectId="project" paper={digestFixture.paper} documentHref="/@reader/project/sglang" activity={activity}
        onShowDocument={() => setShown("document")}
        onGenerate={async force => {
          setActivity({ status: "preparing", message: "Preparing research digest" });
          try {
            const result = await api<DigestDetail>("/api/digest/regenerate", { method: "POST", body: JSON.stringify({ force }) });
            setActivity(undefined);
            return result;
          } catch (error) {
            setActivity({ status: "failed", message: error instanceof Error ? error.message : "Digest generation failed" });
            return null;
          }
        }} />
    </div>
  </>;
}
/** One-line messages as a surface shows them, for `?toast`. */
function ToastHarness() {
  const [notice, setNotice] = useState<Notice>("");
  return <><button onClick={() => setNotice(hint("Saved to the library."))}>Fixture hint</button>
    {notice ? <Toast notice={notice} onDismiss={() => setNotice("")} /> : null}</>;
}
/** Every pinned trace, each in its own turn, at the rail's width (`trace-golden.spec.ts`). */
function TraceGoldenHarness() {
  const [clockOrigin] = useState(() => Date.now());
  const text = (value: string) => <p>{value}</p>;
  return <div style={{ width: 420, padding: 16 }}>
    {traceGoldenCases.map((item) => <div key={item.name} className="kb-chat-turn" data-testid={`golden-${item.name}`}>
      <AnswerFlow content={item.content} trace={item.trace} live={item.liveFor !== undefined} keepWaiting={false}
        startedAt={item.liveFor !== undefined ? clockOrigin - item.liveFor : 0} onOpenResult={() => {}} renderText={text} />
    </div>)}
  </div>;
}
/** An answer with its trace, at the docked rail's width, for `?trace`:
    finished stretches, one of calls alone, and one still running. */
function TraceHarness() {
  const [opened, setOpened] = useState("");
  const text = (value: string) => <p>{value}</p>;
  return <div style={{ width: 420, padding: 16 }}>
    <div className="kb-chat-turn" data-testid="finished">
      <AnswerFlow content={traceAnswer} trace={traceFixture} live={false} keepWaiting={false} startedAt={0}
        onOpenResult={(result) => setOpened(result.slug ?? "")} renderText={text} />
    </div>
    <div className="kb-chat-turn" data-testid="worked">
      <AnswerFlow content="Found it." trace={traceWorkedOnly} live={false} keepWaiting={false} startedAt={0} renderText={text} />
    </div>
    <div className="kb-chat-turn" data-testid="running">
      <AnswerFlow content="" trace={traceRunning} live keepWaiting={false} startedAt={Date.now() - 8000} renderText={text} />
    </div>
    <div className="kb-chat-turn" data-testid="waiting">
      <AnswerFlow content="" trace={[]} live keepWaiting={false} startedAt={Date.now() - 3000} renderText={text} />
    </div>
    <output data-testid="opened">{opened}</output>
  </div>;
}
const mode = new URLSearchParams(location.search);
/** A persona of the reader's own, with a name long enough to fill the pill. */
const cartographer = { id: "cartographer", official: false, name: "Literature Cartographer", element: "leaf", tagline: "Maps how a field's papers cite and answer one another.", capabilities: [], content: "Trace the citations first." };
/** The floating Composer over an empty page, for `?ask`: what it sends,
    and whether it handed over to past conversations. */
function AskComposerHarness() {
  const [personaId, setPersonaId] = useState("mentor");
  const [model, setModel] = useState(DEFAULT_APP_CONFIG.models[0]);
  const [effort, setEffort] = useState("medium");
  const [sent, setSent] = useState<AskDraft | null>(null);
  const [history, setHistory] = useState(0);
  return <><output data-testid="sent">{sent ? JSON.stringify({ prompt: sent.prompt, personaId: sent.personaId }) : ""}</output>
    <output data-testid="history">{history}</output>
    <AskComposer initialContext="general" contextOptions={["general"]} targetFor={() => ({ context: "general" })}
      onSeeHistory={() => setHistory(count => count + 1)}
      config={{ ...DEFAULT_APP_CONFIG, providerConfigured: true }} model={model} onModelChange={setModel} effort={effort} onEffortChange={setEffort}
      personas={officialPersonas} personaId={personaId} onPersonaChange={setPersonaId} onManagePersonas={noop}
      onClose={noop} onNotice={noop} onSend={setSent} /></>;
}
function ResponsiveChatHarness() {
  return <ContextNavigation>{switchTo => <ResponsiveChat onContextChange={switchTo} />}</ContextNavigation>;
}
function ResponsiveChat({ onContextChange }: { onContextChange: (context: ChatContext, conversation?: string) => void }) {
  // `closable` gives the chat a window to close, as the reader's rail does.
  const closable = mode.has("closable");
  const [open, setOpen] = useState(true);
  const [openedPage, setOpenedPage] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const params = useSearchParams();
  const context = params.get("chat") ? contextFromParam(params.get("chat"), { hasPaper: true }) : mode.get("scope") === "general" ? "general" : "document";
  if (!open) return <button onClick={() => setOpen(true)}>Open chat</button>;
  return <><output data-testid="opened-page" hidden>{openedPage}</output><output data-testid="fullscreen" hidden>{String(fullscreen)}</output><div data-testid="chat-width" style={{ width: Number(mode.get("width")) || (closable ? 600 : 340), height: 720 }}>
    <ChatPanel key={context} context={context} project={{ id: "project", slug: "project", name: "Project", owner: "reader", paperCount: 1, updatedAt: "", papers: [digestFixture.paper] }}
      paper={digestFixture.paper} config={{ ...DEFAULT_APP_CONFIG, providerConfigured: true }} personas={mode.has("personas") ? [...officialPersonas, cartographer] : []} onManagePersonas={noop} onContextChange={onContextChange} onNotice={noop}
      onOpenPage={mode.has("no-pages") ? undefined : setOpenedPage}
      onFullscreenChange={closable ? setFullscreen : undefined}
      onClose={closable ? () => setOpen(false) : undefined} />
  </div></>;
}
/** A recorded answer in the real chat panel, for `?answers`: the spec supplies
 *  the library it was answered against, and whether it was a Memory answer or
 *  one beside a document. A followed citation writes where it went. */
function RecordedAnswerHarness() {
  const [scope, setScope] = useState<{ memory: boolean; papers: Paper[]; current: string | null } | null>(null);
  const [opened, setOpened] = useState("");
  useEffect(() => { void api<{ memory: boolean; papers: Paper[]; current: string | null }>("/api/test/case").then(setScope); }, []);
  if (!scope) return null;
  const paper = scope.papers.find((item) => item.title === scope.current) ?? null;
  return <><output data-testid="opened">{opened}</output><div style={{ width: 720, height: 900 }}>
    <ChatPanel key={scope.memory ? "general" : "document"} context={scope.memory ? "general" : "document"}
      project={scope.memory ? null : { id: "project", slug: "project", name: "Project", owner: "reader", paperCount: scope.papers.length, updatedAt: "", papers: scope.papers }}
      paper={scope.memory ? null : paper} config={{ ...DEFAULT_APP_CONFIG, providerConfigured: true }} personas={[]} onManagePersonas={noop}
      onContextChange={noop} onNotice={noop} onOpenPage={noop}
      onCitation={(target, cited, hit) => setOpened(`${cited.title} | ${target.text} | ${hit?.page ?? target.pages[0] ?? ""}`)} />
  </div></>;
}
createRoot(document.getElementById("root")!).render(mode.has("display") ? <DisplayHarness /> : mode.has("math") ? <MathHarness /> : mode.has("goldens") ? <TraceGoldenHarness /> : mode.has("trace") ? <TraceHarness /> : mode.has("responsive-chat") ? <ResponsiveChatHarness /> : mode.has("ask") ? <AskComposerHarness /> : mode.has("persona") ? <PersonaHarness /> : mode.has("settings-projects") ? <SettingsProjectsHarness /> : mode.has("library") ? <LibraryHarness /> : mode.has("ai-connection") ? <AiConnectionHarness /> : mode.has("mention") ? <MentionHarness /> : mode.has("digest") ? <DigestHarness /> : mode.has("toast") ? <ToastHarness /> : mode.has("filing-queue") ? <FilingQueueHarness /> : mode.has("filing-workflow") ? <FilingWorkflowHarness unfiled={mode.has("unfiled")} /> : mode.has("filing") ? <FilingHarness /> : mode.has("related-rows") ? <RelatedRowsHarness /> : mode.has("reader-layout") ? <ReaderLayoutHarness /> : mode.has("citations") ? <CitationHarness /> : mode.has("answers") ? <RecordedAnswerHarness /> : mode.has("pdf") ? <PdfHarness /> : mode.has("rail") ? <RailNavigationHarness /> : mode.has("capacity") ? <CapacityHarness /> : <Harness />);
