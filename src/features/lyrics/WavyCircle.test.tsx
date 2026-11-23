// @vitest-environment jsdom
// The wavy circle fills from the section's own bounds and is complete
// exactly at the section's end; with no known end it spins indeterminate.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { WavyCircle } from "./WavyCircle";
import { buildWavyArcPath } from "./wavyArc";
import type { InstrumentalSection } from "./instrumental";

afterEach(cleanup);

const section: InstrumentalSection = {
  kind: "intro",
  startMs: 0,
  endMs: 10000,
  label: "Intro",
};

function flushFrames() {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe("buildWavyArcPath", () => {
  it("starts at the top of the ring and undulates", () => {
    const plain = buildWavyArcPath({ startDeg: 0, sweepDeg: 180, lobes: 8, amplitude: 0, phase: 0 });
    const wavy = buildWavyArcPath({ startDeg: 0, sweepDeg: 180, lobes: 8, amplitude: 3, phase: 0.7 });
    expect(wavy.startsWith("M60.00 10.00")).toBe(true);
    // Same sweep, but the wave moves points off the plain circle.
    expect(wavy).not.toBe(plain);
    expect(wavy.split("L").length).toBeGreaterThan(40);
  });

  it("closes a full ring back at the top", () => {
    const path = buildWavyArcPath({ startDeg: 0, sweepDeg: 360, lobes: 8, amplitude: 3, phase: 0 });
    expect(path.startsWith("M60.00 10.00")).toBe(true);
    expect(path.trimEnd().endsWith("60.00 10.00")).toBe(true);
  });
});

describe("WavyCircle", () => {
  it("reports its fill as a progressbar value", () => {
    const { container } = render(<WavyCircle section={section} progress={0.5} />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("50");
    expect(bar?.getAttribute("aria-valuetext")).toContain("0:05");
  });

  it("draws the wavy arc for a partial fill", async () => {
    const { container } = render(<WavyCircle section={section} progress={0.5} />);
    await flushFrames();
    const path = container.querySelector(".wavy-circle-progress");
    expect(path?.getAttribute("d")).toBeTruthy();
    expect(path?.getAttribute("d")).not.toBe("");
  });

  it("shows the complete state at full progress", () => {
    const { container } = render(<WavyCircle section={section} progress={1} />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("100");
    expect(bar?.getAttribute("aria-valuetext")).toBe("Instrumental part complete");
  });

  it("spins indeterminate with no known end", async () => {
    const { container } = render(<WavyCircle section={{ ...section, endMs: null }} progress={null} />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.hasAttribute("aria-valuenow")).toBe(false);
    await flushFrames();
    expect(container.querySelector(".wavy-circle-progress")?.getAttribute("d")).toBeTruthy();
  });

  it("renders the ring at the requested size", () => {
    const { container } = render(<WavyCircle section={section} progress={0.5} size={84} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("84");
    expect(svg?.getAttribute("height")).toBe("84");
    // The wrapper follows the same size so the centre text stays centred
    // on the ring instead of on the default 120px box.
    const circle = container.querySelector(".wavy-circle") as HTMLElement | null;
    expect(circle?.style.width).toBe("84px");
    expect(circle?.style.height).toBe("84px");
  });
});
