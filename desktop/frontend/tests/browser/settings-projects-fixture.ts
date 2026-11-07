import type { Page } from "@playwright/test";
import type { Paper, Project } from "../../app/lib/api";

const paper = (id: string, title: string, kind: "pdf" | "web", extra: Partial<Paper> = {}): Paper =>
  ({ id, slug: id, title, filename: `${id}.${kind === "web" ? "html" : "pdf"}`, pages: 1, tokens: 1, kind, ...extra });
const project = (id: string, name: string, papers: Paper[]): Project =>
  ({ id, slug: id, name, owner: "reader", paperCount: papers.length, updatedAt: "", papers });

export const library = (): Project[] => [
  project("inference", "Inference Framework", [
    paper("glm", "Toward Recursive Self-Improvement: How GLM Built Its Own Inference Infrastructure", "web"),
    paper("archs", "Domain specific archs for AI Inference", "web"),
    paper("sglang", "SGLang (2312.07104v2)", "pdf", { doneAt: "2026-10-01T00:00:00Z" }),
    paper("vllm", "vLLM-Omni (2602.02204v1)", "pdf"),
    // Saved from a link, read as a PDF: the web contract with a PDF's filename.
    paper("knapformer", "KnapFormer", "web", { filename: "knapformer.pdf" }),
    // Stored before web documents existed: no kind at all.
    paper("miles", "Miles v0.1 Production-Level Post-Training (2609.08368v1)", "pdf", { kind: undefined }),
  ]),
  project("scaling-law", "Scaling Law", [
    paper("overtraining", "Test-Time Scaling Makes Overtraining Compute-Optimal", "pdf"),
    paper("latent", "Scaling up Test-Time Compute with Latent Reasoning - A Recurrent Depth Approach", "pdf"),
  ]),
  project("optimizers", "Optimizers", [
    paper("muon-zh", "Muon优化器赏析：从向量到矩阵的本质跨越", "web"),
    paper("muon", "Muon: An optimizer for hidden layers in neural networks | Keller Jordan blog", "web"),
    paper("shampoo", "慢即是快：1. Shampoo的尽头是Muon", "web"),
  ]),
  project("filing", "Filing test (safe to delete)", [
    paper("early", "Early stopping - Wikipedia", "web"),
    paper("rate", "Learning rate - Wikipedia", "web", { doneAt: "2026-10-02T00:00:00Z" }),
    paper("ridge", "Ridge regression - Wikipedia", "web"),
  ]),
  project("empty", "Reading list", []),
];

/** The routes the sheet reads and writes, over a library the spec can inspect. */
export async function serveLibrary(page: Page, limits = new URLSearchParams()) {
  const max = Number(limits.get("max") ?? 10), total = Number(limits.get("total") ?? 50);
  const projects = library();
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const find = (id: string) => projects.find(item => item.id === id)!;
  await page.route("**/desktop/**", route => route.fulfill({ status: 404, json: {} }));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const parts = path.split("/").slice(2);
    if (path === "/api/projects") {
      // The listing counts active papers; a project's own record has no count.
      return route.fulfill({ json: projects.map(({ papers, ...summary }) => ({ ...summary, paperCount: papers.filter(item => !item.doneAt).length })) });
    }
    if (parts[0] !== "projects") return route.fulfill({ json: [] });
    const source = find(parts[1]);
    if (request.method() === "GET") {
      const record: Partial<Project> = { ...source };
      delete record.paperCount;
      return route.fulfill({ json: record });
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    writes.push({ method: request.method(), path, body });
    if (path.endsWith("/move")) {
      const target = find(String(body.project_id));
      // The server's own refusal: a done paper takes a place like any other.
      if (target !== source && (target.papers.length >= total || target.papers.filter(item => !item.doneAt).length >= max)) {
        return route.fulfill({ status: 409, json: { detail: `Projects currently support ${max} papers` } });
      }
      const [moved] = source.papers.splice(source.papers.findIndex(item => item.id === parts[3]), 1);
      target.papers.splice(Number(body.position ?? target.papers.length), 0, moved);
      return route.fulfill({ json: target });
    }
    const order = body.paper_ids as string[];
    source.papers.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    return route.fulfill({ json: source });
  });
  return { projects, writes };
}
