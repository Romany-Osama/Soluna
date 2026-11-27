import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { invokeCancellable } from "../../lib/cancellable";
import { nextLyricsPrefetchTarget } from "../../lib/queue";
import { createLyricsPrefetch } from "./lyricsPrefetch";
import type { LyricsPayload, YtItem } from "../../types";

const song = (id: string, overrides: Partial<YtItem> = {}): YtItem => ({
  id,
  kind: "song",
  title: `Song ${id}`,
  subtitle: `Artist ${id}`,
  artists: [{ name: `Artist ${id}` }],
  videoId: `v-${id}`,
  duration: 200,
  albumTitle: `Album ${id}`,
  ...overrides,
});

const payload: LyricsPayload = {
  provider: "LrcLib",
  text: "[00:01.00]la",
  synced: true,
  matchedTitle: "Song b",
  matchedArtist: "Artist b",
  lines: [],
  instrumental: false,
};

/** Let the fire-and-forget promise run to its first await. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const fetchLyricsCall = (index: number) => {
  const [command, args] = invoke.mock.calls[index] as [
    string,
    { title: string; artist: string; duration: number; album: string | null; id: string; requestId: string },
  ];
  return { command, args };
};

describe("lyrics prefetch (PR 1)", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((command: string) =>
      command === "request_cancel" ? Promise.resolve(true) : Promise.resolve(payload),
    );
  });

  it("fetches the next song's lyrics once and discards the result", async () => {
    const prefetch = createLyricsPrefetch();
    prefetch.prefetch([song("a"), song("b"), song("c")], 0, "off");
    await tick();
    expect(invoke).toHaveBeenCalledTimes(1);
    const { command, args } = fetchLyricsCall(0);
    expect(command).toBe("fetch_lyrics");
    expect(args.title).toBe("Song b");
    expect(args.artist).toBe("Artist b");
    expect(args.duration).toBe(200);
    expect(args.album).toBe("Album b");
    expect(args.id).toBe("v-b");
    expect(args.requestId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("makes no call at the end of the queue, on repeat-one, or for a local next song", async () => {
    const prefetch = createLyricsPrefetch();
    prefetch.prefetch([song("a"), song("b")], 1, "off");
    prefetch.prefetch([song("a"), song("b")], 0, "one");
    prefetch.prefetch([song("a"), song("b", { localPath: "/music/b.mp3" })], 0, "off");
    prefetch.prefetch([song("a"), song("a")], 0, "off");
    await tick();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("starting a new prefetch aborts the previous one", async () => {
    let resolveFirst: (value: LyricsPayload) => void = () => undefined;
    invoke.mockImplementation((command: string) =>
      command === "request_cancel"
        ? Promise.resolve(true)
        : new Promise<LyricsPayload>((done) => (resolveFirst = done)),
    );
    const prefetch = createLyricsPrefetch();
    prefetch.prefetch([song("a"), song("b"), song("c")], 0, "off");
    await tick();
    const firstRequestId = fetchLyricsCall(0).args.requestId;
    prefetch.prefetch([song("a"), song("b"), song("c")], 1, "off");
    await tick();
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls[1]).toEqual(["request_cancel", { requestId: firstRequestId }]);
    const second = fetchLyricsCall(2);
    expect(second.command).toBe("fetch_lyrics");
    expect(second.args.title).toBe("Song c");
    expect(second.args.requestId).not.toBe(firstRequestId);
    resolveFirst(payload);
  });

  it("abort() cancels the in-flight prefetch", async () => {
    // The fetch must still be in flight when abort() runs: once it resolves,
    // invokeCancellable stops listening and there is nothing left to cancel.
    let resolveFetch: (value: LyricsPayload) => void = () => undefined;
    invoke.mockImplementation((command: string) =>
      command === "request_cancel"
        ? Promise.resolve(true)
        : new Promise<LyricsPayload>((done) => (resolveFetch = done)),
    );
    const prefetch = createLyricsPrefetch();
    prefetch.prefetch([song("a"), song("b"), song("c")], 0, "off");
    await tick();
    const requestId = fetchLyricsCall(0).args.requestId;
    prefetch.abort();
    await tick();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]).toEqual(["request_cancel", { requestId }]);
    resolveFetch(payload);
  });

  it("swallows a failed prefetch silently: no throw, no other command", async () => {
    invoke.mockImplementation((command: string) =>
      command === "request_cancel" ? Promise.resolve(true) : Promise.reject(new Error("boom")),
    );
    const prefetch = createLyricsPrefetch();
    expect(() => prefetch.prefetch([song("a"), song("b")], 0, "off")).not.toThrow();
    await tick();
    await tick();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(fetchLyricsCall(0).command).toBe("fetch_lyrics");
  });

  it("a queue edit mid-flight does not cancel or refire the prefetch", async () => {
    let resolveFetch: (value: LyricsPayload) => void = () => undefined;
    invoke.mockImplementation((command: string) =>
      command === "request_cancel"
        ? Promise.resolve(true)
        : new Promise<LyricsPayload>((done) => (resolveFetch = done)),
    );
    const prefetch = createLyricsPrefetch();
    const queue = [song("a"), song("b"), song("c")];
    prefetch.prefetch(queue, 0, "off");
    await tick();
    // "Play next" inserts x after the current song while the fetch for b runs.
    const edited = [song("a"), song("x"), song("b"), song("c")];
    resolveFetch(payload);
    await tick();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(fetchLyricsCall(0).args.title).toBe("Song b");
    // The new next song (x) is only prefetched at the next song start — the
    // helper already points at it for that later call.
    expect(nextLyricsPrefetchTarget(edited, 0, "off")?.id).toBe("x");
  });

  it("a shuffle toggle mid-song leaves the fired target unchanged", async () => {
    const prefetch = createLyricsPrefetch();
    const queue = [song("a"), song("b"), song("c")];
    prefetch.prefetch(queue, 0, "off");
    await tick();
    // Toggling shuffle only flips the flag; the live queue is not reordered.
    expect(nextLyricsPrefetchTarget(queue, 0, "off")?.id).toBe("b");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(fetchLyricsCall(0).args.title).toBe("Song b");
  });

  it("the race: an aborted prefetch does not block the on-demand lookup for the same song", async () => {
    let resolveFetch: (value: LyricsPayload) => void = () => undefined;
    invoke.mockImplementation((command: string) =>
      command === "request_cancel"
        ? Promise.resolve(true)
        : new Promise<LyricsPayload>((done) => (resolveFetch = done)),
    );
    const prefetch = createLyricsPrefetch();
    prefetch.prefetch([song("a"), song("b"), song("c")], 0, "off");
    await tick();
    // The song starts: playItem aborts the prefetch, then the on-demand lookup runs.
    prefetch.abort();
    await tick();
    const onDemand = new AbortController();
    const pending = invokeCancellable<LyricsPayload>(
      "fetch_lyrics",
      { title: "Song b", artist: "Artist b", duration: 200, album: "Album b", id: "v-b" },
      onDemand.signal,
    );
    await tick();
    resolveFetch(payload);
    await expect(pending).resolves.toBe(payload);
    const commands = invoke.mock.calls.map((call) => call[0]);
    expect(commands).toEqual(["fetch_lyrics", "request_cancel", "fetch_lyrics"]);
  });
});
