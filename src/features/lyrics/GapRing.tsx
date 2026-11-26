// Gap ring (Meld's IntervalIndicator, reimplemented for the DOM): the
// wavy circular progress ring itself. The gap math lives in lyricsGap.ts
// (pure functions, no React) so this file only exports the component.
import { GAP_RING_AMPLITUDE, GAP_RING_SIZE, GAP_RING_STROKE, GAP_RING_WAVES, wavyCirclePath } from "./lyricsGap";

export function GapRing({ progress }: { progress: number }) {
  return (
    <div className="lyrics-gap-row" role="status" aria-label="Music continues">
      <svg
        className="gap-ring"
        width={GAP_RING_SIZE}
        height={GAP_RING_SIZE}
        viewBox="-5 -5 82 82"
        aria-hidden="true"
        data-fill={progress.toFixed(2)}
        data-waves={GAP_RING_WAVES}
        data-amplitude={GAP_RING_AMPLITUDE}
        data-stroke={GAP_RING_STROKE}
      >
        <path
          className="gap-ring-track"
          d={wavyCirclePath(1)}
          fill="none"
          stroke="rgba(238,240,255,0.35)"
          strokeWidth={GAP_RING_STROKE}
        />
        <path
          className="gap-ring-progress"
          d={wavyCirclePath(progress)}
          fill="none"
          stroke="#4cc3ff"
          strokeWidth={GAP_RING_STROKE}
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
