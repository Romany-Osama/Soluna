import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { InstrumentalSection } from "./instrumental";
import { formatRemainingMs, instrumentalProgress } from "./instrumental";
import {
  WAVY_CIRCLE_AMPLITUDE,
  WAVY_CIRCLE_CENTER,
  WAVY_CIRCLE_LOBES,
  WAVY_CIRCLE_RADIUS,
  WAVY_CIRCLE_STROKE,
  WAVY_CIRCLE_VIEW,
  buildWavyArcPath,
  wavyArcHeadPoint,
} from "./wavyArc";
import type { WavyArcArgs } from "./wavyArc";

/**
 * The wavy completing circle, in the Material 3 Expressive / YouTube Music
 * idiom: a determinate circular progress ring whose radius undulates
 * sinusoidally (a polar wave, strongest at the leading edge) and whose
 * wave travels while the music plays. It fills 0 → 100% across the
 * instrumental section and is complete exactly when the section ends —
 * the vocals resume, or the track ends. With no known end it spins as an
 * indeterminate wavy sweep instead of claiming a fraction it does not know.
 *
 * The fill is driven by the real playhead: the audio element's currentTime
 * read every animation frame when mounted (the `progress` prop is the
 * fallback, from the player's timeupdate state). Nothing here runs on a
 * fixed timer — pause the audio and both the fill and the wave freeze.
 *
 * Drawn as one SVG path, recomputed per frame and written straight to the
 * DOM so the 60fps wave never re-renders React. Soluna's own code; the
 * wave parameters (8 lobes, ~3px amplitude) match the M3 Expressive
 * behaviour, not any copied implementation.
 */

export type WavyCircleProps = {
  section: InstrumentalSection;
  /** Fill 0–1 from the player's timeupdate state; null when the end is unknown. */
  progress: number | null;
  /** The playing audio element: the ground-truth playhead, read per frame. */
  audioRef?: RefObject<HTMLAudioElement | null>;
  size?: number;
};

export function WavyCircle({ section, progress, audioRef, size = 120 }: WavyCircleProps) {
  const pathRef = useRef<SVGPathElement | null>(null);
  const headRef = useRef<SVGCircleElement | null>(null);
  const centerRef = useRef<HTMLSpanElement | null>(null);
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const sectionRef = useRef(section);
  sectionRef.current = section;
  const frameRef = useRef({ phase: 0, lastProgress: progress as number | null, lastTime: 0 });

  useEffect(() => {
    const draw = (phase: number, current: number | null) => {
      const path = pathRef.current;
      const head = headRef.current;
      const center = centerRef.current;
      if (!path || !head || !center) return;
      const currentSection = sectionRef.current;
      if (current === null) {
        // Indeterminate: a 100° wavy sweep rotating around the ring.
        const sweep = 100;
        const args: WavyArcArgs = {
          startDeg: (phase * 180) / Math.PI,
          sweepDeg: sweep,
          lobes: WAVY_CIRCLE_LOBES,
          amplitude: WAVY_CIRCLE_AMPLITUDE,
          phase,
        };
        path.setAttribute("d", buildWavyArcPath(args));
        const point = wavyArcHeadPoint(args);
        head.setAttribute("cx", point.x.toFixed(2));
        head.setAttribute("cy", point.y.toFixed(2));
        head.style.opacity = "1";
        center.textContent = "♪";
        return;
      }
      if (current <= 0) {
        path.setAttribute("d", "");
        head.style.opacity = "0";
        center.textContent =
          currentSection.endMs !== null ? formatRemainingMs(currentSection.endMs - currentSection.startMs) : "♪";
        return;
      }
      const sweep = Math.min(360, current * 360);
      const args: WavyArcArgs = {
        startDeg: 0,
        sweepDeg: sweep,
        lobes: WAVY_CIRCLE_LOBES,
        amplitude: WAVY_CIRCLE_AMPLITUDE,
        phase,
      };
      path.setAttribute("d", buildWavyArcPath(args));
      const point = wavyArcHeadPoint(args);
      head.setAttribute("cx", point.x.toFixed(2));
      head.setAttribute("cy", point.y.toFixed(2));
      head.style.opacity = current >= 1 ? "0" : "1";
      center.textContent =
        current >= 1
          ? "✓"
          : currentSection.endMs !== null
            ? formatRemainingMs((1 - current) * (currentSection.endMs - currentSection.startMs))
            : "♪";
    };

    // Reduced motion: one static draw per progress change, no wave travel.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      draw(0, progressRef.current);
      return;
    }
    let raf = 0;
    const tick = (time: number) => {
      const frame = frameRef.current;
      const dt = frame.lastTime ? time - frame.lastTime : 16;
      frame.lastTime = time;
      const audioMs =
        audioRef?.current && !Number.isNaN(audioRef.current.currentTime) ? audioRef.current.currentTime * 1000 : null;
      const current = audioMs !== null ? instrumentalProgress(sectionRef.current, audioMs) : progressRef.current;
      const advancing =
        current !== null && (frame.lastProgress === null || Math.abs(current - frame.lastProgress) > 0.0005);
      // The wave travels only while the playhead advances; pausing freezes it.
      if (advancing || current === null) frame.phase += (dt * 2 * Math.PI) / 2200;
      frame.lastProgress = current;
      draw(frame.phase, current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // The loop reads progress/section through refs, so it is registered once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const percent = progress === null ? undefined : Math.round(progress * 100);
  const valueText =
    progress === null
      ? "Instrumental part, end unknown"
      : progress >= 1
        ? "Instrumental part complete"
        : `${formatRemainingMs(
            section.endMs !== null ? (1 - progress) * (section.endMs - section.startMs) : 0,
          )} of the instrumental part left`;
  return (
    <div
      className="wavy-circle"
      style={{ width: size, height: size }}
      role="progressbar"
      aria-label={`${section.label} — instrumental part`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={valueText}
    >
      <svg width={size} height={size} viewBox={`0 0 ${WAVY_CIRCLE_VIEW} ${WAVY_CIRCLE_VIEW}`} aria-hidden="true">
        <circle className="wavy-circle-track" cx={WAVY_CIRCLE_CENTER} cy={WAVY_CIRCLE_CENTER} r={WAVY_CIRCLE_RADIUS} />
        <path ref={pathRef} className="wavy-circle-progress" d="" fill="none" strokeLinecap="round" />
        <circle
          ref={headRef}
          className="wavy-circle-head"
          r={WAVY_CIRCLE_STROKE}
          cx={WAVY_CIRCLE_CENTER}
          cy={WAVY_CIRCLE_CENTER - WAVY_CIRCLE_RADIUS}
        />
      </svg>
      <span
        ref={centerRef}
        className="wavy-circle-center"
        style={{ fontSize: Math.max(12, Math.round(size / 6)) }}
        aria-hidden="true"
      >
        ♪
      </span>
    </div>
  );
}
