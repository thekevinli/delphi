import { useCallback, useEffect, useState } from "react";
import { Library } from "../../app/components/Workspace";
import { api, type Project, type ProjectSummary } from "../../app/lib/api";

/** The reader's library rail over the Settings spec's library, for `?library`.
 *  `&project=` is the one open, `&max` the active limit; `log` is what the rail
 *  asked its shell to do. A move posts to the route the shell posts to. */
const noop = () => {};
const query = new URLSearchParams(location.search);
export default function LibraryHarness() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const note = (entry: string) => setLog(all => [...all, entry]);
  const open = query.get("project") ?? "inference";
  const read = useCallback(() => Promise.all([api<ProjectSummary[]>("/api/projects"), api<Project>(`/api/projects/${open}`)]), [open]);
  const reload = useCallback(async () => { const [items, detail] = await read(); setProjects(items); setProject(detail); }, [read]);
  useEffect(() => {
    let active = true;
    void read().then(([items, detail]) => { if (active) { setProjects(items); setProject(detail); } });
    return () => { active = false; };
  }, [read]);
  return <div className="workspace" style={{ display: "grid", gridTemplateColumns: "300px 1fr" }}>
    {projects && project ? <Library tab="papers" setTab={noop} projects={projects} project={project}
      paper={project.papers.find(item => item.id === query.get("paper")) ?? null}
      maxPapers={Number(query.get("max") ?? 10)} uploading={false} onUpload={async () => {}}
      onSelectProject={noop} onDeleteProject={async () => {}} onDeletePaper={async () => {}} onSelectPaper={item => note(`paper ${item.id}`)}
      onMovePaper={async (from, paper, to) => {
        await api(`/api/projects/${from}/papers/${paper}/move`, { method: "POST", body: JSON.stringify({ project_id: to }) });
        await reload();
      }}
      onCreateProject={noop} onAddWebpage={noop} webEnabled memoryEnabled={false} onChanged={reload}
      onNotice={text => note(`notice ${text}`)}
      collapsed={false} onToggleCollapsed={noop} /> : null}
    <output data-testid="library-log">{log.join("\n")}</output>
  </div>;
}
