"""`spawn_clean`: children start without forking the server, and start clean."""

import json
import os
import signal
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

import pytest

from delphi_core.browser_render import kill_group, spawn_clean

pytestmark = pytest.mark.skipif(os.name != "posix", reason="POSIX process model")

BACKEND = Path(__file__).resolve().parent.parent


def test_the_child_gets_a_shell_s_defaults_not_the_server_s():
    """What `_child_defaults` used to do between fork and exec, still done."""
    probe = textwrap.dedent(
        """
        import json, os, signal
        print(json.dumps({
            "leads_session": os.getsid(0) == os.getpid(),
            "sigchld_default": signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL,
            "blocked": sorted(int(s) for s in signal.pthread_sigmask(signal.SIG_BLOCK, set())),
            "cwd": os.getcwd(),
            "extra_fds": sorted(
                int(fd) for fd in os.listdir("/proc/self/fd" if os.path.isdir("/proc/self/fd") else "/dev/fd")
                if int(fd) > 2
            ),
        }))
        """
    )
    # Hand it the worst of a server: SIGCHLD ignored (survives exec and made
    # Chromium abort on Cloud Run), a blocked signal, and an inheritable fd.
    leaked_read, leaked_write = os.pipe()
    os.set_inheritable(leaked_write, True)
    previous = signal.signal(signal.SIGCHLD, signal.SIG_IGN)
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGUSR1})
    try:
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryFile() as out:
            process = spawn_clean(
                [sys.executable, "-c", probe], stdout=out, stderr=subprocess.DEVNULL, cwd=directory,
            )
            assert process.wait(timeout=30) == 0
            out.seek(0)
            seen = json.loads(out.read())
            assert Path(seen["cwd"]).resolve() == Path(directory).resolve()
    finally:
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGUSR1})
        signal.signal(signal.SIGCHLD, previous)
        os.close(leaked_read)
        os.close(leaked_write)
    assert seen["leads_session"]
    assert seen["sigchld_default"]
    assert seen["blocked"] == []
    # The probe's own listing opens one descriptor while it reads the list.
    assert len(seen["extra_fds"]) <= 1


def test_a_child_starts_even_where_a_fork_would_crash(tmp_path):
    """The macOS failure, reproduced with a fork handler that kills the child.

    The server's Network framework state made every forked child die with
    SIGSEGV inside `fork()` before it could exec. An aborting `pthread_atfork`
    child handler gives any process the same condition. Run in its own
    interpreter so the handler cannot reach the rest of the suite.
    """
    # glibc hides pthread_atfork from an ordinary dlsym/ctypes lookup. Link
    # against its public C interface instead of relying on Darwin's exported
    # symbol (or glibc's private __register_atfork ABI). This test needs cc,
    # available on the source-test CI runners; the installed wheel does not.
    source = tmp_path / "abort_atfork.c"
    library = tmp_path / ("abort_atfork.dylib" if sys.platform == "darwin" else "abort_atfork.so")
    source.write_text(textwrap.dedent("""
        #include <pthread.h>
        #include <stdlib.h>

        int install_abort_atfork(void) {
            return pthread_atfork(NULL, NULL, abort);
        }
    """))
    compiled = subprocess.run(
        ["cc", "-dynamiclib" if sys.platform == "darwin" else "-shared",
         "-fPIC", "-pthread", str(source), "-o", str(library)],
        capture_output=True, text=True, timeout=30,
    )
    assert compiled.returncode == 0, compiled.stderr
    script = textwrap.dedent(
        """
        import ctypes, resource, subprocess, sys
        from delphi_core.browser_render import spawn_clean
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        helper = ctypes.CDLL(sys.argv[1])
        helper.install_abort_atfork.argtypes = []
        helper.install_abort_atfork.restype = ctypes.c_int
        assert helper.install_abort_atfork() == 0
        forked = subprocess.Popen(["/bin/echo"], stdout=subprocess.DEVNULL, preexec_fn=lambda: None)
        spawned = spawn_clean(["/bin/echo"], stdout=subprocess.DEVNULL, stderr=None)
        print(forked.wait(timeout=10), spawned.wait(timeout=10))
        """
    )
    result = subprocess.run(
        [sys.executable, "-c", script, str(library)],
        cwd=BACKEND, capture_output=True, text=True, timeout=60,
    )
    diagnostics = f"probe exited {result.returncode}\nstdout: {result.stdout}\nstderr: {result.stderr}"
    assert result.returncode == 0, diagnostics
    assert len(result.stdout.split()) == 2, diagnostics
    forked, spawned = (int(code) for code in result.stdout.split())
    assert forked == -signal.SIGABRT, diagnostics
    assert spawned == 0, diagnostics


def test_kill_group_reaches_what_the_child_started():
    process = spawn_clean(
        ["/bin/sh", "-c", "sleep 30 & wait"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        # Give the launcher time to take its own session before signalling it.
        for _ in range(100):
            try:
                if os.getpgid(process.pid) == process.pid:
                    break
            except ProcessLookupError:
                break
            subprocess.run(["sleep", "0.02"])
        kill_group(process, signal.SIGTERM)
        assert process.wait(timeout=10) != 0
    finally:
        if process.poll() is None:
            process.kill()
