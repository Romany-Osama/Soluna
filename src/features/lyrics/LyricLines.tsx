import { Fragment, RefObject } from "react";
import type { LyricLine } from "../../types";
import { InstrumentalInterlude } from "./InstrumentalInterlude";
import { findInstrumentalSection } from "./instrumental";

export type LyricLinesProps = {
  lines: LyricLine[];
  activeLyricIndex: number;
  activeLyricRef: RefObject<HTMLButtonElement | null>;
  audioRef: RefObject<HTMLAudioElement | null>;
  lyricsContainerRef: RefObject<HTMLDivElement | null>;
  playbackSeconds: number;
  /** Track duration in seconds; 0 when unknown (the outro/whole-track end). */
  durationSeconds: number;
  setLyricsAutoScrollEnabled: (value: boolean) => void;
};

/**
 * The synced-lyrics list, shared by the lyrics panel and the full player so
 * both stay identical. The music-only part the playhead is inside gets the
 * instrumental interlude — with the wavy circle that fills as the section
 * plays — in place of lyric lines: before the first line (intro), between
 * two lines (break), or after the last line (outro). Sections come from
 * the lyrics payload's own timings (see `findInstrumentalSection`); a gap
 * with no word timings and no marker line shows no interlude rather than
 * a guessed one.
 */
export function LyricLines({
  lines,
  activeLyricIndex,
  activeLyricRef,
  audioRef,
  lyricsContainerRef,
  playbackSeconds,
  durationSeconds,
  setLyricsAutoScrollEnabled,
}: LyricLinesProps) {
  const playbackMs = playbackSeconds * 1000;
  const section = findInstrumentalSection({
    lines,
    playbackMs,
    durationMs: durationSeconds * 1000,
    instrumental: false,
  });
  // The interlude sits before the line the section ends at (the next sung
  // line); an outro sits after the last line; an intro sits at the top.
  const interludeBeforeIndex =
    section && section.kind !== "intro" && section.kind !== "outro"
      ? lines.findIndex((line) => line.timeMs >= (section.endMs ?? Number.MAX_SAFE_INTEGER))
      : -1;
  return (
    <div
      ref={lyricsContainerRef}
      className="lyrics-lines"
      onWheel={() => setLyricsAutoScrollEnabled(false)}
      onTouchMove={() => setLyricsAutoScrollEnabled(false)}
      onPointerDown={() => setLyricsAutoScrollEnabled(false)}
      onKeyDown={() => setLyricsAutoScrollEnabled(false)}
    >
      {section && section.kind === "intro" && (
        <InstrumentalInterlude label={section.label} section={section} playbackMs={playbackMs} audioRef={audioRef} />
      )}
      {lines.map((line, index) => (
        <Fragment key={`${line.timeMs}-${index}`}>
          {index === interludeBeforeIndex && section && (
            <InstrumentalInterlude
              label={section.label}
              section={section}
              playbackMs={playbackMs}
              audioRef={audioRef}
            />
          )}
          <button
            ref={index === activeLyricIndex ? activeLyricRef : undefined}
            className={index === activeLyricIndex ? "lyric-line active" : "lyric-line"}
            onClick={() => {
              setLyricsAutoScrollEnabled(true);
              if (audioRef.current) audioRef.current.currentTime = line.timeMs / 1000;
            }}
          >
            {line.text}
          </button>
        </Fragment>
      ))}
      {section && section.kind === "outro" && (
        <InstrumentalInterlude label={section.label} section={section} playbackMs={playbackMs} audioRef={audioRef} />
      )}
    </div>
  );
}
