// @vitest-environment jsdom
// Fullscreen player: Escape leaves fullscreen only when the player itself is
// the topmost layer; a menu (or any layer above it) closes first.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LAYERS, LayerState } from "../../app/layers";
import { useFullscreenPlayer } from "./useFullscreenPlayer";

vi.spyOn(console, "error").mockImplementation(() => undefined);

function layerState(open: Partial<LayerState>): LayerState {
  const state = Object.fromEntries(LAYERS.map((layer) => [layer, false])) as LayerState;
  return { ...state, ...open };
}

function pressEscape() {
  const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe("useFullscreenPlayer", () => {
  it("enters fullscreen, then Escape leaves it", async () => {
    const { result } = renderHook(() => useFullscreenPlayer(true, layerState({ expandedPlayer: true })));
    await act(async () => {
      result.current.toggle();
    });
    expect(result.current.view).toBe(true);
    act(() => {
      pressEscape();
    });
    expect(result.current.view).toBe(false);
  });

  it("Escape does nothing when a menu sits above the player", async () => {
    const { result } = renderHook(() => useFullscreenPlayer(true, layerState({ expandedPlayer: true, menu: true })));
    await act(async () => {
      result.current.toggle();
    });
    expect(result.current.view).toBe(true);
    let event: KeyboardEvent | undefined;
    act(() => {
      event = pressEscape();
    });
    expect(result.current.view).toBe(true);
    expect(event?.defaultPrevented).toBe(false);
  });

  it("leaves fullscreen when the player closes", async () => {
    const { result, rerender } = renderHook(
      ({ expanded }: { expanded: boolean }) => useFullscreenPlayer(expanded, layerState({ expandedPlayer: expanded })),
      { initialProps: { expanded: true } },
    );
    await act(async () => {
      result.current.toggle();
    });
    expect(result.current.view).toBe(true);
    rerender({ expanded: false });
    expect(result.current.view).toBe(false);
  });

  it("enter() opens fullscreen directly, and exit() leaves it", async () => {
    const { result } = renderHook(() => useFullscreenPlayer(true, layerState({ expandedPlayer: true })));
    await act(async () => {
      result.current.enter();
    });
    expect(result.current.view).toBe(true);
    // Entering twice is a no-op, not a toggle back out.
    await act(async () => {
      result.current.enter();
    });
    expect(result.current.view).toBe(true);
    await act(async () => {
      result.current.exit();
    });
    expect(result.current.view).toBe(false);
  });
});
