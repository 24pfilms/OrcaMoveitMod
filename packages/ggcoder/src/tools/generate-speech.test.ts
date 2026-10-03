import { describe, expect, it } from "vitest";
import { estimateWordTimings, wordsFromCharacterTimings } from "./generate-speech.js";

describe("generate_speech captions", () => {
  it("groups character timings into words", () => {
    const chars = [..."Hi there"];
    const starts = chars.map((_, i) => i * 0.1);
    const ends = chars.map((_, i) => i * 0.1 + 0.08);
    expect(wordsFromCharacterTimings(chars, starts, ends)).toEqual([
      { text: "Hi", start: 0, end: 0.18 },
      { text: "there", start: 0.3, end: 0.78 },
    ]);
  });

  it("spreads estimated timings across the whole duration in order", () => {
    const words = estimateWordTimings("Fresh bread, every morning.", 2);
    expect(words.map((w) => w.text)).toEqual(["Fresh", "bread,", "every", "morning."]);
    expect(words[0]!.start).toBe(0);
    for (let i = 1; i < words.length; i++)
      expect(words[i]!.start).toBeGreaterThanOrEqual(words[i - 1]!.end);
    expect(words.at(-1)!.end).toBeLessThanOrEqual(2);
  });

  it("returns nothing without text or duration", () => {
    expect(estimateWordTimings("", 2)).toEqual([]);
    expect(estimateWordTimings("hello", 0)).toEqual([]);
  });
});
