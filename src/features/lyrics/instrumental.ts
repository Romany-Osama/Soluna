import type { LyricLine } from "../../types";

/**
 * The music-only part the playhead is inside right now, with bounds taken
 * from the lyrics payload itself — never from a fixed timer.
 *
 * Bounds come from, in order of trust:
 * - the `instrumental` flag (whole track, LrcLib): 0 to the track duration;
 * - a sung line's last word `endMs` (word-timed providers): the moment the
 *   vocals actually stop, so a gap/outro starts there, not at a guess;
 * - the next sung line's start (first word, or the line time): the moment
 *   the vocals resume, so the ring completes exactly when the music part
 *   ends;
 * - a provider's own marker line ("[Instrumental]", "♪"): the span it
 *   labels, used when the surrounding lines carry no word timings.
 *
 * A gap/outro with no word timings and no marker line is NOT reported:
 * without a sung end the start would be a guess (the previous line's
 * start), and the ring would fill while the line is still being sung.
 */
export type InstrumentalSection = {
  kind: "whole-track" | "intro" | "gap" | "outro" | "marker";
  startMs: number;
  /** Null when the end is unknowable (whole track with no duration). */
  endMs: number | null;
  label: string;
};

/** An intro shorter than this is a pickup, not a music-only part. */
export const MIN_INTRO_MS = 2000;
/** A mid-song gap / outro shorter than this is a breath between lines. */
export const MIN_GAP_MS = 5000;
/** A provider marker line shorter than this is a label, not a section. */
export const MIN_MARKER_MS = 2000;

const MARKER_WORDS = ["instrumental", "music", "interlude", "intro", "outro"];

/** True when a lyric line is a provider's instrumental marker, not a sung line. */
export function isInstrumentalMarkerLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Only music-note symbols (e.g. "♪ ♫") — no words at all.
  if (/^[♪♫♩𝄞\s]+$/u.test(trimmed)) return true;
  // A marker word, optionally bracketed and wrapped in note symbols.
  const bare = trimmed
    .replace(/^[♪♫♩\s]+|[♪♫♩\s]+$/g, "")
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/^\(/, "")
    .replace(/\)$/, "")
    .trim()
    .toLowerCase();
  return MARKER_WORDS.includes(bare);
}

/** First word start of a line, or the line time when it has no word timings. */
function lineStartMs(line: LyricLine): number {
  return line.words?.[0]?.timeMs ?? line.timeMs;
}

/** Last word end of a line, or null when the line has no word timings. */
function sungEndMs(line: LyricLine): number | null {
  const words = line.words;
  if (!words || words.length === 0) return null;
  return words[words.length - 1].endMs;
}

export type FindInstrumentalSectionArgs = {
  lines: LyricLine[];
  /** Playhead in milliseconds. */
  playbackMs: number;
  /** Track duration in milliseconds; 0 or negative when unknown. */
  durationMs: number;
  /** The payload's `instrumental` flag: the whole track has no vocals. */
  instrumental: boolean;
};

/**
 * The instrumental section containing the playhead, or null when the
 * playhead is inside a sung part (or no section can be bounded from the
 * payload). The caller renders the wavy circle only when this returns a
 * section.
 */
export function findInstrumentalSection({
  lines,
  playbackMs,
  durationMs,
  instrumental,
}: FindInstrumentalSectionArgs): InstrumentalSection | null {
  const duration = durationMs > 0 ? durationMs : null;
  if (instrumental) {
    return {
      kind: "whole-track",
      startMs: 0,
      endMs: duration,
      label: "Instrumental",
    };
  }
  if (lines.length === 0) return null;

  const sungLines = lines.filter((line) => !isInstrumentalMarkerLine(line.text));
  if (sungLines.length === 0) {
    // Every line is a marker: fall through to the marker loop below, which
    // bounds the section by the marker's own span.
    return findMarkerSection(lines, playbackMs, duration);
  }

  // Intro: before the first sung line.
  const firstStart = lineStartMs(sungLines[0]);
  if (playbackMs < firstStart && firstStart >= MIN_INTRO_MS) {
    return { kind: "intro", startMs: 0, endMs: firstStart, label: "Intro" };
  }

  // Gap between two sung lines: starts when the earlier line's last word
  // ends, completes exactly when the next sung line starts.
  for (let i = 0; i < sungLines.length - 1; i++) {
    const start = sungEndMs(sungLines[i]);
    const end = lineStartMs(sungLines[i + 1]);
    if (start === null) continue;
    if (end - start < MIN_GAP_MS) continue;
    if (playbackMs >= start && playbackMs < end) {
      return { kind: "gap", startMs: start, endMs: end, label: "Instrumental break" };
    }
  }

  // Outro: after the last sung line ends, to the end of the track.
  const lastEnd = sungEndMs(sungLines[sungLines.length - 1]);
  if (lastEnd !== null && duration !== null) {
    if (duration - lastEnd >= MIN_GAP_MS && playbackMs >= lastEnd && playbackMs < duration) {
      return { kind: "outro", startMs: lastEnd, endMs: duration, label: "Outro" };
    }
  }

  // Marker line: the span the provider labelled, when no word-timed gap
  // covers the playhead. Its end is the next line's start (any line,
  // marker or sung) or the track duration.
  return findMarkerSection(lines, playbackMs, duration);
}

/** The marker-line span containing the playhead, or null. */
function findMarkerSection(
  lines: LyricLine[],
  playbackMs: number,
  duration: number | null,
): InstrumentalSection | null {
  for (let i = 0; i < lines.length; i++) {
    if (!isInstrumentalMarkerLine(lines[i].text)) continue;
    const start = lines[i].timeMs;
    const end = i + 1 < lines.length ? lines[i + 1].timeMs : duration;
    if (end === null) continue;
    if (end - start < MIN_MARKER_MS) continue;
    if (playbackMs >= start && playbackMs < end) {
      return { kind: "marker", startMs: start, endMs: end, label: "Instrumental break" };
    }
  }
  return null;
}

/**
 * How far through the section the playhead is, 0 to 1 — 1 exactly at the
 * section's end, when the vocals resume (or the track ends). Null when the
 * section has no known end: the ring still shows, but cannot claim a
 * fraction it does not know.
 */
export function instrumentalProgress(section: InstrumentalSection | null, playbackMs: number): number | null {
  if (!section || section.endMs === null || section.endMs <= section.startMs) return null;
  return Math.min(1, Math.max(0, (playbackMs - section.startMs) / (section.endMs - section.startMs)));
}

/** Remaining time in a section, as "m:ss". */
export function formatRemainingMs(ms: number): string {
  // The epsilon keeps floating-point dust (e.g. 3000.0000000000005ms from
  // (1 - 0.85) * 20000) from rounding a whole second up.
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000 - 1e-9));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}
