import type { ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";

export type ActionKind =
  | "command"
  | "read"
  | "image"
  | "edit"
  | "write"
  | "search"
  | "web"
  | "fetch"
  | "agent"
  | "plan"
  | "todo"
  | "compact"
  | "worktree"
  | "tool";

export interface Action {
  id: string;
  kind: ActionKind;
  /** Command, file, query, URL or tool name, depending on the kind. */
  subject: string | null;
  failed: boolean;
}

const ICONS: Record<ActionKind, string> = {
  command: "💻",
  read: "📄",
  image: "🖼",
  edit: "✏️",
  write: "📝",
  search: "🔍",
  web: "🌐",
  fetch: "🌐",
  agent: "🤖",
  plan: "📋",
  todo: "📋",
  compact: "🗜",
  worktree: "🌿",
  tool: "🔧",
};

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?)$/i;
const SUBJECT_LIMIT = 60;

export function classifyToolCall(item: ToolCallTimelineItem): Action {
  const base = { id: item.callId, failed: item.status === "failed" };
  const detail = item.detail;
  switch (detail.type) {
    case "shell":
      return { ...base, kind: "command", subject: commandTitle(detail.command) };
    case "read":
      return {
        ...base,
        kind: IMAGE_FILE.test(detail.filePath) ? "image" : "read",
        subject: detail.filePath,
      };
    case "edit":
      return { ...base, kind: "edit", subject: detail.filePath };
    case "write":
      return { ...base, kind: "write", subject: detail.filePath };
    case "search":
      return {
        ...base,
        kind: detail.toolName === "web_search" ? "web" : "search",
        subject: detail.query || null,
      };
    case "fetch":
      return { ...base, kind: "fetch", subject: hostOf(detail.url) };
    case "sub_agent":
      return { ...base, kind: "agent", subject: detail.description ?? detail.subAgentType ?? null };
    case "plan":
      return { ...base, kind: "plan", subject: null };
    case "worktree_setup":
      return { ...base, kind: "worktree", subject: detail.branchName };
    case "plain_text":
      return byName(item.name, base, detail.label ?? null);
    case "unknown":
      return byName(item.name, base, null);
  }
}

function byName(name: string, base: { id: string; failed: boolean }, label: string | null): Action {
  if (/view_?image|read_?image|screenshot/i.test(name))
    return { ...base, kind: "image", subject: null };
  if (/web_?search/i.test(name)) return { ...base, kind: "web", subject: label };
  if (/todo|update_plan/i.test(name)) return { ...base, kind: "todo", subject: null };
  return { ...base, kind: "tool", subject: label ?? toolName(name) };
}

/** `mcp__paseo__create_agent` → `paseo.create_agent`. */
function toolName(name: string): string {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]}.${mcp[2]}` : name;
}

/** Strips `bash -lc '…'` and similar wrappers and keeps the first line. */
export function commandTitle(command: string): string {
  let inner = command.trim();
  const wrapped =
    /^(?:"?[^\s"]*?(?:bash|zsh|sh|dash|pwsh|powershell)(?:\.exe)?"?)\s+(?:-[\w-]+\s+)*?(?:-l?c|-Command)\s+(['"])([\s\S]*)\1$/i.exec(
      inner,
    );
  if (wrapped?.[2]) inner = wrapped[2].trim();
  const firstLine = inner.split("\n").find((line) => line.trim().length > 0) ?? inner;
  return truncate(firstLine.replace(/\s+/g, " ").trim(), SUBJECT_LIMIT);
}

function truncate(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("")}…`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return truncate(url, SUBJECT_LIMIT);
  }
}

function baseName(file: string): string {
  return file.split(/[\\/]/).filter(Boolean).pop() ?? file;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : `${count} ${many}`;
}

function unique(actions: readonly Action[]): string[] {
  return [...new Set(actions.map((action) => action.subject).filter((s): s is string => !!s))];
}

