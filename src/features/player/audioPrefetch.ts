// Next-song audio prefetch (PR 2). Fire-and-forget: near the end of the current song, resolve
// the next song's stream and copy it into the playback cache (disk only, no RAM copy) through
// `player_cache_prefetch`, so the next song starts from the cached file instead of resolving
// and streaming. Audio only: the backend command never fetches or writes lyrics, so PR 1's
// cross-checked lyrics are never overwritten by an unchecked fill-loop lyric. Errors are
// swallowed: a failed prefetch is invisible by design, and the on-demand path plays the song
// normally.
import { invokeIpc } from "../../ipc/bindings";
import { invokeCancellable } from "../../lib/cancellable";
import { nextLyricsPrefetchTarget, type RepeatMode } from "../../lib/queue";
import { streamRequest, type AudioQuality } from "../../lib/audioQuality";
import type { PlayerCacheUsage, YtItem } from "../../types";

/** Seconds of the current song left when the prefetch fires. */
export const AUDIO_PREFETCH_REMAINING_SECONDS = 30;
/** The song must have played at least this long: a fresh play that is already near its end does not prefetch. */
export const AUDIO_PREFETCH_MIN_PLAYED_SECONDS = 5;

/** True when the current song is near enough its end to prefetch the next one. */
export function shouldPrefetchAudio(currentTime: number, duration: number): boolean {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) return false;
  if (currentTime < AUDIO_PREFETCH_MIN_PLAYED_SECONDS) return false;
  return duration - currentTime <= AUDIO_PREFETCH_REMAINING_SECONDS;
}

export type AudioPrefetch = {
  /**
   * Prefetch the next song's audio into the disk cache. Returns true when an attempt
   * started (a target exists, it has a video id, the sleep timer does not end this song,
   * and the device is online); the async cache-limit gate may still skip it. False
   * means nothing started, so the caller may try again on a later tick.
   */
  prefetch: (
    items: YtItem[],
    currentIndex: number,
    repeatMode: RepeatMode,
    audioQuality: AudioQuality,
    sleepTimerEndOfSong: boolean,
  ) => boolean;
  /** Cancel the in-flight prefetch, if any (next play, queue clear). */
  abort: () => void;
};

/** One prefetch at a time: starting a new one aborts the previous controller. */
export function createAudioPrefetch(): AudioPrefetch {
  let current: AbortController | null = null;
  let generation = 0;
  const abort = () => {
    current?.abort();
    current = null;
    generation += 1;
  };
  const prefetch: AudioPrefetch["prefetch"] = (items, currentIndex, repeatMode, audioQuality, sleepTimerEndOfSong) => {
    const next = nextLyricsPrefetchTarget(items, currentIndex, repeatMode);
    if (!next || !next.videoId || sleepTimerEndOfSong) return false;
    if (!navigator.onLine) return false;
    // The cache-limit gate is async, so a skip that lands while it is in flight must not
    // fire a stale prefetch for a song that is no longer next: the generation moves on
    // abort, and the continuation checks it before firing.
    const startedGeneration = generation;
    void (async () => {
      let usage: PlayerCacheUsage;
      try {
        usage = await invokeIpc("player_cache_usage", {});
      } catch {
        return;
      }
      if (usage.limitMb === 0) return;
      if (startedGeneration !== generation) return;
      abort();
      const controller = new AbortController();
      current = controller;
      await invokeCancellable<void>(
        "player_cache_prefetch",
        { ...streamRequest(next, audioQuality) },
        controller.signal,
      ).catch(() => undefined);
    })();
    return true;
  };
  return { prefetch, abort };
}
