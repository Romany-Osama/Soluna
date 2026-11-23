import { useEffect, useState } from "react";

/**
 * Dominant colours for the fullscreen player's ambient lights, extracted in
 * Soluna's own code: the track thumbnail is drawn to a small offscreen
 * canvas, its pixels are bucketed by colour, and the most vivid, most
 * common buckets win. No shader, no copied visuals — just a palette that
 * follows the song.
 *
 * The canvas route is guarded throughout: a remote thumbnail that refuses
 * CORS, a local asset URL the canvas cannot read, or a missing thumbnail
 * all fall back to the Soluna brand palette instead of breaking the player.
 */

export type RgbColor = { r: number; g: number; b: number };

/** Soluna brand palette, used when the thumbnail has no usable colours. */
export const AMBIENT_FALLBACK_COLORS: RgbColor[] = [
  { r: 0, g: 210, b: 255 },
  { r: 0, g: 179, b: 154 },
  { r: 122, g: 108, b: 255 },
  { r: 255, g: 122, b: 89 },
];

export function rgbToCss(color: RgbColor): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

const QUANTIZE_SHIFT = 3;
const QUANTIZE_LEVELS = 1 << (8 - QUANTIZE_SHIFT);
const MAX_DIMENSION = 48;

type Bucket = { r: number; g: number; b: number; count: number; score: number };

function bucketKey(r: number, g: number, b: number): number {
  return ((r >> QUANTIZE_SHIFT) * QUANTIZE_LEVELS + (g >> QUANTIZE_SHIFT)) * QUANTIZE_LEVELS + (b >> QUANTIZE_SHIFT);
}

/**
 * The palette of raw RGBA pixel data (as from `getImageData().data`).
 * Vivid colours outrank dull ones: each bucket scores by how many pixels it
 * holds times its saturation, so a small bright accent beats a large grey
 * background. Near-black, near-white and near-grey buckets are skipped —
 * they make muddy lights — and when nothing survives the filter the
 * fallback palette is returned.
 */
export function extractPaletteFromPixels(data: ArrayLike<number>, count = 4): RgbColor[] {
  const buckets = new Map<number, Bucket>();
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = bucketKey(r, g, b);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.count += 1;
    } else {
      buckets.set(key, { r, g, b, count: 1, score: 0 });
    }
  }

  const vivid: Bucket[] = [];
  for (const bucket of buckets.values()) {
    const avg = { r: bucket.r / bucket.count, g: bucket.g / bucket.count, b: bucket.b / bucket.count };
    const max = Math.max(avg.r, avg.g, avg.b);
    const min = Math.min(avg.r, avg.g, avg.b);
    if (max < 30 || min > 235 || max - min < 16) continue;
    // Saturation (0..1) lifts a small bright accent above a large dull area.
    bucket.score = bucket.count * (0.25 + (max === 0 ? 0 : (max - min) / max));
    vivid.push(bucket);
  }
  if (vivid.length === 0) return [...AMBIENT_FALLBACK_COLORS];

  vivid.sort((a, b) => b.score - a.score);
  const palette: RgbColor[] = [];
  for (const bucket of vivid) {
    const color = {
      r: Math.round(bucket.r / bucket.count),
      g: Math.round(bucket.g / bucket.count),
      b: Math.round(bucket.b / bucket.count),
    };
    // Near-duplicates of a colour already picked add no new light.
    if (palette.some((picked) => colorDistance(picked, color) < 28)) continue;
    palette.push(color);
    if (palette.length >= count) break;
  }
  return palette.length > 0 ? palette : [...AMBIENT_FALLBACK_COLORS];
}

function colorDistance(a: RgbColor, b: RgbColor): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/** Dominant colours of the image at `src`, or the fallback palette on any failure. */
export async function extractAmbientColors(src: string | null, count = 4): Promise<RgbColor[]> {
  if (!src || typeof Image === "undefined" || typeof document === "undefined") {
    return [...AMBIENT_FALLBACK_COLORS];
  }
  try {
    const image = await loadImage(src);
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return [...AMBIENT_FALLBACK_COLORS];
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    // Throws when the canvas is tainted (CORS refusal, unreadable asset URL).
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return extractPaletteFromPixels(pixels, count);
  } catch {
    return [...AMBIENT_FALLBACK_COLORS];
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Ambient colours: thumbnail failed to load (${src})`));
    image.src = src;
  });
}

/**
 * The fullscreen player's light palette for the current thumbnail. The
 * previous track's colours stay up while the new thumbnail is extracted,
 * so the lights change with the song instead of flashing to a default.
 */
export function useAmbientColors(thumbnailSrc: string | null): RgbColor[] {
  const [colors, setColors] = useState<RgbColor[]>(AMBIENT_FALLBACK_COLORS);
  useEffect(() => {
    if (!thumbnailSrc) {
      setColors([...AMBIENT_FALLBACK_COLORS]);
      return;
    }
    let cancelled = false;
    void extractAmbientColors(thumbnailSrc).then((palette) => {
      if (!cancelled) setColors(palette);
    });
    return () => {
      cancelled = true;
    };
  }, [thumbnailSrc]);
  return colors;
}
