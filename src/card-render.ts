/**
 * The one card renderer (node #239, ruling D15 on node #21). Every message
 * ranger posts to Discord is rendered here, so every card reads the same way:
 *
 *   line 1  `<emoji> <status> · **#N** <title>`: only the node id is bold
 *   line 2  `-# ` subtext: map, kind, autonomy, checkpoint, age, link
 *   then    ranger's own lines, the plain body, ranger's footer lines, the tail
 *
 * The body is never wrapped in italics; its markdown headings become plain
 * lines (`## Question` → `Question:`). Links are wrapped in `<…>` so Discord
 * shows no preview embed. Graph text is mention-inerted before anything else
 * runs, and the card never exceeds Discord's 2000-char cap: the body is cut
 * with an explicit `…`, and the tail (which carries the overdue ping) always
 * survives.
 */

export const DISCORD_MESSAGE_LIMIT = 2000;
const TITLE_MAX = 200;

export interface CardSpec {
  /** The status emoji that leads line 1. */
  emoji: string;
  /** Plain status words: `decision needed`, `merged`. */
  status: string;
  /** Graph node id, rendered `**#N**`: the only bold text on line 1. */
  nodeId?: string;
  /** Graph text, mention-inerted, one line, capped at 200 chars. */
  title?: string | null;
  /** Subtext items for line 2, joined by ` · `. Graph text: mention-inerted. */
  meta?: readonly (string | null | undefined)[];
  /** Ranger-authored lines after the subtext. The caller inerts any graph text it interpolates. */
  lines?: readonly string[];
  /** Graph or free text: mention-inerted, headings demoted, cut to fit with `…`. */
  body?: string | null;
  /** A tighter cap on the body than the room the card leaves. */
  bodyMax?: number;
  /** Ranger-authored lines after the body. */
  footer?: readonly string[];
  /** The last line. It survives every cut: it carries the overdue ping. */
  tail?: string | null;
}

/**
 * Inert a `<` in graph-derived text so Discord cannot parse mention/emoji
 * tokens out of it (a node title could otherwise embed `<@principal-id>` and
 * force a ping outside the 7-day policy, or `<@&role>`). `‹` reads like `<`
 * but is not mention syntax.
 */
export function sanitizeGraphText(text: string | null | undefined): string {
  return (text ?? "").replace(/</g, "‹");
}

/** Inline code for an id, command or checkpoint: inerted, backticks dropped. */
export function code(text: string | null | undefined): string {
  return `\`${sanitizeGraphText(text).replace(/`/g, "'").replace(/\s+/g, " ").trim()}\``;
}

/** Collapse prose to one line, truncating at `max` chars with `…`. */
export function oneLine(text: string, max = Number.POSITIVE_INFINITY): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const URL = /https?:\/\/[^\s<>‹›]+/g;

/** Drop sentence punctuation a URL token picked up, and a `)` it does not open. */
function trimUrl(url: string): string {
  let out = url.replace(/[.,;:!?'"]+$/, "");
  while (out.endsWith(")") && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
    out = out.slice(0, -1).replace(/[.,;:!?'"]+$/, "");
  }
  return out;
}

/** Wrap bare `http(s)://` links in `<…>` (no embed), outside inline code. */
function wrapLinks(segment: string): string {
  return segment.replace(URL, (match, offset: number, whole: string) => {
    if (whole[offset - 1] === "<") return match; // already wrapped by ranger
    const url = trimUrl(match);
    return `<${url}>${match.slice(url.length)}`;
  });
}

/** Wrap links in one line, leaving inline-code spans untouched. */
function linkLine(line: string): string {
  return line
    .split(/(`[^`\n]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : wrapLinks(part)))
    .join("");
}

/** Wrap links across lines, leaving fenced code blocks untouched. */
export function wrapLinksIn(text: string): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return line;
      }
      return fenced ? line : linkLine(line);
    })
    .join("\n");
}

/** `## Question` → `Question:`; a body `-# ` subtext line → plain text. */
function demoteHeading(line: string): string {
  const subtext = /^\s{0,3}-#\s+(.*)$/.exec(line);
  if (subtext) return subtext[1]!.trimEnd();
  const heading = /^\s{0,3}#{1,6}(?:\s+(.*?))?(?:\s+#+)?\s*$/.exec(line);
  if (!heading) return line;
  const text = (heading[1] ?? "").trim();
  if (text === "") return "";
  return /[:.?!]$/.test(text) ? text : `${text}:`;
}

