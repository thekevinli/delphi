import type { DigestDetail } from "../../app/lib/api";
import { DEFAULT_CHAT_CONFIG } from "../../app/lib/chat-model-policy";

/** Illustrative design specimen, never persisted to a reader's library. */
export const digestFixture: DigestDetail = {
  paper: { id: "paper", slug: "sglang", title: "SGLang (2312.07104v2)", filename: "sglang.pdf", pages: 20, tokens: 10000, digest: { status: "ready", model: DEFAULT_CHAT_CONFIG.defaultModel, updatedAt: "2026-10-26T09:30:00Z" } },
  digest: {
    contentMarkdown: [
      "# SGLang: co-designing a language and runtime for multi-call LLM programs",
      "SGLang treats advanced prompting and agent workflows as **language-model programs**: programs with multiple, often dependent generation calls interleaved with control flow and structured inputs and outputs. Its central claim is that exposing this structure through a Python-embedded language, and exploiting it in a co-designed runtime, removes both programming friction and inference waste. Across agents, reasoning, few-shot learning, JSON decoding, RAG, multimodal and multi-turn chat, it reports up to **6.4× higher throughput** and **3.7× lower latency** than contemporary systems [E1][E2].",
      "The architecture has two separable parts. The frontend supplies generation and parallelism primitives while keeping native Python control flow; the backend accelerates execution with **RadixAttention** for automatic KV-cache reuse, **compressed finite-state machines** for structured decoding, and **API speculative execution** for black-box models [E3].",
      "### Programming model",
      "An SGLang function incrementally builds a prompt state. `extend` or `+=` appends text; `gen(name)` generates and stores output; `select` picks the highest-probability option; `fork` and `join` express prompt-level parallelism; and `image` and `video` add multimodal inputs. `gen` also accepts a regular-expression constraint, so outputs such as JSON are enforced at decoding time `p. 3`.",
      '```python\n@sgl.function\ndef tip_suggestion(s):\n    s += "Here are two tips for staying healthy: "\n\n    forks = s.fork(2)  # run both branches in parallel\n    for i, f in enumerate(forks):\n        f += f"Expand tip {i+1}: " + sgl.gen("detail")\n    s += "Summary: " + sgl.gen("summary")\n```',
      "### Runtime",
      "Matching a prefix of length $n$ costs $O(n)$ in the tree, independent of the $k$ cached requests.",
      String.raw`$$\operatorname{Attention}(Q,K,V)=\operatorname{softmax}\left(\frac{QK^{\mathsf T}}{\sqrt{d_k}}\right)V\tag{1}$$`,
      "> The frontend and runtime can operate independently, but their co-design enables hints a workload-agnostic server cannot use. [E3]",
      "- Reuse the KV cache across calls that share a prefix.\n\n- Decode several constrained tokens in one step.",
      "### Results",
      "Illustrative result summary [E4].",
      "| Workload | Throughput |\n| --- | --- |\n| Shared prefix | 6.4× |",
      "### Results",
      "A repeated heading still has a distinct contents destination.",
      "A final discussion paragraph. ".repeat(50),
    ].join("\n\n"),
    citations: [
      { id: 1, claimType: "author-claim", page: 1, section: null },
      { id: 2, claimType: "author-claim", page: 7, section: null },
      { id: 3, claimType: "author-claim", page: 2, section: null },
      { id: 4, claimType: "digest-inference", page: 8, section: null },
    ],
    assets: [],
  },
};
