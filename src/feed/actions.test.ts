import type { ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import {
  type Action,
  classifyToolCall,
  commandTitle,
  fileChange,
  renderActions,
} from "./actions.js";

function call(
  detail: ToolCallTimelineItem["detail"],
  overrides: Partial<{
    name: string;
    status: "running" | "completed" | "failed";
    callId: string;
  }> = {},
): ToolCallTimelineItem {
  const status = overrides.status ?? "completed";
  return {
    type: "tool_call",
    callId: overrides.callId ?? "c1",
    name: overrides.name ?? "tool",
    detail,
    status,
    error: status === "failed" ? "boom" : null,
  } as ToolCallTimelineItem;
}

function action(kind: Action["kind"], subject: string | null = null, failed = false): Action {
  return { id: Math.random().toString(), kind, subject, failed };
}

describe("commandTitle", () => {
  it("unwraps shell wrappers and keeps the first line", () => {
    expect(commandTitle("bash -lc 'cd app && npm test'")).toBe("cd app && npm test");
    expect(commandTitle('/bin/zsh -lc "git status"')).toBe("git status");
    expect(commandTitle('powershell.exe -NoProfile -Command "Get-Item x"')).toBe("Get-Item x");
    expect(commandTitle("python - <<'EOF'\nprint(1)\nEOF")).toBe("python - <<'EOF'");
  });

  it("truncates long commands", () => {
    expect(Array.from(commandTitle("x".repeat(200))).length).toBe(60);
  });
});

describe("classifyToolCall", () => {
  it("maps tool details to action kinds", () => {
    expect(classifyToolCall(call({ type: "shell", command: "ls" })).kind).toBe("command");
    expect(classifyToolCall(call({ type: "read", filePath: "/a/shot.PNG" })).kind).toBe("image");
    expect(classifyToolCall(call({ type: "read", filePath: "/a/b.ts" })).kind).toBe("read");
    expect(
      classifyToolCall(call({ type: "search", query: "q", toolName: "web_search" })).kind,
    ).toBe("web");
    expect(
      classifyToolCall(call({ type: "unknown", input: {}, output: {} }, { name: "view_image" }))
        .kind,
    ).toBe("image");
    expect(
      classifyToolCall(
        call({ type: "unknown", input: {}, output: {} }, { name: "mcp__paseo__list_agents" }),
      ),
    ).toMatchObject({ kind: "tool", subject: "paseo.list_agents" });
  });

  it("marks failed calls", () => {
    expect(
      classifyToolCall(call({ type: "shell", command: "false" }, { status: "failed" })).failed,
    ).toBe(true);
  });
});

describe("renderActions", () => {
  it("groups consecutive actions of one kind, like the Codex app", () => {
    expect(
      renderActions([
        action("command", "npm test"),
        action("command", "npm run lint"),
        action("image"),
        action("command", "git diff"),
        action("edit", "/repo/src/a.ts"),
        action("edit", "/repo/src/a.ts"),
      ]),
    ).toEqual(["💻 Ran 2 commands", "🖼 Viewed an image", "💻 Ran git diff", "✏️ Edited a.ts"]);
  });

  it("collapses many groups into one summary line", () => {
    const actions = [
      action("edit", "a.ts"),
      action("command", "x"),
      action("read", "b.ts"),
      action("command", "y", true),
      action("image"),
      action("command", "z"),
    ];
    expect(renderActions(actions, 3)).toEqual([
      "✏️ Edited a file, ran 3 commands, read a file, viewed an image (1 failed)",
    ]);
  });

  it("reports failures", () => {
    expect(renderActions([action("command", "make", true)])).toEqual(["💻 Ran make — failed"]);
  });
});

describe("fileChange", () => {
  it("counts lines in a unified diff", () => {
    const diff = "--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d";
    expect(fileChange(call({ type: "edit", filePath: "x", unifiedDiff: diff }))).toEqual({
      path: "x",
      added: 2,
      removed: 1,
    });
  });

  it("diffs old and new strings by line", () => {
    expect(
      fileChange(
        call({ type: "edit", filePath: "x", oldString: "a\nb\nc", newString: "a\nB\nB2\nc" }),
      ),
    ).toEqual({ path: "x", added: 2, removed: 1 });
    expect(
      fileChange(call({ type: "edit", filePath: "x", oldString: "", newString: "a\nb" })),
    ).toEqual({ path: "x", added: 2, removed: 0 });
  });

  it("counts written files and ignores failed edits", () => {
    expect(fileChange(call({ type: "write", filePath: "n", content: "1\n2\n3\n" }))).toEqual({
      path: "n",
      added: 3,
      removed: 0,
    });
    expect(
      fileChange(call({ type: "write", filePath: "n", content: "1" }, { status: "failed" })),
    ).toBeNull();
  });
});
