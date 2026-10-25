#!/bin/bash
# Stop the serve this run started and delete its scratch state. Keeps evidence/.
# Matches only processes started with this run's own config path, so the live
# dashboard (~/.config/ranger/ranger.yaml) and other runs are never touched.
set -euo pipefail
RUN="${1:?usage: cleanup.sh <run-dir>}"
OURS="src/cli.ts serve --config $RUN/state/ranger.yaml"
PIDS="$(pgrep -f "$OURS" || true)"
for PID in $PIDS; do kill "$PID" 2>/dev/null || true; done
for _ in $(seq 1 10); do pgrep -f "$OURS" >/dev/null || break; sleep 0.5; done
for PID in $(pgrep -f "$OURS" || true); do kill -9 "$PID" 2>/dev/null || true; done
if pgrep -f "$OURS" >/dev/null; then echo "still running: $(pgrep -f "$OURS")" >&2; exit 1; fi
rm -rf "$RUN/state"
echo "stopped: ${PIDS:-none}; scratch state removed; evidence kept at $RUN/evidence"
ls -la "$RUN/evidence"
