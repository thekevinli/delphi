"""`python -m delphi_core_testkit.abstraction <check> [options]`: run one layering check; its exit status is the verdict."""
from importlib import import_module
import sys

COMMANDS = {
    "imports": ("a1_imports", "main"),
    "surface": ("a3_surface", "main"),
    "http": ("a4_http", "main"),
    "settings": ("a6_settings", "main"),
    "versions": ("a7_same_code", "main_versions"),
    "wheel": ("a7_same_code", "main_wheel"),
    "private-names": ("a8_private_names", "main"),
}


def main(argv):
    if not argv or argv[0] not in COMMANDS:
        names = ", ".join(COMMANDS)
        print(f"usage: python -m delphi_core_testkit.abstraction <check> [options]; checks: {names}", file=sys.stderr)
        return 0 if argv[:1] in (["-h"], ["--help"]) else 2
    module, function = COMMANDS[argv[0]]
    return getattr(import_module(f"{__package__}.{module}"), function)(argv[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
