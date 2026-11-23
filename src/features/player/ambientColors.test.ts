// Ambient colours: the pixel-bucketing palette picks vivid, common colours
// and falls back to the brand palette when a thumbnail has none.
import { describe, expect, it } from "vitest";
import { AMBIENT_FALLBACK_COLORS, extractAmbientColors, extractPaletteFromPixels } from "./ambientColors";

/** RGBA pixels for a solid colour block. */
function solidPixels(r: number, g: number, b: number, pixels: number): number[] {
  const data: number[] = [];
  for (let i = 0; i < pixels; i += 1) data.push(r, g, b, 255);
  return data;
}

describe("extractPaletteFromPixels", () => {
  it("finds the solid colour of a cover", () => {
    const palette = extractPaletteFromPixels(solidPixels(230, 30, 40, 64));
    expect(palette[0].r).toBeGreaterThan(200);
    expect(palette[0].g).toBeLessThan(60);
    expect(palette[0].b).toBeLessThan(60);
  });

  it("ranks a large vivid colour above a larger dull one", () => {
    const palette = extractPaletteFromPixels([...solidPixels(200, 40, 40, 100), ...solidPixels(90, 95, 100, 400)]);
    expect(palette[0].r).toBeGreaterThan(150);
  });

  it("falls back when the image is all black, grey or empty", () => {
    expect(extractPaletteFromPixels(solidPixels(0, 0, 0, 64))).toEqual(AMBIENT_FALLBACK_COLORS);
    expect(extractPaletteFromPixels(solidPixels(120, 120, 120, 64))).toEqual(AMBIENT_FALLBACK_COLORS);
    expect(extractPaletteFromPixels([])).toEqual(AMBIENT_FALLBACK_COLORS);
  });

  it("ignores transparent pixels", () => {
    const data = [...solidPixels(0, 200, 80, 64)];
    for (let i = 3; i < data.length; i += 4) data[i] = 0;
    expect(extractPaletteFromPixels(data)).toEqual(AMBIENT_FALLBACK_COLORS);
  });
});

describe("extractAmbientColors", () => {
  it("returns the fallback palette with no thumbnail", async () => {
    await expect(extractAmbientColors(null)).resolves.toEqual(AMBIENT_FALLBACK_COLORS);
  });
});
