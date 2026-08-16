import { describe, expect, it } from "vitest";
import { orText } from "../src/lib/ava_reason/types";

describe("OpenAI-compatible content extraction", () => {
  it("reads the traditional string content shape", () => {
    expect(orText({ choices: [{ message: { content: "  hello  " } }] })).toBe("hello");
  });

  it("joins typed content parts instead of treating a healthy reply as empty", () => {
    expect(orText({ choices: [{ message: { content: [
      { type: "text", text: '{"action":"discuss",' },
      { type: "text", text: '"reply":"hello"}' },
    ] } }] })).toBe('{"action":"discuss","reply":"hello"}');
  });
});
