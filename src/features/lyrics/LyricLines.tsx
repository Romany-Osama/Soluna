import { RefObject } from "react";
import type { LyricLine } from "../../types";
import { InstrumentalInterlude } from "./InstrumentalInterlude";

export type LyricLinesProps = {
  lines: LyricLine[];
  activeLyricIndex: number;
  activeWordIndex: number;
  activeLyricRef: RefObject<HTMLButtonElement | null>;
  audioRef: RefObject<HTMLAudioElement | null>;
  lyricsContainerRef: RefObject<HTMLDivElement | null>;
  playbackSeconds: number;
  setLyricsAutoScrollEnabled: (value: boolean) => void;
};

/**
 * The synced-lyrics list, shared by the lyrics panel and the full player so
 * both stay identical. The active line highlights word by word when the
 * provider sent word timings (Apple TTML via BetterLyrics/Paxsenix); lines
 * without word timings highlight as a whole, as before. Before the first
 * line starts, the intro gets the small instrumental animation instead of
 * an empty list.
 */
export function LyricLines({
  lines,
  activeLyricIndex,
  activeWordIndex,
  activeLyricRef,
  audioRef,
  lyricsContainerRef,
  playbackSeconds,
  setLyricsAutoScrollEnabled,
}: LyricLinesProps) {
  const showIntro = lines.length > 0 && playbackSeconds * 1000 < lines[0].timeMs;
  return (
    <div
      ref={lyricsContainerRef}
      className="lyrics-lines"
      onWheel={() => setLyricsAutoScrollEnabled(false)}
      onTouchMove={() => setLyricsAutoScrollEnabled(false)}
      onPointerDown={() => setLyricsAutoScrollEnabled(false)}
      onKeyDown={() => setLyricsAutoScrollEnabled(false)}
    >
      {showIntro && <InstrumentalInterlude label="Intro" />}
      {lines.map((line, index) => {
        const isActive = index === activeLyricIndex;
        const words = line.words ?? [];
        return (
          <button
            ref={isActive ? activeLyricRef : undefined}
            key={`${line.timeMs}-${index}`}
            className={isActive ? "lyric-line active" : "lyric-line"}
            onClick={() => {
              setLyricsAutoScrollEnabled(true);
              if (audioRef.current) audioRef.current.currentTime = line.timeMs / 1000;
            }}
          >
            {isActive && words.length > 0 ? (
              <span className="lyric-words">
                {words.map((word, wordIndex) => (
                  <span key={`${word.timeMs}-${wordIndex}`}>
                    {wordIndex > 0 ? " " : null}
                    <span
                      className={
                        wordIndex < activeWordIndex
                          ? "lyric-word sung"
                          : wordIndex === activeWordIndex
                            ? "lyric-word sung current"
                            : "lyric-word"
                      }
                    >
                      {word.text}
                    </span>
                  </span>
                ))}
              </span>
            ) : (
              line.text
            )}
          </button>
        );
      })}
    </div>
  );
}
