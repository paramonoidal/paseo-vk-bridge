import { describe, expect, it } from "vitest";
import { markdownToPlain, splitText } from "./text.js";

describe("splitText", () => {
  it("keeps short text whole and drops empty text", () => {
    expect(splitText("hello", 10)).toEqual(["hello"]);
    expect(splitText("", 10)).toEqual([]);
  });

  it("counts code points, never splitting an emoji", () => {
    const text = "😀".repeat(5);
    const parts = splitText(text, 2);
    expect(parts).toEqual(["😀😀", "😀😀", "😀"]);
  });

  it("prefers a paragraph break, then a line break, then a space", () => {
    expect(splitText("aaaa bbbb\n\ncccc dddd", 14)).toEqual(["aaaa bbbb", "cccc dddd"]);
    expect(splitText("aaaa bbbb\ncccc dddd", 14)).toEqual(["aaaa bbbb", "cccc dddd"]);
    expect(splitText("aaaa bbbb cccc", 11)).toEqual(["aaaa bbbb", "cccc"]);
  });

  it("cuts hard when there is no break in the second half of the window", () => {
    expect(splitText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
});

describe("markdownToPlain", () => {
  it("removes emphasis, headings and link syntax", () => {
    expect(markdownToPlain("## Result\n**Done**: see [docs](https://x.dev) and _this_.")).toBe(
      "Result\nDone: see docs (https://x.dev) and this.",
    );
  });

  it("keeps identifiers with underscores and asterisks in math", () => {
    expect(markdownToPlain("call my_func_name and 2 * 3 * 4")).toBe(
      "call my_func_name and 2 * 3 * 4",
    );
  });

  it("keeps code verbatim and drops fences and backticks", () => {
    expect(markdownToPlain("Run `npm **test**`:\n```bash\nnpm run *build*\n```\nok")).toBe(
      "Run npm **test**:\nnpm run *build*\nok",
    );
  });

  it("renders lists, task lists and rules", () => {
    expect(markdownToPlain("- one\n  * two\n- [x] done\n- [ ] todo\n---")).toBe(
      "• one\n  • two\n☑ done\n☐ todo\n———",
    );
  });

  it("drops table separator rows", () => {
    expect(markdownToPlain("| a | b |\n|---|:---:|\n| 1 | 2 |")).toBe("| a | b |\n| 1 | 2 |");
  });
});
