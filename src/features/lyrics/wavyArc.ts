/**
 * The geometry of the wavy ring: one SVG path whose radius undulates
 * sinusoidally (a polar wave, strongest at the leading edge), in the
 * Material 3 Expressive / YouTube Music idiom. Pure functions, so the path
 * can be recomputed every animation frame and unit-tested on its own.
 */

export const WAVY_CIRCLE_LOBES = 8;
export const WAVY_CIRCLE_AMPLITUDE = 3;

export const WAVY_CIRCLE_VIEW = 120;
export const WAVY_CIRCLE_CENTER = WAVY_CIRCLE_VIEW / 2;
export const WAVY_CIRCLE_RADIUS = 50;
export const WAVY_CIRCLE_STROKE = 5.5;

export type WavyArcArgs = {
  startDeg: number;
  sweepDeg: number;
  lobes: number;
  amplitude: number;
  phase: number;
};

function waveRadius(angleDeg: number, t: number, sweepDeg: number, args: WavyArcArgs): number {
  // The wave swells toward the leading edge so the tail joins the track
  // smoothly; a full ring keeps a constant envelope so it closes cleanly.
  const envelope = sweepDeg >= 359.5 ? 1 : t * t * (3 - 2 * t);
  const angle = (angleDeg * Math.PI) / 180;
  return WAVY_CIRCLE_RADIUS + args.amplitude * envelope * Math.sin(args.lobes * angle - args.phase);
}

/** SVG path for one wavy arc, starting at the top and sweeping clockwise. */
export function buildWavyArcPath(args: WavyArcArgs): string {
  const steps = Math.max(2, Math.ceil(args.sweepDeg / 2));
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angleDeg = args.startDeg + args.sweepDeg * t;
    const radius = waveRadius(angleDeg, t, args.sweepDeg, args);
    const angle = ((angleDeg - 90) * Math.PI) / 180;
    const x = WAVY_CIRCLE_CENTER + radius * Math.cos(angle);
    const y = WAVY_CIRCLE_CENTER + radius * Math.sin(angle);
    d += `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d;
}

/** The point at the leading edge of a wavy arc (the head dot). */
export function wavyArcHeadPoint(args: WavyArcArgs): { x: number; y: number } {
  const angleDeg = args.startDeg + args.sweepDeg;
  const radius = waveRadius(angleDeg, 1, args.sweepDeg, args);
  const angle = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: WAVY_CIRCLE_CENTER + radius * Math.cos(angle),
    y: WAVY_CIRCLE_CENTER + radius * Math.sin(angle),
  };
}
