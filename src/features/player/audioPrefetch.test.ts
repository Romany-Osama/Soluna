// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  AUDIO_PREFETCH_MIN_PLAYED_SECONDS,
  AUDIO_PREFETCH_REMAINING_SECONDS,
  createAudioPrefetch,
  shouldPrefetchAudio,
} from "./audioPrefetch";
import type { PlayerCacheUsage, YtItem } from "../../types";

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

const usage: PlayerCacheUsage = { bytes: 0, songs: 0, limitMb: 2048 };

/** Let the fire-and-forget promise run to its next await. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const setOnline = (online: boolean) => {
  Object.defineProperty(window.navigator, "onLine", { value: online, configurable: true });
};

const prefetchCall = (index: number) => {
  const [command, args] = invoke.mock.calls[index] as [
    string,
    { videoId: string; playlistId: string | null; audioQuality: string; requestId: string },
  ];
  return { command, args };
};

describe("audio prefetch trigger threshold (PR 2)", () => {
  it("fires at 30s remaining and not at 31s", () => {
    expect(shouldPrefetchAudio(150, 180)).toBe(true);
    expect(shouldPrefetchAudio(149, 180)).toBe(false);
    expect(shouldPrefetchAudio(170, 200)).toBe(true);
    expect(shouldPrefetchAudio(169, 200)).toBe(false);
  });

  it("needs at least 5s played, even when already near the end", () => {
    expect(shouldPrefetchAudio(5, 35)).toBe(true);
    expect(shouldPrefetchAudio(4, 34)).toBe(false);
    expect(shouldPrefetchAudio(0, 180)).toBe(false);
    expect(shouldPrefetchAudio(AUDIO_PREFETCH_MIN_PLAYED_SECONDS, 200)).toBe(false);
  });

  it("never fires without a finite duration", () => {
    expect(shouldPrefetchAudio(150, 0)).toBe(false);
    expect(shouldPrefetchAudio(150, Number.NaN)).toBe(false);
    expect(shouldPrefetchAudio(Number.NaN, 200)).toBe(false);
    expect(shouldPrefetchAudio(150, Number.POSITIVE_INFINITY)).toBe(false);
    expect(shouldPrefetchAudio(200, 200)).toBe(true);
    expect(AUDIO_PREFETCH_REMAINING_SECONDS).toBe(30);
  });
});

describe("audio prefetch (PR 2)", () => {
  beforeEach(() => {
    invoke.mockReset();
    setOnline(true);
    invoke.mockImplementation((command: string) => {
      if (command === "request_cancel") return Promise.resolve(true);
      if (command === "player_cache_usage") return Promise.resolve(usage);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    setOnline(true);
  });

  it("checks the cache limit, then prefetches the next song's audio once", async () => {
    const prefetch = createAudioPrefetch();
    expect(prefetch.prefetch([song("a"), song("b"), song("c")], 0, "off", "auto", false)).toBe(true);
    await tick();
    await tick();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]).toEqual(["player_cache_usage", {}]);
    const { command, args } = prefetchCall(1);
    expect(command).toBe("player_cache_prefetch");
    expect(args.videoId).toBe("v-b");
    expect(args.playlistId).toBe(null);
    expect(args.audioQuality).toBe("auto");
    expect(args.requestId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("makes no call at the end of the queue, on repeat-one, for a local next song, or without a video id", async () => {
    const prefetch = createAudioPrefetch();
    expect(prefetch.prefetch([song("a"), song("b")], 1, "off", "auto", false)).toBe(false);
    expect(prefetch.prefetch([song("a"), song("b")], 0, "one", "auto", false)).toBe(false);
    expect(prefetch.prefetch([song("a"), song("b", { localPath: "/music/b.mp3" })], 0, "off", "auto", false)).toBe(
      false,
    );
    expect(prefetch.prefetch([song("a"), song("a")], 0, "off", "auto", false)).toBe(false);
    expect(prefetch.prefetch([song("a"), song("b", { videoId: undefined })], 0, "off", "auto", false)).toBe(false);
    await tick();
    await tick();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("makes no call when the sleep timer ends at this song", async () => {
    const prefetch = createAudioPrefetch();
    expect(prefetch.prefetch([song("a"), song("b"), song("c")], 0, "off", "auto", true)).toBe(false);
    await tick();
    await tick();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("makes no call while offline, and never asks for the cache limit", async () => {
    setOnline(false);
    const prefetch = createAudioPrefetch();
    expect(prefetch.prefetch([song("a"), song("b"), song("c")], 0, "off", "auto", false)).toBe(false);
    await tick();
    await tick();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("makes no prefetch call when the cache is off (limit 0)", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "request_cancel") return Promise.resolve(true);
      if (command === "player_cache_usage") return Promise.resolve({ ...usage, limitMb: 0 });
      return Promise.resolve(undefined);
    });
    const prefetch = createAudioPrefetch();
    expect(prefetch.prefetch([song("a"), song("b"), song("c")], 0, "off", "auto", false)).toBe(true);
    await tick();
    await tick();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]).toEqual(["player_cache_usage", {}]);
  });

  it("a failed cache-limit lookup means no prefetch and no throw", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "player_cache_usage") return Promise.reject(new Error("boom"));
      return Promise.resolve(true);
    });
    const prefetch = createAudioPrefetch();
    expect(prefetch.prefetch([song("a"), song("b"), song("c")], 0, "off", "auto", false)).toBe(true);
    await tick();
    await tick();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]).toEqual(["player_cache_usage", {}]);
  });

  it("swallows a failed prefetch silently: no throw, no other command", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "request_cancel") return Promise.resolve(true);
      if (command === "player_cache_usage") return Promise.resolve(usage);
      return Promise.reject(new Error("boom"));
    });
    const prefetch = createAudioPrefetch();
    expect(prefetch.prefetch([song("a"), song("b")], 0, "off", "auto", false)).toBe(true);
    await tick();
    await tick();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(prefetchCall(1).command).toBe("player_cache_prefetch");
  });

  it("an abort while the cache-limit gate is in flight fires no stale prefetch", async () => {
    let resolveUsage: (value: PlayerCacheUsage) => void = () => undefined;
    invoke.mockImplementation((command: string) => {
      if (command === "request_cancel") return Promise.resolve(true);
      if (command === "player_cache_usage") return new Promise<PlayerCacheUsage>((done) => (resolveUsage = done));
      return Promise.resolve(undefined);
    });
    const prefetch = createAudioPrefetch();
    expect(prefetch.prefetch([song("a"), song("b"), song("c")], 0, "off", "auto", false)).toBe(true);
    await tick();
    expect(invoke).toHaveBeenCalledTimes(1);
    // The user skips while the gate is still in flight: the song is no longer next.
    prefetch.abort();
    resolveUsage(usage);
    await tick();
    await tick();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]).toEqual(["player_cache_usage", {}]);
  });

  it("abort() cancels the in-flight prefetch", async () => {
    let resolvePrefetch: (value: undefined) => void = () => undefined;
    invoke.mockImplementation((command: string) => {
      if (command === "request_cancel") return Promise.resolve(true);
      if (command === "player_cache_usage") return Promise.resolve(usage);
      return new Promise<undefined>((done) => (resolvePrefetch = done));
    });
    const prefetch = createAudioPrefetch();
    expect(prefetch.prefetch([song("a"), song("b"), song("c")], 0, "off", "auto", false)).toBe(true);
    await tick();
    await tick();
    const requestId = prefetchCall(1).args.requestId;
    prefetch.abort();
    await tick();
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls[2]).toEqual(["request_cancel", { requestId }]);
    resolvePrefetch(undefined);
  });

  it("starting a new prefetch aborts the previous one", async () => {
    let resolveFirst: (value: undefined) => void = () => undefined;
    invoke.mockImplementation((command: string) => {
      if (command === "request_cancel") return Promise.resolve(true);
      if (command === "player_cache_usage") return Promise.resolve(usage);
      return new Promise<undefined>((done) => (resolveFirst = done));
    });
    const prefetch = createAudioPrefetch();
    expect(prefetch.prefetch([song("a"), song("b"), song("c")], 0, "off", "auto", false)).toBe(true);
    await tick();
    await tick();
    const firstRequestId = prefetchCall(1).args.requestId;
    expect(prefetch.prefetch([song("a"), song("b"), song("c")], 1, "off", "high", false)).toBe(true);
    await tick();
    await tick();
    expect(invoke).toHaveBeenCalledTimes(5);
    // usage, prefetch b, usage, request_cancel for b, prefetch c.
    expect(invoke.mock.calls[3]).toEqual(["request_cancel", { requestId: firstRequestId }]);
    const second = prefetchCall(4);
    expect(second.command).toBe("player_cache_prefetch");
    expect(second.args.videoId).toBe("v-c");
    expect(second.args.audioQuality).toBe("high");
    expect(second.args.requestId).not.toBe(firstRequestId);
    resolveFirst(undefined);
  });
});
