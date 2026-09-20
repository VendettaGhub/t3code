import { describe, expect, it } from "@effect/vitest";

import { parseSideQuestionCommand } from "./sidechatCommand";

describe("mobile side-question command", () => {
  it.each([
    ["/btw", null],
    ["  /BTW   ", null],
  ])("opens an empty side question for %s", (input, question) => {
    expect(parseSideQuestionCommand(input)).toEqual({ question });
  });

  it("keeps the rest of a typed command as the child question", () => {
    expect(parseSideQuestionCommand("/btw explain this error")).toEqual({
      question: "explain this error",
    });
  });

  it.each(["please /btw", "/btwfoo", "```\n/btw\n```"]) (
    "leaves non-command content for the main provider: %s",
    (input) => {
      expect(parseSideQuestionCommand(input)).toBeNull();
    },
  );
});
