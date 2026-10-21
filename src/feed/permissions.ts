import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";
import { markdownToPlain } from "../vk/text.js";
import { commandTitle } from "./actions.js";

export interface Question {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export interface Choice {
  label: string;
  response: AgentPermissionResponse;
}

export interface PermissionPrompt {
  text: string;
  /** Inline buttons. Each sends its numbered label back, which `answerPermission` reads. */
  buttons: string[];
}

/** Mirrors the app's question form parsing (`question-form-card-core.ts`). */
export function parseQuestions(input: unknown): Question[] | null {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return null;
  const questions: Question[] = [];
  for (const item of raw) {
    const q = item as Record<string, unknown> | null;
    if (!q || typeof q.question !== "string" || typeof q.header !== "string") return null;
    if (!Array.isArray(q.options)) return null;
    const options: Question["options"] = [];
    for (const option of q.options as Array<Record<string, unknown> | null>) {
      if (!option || typeof option.label !== "string") return null;
      options.push({
        label: option.label,
        ...(typeof option.description === "string" ? { description: option.description } : {}),
      });
    }
    questions.push({
      question: q.question,
      header: q.header,
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  return questions.length > 0 ? questions : null;
}

/** Numbered choices for a non-question request: its own actions, or allow and deny. */
export function permissionChoices(request: AgentPermissionRequest): Choice[] {
  if (request.actions && request.actions.length > 0) {
    return request.actions.map((action) => ({
      label: action.label,
      response:
        action.behavior === "allow"
          ? { behavior: "allow", selectedActionId: action.id }
          : { behavior: "deny", selectedActionId: action.id, message: "Declined by user" },
    }));
  }
  return [
    { label: "Allow", response: { behavior: "allow" } },
    { label: "Deny", response: { behavior: "deny", message: "Denied by user" } },
  ];
}

export function describePermission(request: AgentPermissionRequest): PermissionPrompt {
  const questions = request.kind === "question" ? parseQuestions(request.input) : null;
  if (questions) {
    const blocks = questions.map((question, index) => {
      const heading = questions.length > 1 ? `${index + 1}) ` : "";
      const options = question.options.map(
        (option, optionIndex) =>
          `${optionIndex + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
      );
      return [`❓ ${heading}${question.question}`, ...options].join("\n");
    });
    const hint =
      questions.length > 1
        ? "Answer each question on its own line: an option number or your own text."
        : questions[0]?.multiSelect
          ? "Reply with option numbers, like 1,3, or your own text."
          : "Reply with an option number or your own text.";
    const single = questions.length === 1 ? questions[0] : undefined;
    return {
      text: `${blocks.join("\n\n")}\n\n${hint} /deny dismisses.`,
      buttons:
        single && !single.multiSelect
          ? single.options.map((option, index) => `${index + 1}. ${option.label}`)
          : [],
    };
  }

  const choices = permissionChoices(request);
  const lines = [`🔐 ${request.title ?? request.name}`];
  if (request.description) lines.push(request.description);
  const detail = request.detail;
  if (detail?.type === "shell") lines.push(`$ ${commandTitle(detail.command)}`);
  else if (detail?.type === "plan") lines.push("", markdownToPlain(detail.text));
  else if (detail && "filePath" in detail) lines.push(detail.filePath);
  const plan = (request.input as { plan?: unknown } | undefined)?.plan;
  if (detail?.type !== "plan" && typeof plan === "string") lines.push("", markdownToPlain(plan));
  lines.push("", "Reply with a number, /allow, or /deny with a reason.");
  return {
    text: lines.join("\n"),
    buttons: choices.map((choice, index) => `${index + 1}. ${choice.label}`),
  };
}

export class AnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerError";
  }
}

/** Reads "2", "2. Label" or "1,3" as option numbers within `count`. */
function optionNumbers(text: string, count: number, multiple: boolean): number[] | null {
  const labelled = /^(\d+)\.\s/.exec(text);
  const candidate = labelled ? (labelled[1] ?? "") : text;
  if (!/^\d+(\s*[, ]\s*\d+)*$/.test(candidate)) return null;
  const numbers = candidate.split(/[\s,]+/).map(Number);
  if (!multiple && numbers.length > 1) return null;
  return numbers.every((number) => number >= 1 && number <= count) ? numbers : null;
}

/**
 * Turns a chat reply into a permission response. A question takes option numbers or
 * free text; any other request takes a choice number, or free text as a denial
 * that tells the agent what to do instead.
 */
export function answerPermission(
  request: AgentPermissionRequest,
  reply: string,
): AgentPermissionResponse {
  const text = reply.trim();
  const questions = request.kind === "question" ? parseQuestions(request.input) : null;
  if (questions) {
    const lines = questions.length === 1 ? [text] : text.split("\n").map((line) => line.trim());
    if (lines.length < questions.length || lines.some((line) => line.length === 0)) {
      throw new AnswerError(`Answer all ${questions.length} questions, one per line.`);
    }
    const answers: Record<string, string> = {};
    questions.forEach((question, index) => {
      const line = lines[index] ?? "";
      const numbers = optionNumbers(line, question.options.length, question.multiSelect);
      answers[question.header] = numbers
        ? numbers.map((number) => question.options[number - 1]?.label ?? "").join(", ")
        : line;
    });
    return { behavior: "allow", updatedInput: { ...(request.input ?? {}), answers } };
  }

  const choices = permissionChoices(request);
  const numbers = optionNumbers(text, choices.length, false);
  const chosen = numbers ? choices[(numbers[0] ?? 1) - 1] : undefined;
  if (chosen) return chosen.response;
  return { behavior: "deny", message: text };
}

/** `/allow [n]` picks an allowing choice; `/deny [reason]` declines or dismisses. */
export function allowResponse(request: AgentPermissionRequest, choice?: number) {
  const choices = permissionChoices(request).filter((c) => c.response.behavior === "allow");
  const chosen = choice === undefined ? choices[0] : permissionChoices(request)[choice - 1];
  if (!chosen) throw new AnswerError("There is no such choice.");
  return chosen.response;
}

export function denyResponse(reason: string | undefined): AgentPermissionResponse {
  return { behavior: "deny", message: reason?.trim() || "Denied by user" };
}
