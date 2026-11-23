import type { RgbColor } from "./ambientColors";

/**
 * Moving soft lights for the fullscreen player: five large, heavily
 * blurred radial glows in the current track's dominant colours, drifting
 * slowly across a dark background on pure CSS animation. Soluna's own
 * implementation — no WebGL shader, no copied visuals.
 *
 * The layer is keyed by `trackKey` (the thumbnail URL), so a new song
 * remounts the lights: fresh colours, fresh drift, no stale glow from the
 * previous track. It only renders in fullscreen view; the expanded player
 * keeps its static blurred-cover backdrop.
 */
export function AmbientLights({ colors, trackKey }: { colors: RgbColor[]; trackKey: string }) {
  const blobs = [0, 1, 2, 3, 4];
  return (
    <div className="ambient-lights" key={trackKey} aria-hidden="true">
      {blobs.map((index) => {
        const color = colors[index % colors.length];
        return (
          <span
            key={index}
            className={`ambient-light ambient-light-${index + 1}`}
            style={{
              background: `radial-gradient(circle, rgba(${color.r}, ${color.g}, ${color.b}, 0.85) 0%, rgba(${color.r}, ${color.g}, ${color.b}, 0) 70%)`,
            }}
          />
        );
      })}
    </div>
  );
}
