import { ALLOWED_NAMES, ALLOWED_PREFIXES } from "./untrusted-env.ts";

export const REMOTE_RESULT_MARK = "RANGER_JOB_RESULT";
export const REMOTE_CWD_MISSING = 97;
export const REMOTE_LAUNCH_FAILED = 98;
export const REMOTE_TIMED_OUT = 124;
export const REMOTE_LOST = 125;
export const REMOTE_KILL_GRACE_S = 10;
export const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
export const HOST_SESSIONS = ["ssh", "login"] as const;
export type HostSession = (typeof HOST_SESSIONS)[number];

export interface RemoteJobSpec {
 host: string;
 cwd: string;
 name: string;
 runId: number;
 wallClockMin: number;
 session?: HostSession;
}

const quote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

const remotePath = (path: string): string =>
 path === "~" ? `"$HOME"` : path.startsWith("~/") ? `"$HOME"/${quote(path.slice(2))}` : quote(path);

const keptEnvPattern = [...ALLOWED_NAMES, ...ALLOWED_PREFIXES.map(prefix => `${prefix}*`)].join("|");

const RUNNER = [
 `t="$1"; c="$2"; l="$3"; label="$4"; secs="$5"; grace="$6"; shift 6`,
 `finish() { echo "$1" > "$t/status.tmp" && mv "$t/status.tmp" "$t/status"; if [ "$label" != "-" ]; then /bin/launchctl remove "$label" 2> /dev/null; fi; exit 0; }`,
 `if [ -e "$t/started" ]; then finish ${REMOTE_LOST}; fi`,
 `: > "$t/started"`,
 `. "$t/env"`,
 `cd "$c" || finish ${REMOTE_CWD_MISSING}`,
 `set -m`,
 `( RANGER_JOB_RESULT_FILE="$t/result" exec "$@" ) > "$l" 2>&1 < /dev/null &`,
 `pid=$!`,
 `( sleep "$secs"; : > "$t/timeout"; kill -TERM -- -"$pid" 2> /dev/null; sleep "$grace"; kill -KILL -- -"$pid" 2> /dev/null ) > /dev/null 2>&1 &`,
 `watchdog=$!`,
 `wait "$pid"`,
 `code=$?`,
 `kill -- -"$watchdog" 2> /dev/null`,
 `kill -KILL -- -"$pid" 2> /dev/null`,
 `if [ -e "$t/timeout" ]; then code=${REMOTE_TIMED_OUT}; fi`,
 `finish "$code"`,
];

function remoteScript(spec: RemoteJobSpec, worker: string[]): string {
 const seconds = Math.max(1, Math.ceil(spec.wallClockMin * 60));
 const label = spec.session === "login" ? `ranger-job.${spec.name}.${spec.runId}` : "-";
 const args = `"$tmp/run.sh" "$tmp" "$PWD" "$log" ${quote(label)} ${seconds} ${REMOTE_KILL_GRACE_S} ${worker.map(quote).join(" ")}`;
 const launch = spec.session === "login"
  ? [
   `/bin/launchctl submit -l ${quote(label)} -- /usr/bin/env -i /bin/bash ${args} || { rm -rf "$tmp"; exit ${REMOTE_LAUNCH_FAILED}; }`,
   `end=$((SECONDS + ${seconds + REMOTE_KILL_GRACE_S + 30}))`,
   `until [ -s "$tmp/status" ] || [ "$SECONDS" -ge "$end" ]; do sleep 1; done`,
   `/bin/launchctl remove ${quote(label)} 2> /dev/null`,
  ]
  : [`/usr/bin/env -i /bin/bash ${args}`];
 return [
  `umask 077`,
  `cd ${remotePath(spec.cwd)} || exit ${REMOTE_CWD_MISSING}`,
  `dir="$HOME"/.local/state/ranger-jobs`,
  `mkdir -p "$dir" && chmod 700 "$dir" || exit 1`,
  `log="$dir"/${quote(`${spec.name}-${spec.runId}.log`)}`,
  `tmp=$(mktemp -d) || exit 1`,
  `(`,
  ` for name in $(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'); do`,
  `  case "$name" in ${keptEnvPattern}) ;; *) unset "$name" 2> /dev/null ;; esac`,
  ` done`,
  ` export -p`,
  `) > "$tmp/env"`,
  `printf '%s\\n' ${RUNNER.map(quote).join(" ")} > "$tmp/run.sh"`,
  ...launch,
  `code=$(cat "$tmp/status" 2> /dev/null || echo ${REMOTE_LOST})`,
  `printf 'remote log: %s:%s\\n' "$(hostname -s)" "$log"`,
  `if [ "$code" -ne ${REMOTE_TIMED_OUT} ] && [ -s "$tmp/result" ]; then printf '${REMOTE_RESULT_MARK} %s\\n' "$(head -n 1 "$tmp/result")"; fi`,
  `rm -rf "$tmp"`,
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
