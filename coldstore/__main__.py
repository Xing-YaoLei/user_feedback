"""Allow ``python -I /path/to/coldstore`` and ``python -m coldstore``."""

import sys
from pathlib import Path

# When executed directly as a directory, sys.path[0] is this package
# directory rather than its parent; add the parent so the absolute import
# below works under -I as well.
_PARENT = str(Path(__file__).resolve().parent.parent)
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)

from coldstore.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