/** The body as plain lines: inerted, headings demoted, blank runs collapsed, links wrapped. */
export function plainBody(text: string | null | undefined): string {
  const lines = sanitizeGraphText(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => demoteHeading(line).trimEnd());
  const kept: string[] = [];
  for (const line of lines) {
    if (line === "" && (kept.length === 0 || kept.at(-1) === "")) continue;
    kept.push(line);
  }
  while (kept.at(-1) === "") kept.pop();
  return wrapLinksIn(kept.join("\n"));
}

/** Cut a rendered body to `max` chars ending in `…`, never mid-link or inside an open fence. */
function cutBody(body: string, max: number): string {
  if (body.length <= max) return body;
  const fenceClose = "\n```\n…";
  let cut = body.slice(0, Math.max(0, max - 1));
  const unclosed = (s: string) => (s.match(/^\s*```/gm)?.length ?? 0) % 2 === 1;
  if (unclosed(cut)) cut = body.slice(0, Math.max(0, max - fenceClose.length));
  const open = cut.lastIndexOf("<");
  if (open > cut.lastIndexOf(">") && cut.startsWith("<http", open)) cut = cut.slice(0, open);
  cut = cut.trimEnd();
  return unclosed(cut) ? `${cut}${fenceClose}` : `${cut}…`;
}

/** Escape markdown bold markers outside inline code: line 1 bolds only the id. */
function plainTitle(title: string): string {
  return linkLine(
    oneLine(sanitizeGraphText(title), TITLE_MAX)
      .split(/(`[^`]*`)/)
      .map((part, i) => (i % 2 === 1 ? part : part.replace(/\*/g, "\\*")))
      .join(""),
  );
}

function statusLine(spec: CardSpec): string {
  const title = spec.title === undefined || spec.title === null ? "" : plainTitle(spec.title);
  const subject =
    spec.nodeId !== undefined
      ? `**#${oneLine(sanitizeGraphText(spec.nodeId))}**${title === "" ? "" : ` ${title}`}`
      : title;
  return subject === "" ? `${spec.emoji} ${spec.status}` : `${spec.emoji} ${spec.status} · ${subject}`;
}

function subtextLine(meta: CardSpec["meta"]): string | null {
  const items = (meta ?? [])
    .filter((m): m is string => m !== null && m !== undefined && m.trim().length > 0)
    .map((m) => linkLine(oneLine(sanitizeGraphText(m))));
  return items.length === 0 ? null : `-# ${items.join(" · ")}`;
}

/** Render one card. Pure: the same spec always renders the same text. */
export function renderCard(spec: CardSpec): string {
  const head = [statusLine(spec), subtextLine(spec.meta), ...(spec.lines ?? []).map((l) => wrapLinksIn(l))]
    .filter((l): l is string => l !== null);
  const footer = (spec.footer ?? []).map((l) => wrapLinksIn(l));
  const tail = spec.tail === undefined || spec.tail === null || spec.tail === "" ? [] : [spec.tail];
  const fixed = [...head, ...footer, ...tail].join("\n").length;
  const fullBody = spec.body === undefined || spec.body === null ? "" : plainBody(spec.body);
  // Room left for the body, less the newline that joins it on.
  const room = Math.min(DISCORD_MESSAGE_LIMIT - fixed - 1, spec.bodyMax ?? Number.POSITIVE_INFINITY);
  const body = fullBody === "" || room < 2 ? "" : cutBody(fullBody, room);
  const lines = [...head, ...(body === "" ? [] : [body]), ...footer];
  const front = lines.join("\n").replace(/\s+$/, "");
  const joined = [front, ...tail].join("\n");
  if (joined.length <= DISCORD_MESSAGE_LIMIT) return joined;
  // The fixed parts alone overflow: cut the front, keep the tail whole.
  const tailText = tail.join("\n");
  const maxFront = DISCORD_MESSAGE_LIMIT - (tailText === "" ? 0 : tailText.length + 1);
  const cut = `${front.slice(0, maxFront - 1).trimEnd()}…`;
  return tailText === "" ? cut : `${cut}\n${tailText}`;
}
