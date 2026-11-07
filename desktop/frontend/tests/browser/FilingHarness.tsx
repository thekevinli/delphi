import { useCallback, useState } from "react";
import { OutdatedPage, UnfiledDocument, useDocumentFiling } from "../../app/components/DocumentFiling";
import { FilingProgress, SettledFilingCard, useLibraryFiling } from "../../app/components/FilingProgress";
import type { Paper } from "../../app/lib/api";
import { requestMemoryMaintenance } from "../../app/lib/memory-maintenance";
import { outdatedFiling, unfiledFiling } from "../../app/lib/filing-progress";

const record = { filed: true, stuck: false, stale: false, dropped: [] as { slug: string; title: string; reason: string }[] };
const dropped = [
  { slug: "muon", title: "Muon optimizer", reason: "The update rule it states is not in the passage it cites." },
  { slug: "newton-schulz", title: "Newton–Schulz iteration", reason: "Cites a figure the document does not have." },
];
const cards = {
  "one-page": outdatedFiling({ ...record, dropped: dropped.slice(0, 1) })!,
  "several-pages": outdatedFiling({ ...record, dropped })!,
  "older-delphi": outdatedFiling({ ...record, stale: true })!,
  "gave-up": unfiledFiling({ ...record, filed: false, stuck: true }, false),
  "gave-up-with-page": outdatedFiling({ ...record, filed: false, stuck: true })!,
  "no-page": unfiledFiling(record, false),
  "not-filed": unfiledFiling(null, false),
};

/** Every settled filing card at the reader rail's width, for `?filing`. */
export default function FilingHarness() {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 320px)", gap: 32, padding: 24, background: "var(--paper, #f4f1ef)" }}>
    {Object.entries(cards).map(([name, card]) => <div key={name} data-testid={name} className="reader-unfiled is-outdated">
      <SettledFilingCard card={card} onAction={() => {}} />
    </div>)}
  </div>;
}

const paper = { id: "paper1", title: "Cuts and flashes" } as Paper;

/** The reader rail's filing cards on their real client, for `?filing-workflow` (`filing-workflow.spec.ts`). */
export function FilingWorkflowHarness({ unfiled }: { unfiled: boolean }) {
  const [filed, setFiled] = useState(0);
  const [opened, setOpened] = useState("");
  // Stable, as the Workspace's is, so the hook's poll is not restarted by every render.
  const onFiled = useCallback(async () => setFiled(count => count + 1), []);
  const filing = useDocumentFiling({ paper, projectId: null, enabled: true, onFiled, onNotice: () => {} });
  return <aside className="reader-rail" style={{ width: 320, padding: 16 }}>
    {/* One or the other, as the Workspace chooses by whether the document has its page. */}
    {unfiled ? <UnfiledDocument filing={filing} onOpenPage={setOpened} /> : <OutdatedPage filing={filing} />}
    <output data-testid="filed">{filed}</output>
    <output data-testid="opened">{opened}</output>
    <button onClick={() => requestMemoryMaintenance(true)}>Run the queue</button>
  </aside>;
}

/** The library's filing mark beside the open document's card, both on the one shared queue read, for `?filing-queue`. */
export function FilingQueueHarness() {
  const [open, setOpen] = useState(true);
  const filingOf = useLibraryFiling(true);
  return <aside className="reader-rail" style={{ width: 320, padding: 16 }}>
    <output data-testid="library">{filingOf(paper) ?? "idle"}</output>
    {open ? <FilingProgress paper={paper} /> : null}
    <button onClick={() => setOpen(false)}>Close the card</button>
    <button onClick={() => requestMemoryMaintenance(true)}>Run the queue</button>
  </aside>;
}
