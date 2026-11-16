import { ALLOWED_NAMES, ALLOWED_PREFIXES } from "./untrusted-env.ts";

export const REMOTE_RESULT_MARK = "RANGER_JOB_RESULT";
export const REMOTE_CWD_MISSING = 97;
export const REMOTE_TIMED_OUT = 124;
export const REMOTE_KILL_GRACE_S = 10;
export const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

export interface RemoteJobSpec {
 host: string;
 cwd: string;
 name: string;
 runId: number;
 wallClockMin: number;
}

const quote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

const remotePath = (path: string): string =>
 path === "~" ? `"$HOME"` : path.startsWith("~/") ? `"$HOME"/${quote(path.slice(2))}` : quote(path);

const keptEnvPattern = [...ALLOWED_NAMES, ...ALLOWED_PREFIXES.map(prefix => `${prefix}*`)].join("|");

function remoteScript(spec: RemoteJobSpec, worker: string[]): string {
 const seconds = Math.max(1, Math.ceil(spec.wallClockMin * 60));
 return [
  `umask 077`,
  `set -m`,
  `cd ${remotePath(spec.cwd)} || exit ${REMOTE_CWD_MISSING}`,
  `dir="$HOME"/.local/state/ranger-jobs`,
  `mkdir -p "$dir" && chmod 700 "$dir" || exit 1`,
  `log="$dir"/${quote(`${spec.name}-${spec.runId}.log`)}`,
  `rf=$(mktemp)`,
  `(`,
  ` for name in $(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'); do`,
  `  case "$name" in ${keptEnvPattern}) ;; *) unset "$name" 2> /dev/null ;; esac`,
  ` done`,
  ` RANGER_JOB_RESULT_FILE="$rf" exec ${worker.map(quote).join(" ")}`,
  `) > "$log" 2>&1 < /dev/null &`,
  `pid=$!`,
  `( sleep ${seconds}; : > "$rf.timeout"; kill -TERM -- -"$pid" 2> /dev/null; sleep ${REMOTE_KILL_GRACE_S}; kill -KILL -- -"$pid" 2> /dev/null ) > /dev/null 2>&1 &`,
  `watchdog=$!`,
  `wait "$pid"`,
  `code=$?`,
  `kill -- -"$watchdog" 2> /dev/null`,
  `kill -KILL -- -"$pid" 2> /dev/null`,
  `printf 'remote log: %s:%s\\n' "$(hostname -s)" "$log"`,
  `if [ ! -e "$rf.timeout" ] && [ -s "$rf" ]; then printf '${REMOTE_RESULT_MARK} %s\\n' "$(head -n 1 "$rf")"; fi`,
  `if [ -e "$rf.timeout" ]; then code=${REMOTE_TIMED_OUT}; fi`,
  `rm -f "$rf" "$rf.timeout"`,
  `exit "$code"`,
 ].join("\n");
}

export function remoteJobArgv(spec: RemoteJobSpec, command: string[], prompt: string): string[] {
 const script = remoteScript(spec, [...command, prompt]);
 return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", spec.host, `/bin/bash -c ${quote(script)}`];
}

export function remoteJobResult(stdout: string): string | null {
 const prefix = `${REMOTE_RESULT_MARK} `;
 const line = stdout.split("\n").find(l => l.startsWith(prefix));
 const value = line?.slice(prefix.length).trim() ?? "";
 return value === "" ? null : value;
}
