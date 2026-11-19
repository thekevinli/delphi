import { useState } from "react";
import { SettingsModal } from "../../app/components/SettingsModal";
import { DEFAULT_APP_CONFIG } from "../../app/lib/api";
import { noticeText } from "../../app/components/Notice";

const noop = () => {};
const done = async () => {};
const user = { username: "reader", useStandardTier: false };
const projects: [] = [];
export default function PersonaHarness() {
  const [open, setOpen] = useState(true);
  const [notice, setNotice] = useState("");
  const [changes, setChanges] = useState(0);
  return <><button onClick={() => setOpen(true)}>Open settings</button><output role="status" data-testid="persona-notice">{notice}</output><output data-testid="persona-changes">{changes}</output>
    {open && <SettingsModal initialPane="persona" user={user} onUserChange={noop}
      config={{ ...DEFAULT_APP_CONFIG, personaMarketplaceEnabled: new URLSearchParams(location.search).has("marketplace") }}
      onPersonasChanged={() => setChanges(count => count + 1)} projects={projects} maxPapers={10}
      onClose={() => setOpen(false)} onOpenPaper={noop} onNavigate={noop} onMovePaper={done} onReordered={done} onNotice={(notice) => setNotice(noticeText(notice))} />}
  </>;
}
