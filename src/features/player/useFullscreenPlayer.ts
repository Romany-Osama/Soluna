import { useCallback, useEffect, useRef, useState } from "react";
import { LayerState, topmostLayer } from "../../app/layers";
import { isFullscreenWindow, setFullscreenWindow } from "../../lib/windowControls";

export type FullscreenPlayerState = {
  /** The expanded player takes over the whole window. */
  view: boolean;
  /** The OS window itself is fullscreen (Tauri setFullscreen). */
  window: boolean;
  /** Enter/exit the fullscreen player view. */
  toggle: () => void;
};

/**
 * True fullscreen player (Liner-style): the expanded player takes over the
 * whole window (`view`), and optionally the OS window itself (`window`, via
 * Tauri). Escape leaves fullscreen first and only closes the player on a
 * second press; closing the player always leaves fullscreen behind. Both
 * are presentation state, not playback state.
 *
 * Escape is handled here, on the window in the capture phase, so it runs
 * before App's key handler — but only when the player itself is the
 * topmost layer: a menu, dialog or panel above it still closes first, and
 * the event is swallowed (stopPropagation) only in that case.
 */
export function useFullscreenPlayer(playerExpanded: boolean, layerState: LayerState): FullscreenPlayerState {
  const [view, setView] = useState(false);
  const [windowFullscreen, setWindowFullscreen] = useState(false);

  const toggle = useCallback(async () => {
    if (view) {
      setView(false);
      if (windowFullscreen) {
        await setFullscreenWindow(false);
        setWindowFullscreen(false);
      }
      return;
    }
    setView(true);
    if (await isFullscreenWindow()) {
      setWindowFullscreen(true);
      return;
    }
    await setFullscreenWindow(true);
    setWindowFullscreen(true);
  }, [view, windowFullscreen]);

  // Latest Escape handler, kept in a ref so the window listener is
  // registered once and always sees the current layer state.
  const escapeHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    escapeHandlerRef.current = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!view || topmostLayer(layerState) !== "expandedPlayer") return;
      event.preventDefault();
      event.stopPropagation();
      void toggle();
    };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => escapeHandlerRef.current(event);
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // The player closing (any path: backdrop, close button, Back, Escape)
  // leaves fullscreen behind.
  useEffect(() => {
    if (!playerExpanded && (view || windowFullscreen)) {
      setView(false);
      if (windowFullscreen) {
        void setFullscreenWindow(false);
        setWindowFullscreen(false);
      }
    }
  }, [playerExpanded, view, windowFullscreen]);

  return { view, window: windowFullscreen, toggle };
}
