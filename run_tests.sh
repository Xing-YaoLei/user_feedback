#!/bin/sh
# Convenience runner: executes the stdlib test suite from the repo root.
cd "$(dirname "$0")" || exit 1
exec python3 -m unittest discover -s tests -v
