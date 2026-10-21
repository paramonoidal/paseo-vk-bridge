/**
 * Splits text into VK-sized messages. VK counts characters, so the limit is in code
 * points, and a split never lands inside a surrogate pair. Splits prefer a paragraph
 * break, then a line break, then a space in the last half of the window.
 */
export function splitText(text: string, limit: number): string[] {
  const chars = Array.from(text);
  if (chars.length <= limit) return text.length > 0 ? [text] : [];
  const parts: string[] = [];
  let start = 0;
  while (start < chars.length) {
    if (chars.length - start <= limit) {
      parts.push(chars.slice(start).join(""));
      break;
    }
    const end = start + limit;
    const cut = findBreak(chars, start + Math.floor(limit / 2), end) ?? end;
    parts.push(chars.slice(start, cut).join("").trimEnd());
    start = cut;
    while (start < chars.length && (chars[start] === "\n" || chars[start] === " ")) start++;
  }
  return parts.filter((part) => part.length > 0);
}

function findBreak(chars: string[], from: number, to: number): number | null {
  for (const separator of ["\n\n", "\n", " "]) {
    for (let index = to; index > from; index--) {
      if (separator === "\n\n") {
        if (chars[index - 1] === "\n" && chars[index - 2] === "\n") return index;
      } else if (chars[index - 1] === separator) {
        return index;
      }
    }
  }
  return null;
}

const FENCE = /^\s{0,3}(```|~~~)/;

/**
 * Renders agent Markdown as plain text, since VK messages have no formatting.
 * Code blocks keep their content; emphasis markers, heading hashes and link syntax go.
 */
export function markdownToPlain(markdown: string): string {
  const output: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = FENCE.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1] === fence) fence = null;
      else output.push(line);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1] ?? null;
      continue;
    }
    const rendered = renderLine(line);
    if (rendered !== null) output.push(rendered);
  }
  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Renders one line outside code blocks; `null` drops it. */
function renderLine(line: string): string | null {
  if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) {
    return null;
  }
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return "———";
  let rest = line;
  let prefix = "";
  const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(rest);
  if (heading) return renderInline(heading[1] ?? "");
  const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+/.exec(rest);
  if (task) {
    prefix = `${task[1]}${task[2] === " " ? "☐" : "☑"} `;
    rest = rest.slice(task[0].length);
  } else {
    const bullet = /^(\s*)[-*+]\s+/.exec(rest);
    if (bullet) {
      prefix = `${bullet[1]}• `;
      rest = rest.slice(bullet[0].length);
    }
  }
  return prefix + renderInline(rest);
}

/** Applies inline rules outside code spans, then drops the backticks. */
function renderInline(text: string): string {
  return text
    .split(/(`+[^`]*`+)/)
    .map((segment) =>
      /^`+[^`]*`+$/.test(segment) ? segment.replace(/^`+|`+$/g, "") : renderEmphasis(segment),
    )
    .join("");
}

function renderEmphasis(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt: string, url: string) =>
      alt ? `${alt} (${url})` : url,
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, label: string, url: string) =>
      label === url ? url : `${label} (${url})`,
    )
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, "$1$2")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1");
}
