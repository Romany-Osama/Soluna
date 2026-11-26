import { Fragment, RefObject, useEffect, useState } from "react";
import type { LyricLine } from "../../types";
import { GapRing } from "./GapRing";
import { findLyricsGap } from "./lyricsGap";
import { InstrumentalInterlude } from "./InstrumentalInterlude";

// Meld's LYRICS_PREVIEW_TIME: follow resumes 8s after the last manual
// scroll input, so the lyrics jump back in sync on their own.
const RESYNC_DELAY_MS = 8000;

export type LyricLinesProps = {
  lines: LyricLine[];
  activeLyricIndex: number;
  activeWordIndex: number;
  activeLyricRef: RefObject<HTMLButtonElement | null>;
  audioRef: RefObject<HTMLAudioElement | null>;
  lyricsContainerRef: RefObject<HTMLDivElement | null>;
  lyricsAutoScrollEnabled: boolean;
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
 *
 * Once the user scrolls away, a floating Re-sync pill appears at the bottom
 * of the list (Meld's LyricsActionOverlay, same behaviour: it shows exactly
 * when follow is off and a line is active, and one tap turns follow back on
 * without seeking). Follow also resumes on its own 8s after the last manual
 * scroll input. LyricLines only renders for synced lyrics, so plain lyrics
 * never see the pill.
 *
 * A mid-song silence over 4s gets Meld's filling circle in-flow after the
 * last sung line (see GapRing), and each line carries a lyric-dist-0..3
 * class by its distance from the active line, which the fullscreen look
 * uses to fade inactive lines. The small lyrics panel keeps its pill
 * lyrics: the distance classes have no rules outside fullscreen.
 */
export function LyricLines({
  lines,
  activeLyricIndex,
  activeWordIndex,
  activeLyricRef,
  audioRef,
  lyricsContainerRef,
  lyricsAutoScrollEnabled,
  playbackSeconds,
  setLyricsAutoScrollEnabled,
}: LyricLinesProps) {
  const showIntro = lines.length > 0 && playbackSeconds * 1000 < lines[0].timeMs;
  // Before the first line there is nothing to resync to.
  const showResync = !lyricsAutoScrollEnabled && activeLyricIndex >= 0;
  // Mid-song silence: Meld's filling circle, in-flow after the last sung
  // line, while the playhead is inside the gap.
  const gap = findLyricsGap(lines, playbackSeconds * 1000);
  const [lastManualScrollAt, setLastManualScrollAt] = useState<number | null>(null);

  // Auto-resume 8s after the latest manual scroll. A new stamp restarts the
  // wait (the effect cleanup clears the pending timer); a line click, a new
  // song or a re-fetch re-enables follow first, which cancels the timer the
  // same way — the timer never fires after follow is already back on.
  useEffect(() => {
    if (lyricsAutoScrollEnabled || lastManualScrollAt === null) return;
    const timer = window.setTimeout(() => {
      setLastManualScrollAt(null);
      setLyricsAutoScrollEnabled(true);
    }, RESYNC_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [lyricsAutoScrollEnabled, lastManualScrollAt, setLyricsAutoScrollEnabled]);

  const handleManualScroll = () => {
    setLyricsAutoScrollEnabled(false);
    setLastManualScrollAt(Date.now());
  };

  return (
    <div className="lyrics-lines-wrap">
      <div
        ref={lyricsContainerRef}
        className="lyrics-lines"
        onWheel={handleManualScroll}
        onTouchMove={handleManualScroll}
        onPointerDown={handleManualScroll}
        onKeyDown={handleManualScroll}
      >
        {showIntro && <InstrumentalInterlude label="Intro" />}
        {lines.map((line, index) => {
          const isActive = index === activeLyricIndex;
          // Distance from the active line, capped at 3: the fullscreen
          // look fades inactive lines by distance (Meld's ladder). Before
          // the first line there is no active line to measure from.
          const distance = activeLyricIndex < 0 ? -1 : Math.min(Math.abs(index - activeLyricIndex), 3);
          const words = line.words ?? [];
          return (
            <Fragment key={`${line.timeMs}-${index}`}>
              <button
                ref={isActive ? activeLyricRef : undefined}
                className={
                  isActive
                    ? "lyric-line active lyric-dist-0"
                    : distance >= 0
                      ? `lyric-line lyric-dist-${distance}`
                      : "lyric-line"
                }
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
              {gap?.index === index ? <GapRing progress={gap.progress} /> : null}
            </Fragment>
          );
        })}
      </div>
      <button
        type="button"
        className={showResync ? "lyrics-resync visible" : "lyrics-resync"}
        aria-hidden={!showResync}
        tabIndex={showResync ? 0 : -1}
        onClick={() => {
          // Resync only: re-enable follow and let the follow effect centre
          // the active line. No seek, no re-fetch.
          setLastManualScrollAt(null);
          setLyricsAutoScrollEnabled(true);
        }}
      >
        <span aria-hidden="true" className="lyrics-resync-icon">
          ↻
        </span>
        Re-sync
      </button>
    </div>
  );
}
