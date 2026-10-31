#!/usr/bin/env bash
# Amaya idle-traffic privacy test (Gate 1).
# usage: tests/privacy/run.sh <browser-binary> [--duration S] [--allowlist FILE]
#                             [--report OUT.json] [--scenario idle|newtab|all] [--headful]
# exit: 0 all destinations allowed, 1 something outside the allow-list, 2 harness error
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || { echo "harness error: $PY not found" >&2; exit 2; }
exec "$PY" "$DIR/harness.py" "$@"