/** Title for a run of actions of one kind, e.g. "Ran 3 commands" or "Edited bridge.ts". */
function groupTitle(kind: ActionKind, actions: readonly Action[]): string {
  const count = actions.length;
  const subjects = unique(actions);
  const only = count === 1 ? actions[0]?.subject : null;
  switch (kind) {
    case "command":
      return only ? `Ran ${only}` : `Ran ${plural(count, "a command", "commands")}`;
    case "read":
      return subjects.length === 1
        ? `Read ${baseName(subjects[0] ?? "")}`
        : `Read ${plural(Math.max(subjects.length, 1), "a file", "files")}`;
    case "image":
      return `Viewed ${plural(count, "an image", "images")}`;
    case "edit":
      return subjects.length === 1
        ? `Edited ${baseName(subjects[0] ?? "")}`
        : `Edited ${plural(Math.max(subjects.length, 1), "a file", "files")}`;
    case "write":
      return subjects.length === 1
        ? `Wrote ${baseName(subjects[0] ?? "")}`
        : `Wrote ${plural(Math.max(subjects.length, 1), "a file", "files")}`;
    case "search":
      return only ? `Searched for “${truncate(only, SUBJECT_LIMIT)}”` : `Searched ${count} times`;
    case "web":
      return only
        ? `Searched the web for “${truncate(only, SUBJECT_LIMIT)}”`
        : `Searched the web ${plural(count, "once", "times")}`;
    case "fetch":
      return only ? `Fetched ${only}` : `Fetched ${plural(count, "a page", "pages")}`;
    case "agent":
      return only
        ? `Ran a subagent: ${truncate(only, SUBJECT_LIMIT)}`
        : `Ran ${plural(count, "a subagent", "subagents")}`;
    case "plan":
      return "Updated the plan";
    case "todo":
      return "Updated the task list";
    case "compact":
      return "Compacted the conversation";
    case "worktree":
      return "Set up a worktree";
    case "tool":
      if (subjects.length === 1) {
        return count === 1 ? `Used ${subjects[0]}` : `Used ${subjects[0]} ${count} times`;
      }
      return subjects.length > 1 && subjects.length <= 3
        ? `Used ${subjects.slice(0, -1).join(", ")} and ${subjects.at(-1)}`
        : `Used ${plural(count, "a tool", "tools")}`;
  }
}

/** Phrase used inside a collapsed summary, e.g. "ran 3 commands". */
function summaryPhrase(kind: ActionKind, actions: readonly Action[]): string {
  const count = actions.length;
  const files = Math.max(unique(actions).length, 1);
  switch (kind) {
    case "command":
      return `ran ${plural(count, "a command", "commands")}`;
    case "read":
      return `read ${plural(files, "a file", "files")}`;
    case "image":
      return `viewed ${plural(count, "an image", "images")}`;
    case "edit":
      return `edited ${plural(files, "a file", "files")}`;
    case "write":
      return `wrote ${plural(files, "a file", "files")}`;
    case "search":
      return count === 1 ? "searched" : `searched ${count} times`;
    case "web":
      return count === 1 ? "searched the web" : `searched the web ${count} times`;
    case "fetch":
      return `fetched ${plural(count, "a page", "pages")}`;
    case "agent":
      return `ran ${plural(count, "a subagent", "subagents")}`;
    case "plan":
      return "updated the plan";
    case "todo":
      return "updated the task list";
    case "compact":
      return "compacted the conversation";
    case "worktree":
      return "set up a worktree";
    case "tool":
      return `used ${plural(count, "a tool", "tools")}`;
  }
}

function failureSuffix(actions: readonly Action[]): string {
  const failed = actions.filter((action) => action.failed).length;
  if (failed === 0) return "";
  return actions.length === 1 ? " — failed" : ` (${failed} failed)`;
}

/**
 * One line per run of same-kind actions. More runs than `maxLines` collapse into one
 * summary line, e.g. "✏️ Edited 2 files, ran 5 commands, viewed an image".
 */
export function renderActions(actions: readonly Action[], maxLines = 5): string[] {
  const runs: Array<{ kind: ActionKind; actions: Action[] }> = [];
  for (const action of actions) {
    const last = runs.at(-1);
    if (last && last.kind === action.kind) last.actions.push(action);
    else runs.push({ kind: action.kind, actions: [action] });
  }
  if (runs.length <= maxLines) {
    return runs.map(
      (run) =>
        `${ICONS[run.kind]} ${groupTitle(run.kind, run.actions)}${failureSuffix(run.actions)}`,
    );
  }
  const byKind = new Map<ActionKind, Action[]>();
  for (const action of actions) {
    byKind.set(action.kind, [...(byKind.get(action.kind) ?? []), action]);
  }
  const phrases = [...byKind].map(([kind, group]) => summaryPhrase(kind, group));
  const sentence = phrases.join(", ");
  const first = actions[0]?.kind ?? "tool";
  return [
    `${ICONS[first]} ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}${failureSuffix(actions)}`,
  ];
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

function lineCount(text: string | undefined): number {
  if (!text) return 0;
  const lines = text.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

/** Lines added and removed by an edit or write, for the end-of-turn summary. */
export function fileChange(item: ToolCallTimelineItem): FileChange | null {
  if (item.status === "failed" || item.status === "canceled") return null;
  const detail = item.detail;
  if (detail.type === "write") {
    return detail.content === undefined
      ? null
      : { path: detail.filePath, added: lineCount(detail.content), removed: 0 };
  }
  if (detail.type !== "edit") return null;
  if (detail.unifiedDiff) {
    let added = 0;
    let removed = 0;
    for (const line of detail.unifiedDiff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    return { path: detail.filePath, added, removed };
  }
  if (detail.oldString === undefined && detail.newString === undefined) return null;
  const before = detail.oldString ? detail.oldString.split("\n") : [];
  const after = detail.newString ? detail.newString.split("\n") : [];
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    path: detail.filePath,
    added: after.length - prefix - suffix,
    removed: before.length - prefix - suffix,
  };
}
