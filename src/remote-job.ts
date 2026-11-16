export const REMOTE_RESULT_MARK = "RANGER_JOB_RESULT";
export const REMOTE_CWD_MISSING = 97;
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

function remoteScript(spec: RemoteJobSpec, worker: string[]): string {
 const seconds = Math.max(1, Math.ceil(spec.wallClockMin * 60));
 const log = `"$HOME"/.local/state/ranger-jobs/${quote(`${spec.name}-${spec.runId}.log`)}`;
 return [
  `cd ${remotePath(spec.cwd)} || exit ${REMOTE_CWD_MISSING}`,
  `mkdir -p "$HOME"/.local/state/ranger-jobs`,
  `log=${log}`,
  `rf=$(mktemp)`,
  `RANGER_JOB_RESULT_FILE="$rf" ${worker.map(quote).join(" ")} > "$log" 2>&1 < /dev/null &`,
  `pid=$!`,
  `( sleep ${seconds}; kill -TERM "$pid" 2> /dev/null ) > /dev/null 2>&1 &`,
  `watchdog=$!`,
  `wait "$pid"`,
  `code=$?`,
  `kill "$watchdog" 2> /dev/null`,
  `printf 'remote log: %s:%s\\n' "$(hostname -s)" "$log"`,
  `if [ -s "$rf" ]; then printf '${REMOTE_RESULT_MARK} %s\\n' "$(head -n 1 "$rf")"; fi`,
  `rm -f "$rf"`,
  `exit "$code"`,
 ].join("\n");
}

export function remoteJobArgv(spec: RemoteJobSpec, command: string[], prompt: string): string[] {
 return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", spec.host, remoteScript(spec, [...command, prompt])];
}

export function remoteJobResult(stdout: string): string | null {
 const prefix = `${REMOTE_RESULT_MARK} `;
 const line = stdout.split("\n").find(l => l.startsWith(prefix));
 const value = line?.slice(prefix.length).trim() ?? "";
 return value === "" ? null : value;
}
