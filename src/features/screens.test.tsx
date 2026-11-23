// U4-001: route-level screens render on their own, outside App.tsx.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { YtItem } from "../types";
import { HomeScreen } from "./home/HomeScreen";
import { QueuePanel } from "./queue/QueuePanel";

const song = (id: string, title: string): YtItem => ({
  id,
  kind: "song",
  title,
  subtitle: "Artist",
  artists: [{ name: "Artist" }],
  videoId: id,
  thumbnail: "https://i.ytimg.com/vi/x/default.jpg",
});
const noop = () => undefined;
const asyncNoop = async () => undefined;

describe("HomeScreen", () => {
  const props = {
    hideItem: () => false,
    homeMoreLoading: false,
    loadHome: asyncNoop,
    loadHomeMore: asyncNoop,
    openItem: asyncNoop,
    openMenu: asyncNoop,
    speedDial: [],
  };

  it("shows the boot screen while Home loads", () => {
    const html = renderToStaticMarkup(<HomeScreen {...props} home={{ status: "loading", data: { sections: [] } }} />);
    expect(html).toContain("Loading Soluna");
  });

  it("renders Home sections and their items", () => {
    const html = renderToStaticMarkup(
      <HomeScreen
        {...props}
        home={{ status: "ready", data: { sections: [{ title: "Quick picks", items: [song("a", "First song")] }] } }}
      />,
    );
    expect(html).toContain("Quick picks");
    expect(html).toContain("First song");
    expect(html).not.toContain("Loading Soluna");
  });
});

describe("QueuePanel", () => {
  const items = [song("a", "First song"), song("b", "Second song")];
  const props = {
    clearQueue: noop,
    moveQueueItem: noop,
    playQueueIndex: asyncNoop,
    queueIndex: 0,
    queueItems: items,
    removeQueueItem: noop,
    setQueueOpen: noop,
    player: {
      item: items[0],
      payload: {
        videoId: "a",
        streamUrl: "https://example.invalid/a",
        mimeType: "audio/webm",
        bitrate: 0,
        expiresInSeconds: 0,
        duration: 0,
      },
      session: 1,
    },
  };

  it("lists every queued song when open", () => {
    const html = renderToStaticMarkup(<QueuePanel {...props} queueOpen />);
    expect(html).toContain("2 songs");
    expect(html).toContain("First song");
    expect(html).toContain("Second song");
  });

  it("renders nothing when closed or when nothing plays", () => {
    expect(renderToStaticMarkup(<QueuePanel {...props} queueOpen={false} />)).toBe("");
    expect(renderToStaticMarkup(<QueuePanel {...props} queueOpen player={null} />)).toBe("");
  });
});

describe("PlaylistScreen (U4-015)", () => {
  it("keeps a song that is in the playlist twice as two separately selectable rows", async () => {
    const { PlaylistScreen } = await import("./playlist/PlaylistScreen");
    const selected = new Set(["playlist:P:song:a#1"]);
    const html = renderToStaticMarkup(
      <PlaylistScreen
        audioQuality={null as never}
        closePlaylist={noop}
        isSelected={(key) => selected.has(key)}
        loadPlaylistMore={asyncNoop}
        openMenu={asyncNoop}
        playItem={asyncNoop}
        playlist={{
          status: "ready",
          data: {
            playlist: { id: "P", kind: "playlist", title: "Mix", subtitle: "", artists: [] },
            songs: [song("a", "Twice"), song("b", "Once"), song("a", "Twice")],
          },
        }}
        selectionMode
        settings={{}}
        toggleSelectedItem={noop}
      />,
    );
    const boxes = [...html.matchAll(/<input[^>]*aria-label="Select Twice"[^>]*>/g)].map((match) => match[0]);
    expect(boxes).toHaveLength(2);
    expect(boxes.map((box) => box.includes("checked"))).toEqual([false, true]);
  });

  it("offers a whole-playlist download and shows its progress and failures", async () => {
    const { PlaylistScreen } = await import("./playlist/PlaylistScreen");
    const downloadsFor = (download: object | null) =>
      ({
        playlistDownloads: [],
        statusForPlaylist: () => download,
        refreshPlaylistDownload: asyncNoop,
        refreshPlaylistDownloads: asyncNoop,
        startPlaylistDownload: noop,
        cancelPlaylistDownload: asyncNoop,
        removePlaylistDownload: noop,
      }) as never;
    const props = {
      audioQuality: null as never,
      closePlaylist: noop,
      isSelected: () => false,
      loadPlaylistMore: asyncNoop,
      openMenu: asyncNoop,
      playItem: asyncNoop,
      playlist: {
        status: "ready" as const,
        data: {
          playlist: { id: "PL1", kind: "playlist", title: "Mix", subtitle: "", artists: [] },
          songs: [song("a", "First"), song("b", "Second")],
        },
      },
      selectionMode: false,
      settings: {},
      toggleSelectedItem: noop,
      playlistDownloads: downloadsFor(null),
    };
    expect(renderToStaticMarkup(<PlaylistScreen {...props} />)).toContain("Download playlist");
    const downloading = renderToStaticMarkup(
      <PlaylistScreen
        {...props}
        playlistDownloads={downloadsFor({
          playlistId: "PL1",
          title: "Mix",
          thumbnail: null,
          artworkPath: null,
          state: "downloading",
          totalSongs: 2,
          completedSongs: 1,
          failedSongs: 0,
          failures: [],
          error: null,
          startedAt: 7,
          updatedAt: 7,
        })}
      />,
    );
    expect(downloading).toContain("Downloading… 1 of 2");
    expect(downloading).toContain("Cancel download");
    const partial = renderToStaticMarkup(
      <PlaylistScreen
        {...props}
        playlistDownloads={downloadsFor({
          playlistId: "PL1",
          title: "Mix",
          thumbnail: null,
          artworkPath: null,
          state: "partial",
          totalSongs: 2,
          completedSongs: 1,
          failedSongs: 1,
          failures: [{ songId: "b", title: "Second", error: "audio cache response failed" }],
          error: "1 of 2 songs failed to download",
          startedAt: 7,
          updatedAt: 7,
        })}
      />,
    );
    expect(partial).toContain("Downloaded with 1 failed song");
    expect(partial).toContain("Retry failed songs");
    expect(partial).toContain("Second");
  });
});
