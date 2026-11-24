// @vitest-environment jsdom
// App-open Liked Songs sync: fires once, only after the stored settings have loaded.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (path: string) => path,
}));

const { useLikedSyncOnOpen } = await import("./useLikedSyncOnOpen");

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { value, configurable: true });
}

const props = {
  sessionStatus: { authenticated: true },
  settings: { ytmSync: true, likedSongsSync: true },
  settingsLoading: true,
  loadLibrary: vi.fn(async () => undefined),
  lastLibrarySyncRef: { current: {} as Record<string, number> },
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "sync_youtube_library") return { likedSongs: 2, librarySongs: 0, uploadedSongs: 0, playlists: 0 };
    return [];
  });
  setOnline(true);
  props.loadLibrary.mockClear();
  props.lastLibrarySyncRef = { current: {} };
});

describe("useLikedSyncOnOpen", () => {
  it("syncs once, only after the stored settings finish loading", async () => {
    const { rerender } = renderHook((loading: boolean) => useLikedSyncOnOpen({ ...props, settingsLoading: loading }), {
      initialProps: true,
    });
    // While the settings are still loading, the stored toggle value is unknown: no sync yet, even
    // though the session is authenticated and the in-code defaults are on.
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => {
      rerender(false);
    });
    expect(invoke).toHaveBeenCalledWith("sync_youtube_library", { mode: "liked" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(props.loadLibrary).toHaveBeenCalledWith("liked");
    expect(props.lastLibrarySyncRef.current.liked).toBeGreaterThan(0);
    // A later re-render does not sync again in the same app open.
    await act(async () => {
      rerender(false);
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not sync when the app opens offline", async () => {
    setOnline(false);
    const { rerender } = renderHook((loading: boolean) => useLikedSyncOnOpen({ ...props, settingsLoading: loading }), {
      initialProps: true,
    });
    await act(async () => {
      rerender(false);
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not sync when the Liked Songs toggle is off", async () => {
    const { rerender } = renderHook(
      (loading: boolean) =>
        useLikedSyncOnOpen({ ...props, settings: { ytmSync: true, likedSongsSync: false }, settingsLoading: loading }),
      { initialProps: true },
    );
    await act(async () => {
      rerender(false);
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not sync while signed out", async () => {
    const { rerender } = renderHook(
      (loading: boolean) =>
        useLikedSyncOnOpen({ ...props, sessionStatus: { authenticated: false }, settingsLoading: loading }),
      { initialProps: true },
    );
    await act(async () => {
      rerender(false);
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
