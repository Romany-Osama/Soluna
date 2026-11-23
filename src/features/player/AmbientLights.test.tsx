// @vitest-environment jsdom
// Ambient lights: one blurred glow per slot, coloured from the track palette.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AmbientLights } from "./AmbientLights";

describe("AmbientLights", () => {
  it("renders five glows in the track colours", () => {
    const { container } = render(
      <AmbientLights
        colors={[
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 255, b: 0 },
        ]}
        trackKey="cover-a.jpg"
      />,
    );
    const lights = container.querySelectorAll(".ambient-light");
    expect(lights).toHaveLength(5);
    expect(lights[0].getAttribute("style") ?? "").toContain("255, 0, 0");
    expect(lights[1].getAttribute("style") ?? "").toContain("0, 255, 0");
    // Colours cycle when the palette is shorter than the glow count.
    expect(lights[2].getAttribute("style") ?? "").toContain("255, 0, 0");
    expect(container.querySelector(".ambient-lights")).not.toBeNull();
  });
});
