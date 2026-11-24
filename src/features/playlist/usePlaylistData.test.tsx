// @vitest-environment jsdom
// B1 regression: "Download playlist" must page through every continuation.
// PlaylistScreen's download loop holds the `loadPlaylistMore` from the render
// in which the click happened and calls it repeatedly; the loader must read
// the latest continuation from the cache on every call, not the continuation
// its render-time closure captured (which re-fetched the first page forever).
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (path: string) => path,
}));

const { usePlaylistData } = await import("./usePlaylistData");
const { ResourceCache } = await import("../../data/resourceCache");
const { playlistKey } = await import("../../data/keys");
import type { PlaylistPage, YtItem } from "../../types";

const song = (id: string): YtItem => ({ id, kind: "song", title: id, subtitle: "", artists: [] });
const playlistItem: YtItem = { id: "PL1", kind: "playlist", title: "PL1", subtitle: "", artists: [] };

describe("usePlaylistData loadPlaylistMore", () => {
  it("advances through continuations when the same loader reference is called repeatedly", async () => {
    const cache = new ResourceCache();
    const key = playlistKey("PL1");
    const page1: PlaylistPage = { playlist: playlistItem, songs: [song("s1")], continuation: "T1" };
    cache.set<PlaylistPage>(key, { status: "ready", data: page1 });

    const tokens: (string | undefined)[] = [];
    invoke.mockImplementation(async (command: string, args?: { continuation?: string }) => {
      if (command !== "ytm_playlist_continuation") throw new Error(`unexpected ${command}`);
      tokens.push(args?.continuation);
      if (args?.continuation === "T1") return { songs: [song("s2")], continuation: "T2" };
      if (args?.continuation === "T2") return { songs: [song("s3")], continuation: null };
      throw new Error(`unexpected continuation ${args?.continuation}`);
    });

    const { result } = renderHook(() => usePlaylistData({ cache, openPlaylist: playlistItem, setNotice: vi.fn() }));
    // The download handler holds the loadPlaylistMore from the render in which
    // the click happened, so keep that exact reference for the whole loop.
    const loadMoreStale = result.current.loadPlaylistMore;

    // Mirror PlaylistScreen.downloadPlaylist: loop while the latest cached
    // page still has a continuation (guard 25), calling the captured loader.
    let guard = 0;
    while (
      cache.get<PlaylistPage>(key)?.status === "ready" &&
      cache.get<PlaylistPage>(key)?.data.continuation &&
      guard < 25
    ) {
      guard += 1;
      await act(async () => {
        await loadMoreStale();
      });
    }

    expect(tokens).toEqual(["T1", "T2"]);
    expect(cache.get<PlaylistPage>(key)?.data.songs.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });
});
