"""Run the same fixed digest sample through two model/effort configurations.

This is a local, isolated benchmark over a staged Memory candidate. It copies
the candidate before calling the shipped ``generate_digest`` routine, writes one
result file after each document, and never changes the candidate or live data.

    python -m delphi_core.backfill.digest_model_benchmark \
      --candidate ../.data/memory-rebuilds/kevin/candidate-... \
      --output ../.data/digest-benchmarks/kevin-20260904 \
      --arm luna-high
    python -m delphi_core.backfill.digest_model_benchmark ... --arm sol-medium

The sample is intentionally stratified. Eight documents had a rejection during
the Kevin rebuild; their labels distinguish a digest defect from notation copied
from the source and a verifier demand the source itself does not establish.
Eight controls filed cleanly in one author plus one verifier call and emphasize
mathematical diffusion, optimization, and scaling-law material.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any

import httpx

from ..config import Settings
from ..research_digest import generate_digest, load_digest, malformed_math_in_body
from ..storage import LocalObjectStore, LocalStorage


ARMS = {
    "luna-high": ("gpt-6-luna", "high"),
    "sol-medium": ("gpt-6-sol", "medium"),
}

SAMPLE: tuple[dict[str, str], ...] = (
    {
        "paperId": "389a90046f84",
        "cohort": "prior-reject",
        "origin": "source-formula-verifier-dispute",
        "reason": "MDLM finite-step objective sign rejected despite matching source",
    },
    {
        "paperId": "01ed31c33266",
        "cohort": "prior-reject",
        "origin": "source-formula-verifier-dispute",
        "reason": "Block Diffusion derivative/sign convention",
    },
    {
        "paperId": "12209733906e",
        "cohort": "prior-reject",
        "origin": "digest-amplified-source-notation",
        "reason": "MMaDA changed source's M count into a set of masked positions",
    },
    {
        "paperId": "3fde09304912",
        "cohort": "prior-reject",
        "origin": "source-notation",
        "reason": "source article's non-standard latent-variable marginalization",
    },
    {
        "paperId": "133bf81bb367",
        "cohort": "prior-reject",
        "origin": "digest",
        "reason": "undefined symbols in feature-utility formalism",
    },
    {
        "paperId": "75b7c79041bc",
        "cohort": "prior-reject",
        "origin": "verifier-demand-beyond-source",
        "reason": "LLaDA 1/t rationale demanded more than the cited source states",
    },
    {
        "paperId": "137569b6424f",
        "cohort": "prior-reject",
        "origin": "source-formula",
        "reason": "VERA source prints a dimensionally problematic pseudoinverse",
    },
    {
        "paperId": "d3ff779e80cb",
        "cohort": "prior-reject",
        "origin": "source-notation",
        "reason": "Esoteric dLLM source calls schedule union a concatenation",
    },
    {
        "paperId": "6606aa995edc",
        "cohort": "clean-control",
        "origin": "none-observed",
        "reason": "Chinchilla scaling law",
    },
    {
        "paperId": "f1fd0d2a85a3",
        "cohort": "clean-control",
        "origin": "none-observed",
        "reason": "scaling-law methodology",
    },
    {
        "paperId": "ebb3d6f97e48",
        "cohort": "clean-control",
        "origin": "none-observed",
        "reason": "MoE scaling laws",
    },
    {
        "paperId": "56556f32d171",
        "cohort": "clean-control",
        "origin": "none-observed",
        "reason": "muE parameterization",
    },
    {
        "paperId": "9719897d10f4",
        "cohort": "clean-control",
        "origin": "none-observed",
        "reason": "Muon optimizer scaling",
    },
    {
        "paperId": "d514aa46599e",
        "cohort": "clean-control",
        "origin": "none-observed",
        "reason": "diffusion-language-model objective",
    },
    {
        "paperId": "4f5050eee26a",
        "cohort": "clean-control",
        "origin": "none-observed",
        "reason": "diffusion integral identity",
    },
    {
        "paperId": "3427304bcb29",
        "cohort": "clean-control",
        "origin": "none-observed",
        "reason": "diffusion data-scaling comparison",
    },
)

_MARKDOWN_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")


def visual_checks(digest: dict[str, Any]) -> dict[str, int]:
    """Count selected visuals and the prose anchors that can place them.

    Stored digest Markdown intentionally has no inline image embeds: the digest
    renderer places its structured assets out of band, and a Memory source
    page deterministically writes `figure:<id>` embeds later. Keeping this count
    in the benchmark prevents a zero from being misread as model noncompliance.
    The important model-owned join is `afterEvidenceId` to a real `[E#]` marker.
    """
    body = str(digest.get("contentMarkdown") or "")
    assets = digest.get("assets") or []
    anchored = sum(
        f"[E{asset.get('afterEvidenceId')}]" in body for asset in assets
    )
    return {
        "selectedCapturedAssets": len(assets),
        "inlineImageEmbedsInStoredMarkdown": len(_MARKDOWN_IMAGE.findall(body)),
        "assetsWithPresentEvidenceAnchor": anchored,
        "assetsWithMissingEvidenceAnchor": len(assets) - anchored,
    }


def report_saved_results(output: Path) -> dict[str, dict[str, int | float]]:
    """Summarize completed arm files without making provider calls."""
    report: dict[str, dict[str, int | float]] = {}
    for arm in ARMS:
        totals = {
            "documents": 0,
            "selectedCapturedAssets": 0,
            "inlineImageEmbedsInStoredMarkdown": 0,
            "documentsWithAssetsAndNoInlineEmbed": 0,
            "assetsWithPresentEvidenceAnchor": 0,
            "assetsWithMissingEvidenceAnchor": 0,
        }
        for path in sorted((output / arm).glob("*.json")):
            result = json.loads(path.read_text(encoding="utf-8"))
            digest = result.get("digest")
            if not digest:
                continue
            checks = visual_checks(digest)
            totals["documents"] += 1
            for key, value in checks.items():
                totals[key] += value
            if (
                checks["selectedCapturedAssets"]
                and not checks["inlineImageEmbedsInStoredMarkdown"]
            ):
                totals["documentsWithAssetsAndNoInlineEmbed"] += 1
        documents = totals["documents"]
        totals["assetsPerDigest"] = (
            totals["selectedCapturedAssets"] / documents if documents else 0.0
        )
        report[arm] = totals
    return report


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary.replace(path)


def _workspace(candidate: Path, output: Path) -> Path:
    candidate = candidate.resolve()
    output = output.resolve()
    if candidate == output or candidate in output.parents:
        raise ValueError("Benchmark output must not be the candidate or contain it")
    workspace = output / "workspace"
    if not workspace.exists():
        output.mkdir(parents=True, exist_ok=True)
        shutil.copytree(candidate, workspace)
    return workspace


def _documents(storage: LocalStorage, username: str) -> dict[str, tuple[str, dict[str, Any]]]:
    found: dict[str, tuple[str, dict[str, Any]]] = {}
    for project in storage.list_projects_with_papers(username):
        for paper in project.get("papers") or []:
            found[paper["id"]] = (project["id"], paper)
    return found


async def run(args: argparse.Namespace) -> int:
    candidate = args.candidate.resolve()
    if not (candidate / "manifest.json").exists():
        raise ValueError("--candidate must name a staged Memory candidate")
    workspace = _workspace(candidate, args.output)
    model, effort = ARMS[args.arm]
    base = Settings()
    if not base.api_key:
        raise ValueError("No API key is configured")
    settings = base.model_copy(
        update={
            "data_dir": workspace,
            "digest_model": model,
            "digest_reasoning_effort": effort,
        }
    )
    storage = LocalStorage(settings)
    objects = LocalObjectStore(
        workspace, settings.chat_image_retention_days
    )
    documents = _documents(storage, args.username)
    missing = [row["paperId"] for row in SAMPLE if row["paperId"] not in documents]
    if missing:
        raise ValueError("Candidate is missing sample documents: " + ", ".join(missing))

    arm_dir = args.output.resolve() / args.arm
    timeout = httpx.Timeout(settings.digest_timeout_seconds, connect=20)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for index, sample in enumerate(SAMPLE, start=1):
            paper_id = sample["paperId"]
            result_path = arm_dir / f"{paper_id}.json"
            if result_path.exists() and not args.force:
                prior = json.loads(result_path.read_text(encoding="utf-8"))
                if prior.get("digest") and not prior.get("error"):
                    print(f"{index:02}/{len(SAMPLE)} reuse {paper_id}", flush=True)
                    continue
            project_id, paper = documents[paper_id]
            print(
                f"{index:02}/{len(SAMPLE)} {args.arm} · {paper['title']}",
                flush=True,
            )
            terminal: dict[str, Any] | None = None
            try:
                async for event in generate_digest(
                    client,
                    storage,
                    objects,
                    args.username,
                    project_id,
                    paper_id,
                    settings,
                    force=True,
                    current=index,
                    total=len(SAMPLE),
                    use_standard_tier=True,
                ):
                    if event.get("type") == "progress":
                        print(f"    {event.get('message')}", flush=True)
                    elif event.get("type") == "_digest_ready":
                        terminal = event
            except Exception as exc:  # noqa: BLE001 - preserve a resumable result
                _write_json(
                    result_path,
                    {
                        **sample,
                        "title": paper.get("title"),
                        "model": model,
                        "effort": effort,
                        "error": str(exc),
                    },
                )
                print(f"    FAILED: {exc}", file=sys.stderr, flush=True)
                continue
            if terminal is None:
                raise RuntimeError(f"Digest generation ended without a result for {paper_id}")
            saved_paper = storage.get_paper(args.username, project_id, paper_id)
            digest = load_digest(objects, args.username, project_id, paper_id)
            body = str(digest.get("contentMarkdown") or "")
            _write_json(
                result_path,
                {
                    **sample,
                    "title": paper.get("title"),
                    "model": model,
                    "effort": effort,
                    "digest": digest,
                    "telemetry": (saved_paper.get("digest") or {}).get("telemetry", {}),
                    "deterministicChecks": {
                        "malformedMath": malformed_math_in_body(body),
                        "bodyCharacters": len(body),
                        "citationCount": len(digest.get("citations") or []),
                        "assetCount": len(digest.get("assets") or []),
                        "visuals": visual_checks(digest),
                    },
                },
            )
    print(f"Results: {arm_dir}")
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--candidate", type=Path)
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--username", default="kevin")
    result.add_argument("--arm", choices=tuple(ARMS))
    result.add_argument("--force", action="store_true")
    result.add_argument(
        "--report",
        action="store_true",
        help="audit saved arm JSON without making provider calls",
    )
    return result


def main() -> int:
    args = parser().parse_args()
    if args.report:
        print(json.dumps(report_saved_results(args.output.resolve()), indent=2))
        return 0
    if args.candidate is None or args.arm is None:
        raise SystemExit("--candidate and --arm are required unless --report is used")
    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
