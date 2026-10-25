#!/bin/bash
# Read-only: is this verification instance worth driving?
set -uo pipefail
RUN="${1:?usage: doctor.sh <run-dir>}"
fail=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }

PORT="$(cat "$RUN/state/port" 2>/dev/null)" || { bad "no $RUN/state/port: not launched"; exit 1; }
PID="$(pgrep -f "src/cli.ts serve --config $RUN/state/ranger.yaml" | head -1)"
CHECKOUT="$(cat "$RUN/state/checkout")"

[ "$PORT" != "7311" ] && ok "port $PORT is not the live dashboard" || bad "port 7311 is the live dashboard"
if ps -p "$PID" -o command= 2>/dev/null | grep -q "src/cli.ts serve"; then ok "serve pid $PID up"; else bad "serve pid $PID not running"; fi
OWNER="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
[ "$OWNER" = "$PID" ] && ok "port $PORT owned by our pid" || bad "port $PORT owned by '${OWNER:-nobody}', not $PID"
CWD="$(lsof -a -p "$PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
[ "$CWD" = "$CHECKOUT" ] && ok "serving code from $CHECKOUT @ $(git -C "$CHECKOUT" rev-parse --short HEAD)" || bad "serve cwd '$CWD' != checkout $CHECKOUT"
if ps -E -p "$PID" -o command= 2>/dev/null | grep -q "RANGER_JOURNAL_PATH=$RUN/state/state.sqlite"; then
  ok "journal is the snapshot, not the live file"
else
  bad "cannot confirm RANGER_JOURNAL_PATH points at the snapshot"
fi
if grep -qF "journalPath: $RUN/state/state.sqlite" "$RUN/state/ranger.yaml"; then
  ok "copied config pins journalPath to the snapshot"
else
  bad "copied config does not pin state.journalPath to the snapshot"
fi
if curl -fsS "http://127.0.0.1:$PORT/api/state" -o "$RUN/state/doctor.json" 2>/dev/null; then
  bun "$(dirname "$0")/state-summary.ts" "$RUN/state/doctor.json" | sed "s/^/     /" && ok "at least one map read" || bad "no map read without error: the snapshot holds no cached frontier for them (a missing read-only PAT stops serve at startup instead; see serve.log)"
else
  bad "/api/state did not answer"
fi
grep -iE "error|refus" "$RUN/state/serve.log" | tail -5 | sed 's/^/     log: /'
exit $fail
