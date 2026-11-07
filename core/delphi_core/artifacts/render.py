"""Bounded, serialized artifact rendering in a credential-free child process."""
from __future__ import annotations

import asyncio
import ctypes
from dataclasses import asdict
import errno
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from typing import Any

from ..browser_host import configured as browser_host
from ..browser_render import _chrome_executable, kill_group, spawn_clean
from .types import SOURCE_MAX, RenderReport

MAX_CHECKS = 6
MAX_REPORT_BYTES = 4 * 1024 * 1024
_SERIAL = asyncio.Lock()
_CLEAN_EXEC = Path(__file__).resolve().parents[1] / "clean_exec.py"


def failure(code: str, message: str) -> RenderReport:
    return RenderReport(False, [{"code": code, "severity": "error", "message": message[:400]}])


def validate_checks(checks: Any) -> list[dict[str, str]]:
    if not isinstance(checks, list) or len(checks) > MAX_CHECKS:
        raise ValueError("Supply at most six interaction checks.")
    result = []
    for check in checks:
        if not isinstance(check, dict) or set(check) - {"action", "target", "value", "expect_target", "expect_text"}:
            raise ValueError("Checks contain only action, target, value and an optional expectation.")
        action, target, value = check.get("action"), check.get("target"), check.get("value", "")
        expect_target, expect_text = check.get("expect_target", ""), check.get("expect_text", "")
        if action not in {"click", "set"} or not isinstance(target, str) or not 1 <= len(target) <= 240:
            raise ValueError("Each check needs click/set and a bounded CSS selector or header:next/back.")
        if not isinstance(value, str) or len(value) > 240:
            raise ValueError("Check values must be strings of at most 240 characters.")
        if target.startswith("header:") and (target not in {"header:next", "header:back"} or action != "click"):
            raise ValueError("Header checks support click on header:next or header:back only.")
        if not isinstance(expect_target, str) or not isinstance(expect_text, str) or len(expect_target) > 240 or len(expect_text) > 240 \
                or bool(expect_target) != bool(expect_text.strip()) or (expect_target.startswith("header:") and expect_target != "header:progress"):
            raise ValueError("An expectation names one CSS selector inside the artifact, or header:progress, and the text it must then contain, or neither.")
        result.append({"action": action, "target": target, "value": value, "expect_target": expect_target, "expect_text": expect_text.strip()})
    return result


def renderer_assets(directory: Path) -> dict[str, Any]:
    """Only the trusted build's fixed files are read, never model-supplied paths."""
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file() or manifest_path.stat().st_size > 16_384:
        raise ValueError("The artifact renderer build is missing its manifest.")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("version") != 1 or not isinstance(manifest.get("runtimeHash"), str):
        raise ValueError("The artifact renderer manifest has an unsupported version.")
    combined = hashlib.sha256()
    # The builder's canonical order is JavaScript, then stylesheet.
    for name in ("host.js", "host.css"):
        path = directory / name
        if not path.is_file() or path.stat().st_size > 12 * 1024 * 1024:
            raise ValueError(f"The artifact renderer is missing bounded {name}.")
        content = path.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        if manifest.get("files", {}).get(name) != digest:
            raise ValueError(f"The artifact renderer checksum differs for {name}; rebuild it.")
        combined.update(name.encode() + b"\0" + content + b"\0")
    if manifest["runtimeHash"] != combined.hexdigest():
        raise ValueError("The artifact renderer identity differs from its checked files; rebuild it.")
    return manifest


def _child_environment() -> dict[str, str]:
    # No provider keys, session secrets, PYTHONPATH or backend configuration.
    # HOME must remain the real HOME: relocating it starts macOS browser setup.
    return {key: os.environ[key] for key in ("HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SYSTEMROOT") if key in os.environ}


