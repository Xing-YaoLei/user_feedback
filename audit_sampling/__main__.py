"""Allow ``python3 -m audit_sampling`` to run the CLI."""

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
