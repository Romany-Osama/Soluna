import { useEffect } from "react";
import type { RefObject } from "react";
import type { SetNotice } from "../../app/notifications";
import { errorMessage } from "../../lib/util";
import type { PlayerPayload, YtItem } from "../../types";

export type MediaSessionPlayer = {
  item: YtItem;
  payload: PlayerPayload;
  session: number;
};

export type MediaSessionDeps = {
  player: MediaSessionPlayer | null;
  audioRef: RefObject<HTMLAudioElement | null>;
  playbackSeconds: number;
  durationSeconds: number;
  queueIndex: number;
  queueItems: YtItem[];
  queueContinuation: string | null;
  seekPlayback: (value: number) => void;
  playQueueIndexRef: RefObject<(index: number) => void>;
  setNotice: SetNotice;
};

/**
 * Wire the OS media controls (lock screen, notification shade, headset
 * buttons) to the current player via navigator.mediaSession: metadata for the
 * playing item, and handlers for play / pause / seek / previous / next.
 * Nothing here owns playback state — it only mirrors what App already knows
 * into the platform session, and clears the session when playback stops.
 */
export function useMediaSession({
  player,
  audioRef,
  playbackSeconds,
  durationSeconds,
  queueIndex,
  queueItems,
  queueContinuation,
  seekPlayback,
  playQueueIndexRef,
  setNotice,
}: MediaSessionDeps) {
  useEffect(() => {
    const mediaSession = navigator.mediaSession;
    if (!mediaSession) return;
    const setHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {
        /* WebView2 may not support every action. */
      }
    };
    if (!player) {
      mediaSession.metadata = null;
      for (const action of [
        "play",
        "pause",
        "seekbackward",
        "seekforward",
        "seekto",
        "previoustrack",
        "nexttrack",
      ] as MediaSessionAction[])
        setHandler(action, null);
      return;
    }
    mediaSession.metadata = new MediaMetadata({
      title: player.payload.title || player.item.title,
      artist: player.payload.artist || player.item.subtitle,
      album: player.item.albumTitle || "Soluna Desktop",
    });
    setHandler("play", () => {
      if (audioRef.current)
        void audioRef.current
          .play()
          .catch((error) => setNotice(`Audio playback failed: ${errorMessage(error)}`, "error"));
    });
    setHandler("pause", () => audioRef.current?.pause());
    setHandler("seekbackward", () => {
      const current = audioRef.current?.currentTime ?? playbackSeconds;
      seekPlayback(Math.max(0, current - 10));
    });
    setHandler("seekforward", () => {
      const current = audioRef.current?.currentTime ?? playbackSeconds;
      seekPlayback(Math.min(durationSeconds || Number.MAX_SAFE_INTEGER, current + 10));
    });
    setHandler("seekto", (details) => {
      if (details.seekTime !== undefined)
        seekPlayback(Math.max(0, Math.min(durationSeconds || Number.MAX_SAFE_INTEGER, details.seekTime)));
    });
    setHandler("previoustrack", () => {
      if (queueIndex > 0) void playQueueIndexRef.current(queueIndex - 1);
    });
    setHandler("nexttrack", () => {
      if (queueIndex + 1 < queueItems.length || queueContinuation) void playQueueIndexRef.current(queueIndex + 1);
    });
    return () => {
      mediaSession.metadata = null;
      for (const action of [
        "play",
        "pause",
        "seekbackward",
        "seekforward",
        "seekto",
        "previoustrack",
        "nexttrack",
      ] as MediaSessionAction[])
        setHandler(action, null);
    };
  }, [
    durationSeconds,
    playbackSeconds,
    player?.item.id,
    player?.item.title,
    player?.item.subtitle,
    player?.item.albumTitle,
    player?.payload.artist,
    player?.payload.title,
    queueContinuation,
    queueIndex,
    queueItems.length,
    player,
    setNotice,
    seekPlayback,
    audioRef,
    playQueueIndexRef,
  ]);
}
