// @vitest-environment jsdom
// M19: Spotify Liked Tracks (100/page) and Playlists (50/page) had no pagination —
// a >100-track liked library and a >50-playlist library were silently truncated.
// The hook must page through every page: liked tracks via load-more, playlists by
// fetching all pages when the add-to-playlist dialog opens.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SpotifyFolderItem,
  SpotifyLibraryNode,
  SpotifyLikedTracksPayload,
  SpotifyPlaylistItem,
  SpotifyTrackItem,
  YtItem,
} from "../../types";
import type { Destructive } from "../../app/destructive";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (path: string) => path,
}));

const { useSpotifyLibrary } = await import("./useSpotifyLibrary");

const LIKED_TOTAL = 250;
const PLAYLIST_TOTAL = 120;
const LIBRARY_TOTAL = 250;
const LIBRARY_FOLDERS = 5;

function makeFolder(index: number): SpotifyFolderItem {
  return { uri: `spotify:folder:folder-${index}`, name: `Folder ${index}`, totalChildren: 3 };
}

function makeTrack(index: number): SpotifyTrackItem {
  return {
    id: `track-${index}`,
    uri: `spotify:track:track-${index}`,
    uid: null,
    name: `Liked ${index}`,
    artist: "Artist",
    album: "Album",
    image: null,
    durationMs: 180_000,
  };
}

function makePlaylist(index: number): SpotifyPlaylistItem {
  return { id: `playlist-${index}`, name: `Playlist ${index}`, description: null, image: null, owner: null };
}

const likedTracks = Array.from({ length: LIKED_TOTAL }, (_, index) => makeTrack(index));
const playlists = Array.from({ length: PLAYLIST_TOTAL }, (_, index) => makePlaylist(index));
// The library node pages over folders + playlists together (limit 100).
const libraryItems: (
  { kind: "folder"; folder: SpotifyFolderItem } | { kind: "playlist"; playlist: SpotifyPlaylistItem }
)[] = [
  ...Array.from({ length: LIBRARY_FOLDERS }, (_, index) => ({
    kind: "folder" as const,
    folder: makeFolder(index),
  })),
  ...Array.from({ length: LIBRARY_TOTAL - LIBRARY_FOLDERS }, (_, index) => ({
    kind: "playlist" as const,
    playlist: makePlaylist(index),
  })),
];

const item: YtItem = {
  id: "video-1",
  kind: "song",
  title: "Song",
  subtitle: "",
  artists: [{ name: "Artist" }],
  videoId: "video-1",
  duration: 180,
};

const props = {
  audioQuality: "high" as const,
  setMenuItem: vi.fn(),
  setNotice: vi.fn(),
  setSpotifyProfile: vi.fn(),
  spotifyStatus: { authenticated: true },
  destructive: vi.fn() as unknown as Destructive,
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args?: { offset?: number | null }) => {
    if (command === "spotify_liked_tracks") {
      const offset = args?.offset ?? 0;
      const page = likedTracks.slice(offset, offset + 100);
      return { tracks: page, totalCount: LIKED_TOTAL, offset, limit: 100 };
    }
    if (command === "spotify_playlists") {
      const offset = args?.offset ?? 0;
      const page = playlists.slice(offset, offset + 50);
      return { playlists: page, totalCount: PLAYLIST_TOTAL, offset, limit: 50 };
    }
    if (command === "spotify_library_node") {
      const offset = args?.offset ?? 0;
      const page = libraryItems.slice(offset, offset + 100);
      return {
        folders: page.filter((entry) => entry.kind === "folder").map((entry) => entry.folder),
        playlists: page.filter((entry) => entry.kind === "playlist").map((entry) => entry.playlist),
        totalCount: LIBRARY_TOTAL,
        offset,
        limit: 100,
      };
    }
    if (command === "spotify_resolve_youtube") {
      return { id: "track-0", uri: "spotify:track:track-0", name: "Song", artist: "Artist", durationMs: 180_000 };
    }
    throw new Error(`unexpected invoke: ${command}`);
  });
  vi.clearAllMocks();
});

