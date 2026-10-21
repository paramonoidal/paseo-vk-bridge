import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import {
  AnswerError,
  allowResponse,
  answerPermission,
  denyResponse,
  describePermission,
} from "./permissions.js";

const question: AgentPermissionRequest = {
  id: "q1",
  provider: "claude",
  name: "AskUserQuestion",
  kind: "question",
  input: {
    questions: [
      {
        question: "Which channel?",
        header: "Channel",
        multiSelect: false,
        options: [{ label: "CAN 1", description: "left" }, { label: "CAN 2" }],
      },
    ],
  },
};

const twoQuestions: AgentPermissionRequest = {
  ...question,
  input: {
    questions: [
      {
        question: "Which?",
        header: "Which",
        multiSelect: true,
        options: [{ label: "A" }, { label: "B" }, { label: "C" }],
      },
      { question: "Why?", header: "Why", multiSelect: false, options: [] },
    ],
  },
};

const tool: AgentPermissionRequest = {
  id: "t1",
  provider: "codex",
  name: "shell",
  kind: "tool",
  title: "Run a command",
  detail: { type: "shell", command: "bash -lc 'rm -rf build'" },
};

describe("describePermission", () => {
  it("numbers question options and offers them as buttons", () => {
    const prompt = describePermission(question);
    expect(prompt.text).toContain("❓ Which channel?\n1. CAN 1 — left\n2. CAN 2");
    expect(prompt.buttons).toEqual(["1. CAN 1", "2. CAN 2"]);
  });

  it("shows the command of a tool approval", () => {
    const prompt = describePermission(tool);
    expect(prompt.text).toContain("🔐 Run a command\n$ rm -rf build");
    expect(prompt.buttons).toEqual(["1. Allow", "2. Deny"]);
  });
});

describe("answerPermission", () => {
  it("reads an option number, a pressed button, or free text", () => {
    expect(answerPermission(question, "2")).toEqual({
      behavior: "allow",
      updatedInput: { ...question.input, answers: { Channel: "CAN 2" } },
    });
    expect(answerPermission(question, "1. CAN 1")).toMatchObject({
      updatedInput: { answers: { Channel: "CAN 1" } },
    });
    expect(answerPermission(question, "both, actually")).toMatchObject({
      updatedInput: { answers: { Channel: "both, actually" } },
    });
  });

  it("answers several questions line by line, with multi-select numbers", () => {
    expect(answerPermission(twoQuestions, "1, 3\nbecause")).toMatchObject({
      updatedInput: { answers: { Which: "A, C", Why: "because" } },
    });
    expect(() => answerPermission(twoQuestions, "1")).toThrow(AnswerError);
  });

  it("treats free text on an approval as a denial with instructions", () => {
    expect(answerPermission(tool, "1")).toEqual({ behavior: "allow" });
    expect(answerPermission(tool, "2")).toMatchObject({ behavior: "deny" });
    expect(answerPermission(tool, "keep the build dir")).toEqual({
      behavior: "deny",
      message: "keep the build dir",
    });
  });

  it("uses the request's own actions", () => {
    const plan: AgentPermissionRequest = {
      ...tool,
      kind: "plan",
      actions: [
        { id: "implement", label: "Implement", behavior: "allow" },
        { id: "keep", label: "Keep planning", behavior: "deny" },
      ],
    };
    expect(answerPermission(plan, "1")).toEqual({
      behavior: "allow",
      selectedActionId: "implement",
    });
    expect(allowResponse(plan)).toEqual({ behavior: "allow", selectedActionId: "implement" });
    expect(denyResponse("")).toEqual({ behavior: "deny", message: "Denied by user" });
  });
});
