import { useState } from "react";
import { SettingsModal, type SettingsPane } from "../../app/components/SettingsModal";
import { DEFAULT_APP_CONFIG } from "../../app/lib/api";

/** Settings over a stubbed `/desktop/connection`, for `?ai-connection`.
 *  `&pane=` opens a section, `&connection` opens on the AI connection view,
 *  `&flex` starts on the Flex tier; `tier` is the preference as last saved. */
const noop = () => {};
const query = new URLSearchParams(location.search);
export default function AiConnectionHarness() {
  const [user, setUser] = useState({ username: "reader", useStandardTier: !query.has("flex") });
  return <>
    <output data-testid="tier">{user.useStandardTier ? "standard" : "flex"}</output>
    <SettingsModal user={user} onUserChange={setUser} config={DEFAULT_APP_CONFIG} projects={[]} maxPapers={10}
      initialPane={(query.get("pane") ?? "advanced") as SettingsPane} initialConnection={query.has("connection")}
      onClose={noop} onOpenPaper={noop} onNavigate={noop} onMovePaper={async () => {}} onReordered={async () => {}} onNotice={noop} />
  </>;
}