describe("useSpotifyLibrary Spotify pagination (M19)", () => {
  it("loads a >100-track liked library in full via load more", async () => {
    const { result } = renderHook(() => useSpotifyLibrary(props));
    await act(async () => {
      await result.current.loadSpotifyLikedTracks();
    });
    expect(result.current.spotifyLikedTracks.data.tracks).toHaveLength(100);
    expect(result.current.spotifyLikedTracks.data.totalCount).toBe(LIKED_TOTAL);

    await act(async () => {
      await result.current.spotifyLoadMore.liked.loadMore();
    });
    expect(result.current.spotifyLikedTracks.data.tracks).toHaveLength(200);
    await act(async () => {
      await result.current.spotifyLoadMore.liked.loadMore();
    });
    expect(result.current.spotifyLikedTracks.data.tracks).toHaveLength(LIKED_TOTAL);
    expect(result.current.spotifyLikedTracks.data.tracks[LIKED_TOTAL - 1].id).toBe(`track-${LIKED_TOTAL - 1}`);

    const likedCalls = invoke.mock.calls.filter(([command]) => command === "spotify_liked_tracks");
    expect(likedCalls.map(([, args]) => args?.offset ?? 0)).toEqual([0, 100, 200]);
  });

  it("does not request another liked page once every track is loaded", async () => {
    const { result } = renderHook(() => useSpotifyLibrary(props));
    await act(async () => {
      await result.current.loadSpotifyLikedTracks();
    });
    await act(async () => {
      await result.current.spotifyLoadMore.liked.loadMore();
    });
    await act(async () => {
      await result.current.spotifyLoadMore.liked.loadMore();
    });
    const callsBefore = invoke.mock.calls.filter(([command]) => command === "spotify_liked_tracks").length;
    await act(async () => {
      await result.current.spotifyLoadMore.liked.loadMore();
    });
    expect(invoke.mock.calls.filter(([command]) => command === "spotify_liked_tracks").length).toBe(callsBefore);
  });

  it("fetches every playlist page when opening add-to-playlist for a >50-playlist library", async () => {
    const { result } = renderHook(() => useSpotifyLibrary(props));
    await act(async () => {
      await result.current.beginSpotifyAdd(item);
    });
    expect(result.current.spotifyAddState?.status).toBe("ready");
    expect(result.current.spotifyAddState?.data.playlists).toHaveLength(PLAYLIST_TOTAL);
    expect(result.current.spotifyAddState?.data.playlists[PLAYLIST_TOTAL - 1].id).toBe(
      `playlist-${PLAYLIST_TOTAL - 1}`,
    );

    const playlistCalls = invoke.mock.calls.filter(([command]) => command === "spotify_playlists");
    expect(playlistCalls.map(([, args]) => args?.offset ?? 0)).toEqual([0, 50, 100]);
  });

  it("loads a >100-item Spotify library in full via load more", async () => {
    const { result } = renderHook(() => useSpotifyLibrary(props));
    await act(async () => {
      await result.current.loadSpotifyLibrary();
    });
    expect(result.current.spotifyLibrary.data.folders).toHaveLength(LIBRARY_FOLDERS);
    expect(result.current.spotifyLibrary.data.playlists).toHaveLength(100 - LIBRARY_FOLDERS);
    expect(result.current.spotifyLibrary.data.totalCount).toBe(LIBRARY_TOTAL);

    await act(async () => {
      await result.current.spotifyLoadMore.library.loadMore();
    });
    expect(
      result.current.spotifyLibrary.data.folders.length + result.current.spotifyLibrary.data.playlists.length,
    ).toBe(200);
    await act(async () => {
      await result.current.spotifyLoadMore.library.loadMore();
    });
    expect(result.current.spotifyLibrary.data.folders).toHaveLength(LIBRARY_FOLDERS);
    expect(result.current.spotifyLibrary.data.playlists).toHaveLength(LIBRARY_TOTAL - LIBRARY_FOLDERS);
    expect(result.current.spotifyLibrary.data.playlists[LIBRARY_TOTAL - LIBRARY_FOLDERS - 1].id).toBe(
      `playlist-${LIBRARY_TOTAL - LIBRARY_FOLDERS - 1}`,
    );

    const libraryCalls = invoke.mock.calls.filter(([command]) => command === "spotify_library_node");
    expect(libraryCalls.map(([, args]) => args?.offset ?? 0)).toEqual([0, 100, 200]);

    const callsBefore = libraryCalls.length;
    await act(async () => {
      await result.current.spotifyLoadMore.library.loadMore();
    });
    expect(invoke.mock.calls.filter(([command]) => command === "spotify_library_node").length).toBe(callsBefore);
  });

  // O1: opening a folder (or going back) while a library load-more is in flight
  // must not let the stale page overwrite the new folder's view when it resolves.
  it("drops a library load-more that resolves after the folder changed", async () => {
    let resolvePageTwo: (page: SpotifyLibraryNode) => void = () => {};
    const pageTwo = new Promise<SpotifyLibraryNode>((resolve) => {
      resolvePageTwo = resolve;
    });
    invoke.mockImplementation(async (command: string, args?: { folderUri?: string | null; offset?: number | null }) => {
      if (command === "spotify_library_node") {
        const folderUri = args?.folderUri ?? null;
        const offset = args?.offset ?? 0;
        if (folderUri === "spotify:folder:folder-0") {
          return {
            folders: [],
            playlists: [makePlaylist(900), makePlaylist(901), makePlaylist(902)],
            totalCount: 3,
            offset: 0,
            limit: 100,
          };
        }
        if (offset === 100) return pageTwo;
        const page = libraryItems.slice(offset, offset + 100);
        return {
          folders: page.filter((entry) => entry.kind === "folder").map((entry) => entry.folder),
          playlists: page.filter((entry) => entry.kind === "playlist").map((entry) => entry.playlist),
          totalCount: LIBRARY_TOTAL,
          offset,
          limit: 100,
        };
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const { result } = renderHook(() => useSpotifyLibrary(props));
    await act(async () => {
      await result.current.loadSpotifyLibrary();
    });
    expect(result.current.spotifyLibrary.data.folders).toHaveLength(LIBRARY_FOLDERS);
    expect(result.current.spotifyLibrary.data.playlists).toHaveLength(100 - LIBRARY_FOLDERS);

    // Start the load-more for the root folder's page 2, but do not resolve it yet.
    let loadMorePromise: Promise<void> | undefined;
    await act(async () => {
      loadMorePromise = result.current.spotifyLoadMore.library.loadMore();
    });

    // Change folder while the load-more is in flight.
    await act(async () => {
      await result.current.loadSpotifyLibrary("spotify:folder:folder-0");
    });
    expect(result.current.spotifyLibrary.data.playlists).toHaveLength(3);
    expect(result.current.spotifyLibrary.data.totalCount).toBe(3);

    // Now let the stale page-2 response resolve.
    await act(async () => {
      resolvePageTwo({
        folders: [],
        playlists: libraryItems
          .slice(100, 200)
          .filter((entry) => entry.kind === "playlist")
          .map((entry) => entry.playlist),
        totalCount: LIBRARY_TOTAL,
        offset: 100,
        limit: 100,
      });
      await loadMorePromise;
    });

    // The stale append must be dropped: only the new folder's page 1 remains.
    expect(result.current.spotifyLibrary.data.playlists).toHaveLength(3);
    expect(result.current.spotifyLibrary.data.playlists.map((playlist) => playlist.id)).toEqual([
      "playlist-900",
      "playlist-901",
      "playlist-902",
    ]);
    expect(result.current.spotifyLibrary.data.totalCount).toBe(3);
    expect(result.current.spotifyLoadMore.library.loading).toBe(false);
  });

  // O1 (liked mirror): reloading liked tracks while a liked load-more is in
  // flight must not let the stale page append onto the fresh load when it resolves.
  it("drops a liked load-more that resolves after a fresh liked load", async () => {
    let resolvePageTwo: (page: SpotifyLikedTracksPayload) => void = () => {};
    const pageTwo = new Promise<SpotifyLikedTracksPayload>((resolve) => {
      resolvePageTwo = resolve;
    });
    invoke.mockImplementation(async (command: string, args?: { offset?: number | null }) => {
      if (command === "spotify_liked_tracks") {
        const offset = args?.offset ?? 0;
        if (offset === 100) return pageTwo;
        const page = likedTracks.slice(offset, offset + 100);
        return { tracks: page, totalCount: LIKED_TOTAL, offset, limit: 100 };
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const { result } = renderHook(() => useSpotifyLibrary(props));
    await act(async () => {
      await result.current.loadSpotifyLikedTracks();
    });
    expect(result.current.spotifyLikedTracks.data.tracks).toHaveLength(100);
    expect(result.current.spotifyLikedTracks.data.totalCount).toBe(LIKED_TOTAL);

    // Start the load-more for page 2, but do not resolve it yet.
    let loadMorePromise: Promise<void> | undefined;
    await act(async () => {
      loadMorePromise = result.current.spotifyLoadMore.liked.loadMore();
    });

    // Reload liked tracks while the load-more is in flight.
    await act(async () => {
      await result.current.loadSpotifyLikedTracks();
    });
    expect(result.current.spotifyLikedTracks.data.tracks).toHaveLength(100);
    expect(result.current.spotifyLikedTracks.data.totalCount).toBe(LIKED_TOTAL);

    // Now let the stale page-2 response resolve.
    await act(async () => {
      resolvePageTwo({
        tracks: likedTracks.slice(100, 200),
        totalCount: LIKED_TOTAL,
        offset: 100,
        limit: 100,
      });
      await loadMorePromise;
    });

    // The stale append must be dropped: only the fresh load's page 1 remains.
    expect(result.current.spotifyLikedTracks.data.tracks).toHaveLength(100);
    expect(result.current.spotifyLikedTracks.data.tracks.map((track) => track.id)).toEqual(
      likedTracks.slice(0, 100).map((track) => track.id),
    );
    expect(result.current.spotifyLikedTracks.data.totalCount).toBe(LIKED_TOTAL);
    expect(result.current.spotifyLoadMore.liked.loading).toBe(false);
  });

  // Sign-out: load-mores in flight during sign-out must not repopulate the
  // library or liked state when they resolve — signed-in account data must not
  // show after sign-out.
  it("does not repopulate library or liked tracks when load-mores resolve after sign-out", async () => {
    let resolveLibraryPageTwo: (page: SpotifyLibraryNode) => void = () => {};
    const libraryPageTwo = new Promise<SpotifyLibraryNode>((resolve) => {
      resolveLibraryPageTwo = resolve;
    });
    let resolveLikedPageTwo: (page: SpotifyLikedTracksPayload) => void = () => {};
    const likedPageTwo = new Promise<SpotifyLikedTracksPayload>((resolve) => {
      resolveLikedPageTwo = resolve;
    });
    invoke.mockImplementation(async (command: string, args?: { offset?: number | null }) => {
      if (command === "spotify_library_node") {
        const offset = args?.offset ?? 0;
        if (offset === 100) return libraryPageTwo;
        const page = libraryItems.slice(offset, offset + 100);
        return {
          folders: page.filter((entry) => entry.kind === "folder").map((entry) => entry.folder),
          playlists: page.filter((entry) => entry.kind === "playlist").map((entry) => entry.playlist),
          totalCount: LIBRARY_TOTAL,
          offset,
          limit: 100,
        };
      }
      if (command === "spotify_liked_tracks") {
        const offset = args?.offset ?? 0;
        if (offset === 100) return likedPageTwo;
        const page = likedTracks.slice(offset, offset + 100);
        return { tracks: page, totalCount: LIKED_TOTAL, offset, limit: 100 };
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const { result, rerender } = renderHook((hookProps) => useSpotifyLibrary(hookProps), { initialProps: props });
    await act(async () => {
      await result.current.loadSpotifyLibrary();
    });
    await act(async () => {
      await result.current.loadSpotifyLikedTracks();
    });
    expect(result.current.spotifyLibrary.data.folders).toHaveLength(LIBRARY_FOLDERS);
    expect(result.current.spotifyLibrary.data.playlists).toHaveLength(100 - LIBRARY_FOLDERS);
    expect(result.current.spotifyLikedTracks.data.tracks).toHaveLength(100);

    // Start both load-mores, but do not resolve either yet.
    let libraryLoadMorePromise: Promise<void> | undefined;
    let likedLoadMorePromise: Promise<void> | undefined;
    await act(async () => {
      libraryLoadMorePromise = result.current.spotifyLoadMore.library.loadMore();
      likedLoadMorePromise = result.current.spotifyLoadMore.liked.loadMore();
    });

    // Sign out while both load-mores are in flight: this is what App.tsx does
    // when spotifyStatus.authenticated flips — it calls loadSpotifyProfile(),
    // whose reset branch clears the library and liked state.
    rerender({ ...props, spotifyStatus: { authenticated: false } });
    await act(async () => {
      await result.current.loadSpotifyProfile();
    });
    expect(result.current.spotifyLibrary.status).toBe("idle");
    expect(result.current.spotifyLibrary.data.folders).toHaveLength(0);
    expect(result.current.spotifyLibrary.data.playlists).toHaveLength(0);
    expect(result.current.spotifyLibrary.data.totalCount).toBe(0);
    expect(result.current.spotifyLikedTracks.status).toBe("idle");
    expect(result.current.spotifyLikedTracks.data.tracks).toHaveLength(0);
    expect(result.current.spotifyLikedTracks.data.totalCount).toBe(0);

    // Now let both stale page-2 responses resolve.
    await act(async () => {
      resolveLibraryPageTwo({
        folders: [],
        playlists: libraryItems
          .slice(100, 200)
          .filter((entry) => entry.kind === "playlist")
          .map((entry) => entry.playlist),
        totalCount: LIBRARY_TOTAL,
        offset: 100,
        limit: 100,
      });
      resolveLikedPageTwo({
        tracks: likedTracks.slice(100, 200),
        totalCount: LIKED_TOTAL,
        offset: 100,
        limit: 100,
      });
      await libraryLoadMorePromise;
      await likedLoadMorePromise;
    });

    // Neither stale page may repopulate the signed-out state.
    expect(result.current.spotifyLibrary.status).toBe("idle");
    expect(result.current.spotifyLibrary.data.folders).toHaveLength(0);
    expect(result.current.spotifyLibrary.data.playlists).toHaveLength(0);
    expect(result.current.spotifyLibrary.data.totalCount).toBe(0);
    expect(result.current.spotifyLikedTracks.status).toBe("idle");
    expect(result.current.spotifyLikedTracks.data.tracks).toHaveLength(0);
    expect(result.current.spotifyLikedTracks.data.totalCount).toBe(0);
    expect(result.current.spotifyLoadMore.library.loading).toBe(false);
    expect(result.current.spotifyLoadMore.liked.loading).toBe(false);
  });

  // N3: two fresh loads resolving out of order must not let the older one
  // overwrite the newer one's data.
  it("keeps the newer fresh load when an older one resolves after it", async () => {
    let resolveLibraryFirst: (page: SpotifyLibraryNode) => void = () => {};
    const libraryFirst = new Promise<SpotifyLibraryNode>((resolve) => {
      resolveLibraryFirst = resolve;
    });
    let resolveLikedFirst: (page: SpotifyLikedTracksPayload) => void = () => {};
    const likedFirst = new Promise<SpotifyLikedTracksPayload>((resolve) => {
      resolveLikedFirst = resolve;
    });
    let libraryCalls = 0;
    let likedCalls = 0;
    invoke.mockImplementation(async (command: string, args?: { folderUri?: string | null; offset?: number | null }) => {
      if (command === "spotify_library_node") {
        libraryCalls += 1;
        if (libraryCalls === 1) return libraryFirst;
        const folderUri = args?.folderUri ?? null;
        if (folderUri === "spotify:folder:folder-0") {
          return {
            folders: [],
            playlists: [makePlaylist(900), makePlaylist(901), makePlaylist(902)],
            totalCount: 3,
            offset: 0,
            limit: 100,
          };
        }
        const offset = args?.offset ?? 0;
        const page = libraryItems.slice(offset, offset + 100);
        return {
          folders: page.filter((entry) => entry.kind === "folder").map((entry) => entry.folder),
          playlists: page.filter((entry) => entry.kind === "playlist").map((entry) => entry.playlist),
          totalCount: LIBRARY_TOTAL,
          offset,
          limit: 100,
        };
      }
      if (command === "spotify_liked_tracks") {
        likedCalls += 1;
        if (likedCalls === 1) return likedFirst;
        const offset = args?.offset ?? 0;
        const page = likedTracks.slice(offset, offset + 100);
        return { tracks: page, totalCount: LIKED_TOTAL, offset, limit: 100 };
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const { result } = renderHook(() => useSpotifyLibrary(props));

    // Start the older fresh load of each list, but do not resolve either yet.
    let libraryFirstPromise: Promise<void> | undefined;
    let likedFirstPromise: Promise<void> | undefined;
    await act(async () => {
      libraryFirstPromise = result.current.loadSpotifyLibrary();
      likedFirstPromise = result.current.loadSpotifyLikedTracks();
    });
    expect(result.current.spotifyLibrary.status).toBe("loading");
    expect(result.current.spotifyLikedTracks.status).toBe("loading");

    // Start the newer fresh loads; these resolve first.
    await act(async () => {
      await result.current.loadSpotifyLibrary("spotify:folder:folder-0");
    });
    expect(result.current.spotifyLibrary.status).toBe("ready");
    expect(result.current.spotifyLibrary.data.playlists).toHaveLength(3);
    expect(result.current.spotifyLibrary.data.totalCount).toBe(3);
    await act(async () => {
      await result.current.loadSpotifyLikedTracks();
    });
    expect(result.current.spotifyLikedTracks.status).toBe("ready");
    expect(result.current.spotifyLikedTracks.data.tracks).toHaveLength(100);
    expect(result.current.spotifyLikedTracks.data.totalCount).toBe(LIKED_TOTAL);

    // Now let the older fresh-load responses resolve.
    await act(async () => {
      resolveLibraryFirst({
        folders: libraryItems
          .slice(0, 100)
          .filter((entry) => entry.kind === "folder")
          .map((entry) => entry.folder),
        playlists: libraryItems
          .slice(0, 100)
          .filter((entry) => entry.kind === "playlist")
          .map((entry) => entry.playlist),
        totalCount: LIBRARY_TOTAL,
        offset: 0,
        limit: 100,
      });
      resolveLikedFirst({
        tracks: likedTracks.slice(0, 100),
        totalCount: LIKED_TOTAL,
        offset: 0,
        limit: 100,
      });
      await libraryFirstPromise;
      await likedFirstPromise;
    });

    // The older responses must be dropped: the newer data remains, and the
    // status must not be stuck on loading.
    expect(result.current.spotifyLibrary.status).toBe("ready");
    expect(result.current.spotifyLibrary.data.playlists).toHaveLength(3);
    expect(result.current.spotifyLibrary.data.playlists.map((playlist) => playlist.id)).toEqual([
      "playlist-900",
      "playlist-901",
      "playlist-902",
    ]);
    expect(result.current.spotifyLibrary.data.totalCount).toBe(3);
    expect(result.current.spotifyLikedTracks.status).toBe("ready");
    expect(result.current.spotifyLikedTracks.data.tracks).toHaveLength(100);
    expect(result.current.spotifyLikedTracks.data.tracks.map((track) => track.id)).toEqual(
      likedTracks.slice(0, 100).map((track) => track.id),
    );
    expect(result.current.spotifyLikedTracks.data.totalCount).toBe(LIKED_TOTAL);
  });

  // N10: fresh loads in flight during sign-out must not repopulate the
  // library or liked state when they resolve — signed-in account data must not
  // show after sign-out.
  it("does not repopulate library or liked tracks when fresh loads resolve after sign-out", async () => {
    let resolveLibraryFresh: (page: SpotifyLibraryNode) => void = () => {};
    const libraryFresh = new Promise<SpotifyLibraryNode>((resolve) => {
      resolveLibraryFresh = resolve;
    });
    let resolveLikedFresh: (page: SpotifyLikedTracksPayload) => void = () => {};
    const likedFresh = new Promise<SpotifyLikedTracksPayload>((resolve) => {
      resolveLikedFresh = resolve;
    });
    let libraryCalls = 0;
    let likedCalls = 0;
    invoke.mockImplementation(async (command: string, args?: { folderUri?: string | null; offset?: number | null }) => {
      if (command === "spotify_library_node") {
        libraryCalls += 1;
        if (libraryCalls === 2) return libraryFresh;
        const offset = args?.offset ?? 0;
        const page = libraryItems.slice(offset, offset + 100);
        return {
          folders: page.filter((entry) => entry.kind === "folder").map((entry) => entry.folder),
          playlists: page.filter((entry) => entry.kind === "playlist").map((entry) => entry.playlist),
          totalCount: LIBRARY_TOTAL,
          offset,
          limit: 100,
        };
      }
      if (command === "spotify_liked_tracks") {
        likedCalls += 1;
        if (likedCalls === 2) return likedFresh;
        const offset = args?.offset ?? 0;
        const page = likedTracks.slice(offset, offset + 100);
        return { tracks: page, totalCount: LIKED_TOTAL, offset, limit: 100 };
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const { result, rerender } = renderHook((hookProps) => useSpotifyLibrary(hookProps), { initialProps: props });
    await act(async () => {
      await result.current.loadSpotifyLibrary();
    });
    await act(async () => {
      await result.current.loadSpotifyLikedTracks();
    });
    expect(result.current.spotifyLibrary.data.folders).toHaveLength(LIBRARY_FOLDERS);
    expect(result.current.spotifyLibrary.data.playlists).toHaveLength(100 - LIBRARY_FOLDERS);
    expect(result.current.spotifyLikedTracks.data.tracks).toHaveLength(100);

    // Start a fresh load of each list, but do not resolve either yet.
    let libraryFreshPromise: Promise<void> | undefined;
    let likedFreshPromise: Promise<void> | undefined;
    await act(async () => {
      libraryFreshPromise = result.current.loadSpotifyLibrary();
      likedFreshPromise = result.current.loadSpotifyLikedTracks();
    });
    // Both fresh loads are in flight: status is loading, not ready.
    expect(result.current.spotifyLibrary.status).toBe("loading");
    expect(result.current.spotifyLikedTracks.status).toBe("loading");

    // Sign out while both fresh loads are in flight.
    rerender({ ...props, spotifyStatus: { authenticated: false } });
    await act(async () => {
      await result.current.loadSpotifyProfile();
    });
    expect(result.current.spotifyLibrary.status).toBe("idle");
    expect(result.current.spotifyLibrary.data.folders).toHaveLength(0);
    expect(result.current.spotifyLibrary.data.playlists).toHaveLength(0);
    expect(result.current.spotifyLibrary.data.totalCount).toBe(0);
    expect(result.current.spotifyLikedTracks.status).toBe("idle");
    expect(result.current.spotifyLikedTracks.data.tracks).toHaveLength(0);
    expect(result.current.spotifyLikedTracks.data.totalCount).toBe(0);

    // Now let both stale fresh-load responses resolve.
    await act(async () => {
      resolveLibraryFresh({
        folders: libraryItems
          .slice(0, 100)
          .filter((entry) => entry.kind === "folder")
          .map((entry) => entry.folder),
        playlists: libraryItems
          .slice(0, 100)
          .filter((entry) => entry.kind === "playlist")
          .map((entry) => entry.playlist),
        totalCount: LIBRARY_TOTAL,
        offset: 0,
        limit: 100,
      });
      resolveLikedFresh({
        tracks: likedTracks.slice(0, 100),
        totalCount: LIKED_TOTAL,
        offset: 0,
        limit: 100,
      });
      await libraryFreshPromise;
      await likedFreshPromise;
    });

    // Neither stale fresh load may repopulate the signed-out state, and the
    // status must not be stuck on loading.
    expect(result.current.spotifyLibrary.status).toBe("idle");
    expect(result.current.spotifyLibrary.data.folders).toHaveLength(0);
    expect(result.current.spotifyLibrary.data.playlists).toHaveLength(0);
    expect(result.current.spotifyLibrary.data.totalCount).toBe(0);
    expect(result.current.spotifyLikedTracks.status).toBe("idle");
    expect(result.current.spotifyLikedTracks.data.tracks).toHaveLength(0);
    expect(result.current.spotifyLikedTracks.data.totalCount).toBe(0);
  });
});
