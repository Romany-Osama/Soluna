// The instrumental section comes from the lyrics payload's own timings —
// never from a fixed timer — and the ring completes exactly at its end.
import { describe, expect, it } from "vitest";
import {
  findInstrumentalSection,
  formatRemainingMs,
  instrumentalProgress,
  isInstrumentalMarkerLine,
} from "./instrumental";
import type { LyricLine } from "../../types";

const wordTimed: LyricLine[] = [
  {
    timeMs: 9730,
    text: "The club isn't",
    words: [
      { timeMs: 9730, endMs: 9930, text: "The" },
      { timeMs: 9930, endMs: 10280, text: "club" },
      { timeMs: 10280, endMs: 12105, text: "isn't" },
    ],
  },
  { timeMs: 30000, text: "So the bar is where I go", words: [] },
];

const plain: LyricLine[] = [
  { timeMs: 9730, text: "The club isn't" },
  { timeMs: 30000, text: "So the bar is where I go" },
];

function find(lines: LyricLine[], playbackMs: number, durationMs = 60000, instrumental = false) {
  return findInstrumentalSection({ lines, playbackMs, durationMs, instrumental });
}

describe("isInstrumentalMarkerLine", () => {
  it("recognises provider marker lines", () => {
    for (const text of [
      "[Instrumental]",
      "(Instrumental)",
      "Instrumental",
      "♪",
      "♫ ♪",
      "[Music]",
      "[Interlude]",
      "♪ Instrumental ♪",
    ]) {
      expect(isInstrumentalMarkerLine(text)).toBe(true);
    }
  });

  it("does not mistake sung lines for markers", () => {
    for (const text of ["The club isn't", "Instrumental love", "Music to my ears", ""]) {
      expect(isInstrumentalMarkerLine(text)).toBe(false);
    }
  });
});

describe("findInstrumentalSection", () => {
  it("reports the whole track when the payload is flagged instrumental", () => {
    const section = find([], 120000, 202000, true);
    expect(section).toEqual({ kind: "whole-track", startMs: 0, endMs: 202000, label: "Instrumental" });
  });

  it("reports a whole-track section with no end when the duration is unknown", () => {
    const section = find([], 5000, 0, true);
    expect(section?.kind).toBe("whole-track");
    expect(section?.endMs).toBeNull();
    expect(instrumentalProgress(section, 5000)).toBeNull();
  });

  it("reports the intro before the first line", () => {
    const section = find(wordTimed, 2000);
    expect(section).toEqual({ kind: "intro", startMs: 0, endMs: 9730, label: "Intro" });
  });

  it("does not report a sub-2s intro", () => {
    expect(find([{ timeMs: 1500, text: "Hey" }], 500)).toBeNull();
  });

  it("reports no section while a line is being sung", () => {
    expect(find(wordTimed, 10000)).toBeNull();
  });

  it("reports a word-timed gap from the last word's end to the next line", () => {
    const section = find(wordTimed, 20000);
    expect(section).toEqual({ kind: "gap", startMs: 12105, endMs: 30000, label: "Instrumental break" });
  });

  it("does not guess a gap when the lines carry no word timings", () => {
    // The previous line's sung end is unknown: starting the ring at its
    // start would fill it while the line is still being sung.
    expect(find(plain, 20000)).toBeNull();
  });

  it("reports a marker line's span when no word-timed gap covers the playhead", () => {
    const lines: LyricLine[] = [
      { timeMs: 9730, text: "The club isn't" },
      { timeMs: 20000, text: "[Instrumental]" },
      { timeMs: 40000, text: "So the bar is where I go" },
    ];
    const section = find(lines, 30000);
    expect(section).toEqual({ kind: "marker", startMs: 20000, endMs: 40000, label: "Instrumental break" });
  });

  it("reports the outro from the last word's end to the track end", () => {
    const section = find(wordTimed.slice(0, 1), 30000, 60000);
    expect(section).toEqual({ kind: "outro", startMs: 12105, endMs: 60000, label: "Outro" });
  });

  it("does not report an outro when the track duration is unknown", () => {
    expect(find(wordTimed.slice(0, 1), 30000, 0)).toBeNull();
  });

  it("ends the section exactly where the next line starts", () => {
    expect(find(wordTimed, 30000)).toBeNull();
    expect(find(wordTimed, 29999)?.kind).toBe("gap");
  });
});

describe("instrumentalProgress", () => {
  it("is 0 at the section start and 1 exactly at its end", () => {
    const section = find(wordTimed, 20000);
    expect(section).not.toBeNull();
    expect(instrumentalProgress(section, 12105)).toBe(0);
    expect(instrumentalProgress(section, 21052.5)).toBeCloseTo(0.5, 10);
    expect(instrumentalProgress(section, 30000)).toBe(1);
  });

  it("clamps outside the section", () => {
    const section = find(wordTimed, 20000);
    expect(instrumentalProgress(section, 0)).toBe(0);
    expect(instrumentalProgress(section, 99999)).toBe(1);
  });
});

describe("formatRemainingMs", () => {
  it("does not let floating-point dust round a whole second up", () => {
    // (1 - 0.85) * 20000 is 3000.0000000000005 in floating point.
    expect(formatRemainingMs((1 - 0.85) * 20000)).toBe("0:03");
    expect(formatRemainingMs(17000)).toBe("0:17");
    expect(formatRemainingMs(0)).toBe("0:00");
  });
});
