"""Start a program the way a shell would, without forking this server.

    python -I -S clean_exec.py CWD PROGRAM [ARGS...]

`browser_render.spawn_clean` runs this for every child the server starts —
Chromium for captures and renders, and the isolated PDF worker. It exists so
that nothing has to run in the server's own child between fork and exec.

That used to happen through `preexec_fn`, and it made `subprocess` fall back
from `posix_spawn` to a real `fork()` of a threaded server. On macOS that fork
runs Apple's own fork handlers in the child, and once the server's process had
used the network in some way the Network framework's handler
(`nw_settings_child_has_forked`) crashed every child with SIGSEGV before it
could exec: Chromium was reported "killed by signal 11 after 0.0s" on every
capture from then on, until the server restarted. Without `preexec_fn`,
`cwd`, `start_new_session` or `close_fds`, `subprocess` uses `posix_spawn` on
macOS and on glibc Linux, no fork handler runs, and this script does the
child's setup instead — in a fresh interpreter that inherited no state.

The setup is what a shell gives a program and a server does not:

- A new session, so the caller can kill the program and everything it starts
  as one process group.
- Default dispositions and an empty blocked mask. `SIGCHLD` set to `SIG_IGN`
  survives exec and makes the kernel reap children at once; Chromium's
  `waitpid` on its crashpad handler and zygote then fails with ECHILD and it
  aborts with SIGTRAP — the crash the deployed service produced 0.2 seconds in,
  while the same image captured the page in 2.4 seconds as a Cloud Run job.
  Python itself ignores SIGPIPE and SIGXFSZ at startup, so those are reset too.
- No inherited descriptors beyond stdin, stdout and stderr, as `close_fds`
  would have given.

Standard library only, and started with `-I -S`: it must not import the app.
"""

import os
import signal
import sys


def main() -> None:
    if len(sys.argv) < 3:
        sys.stderr.write("usage: clean_exec.py CWD PROGRAM [ARGS...]\n")
        raise SystemExit(2)
    cwd, program, *arguments = sys.argv[1:]
    os.setsid()
    for name in (
        "SIGCHLD", "SIGPIPE", "SIGXFSZ", "SIGTERM", "SIGINT", "SIGHUP",
        "SIGUSR1", "SIGUSR2",
    ):
        handled = getattr(signal, name, None)
        if handled is not None:
            signal.signal(handled, signal.SIG_DFL)
    signal.pthread_sigmask(signal.SIG_SETMASK, set())
    descriptors = "/proc/self/fd" if os.path.isdir("/proc/self/fd") else "/dev/fd"
    for entry in os.listdir(descriptors):
        descriptor = int(entry)
        if descriptor > 2:
            try:
                os.close(descriptor)
            except OSError:
                pass
    if cwd:
        os.chdir(cwd)
    try:
        os.execv(program, [program, *arguments])
    except OSError as error:
        sys.stderr.write(f"clean_exec: could not start {program}: {error}\n")
        raise SystemExit(127) from error


if __name__ == "__main__":
    main()