class _RusageInfoV0(ctypes.Structure):
    # Public macOS SDK sys/resource.h, RUSAGE_INFO_V0. The complete stable
    # structure is necessary: proc_pid_rusage writes all 96 bytes, not just
    # the footprint field. RSS counts Chromium's shared clean mappings once
    # per process; physical footprint measures their actual memory charge.
    _fields_ = [("ri_uuid", ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        "ri_user_time", "ri_system_time", "ri_pkg_idle_wkups", "ri_interrupt_wkups", "ri_pageins",
        "ri_wired_size", "ri_resident_size", "ri_phys_footprint", "ri_proc_start_abstime", "ri_proc_exit_abstime")]


@lru_cache(maxsize=1)
def _mac_rusage():
    function = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True).proc_pid_rusage
    function.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    function.restype = ctypes.c_int
    return function


def _process_memory(pid: int, rss_kib: int) -> int:
    if sys.platform != "darwin":
        return rss_kib * 1024
    info = _RusageInfoV0()
    if _mac_rusage()(pid, 0, ctypes.byref(info)) == 0:
        return info.ri_phys_footprint
    error = ctypes.get_errno()
    if error == errno.ESRCH:
        return 0  # A child exited between the process snapshot and this read.
    raise RuntimeError(f"Could not measure renderer physical footprint (errno {error}).")


