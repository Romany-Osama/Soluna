// @vitest-environment jsdom
// Gap ring (Meld's IntervalIndicator, reimplemented for the DOM): a wavy
// circular progress ring in the silence between two lyric lines. The gap
// math is pure, so it is tested here without layout; the ring itself is
// also proven by the mocked-render probe.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  GAP_RING_AMPLITUDE,
  GAP_RING_MIN_GAP_MS,
  GAP_RING_STROKE,
  GAP_RING_TAIL_MS,
  GAP_RING_WAVES,
  findLyricsGap,
  wavyCirclePath,
} from "./lyricsGap";
import { GapRing } from "./GapRing";
import type { LyricLine } from "../../types";

function line(timeMs: number, wordEnds: number[]): LyricLine {
  return {
    timeMs,
    text: `line at ${timeMs}`,
    words: wordEnds.map((endMs, i) => ({ timeMs: endMs - 500, endMs, text: `w${i}` })),
  };
}

// The mock's Viva La Vida lines: a 10s gap (12s -> 22s) after line 2, whose
// last word ends at 12000ms.
const gapLines: LyricLine[] = [
  line(0, [3600]),
  line(4000, [8500]),
  line(8000, [12000]),
  line(22000, [26000]),
  line(26000, [29500]),
  line(29000, [31800]),
];

describe("findLyricsGap", () => {
  it("finds the gap after the last sung line, with Meld's window", () => {
    const gap = findLyricsGap(gapLines, 17000);
    expect(gap).not.toBeNull();
    expect(gap?.index).toBe(2);
    // Gap start is the last word's end (12000), not the line start (8000):
    // the ring fills through the silence, not while the line is sung.
    expect(gap?.gapStartMs).toBe(12000);
    expect(gap?.gapEndMs).toBe(22000);
    expect(gap?.progress).toBeCloseTo(0.5);
  });

  it("returns null before the gap starts", () => {
    expect(findLyricsGap(gapLines, 10000)).toBeNull();
    expect(findLyricsGap(gapLines, 11999)).toBeNull();
  });

  it("returns the gap at its start, at 0% fill", () => {
    const gap = findLyricsGap(gapLines, 12000);
    expect(gap).not.toBeNull();
    expect(gap?.progress).toBe(0);
  });

  it("keeps the gap until gapEnd - 650ms, then hides it", () => {
    expect(findLyricsGap(gapLines, 22000 - GAP_RING_TAIL_MS)).not.toBeNull();
    expect(findLyricsGap(gapLines, 22000 - GAP_RING_TAIL_MS + 1)).toBeNull();
    expect(findLyricsGap(gapLines, 22000)).toBeNull();
  });

  it("returns null when the gap is 4000ms or less", () => {
    const short: LyricLine[] = [
      { timeMs: 9730, text: "a", words: [] },
      { timeMs: 12105, text: "b", words: [] },
    ];
    expect(findLyricsGap(short, 11000)).toBeNull();
    // Exactly 4000ms is not a gap: Meld requires gap > 4000.
    const exact: LyricLine[] = [
      { timeMs: 0, text: "a", words: [] },
      { timeMs: GAP_RING_MIN_GAP_MS, text: "b", words: [] },
    ];
    expect(findLyricsGap(exact, 2000)).toBeNull();
  });

  it("finds a 4001ms gap", () => {
    const justOver: LyricLine[] = [
      { timeMs: 0, text: "a", words: [] },
      { timeMs: GAP_RING_MIN_GAP_MS + 1, text: "b", words: [] },
    ];
    const gap = findLyricsGap(justOver, 2000);
    expect(gap).not.toBeNull();
    expect(gap?.gapStartMs).toBe(0);
    expect(gap?.gapEndMs).toBe(GAP_RING_MIN_GAP_MS + 1);
  });

  it("falls back to the line start when a line has no word timings", () => {
    // LyricLine has no end time; without words the only honest start of
    // the silence is the line's own start (a Soluna adaptation — Meld
    // emits no indicator at all for wordless lines).
    const wordless: LyricLine[] = [
      { timeMs: 8000, text: "a" },
      { timeMs: 22000, text: "b" },
    ];
    const gap = findLyricsGap(wordless, 15000);
    expect(gap).not.toBeNull();
    expect(gap?.gapStartMs).toBe(8000);
    expect(gap?.gapEndMs).toBe(22000);
    expect(gap?.progress).toBeCloseTo(0.5);
  });

  it("returns null after the last line", () => {
    expect(findLyricsGap(gapLines, 30000)).toBeNull();
  });

  it("returns the gap that contains the position when there are several", () => {
    const two: LyricLine[] = [line(0, [1000]), line(8000, [9000]), line(20000, [21000]), line(30000, [31000])];
    // Gap 1: 1000 -> 8000. Gap 2: 9000 -> 20000. Gap 3: 21000 -> 30000.
    expect(findLyricsGap(two, 5000)?.index).toBe(0);
    expect(findLyricsGap(two, 15000)?.index).toBe(1);
    expect(findLyricsGap(two, 25000)?.index).toBe(2);
  });
});

describe("wavyCirclePath", () => {
  it("starts at 12 o'clock with no progress", () => {
    expect(wavyCirclePath(0)).toBe("M41.00 11.00");
  });

  it("ends at the bottom of the circle at 50%", () => {
    const d = wavyCirclePath(0.5);
    const last = d.split("L").pop()!;
    const [x, y] = last.split(" ").map(Number);
    expect(x).toBeCloseTo(41);
    expect(y).toBeCloseTo(71);
  });

  it("closes seamlessly at 100%: first point equals last point", () => {
    const d = wavyCirclePath(1);
    expect(d.endsWith("Z")).toBe(true);
    const points = d.slice(0, -1).split(/[ML]/).filter(Boolean);
    expect(points.length).toBe(361);
    expect(points[0]).toBe(points[points.length - 1]);
  });

  it("keeps every point on the ripple radius, 30px +/- 2px", () => {
    for (const progress of [0.25, 0.5, 0.75, 1]) {
      const d = wavyCirclePath(progress);
      const points = d.replace(/Z$/, "").split(/[ML]/).filter(Boolean);
      for (const point of points) {
        const [x, y] = point.split(" ").map(Number);
        const r = Math.hypot(x - 41, y - 41);
        expect(r).toBeGreaterThanOrEqual(27.99);
        expect(r).toBeLessThanOrEqual(32.01);
      }
    }
  });

  it("clamps progress to 0..1", () => {
    expect(wavyCirclePath(-1)).toBe(wavyCirclePath(0));
    expect(wavyCirclePath(2)).toBe(wavyCirclePath(1));
  });
});

describe("GapRing", () => {
  it("renders the track and the progress arc with the mock's values", () => {
    render(<GapRing progress={0.5} />);
    const ring = screen.getByRole("status");
    expect(ring.classList.contains("lyrics-gap-row")).toBe(true);
    expect(ring.getAttribute("aria-label")).toBe("Music continues");
    const svg = ring.querySelector(".gap-ring");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("data-fill")).toBe("0.50");
    expect(svg?.getAttribute("data-waves")).toBe(String(GAP_RING_WAVES));
    expect(svg?.getAttribute("data-amplitude")).toBe(String(GAP_RING_AMPLITUDE));
    expect(svg?.getAttribute("data-stroke")).toBe(String(GAP_RING_STROKE));
    expect(ring.querySelector(".gap-ring-track")).not.toBeNull();
    expect(ring.querySelector(".gap-ring-progress")).not.toBeNull();
  });
});
