import type { RefObject } from "react";
import type { InstrumentalSection } from "./instrumental";
import { instrumentalProgress } from "./instrumental";
import { WavyCircle } from "./WavyCircle";

/**
 * The music-only part, shown in place of lyric lines: floating notes over
 * pulsing bars, with the wavy circle above them. The circle fills as the
 * section plays and completes exactly at its end — the moment the vocals
 * resume (or the track ends) — because its bounds come from the lyrics
 * payload (`InstrumentalSection`), not a timer. With no known end the
 * circle spins as an indeterminate wavy sweep.
 */
export function InstrumentalInterlude({
  label,
  section,
  playbackMs,
  audioRef,
  size = 120,
}: {
  label: string;
  section: InstrumentalSection;
  /** Playhead in milliseconds, from the player's timeupdate state. */
  playbackMs: number;
  /** The playing audio element: the ground-truth playhead for the circle. */
  audioRef?: RefObject<HTMLAudioElement | null>;
  /** Circle diameter in px; smaller when the interlude stands alone in a
      short lyrics box so the ring still fits (see .lyrics-lines--standalone). */
  size?: number;
}) {
  const progress = instrumentalProgress(section, playbackMs);
  return (
    <div className="lyrics-interlude" role="status" aria-label={label}>
      <WavyCircle section={section} progress={progress} audioRef={audioRef} size={size} />
      <div className="lyrics-interlude-notes" aria-hidden="true">
        <span>♪</span>
        <span>♫</span>
        <span>♪</span>
        <span>♫</span>
        <span>♪</span>
      </div>
      <div className="lyrics-interlude-bars" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <p>{label}</p>
    </div>
  );
}
