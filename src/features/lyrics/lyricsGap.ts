// Gap math for Meld's IntervalIndicator, reimplemented for the DOM (pure,
// no React): a wavy circular progress ring for the silence between two
// lyric lines.
//
// Meld inserts the indicator after a line when the gap to the next line is
// > 4000ms and shows it only while the playhead is inside
// [gapStart, gapEnd - 650ms]; progress is the playhead's position through
// the gap, clamped 0-1. The ring is a smooth circle with a gentle ripple
// (Meld's CircularWavyProgressIndicator default amplitude is ~5.5% of the
// radius), drawn as a computed sine path r(θ) = 30 + 2·sin(10θ): 10 whole
// waves so the track is seamless at the join, 6px stroke, 80×80 element.
import type { LyricLine } from "../../types";

export const GAP_RING_MIN_GAP_MS = 4000;
export const GAP_RING_TAIL_MS = 650;
export const GAP_RING_RADIUS = 30;
export const GAP_RING_WAVES = 10;
export const GAP_RING_AMPLITUDE = 2;
export const GAP_RING_STROKE = 6;
export const GAP_RING_SIZE = 80;
export const GAP_RING_CENTRE = 41; // viewBox "-5 -5 82 82"

export type LyricsGap = {
  /** Index of the line the gap follows. */
  index: number;
  gapStartMs: number;
  gapEndMs: number;
  /** Playhead position through the gap, 0-1. */
  progress: number;
};

/**
 * The silence after one line, if it qualifies for the ring. The gap ends at
 * the next line's start; it starts at the current line's end — the last
 * word's end when the provider sent word timings. LyricLine has no end
 * time, so for a line without word timings the gap starts at the line's
 * own start (a Soluna adaptation: Meld emits no indicator at all for
 * wordless lines, which would hide the ring from the common line-only
 * payloads entirely).
 */
export function findLyricsGap(lines: LyricLine[], positionMs: number): LyricsGap | null {
  for (let i = 0; i < lines.length - 1; i++) {
    const words = lines[i].words ?? [];
    const gapStartMs = words.length > 0 ? words[words.length - 1].endMs : lines[i].timeMs;
    const gapEndMs = lines[i + 1].timeMs;
    if (gapEndMs - gapStartMs <= GAP_RING_MIN_GAP_MS) continue;
    if (positionMs < gapStartMs || positionMs > gapEndMs - GAP_RING_TAIL_MS) continue;
    return {
      index: i,
      gapStartMs,
      gapEndMs,
      progress: Math.min(1, Math.max(0, (positionMs - gapStartMs) / (gapEndMs - gapStartMs))),
    };
  }
  return null;
}

/**
 * The wavy circle path: θ runs from 12 o'clock clockwise, r(θ) =
 * R + A·sin(n·θ), sampled at one point per degree. progress is the fraction
 * of the circle to draw, 0-1; progress 1 closes the full circle.
 */
export function wavyCirclePath(progress: number): string {
  const fraction = Math.min(1, Math.max(0, progress));
  if (fraction === 0) return "M41.00 11.00";
  const steps = Math.max(8, Math.ceil(fraction * 360));
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const theta = (2 * Math.PI * fraction * i) / steps;
    const angle = theta - Math.PI / 2;
    const r = GAP_RING_RADIUS + GAP_RING_AMPLITUDE * Math.sin(GAP_RING_WAVES * theta);
    const x = GAP_RING_CENTRE + r * Math.cos(angle);
    const y = GAP_RING_CENTRE + r * Math.sin(angle);
    d += (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2);
  }
  return fraction >= 1 ? d + "Z" : d;
}
