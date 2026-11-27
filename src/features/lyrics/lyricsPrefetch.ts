// Next-song lyrics prefetch (PR 1). Fire-and-forget: when a song starts, fetch the
// next song's lyrics through the normal on-demand chain (`fetch_lyrics`, with the
// YouTube cross-check) and discard the result. The settled lyrics land in the
// SQLite `lyrics` table, so the next song's on-demand lookup is a cache hit and
// shows instantly. Never the cache-fill loop (`fetch_all_enabled_lyrics_for_cache`:
// no cross-check, no matcher) — a wrong lyric it cached would be served by the
// on-demand cache check with the cross-check never having run.
// The prefetch never touches lyrics UI state and never surfaces errors: a failed
// prefetch is invisible by design, and the on-demand path retries at song start.
import { invokeCancellable } from "../../lib/cancellable";
import { nextLyricsPrefetchTarget, type RepeatMode } from "../../lib/queue";
import type { LyricsPayload, YtItem } from "../../types";

export type LyricsPrefetch = {
  /** Fetch the next song's lyrics in the background (no-op when there is no target). */
  prefetch: (items: YtItem[], currentIndex: number, repeatMode: RepeatMode) => void;
  /** Cancel the in-flight prefetch, if any (next play, queue clear). */
  abort: () => void;
};

/** One prefetch at a time: starting a new one aborts the previous controller. */
export function createLyricsPrefetch(): LyricsPrefetch {
  let current: AbortController | null = null;
  const abort = () => {
    current?.abort();
    current = null;
  };
  const prefetch: LyricsPrefetch["prefetch"] = (items, currentIndex, repeatMode) => {
    const next = nextLyricsPrefetchTarget(items, currentIndex, repeatMode);
    if (!next) return;
    abort();
    const controller = new AbortController();
    current = controller;
    const artist = next.artists.map((value) => value.name).join(", ") || next.subtitle || "";
    void invokeCancellable<LyricsPayload>(
      "fetch_lyrics",
      {
        title: next.title,
        artist,
        duration: next.duration ?? -1,
        album: next.albumTitle ?? null,
        id: next.videoId ?? next.id,
      },
      controller.signal,
    ).catch(() => undefined);
  };
  return { prefetch, abort };
}
