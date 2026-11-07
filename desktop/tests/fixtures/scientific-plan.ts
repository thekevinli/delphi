export const scientificPlan = {
  version: 2 as const, title: "Distinguish scene cuts from flashes", objective: "Test whether temporal context reduces false detections without losing weak cuts.",
  milestone: "A reproducible comparison with a fixed baseline on a held-out subset.",
  rationale: "The discussion identified transient illumination changes as a possible confound. This fixture illustrates a proposed experiment, not a published result.",
  evidence: [{ claim: "A one-frame flash can resemble a cut.", basis: "literature" as const, references: [{ sourceId: "paper1", location: "Fixture, section 3", excerpt: "Temporal context distinguishes flashes from cuts." }], limitation: "This fixture passage does not establish performance on a real benchmark." }],
  method: "Compare a fixed single-frame threshold baseline with a temporal consistency check using the same inputs and split.",
  tasks: [{ title: "Freeze the comparison", outcome: "Dataset, baseline and review protocol are fixed", dependsOn: [] }, { title: "Compare temporal consistency", outcome: "A matched result with false positives and misses inspected", dependsOn: ["Freeze the comparison"] }],
  evaluation: [{ question: "Does temporal context reduce flash errors?", comparison: "Fixed threshold versus temporal consistency", data: "Held-out clips; annotations and split to be confirmed", measure: "Precision, recall and F1 under the agreed frame tolerance", decision: "Report tradeoffs; do not declare a win before agreeing the threshold" }],
  exitCriteria: { success: "A supported improvement under the frozen protocol", negative: "No benefit over the simpler baseline", inconclusive: "Insufficient labeled examples or ambiguous annotations", stop: "Stop on unavailable data or user-defined resource limits" },
  monitoring: { destination: "Local experiment report in the coding workspace", records: ["Dataset and code revisions", "All comparisons, errors and resource usage"], review: "Review baseline and error cases before further comparisons", deliverables: ["Reproducible commands and a results table"] },
  constraints: ["CPU functionality", "No invented benchmark claims"], openQuestions: ["Confirm data availability and frame tolerance"],
  flow: ["Freeze evidence", "Run matched comparison", "Inspect errors", "Decide"], pseudocode: "for boundary in candidates:\n  compare temporal context\nreport false positives and misses",
};

export const proposalPlan = {
  version: 4 as const, title: "Distinguish scene cuts from flashes", question: "Does temporal context reduce false detections without losing weak cuts?",
  scope: "A fixed single-frame baseline against a temporal check on one held-out subset. This fixture illustrates a proposed experiment, not a published result.",
  design: {
    settings: [{ id: "a", label: "Held-out subset", detail: "Fixed split" }],
    runs: [
      { id: "1", group: "Baseline", label: "Single-frame threshold", cells: [{ setting: "a", reports: "precision, recall, F1", decisive: true }] },
      { id: "2", group: "Temporal", label: "Temporal consistency check", cells: [{ setting: "a", reports: "precision, recall, F1", decisive: true }] },
    ],
    caption: "Run (2) against run (1) in (a) decides the claim.",
  },
  method: "Compare a fixed single-frame threshold baseline with a temporal consistency check using the same inputs and split.",
  order: ["Freeze the split and run (1)", "Run (2) and inspect false positives and misses"], pseudocode: "for boundary in candidates:\n  compare temporal context",
  setup: [{ component: "Frame tolerance", setting: "±1 frame", basis: "proposed" as const }],
  readings: [{ when: "(2) beats (1) on F1", then: "Temporal context helps on this subset." }],
  limits: "One subset and one tolerance.", reference: [], web: [], exhibits: [],
};
