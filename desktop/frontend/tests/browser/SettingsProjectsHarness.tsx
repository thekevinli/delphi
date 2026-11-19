import { useCallback, useEffect, useState } from "react";
import { SettingsModal } from "../../app/components/SettingsModal";
import { DEFAULT_APP_CONFIG, api, type ProjectSummary } from "../../app/lib/api";

/** Settings → Projects over the spec's library, for `?settings-projects`.
 *  A move goes to the same route the shells post to; `log` is what the sheet
 *  asked its shell to do. `&max` and `&total` are the two project limits. */
const noop = () => {};
const user = { username: "reader", useStandardTier: false };
const limit = (name: string, fallback: number) => Number(new URLSearchParams(location.search).get(name) ?? fallback);
const config = { ...DEFAULT_APP_CONFIG, maxPapersTotalPerProject: limit("total", DEFAULT_APP_CONFIG.maxPapersTotalPerProject) };
export default function SettingsProjectsHarness() {
  const [open, setOpen] = useState(true);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const note = (entry: string) => setLog(all => [...all, entry]);
  const reload = useCallback(async () => setProjects(await api<ProjectSummary[]>("/api/projects")), []);
  useEffect(() => {
    let active = true;
    void api<ProjectSummary[]>("/api/projects").then(items => { if (active) setProjects(items); });
    return () => { active = false; };
  }, []);
  return <><button onClick={() => setOpen(true)}>Open settings</button><output data-testid="settings-log">{log.join("\n")}</output>
    {open && projects && <SettingsModal user={user} onUserChange={noop} config={config}
      projects={projects} maxPapers={limit("max", 10)}
      currentProjectId="inference" currentPaperId="glm"
      onClose={() => setOpen(false)} onOpenPaper={(project, paper) => note(`paper ${project}/${paper}`)}
      onNavigate={href => note(`navigate ${href}`)}
      onMovePaper={async (from, paper, to, position) => {
        await api(`/api/projects/${from}/papers/${paper}/move`, { method: "POST", body: JSON.stringify({ project_id: to, position }) });
        await reload();
      }}
      onReordered={reload} onNotice={notice => note(`notice ${String(notice)}`)} />}
  </>;
}