def _process_rows() -> list[tuple[int, int, int, int]]:
    """Read process identities and RSS only; argv can contain unrelated secrets."""
    probe = spawn_clean(["/bin/ps", "-axo", "pid=,ppid=,pgid=,rss="], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        output, _ = probe.communicate(timeout=1)
    except subprocess.TimeoutExpired:
        kill_group(probe, signal.SIGKILL)
        probe.communicate()
        raise RuntimeError("Could not measure renderer memory.") from None
    if probe.returncode != 0:
        raise RuntimeError("Could not inspect renderer processes.")
    rows = []
    for line in output.decode("ascii", "replace").splitlines():
        fields = line.split()
        if len(fields) == 4 and all(field.isdecimal() for field in fields):
            rows.append(tuple(map(int, fields)))
    return rows


def _group_memory(root: int) -> int:
    """Owned descendant footprint on macOS; conservative summed RSS elsewhere."""
    rows = _process_rows()
    owned = {root} | {pid for pid, _, group, _ in rows if group == root}
    previous = set()
    while owned != previous:
        previous = owned.copy()
        owned.update(pid for pid, parent, _, _ in rows if parent in owned)
    return sum(_process_memory(pid, rss) for pid, _, _, rss in rows if pid in owned)


def _signal_group(process: subprocess.Popen, sig: int) -> None:
    try:
        kill_group(process, sig)
    except PermissionError:
        # macOS can report EPERM while a just-signalled group finishes exiting.
        # Do not turn successful teardown into an error, or ignore a real live
        # process: require both the leader and every group member to be gone.
        if process.poll() is None or any(pid == process.pid or group == process.pid for pid, _, group, _ in _process_rows()):
            raise


async def _stop(process: subprocess.Popen) -> None:
    # Signal the group even when its leader has exited; Chrome may still exist.
    try:
        _signal_group(process, signal.SIGTERM)
        for _ in range(10):
            if process.poll() is not None:
                break
            await asyncio.sleep(0.025)
    finally:
        try:
            _signal_group(process, signal.SIGKILL)
        finally:
            if process.stdin:
                process.stdin.close()
    await asyncio.wait_for(asyncio.to_thread(process.wait), 1)


async def render_artifact(settings: Any, title: str, source: str, checks: list[dict[str, str]]) -> RenderReport:
    """Render exactly this source; failure never mutates or publishes the draft."""
    started = time.monotonic()
    timeout = min(45.0, max(1.0, float(getattr(settings, "artifact_render_timeout_seconds", 45))))
    deadline = started + timeout
    limit = min(768, max(64, int(getattr(settings, "artifact_render_memory_mb", 768)))) * 1024 * 1024
    report: RenderReport
    if not isinstance(source, str) or not source.strip() or len(source) > SOURCE_MAX:
        return failure("source_size", "Artifact source must contain 1–128000 characters.")
    try:
        checked = validate_checks(checks)
        directory = Path(getattr(settings, "artifact_renderer_path", "") or "")
        manifest = renderer_assets(directory)
    except (ValueError, TypeError, OSError) as error:
        return failure("renderer_unavailable", str(error))
    # The product's own browser when it lends one (`browser_host`), and then
    # never an installed one; otherwise a Chrome this process launches.
    host = browser_host()
    chrome = None if host else os.environ.get("CHROME_PATH") or _chrome_executable()
    if not host and (not chrome or not Path(chrome).is_file()):
        return failure("browser_unavailable", "An installed Chrome/Chromium browser is required for artifact validation.")
    acquired = False
    process = None
    temporary = None
    peak = 0
    cleanup_error = ""
    try:
        await asyncio.wait_for(_SERIAL.acquire(), max(0.01, deadline - time.monotonic()))
        acquired = True
        temporary = tempfile.TemporaryDirectory(prefix="delphi-artifact-")
        directory_path = Path(temporary.name)
        request, response = directory_path / "request.json", directory_path / "response.json"
        browser = {"host": host.as_request(), "memory_limit": limit} if host else {"chrome": chrome}
        request.write_text(json.dumps({"title": str(title)[:160], "source": source, "checks": checked,
                                       "renderer": str(directory.resolve()), **browser,
                                       "timeout": max(0.1, deadline - time.monotonic())}))
        request.chmod(0o600)
        # Equivalent to spawn_clean, with a dedicated stdin parent-watch
        # pipe. No preexec_fn/cwd/start_new_session: retain posix_spawn.
        process = subprocess.Popen(
            [sys.executable, "-I", "-S", str(_CLEAN_EXEC), "", sys.executable,
             "-I", "-m", "delphi_core.artifacts.worker", str(request), str(response)],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            close_fds=False, env=_child_environment(),
        )
        measured = 0.0
        while process.poll() is None:
            now = time.monotonic()
            if now >= deadline:
                raise asyncio.TimeoutError
            if now - measured >= 0.5:
                peak = max(peak, await asyncio.to_thread(_group_memory, process.pid))
                measured = now
                if peak > limit:
                    report = failure("memory_limit", f"Renderer exceeded its {limit // (1024 * 1024)} MiB process-tree memory limit.")
                    break
            await asyncio.sleep(0.05)
        else:
            if process.returncode != 0 or not response.is_file() or response.stat().st_size > MAX_REPORT_BYTES:
                report = failure("renderer_failed", "The isolated renderer exited without a bounded report.")
            else:
                payload = json.loads(response.read_text())
                report = RenderReport(**payload)
        await _stop(process)
        process = None
    except asyncio.TimeoutError:
        report = failure("render_timeout", "Artifact validation exceeded its total deadline, including queueing and browser startup.")
    except asyncio.CancelledError:
        raise
    except (OSError, ValueError, TypeError, RuntimeError) as error:
        report = failure("renderer_failed", str(error))
    finally:
        try:
            if process is not None:
                try:
                    await asyncio.shield(_stop(process))
                except (OSError, RuntimeError, asyncio.TimeoutError) as error:
                    cleanup_error = str(error)
            if temporary is not None:
                try:
                    temporary.cleanup()
                except OSError as error:
                    cleanup_error = str(error)
        finally:
            if acquired:
                _SERIAL.release()
    if cleanup_error:
        report.passed = False
        report.diagnostics.append({"code": "cleanup_failed", "severity": "error", "message": cleanup_error[:400]})
    report.elapsed_ms = round((time.monotonic() - started) * 1000)
    report.renderer_version = manifest["runtimeHash"][:128]
    # A host measures the page's own renderer processes and enforces the
    # limit there; this process can see only its worker.
    peak = max(peak, report.renderer_peak_bytes)
    metric = "resident memory" if host else "physical footprint" if sys.platform == "darwin" else "RSS"
    report.diagnostics = report.diagnostics[:23] + [{"code": "resource_usage", "severity": "info",
                                                    "message": f"Peak observed renderer {metric}: {peak // (1024 * 1024)} MiB."}]
    # Assert the serializable contract here, before the harness receives it.
    json.dumps(asdict(report))
    return report
