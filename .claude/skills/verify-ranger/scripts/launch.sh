#!/bin/bash
# Start an isolated `ranger serve` for verification: the checkout this skill
# lives in, a snapshot of the live journal, read-only tokens only, its own port.
# Prints the run dir on the last line; every other script takes it as $1.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHECKOUT="${RANGER_CHECKOUT:-$(git -C "$SKILL_DIR" rev-parse --show-toplevel)}"
PORT="${VERIFY_RANGER_PORT:-7399}"
LIVE_DIR="$HOME/.config/ranger"
RUN="${VERIFY_RANGER_RUN:-$HOME/.cache/verify-ranger/runs/$(date +%Y%m%d-%H%M%S)}"
BUN="${BUN:-$(command -v bun || echo /opt/homebrew/bin/bun)}"

if [ "$PORT" = "7311" ]; then echo "refusing port 7311: that is the principal's live dashboard" >&2; exit 1; fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is taken (another verify run? check ~/.cache/verify-ranger/runs/*/state/serve.pid); set VERIFY_RANGER_PORT" >&2
  exit 1
fi

mkdir -p "$RUN/state" "$RUN/evidence"
# The run dir is always the last stdout line, on success and on every failure.
trap 'echo "$RUN"' EXIT
echo "$CHECKOUT" > "$RUN/state/checkout"
echo "$PORT" > "$RUN/state/port"

# Consistent snapshot through SQLite's backup API; the live file is only read.
sqlite3 "$LIVE_DIR/state.sqlite" ".backup '$RUN/state/state.sqlite'"
cp "$LIVE_DIR/ranger.yaml" "$RUN/state/ranger.yaml"
# The copy names the snapshot itself: an env without RANGER_JOURNAL_PATH (a
# dashboard action's allowlisted env, a fresh shell) still lands on the copy.
(cd "$CHECKOUT" && "$BUN" "$SKILL_DIR/scripts/pin-journal.ts" "$RUN/state/ranger.yaml" "$RUN/state/state.sqlite")

cat > "$RUN/state/env.sh" <<EOF
export RANGER_JOURNAL_PATH="$RUN/state/state.sqlite"
export GH_CONFIG_DIR="$RUN/state/gh-config"
export RANGER_READONLY_GH_TOKEN_METAFACTORY="\$(security find-generic-password -s ranger-ro-metafactory -w 2>/dev/null || true)"
export RANGER_READONLY_GH_TOKEN_PERSONAL="\$(security find-generic-password -s ranger-ro-personal -w 2>/dev/null || true)"
unset GH_TOKEN GITHUB_TOKEN RANGER_WRITE_GH_TOKEN_METAFACTORY RANGER_WRITE_GH_TOKEN_PERSONAL RANGER_DISCORD_TOKEN
EOF
mkdir -p "$RUN/state/gh-config"
# shellcheck disable=SC1091
source "$RUN/state/env.sh"

# Bring the snapshot up to this checkout's migrations (a branch may add one).
if ! (cd "$CHECKOUT" && "$BUN" src/cli.ts job list --config "$RUN/state/ranger.yaml" >/dev/null 2>"$RUN/state/migrate.log"); then
  echo "opening the snapshot with this checkout failed; migrate.log:" >&2; cat "$RUN/state/migrate.log" >&2; exit 1
fi

cd "$CHECKOUT"
nohup "$BUN" src/cli.ts serve --config "$RUN/state/ranger.yaml" --port "$PORT" >"$RUN/state/serve.log" 2>&1 &
echo $! >"$RUN/state/serve.pid"  # may be a launcher parent; cleanup and doctor match by config path

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/state" -o "$RUN/state/ready.json" 2>/dev/null \
     && "$BUN" "$SKILL_DIR/scripts/state-summary.ts" "$RUN/state/ready.json" --quiet; then
    echo "ready: http://127.0.0.1:$PORT  pid $(pgrep -f "src/cli.ts serve --config $RUN/state/ranger.yaml" | head -1)  checkout $CHECKOUT"
    exit 0
  fi
  if ! pgrep -f "src/cli.ts serve --config $RUN/state/ranger.yaml" >/dev/null; then
    echo "serve exited; log:" >&2; cat "$RUN/state/serve.log" >&2; exit 1
  fi
  sleep 1
done
echo "not ready after 60s; log:" >&2; tail -40 "$RUN/state/serve.log" >&2
exit 1
