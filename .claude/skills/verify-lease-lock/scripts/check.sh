#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
model="$here/model"
jar_version=1.7.4
jar_sha=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
jar="${TLA2TOOLS:-$HOME/.cache/ranger-tla/tla2tools-$jar_version.jar}"

java="${JAVA:-}"
if [[ -z "$java" ]]; then
  for candidate in java /opt/homebrew/opt/openjdk/bin/java /usr/local/opt/openjdk/bin/java; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -version >/dev/null 2>&1; then java="$candidate"; break; fi
  done
fi
if [[ -z "$java" ]]; then
  echo "No working Java 11+. Install one (brew install openjdk) or set JAVA=/path/to/java." >&2
  exit 2
fi

if [[ ! -f "$jar" ]]; then
  mkdir -p "$(dirname "$jar")"
  curl -fsSL -o "$jar.part" "https://github.com/tlaplus/tlaplus/releases/download/v$jar_version/tla2tools.jar"
  mv "$jar.part" "$jar"
fi
if [[ "$(shasum -a 256 "$jar" | cut -d' ' -f1)" != "$jar_sha" ]]; then
  echo "Checksum mismatch for $jar; delete it and rerun." >&2
  exit 2
fi

sync="$(sed -n 's/^sync-commit: *//p' "$here/SKILL.md")"
if ! git -C "$repo" diff --quiet "$sync" -- src/lock.ts 2>/dev/null; then
  echo "NOTE: src/lock.ts differs from sync commit $sync; confirm the model still describes it (SKILL.md, 'Keep the model in step')."
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/lease-lock-tlc.XXXXXX")"
trap 'rm -rf "$work"' EXIT
status=0
while IFS=$'\t' read -r cfg expected; do
  [[ -z "$cfg" || "$cfg" == \#* ]] && continue
  out="$work/$cfg.out"
  "$java" -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 1 -metadir "$work/$cfg" \
    -config "$model/$cfg.cfg" "$model/LeaseLock.tla" >"$out" 2>&1 || true
  if grep -q "No error has been found" "$out"; then
    actual=pass
  elif rule="$(sed -n 's/^Error: Invariant \(.*\) is violated\.$/\1/p' "$out")" && [[ -n "$rule" ]]; then
    actual="$rule: $(sed -n 's/^State [0-9]*: <\([A-Za-z]*\).*/\1/p' "$out" | grep -v '^Initial$' | paste -sd' ' -)"
  else
    actual="tlc-error"
  fi
  if [[ "$actual" == "$expected" ]]; then
    echo "ok       $cfg: $actual"
  else
    echo "CHANGED  $cfg"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    keep="${TMPDIR:-/tmp}/lease-lock-$cfg.out"
    cp "$out" "$keep"
    echo "  TLC output kept at $keep"
    status=1
  fi
done <"$model/expected.tsv"
exit $status
