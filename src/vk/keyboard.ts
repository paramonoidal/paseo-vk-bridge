// https://dev.vk.com/ru/api/bots/development/keyboard
const MAX_LABEL = 40;
const MAX_INLINE_BUTTONS = 10;

type Color = "primary" | "secondary" | "negative" | "positive";

function button(label: string, color: Color = "secondary") {
  return { action: { type: "text", label: truncateLabel(label) }, color };
}

export function truncateLabel(label: string): string {
  const chars = Array.from(label);
  return chars.length <= MAX_LABEL ? label : `${chars.slice(0, MAX_LABEL - 1).join("")}…`;
}

/** Persistent keyboard with the commands used most from a phone. */
export function commandKeyboard(): string {
  return JSON.stringify({
    one_time: false,
    inline: false,
    buttons: [
      [button("/stop", "negative"), button("/status"), button("/agents")],
      [button("/new", "primary"), button("/nodes"), button("/help")],
    ],
  });
}

/** Inline buttons under a message. Pressing one sends its label as a message. */
export function choiceKeyboard(choices: ReadonlyArray<{ label: string; color?: Color }>): string {
  return JSON.stringify({
    inline: true,
    buttons: choices
      .slice(0, MAX_INLINE_BUTTONS)
      .map((choice) => [button(choice.label, choice.color ?? "secondary")]),
  });
}
