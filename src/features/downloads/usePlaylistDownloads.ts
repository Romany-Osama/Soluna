import { invokeApp as invoke } from "../../ipc/bindings";
import { listenEvent } from "../../lib/events";
import { useCallback, useEffect, useState } from "react";
import { AudioQuality } from "../../lib/audioQuality";
import { errorMessage } from "../../lib/util";
import { PlaylistDownloadStatus, YtItem } from "../../types";
import type { SetNotice } from "../../app/notifications";
import type { Destructive } from "../../app/destructive";

export type PlaylistDownloadsDeps = {
  audioQuality: AudioQuality;
  setNotice: SetNotice;
  destructive: Destructive;
};

const POLL_MS = 2000;

/** Whole-playlist downloads: one action, progress, and the per-song failures. */
export function usePlaylistDownloads({ audioQuality, setNotice, destructive }: PlaylistDownloadsDeps) {
  const [playlistDownloads, setPlaylistDownloads] = useState<PlaylistDownloadStatus[]>([]);

  const mergeStatus = useCallback((status: PlaylistDownloadStatus) => {
    setPlaylistDownloads((current) => {
      const index = current.findIndex((entry) => entry.playlistId === status.playlistId);
      if (index < 0) return [...current, status];
      const next = [...current];
      next[index] = status;
      return next;
    });
  }, []);

  const refreshPlaylistDownloads = useCallback(async () => {
    try {
      const result = await invoke<PlaylistDownloadStatus[]>("playlist_downloads", {});
      // The backend always returns an array; anything else (a stale mock, a proxy) must not
      // replace the list with a non-array the polling effect would crash on.
      if (Array.isArray(result)) setPlaylistDownloads(result);
    } catch {
      // The badge/progress just keeps its last state; the next poll retries.
    }
  }, []);

  const refreshPlaylistDownload = useCallback(
    async (playlistId: string) => {
      try {
        const status = await invoke<PlaylistDownloadStatus | null>("playlist_download_status", {
          playlistId,
        });
        if (status) mergeStatus(status);
      } catch {
        // Keep the last known state; the next poll retries.
      }
    },
    [mergeStatus],
  );

  // Load the known downloads once, then poll while any playlist is still downloading.
  useEffect(() => {
    void refreshPlaylistDownloads();
  }, [refreshPlaylistDownloads]);
  useEffect(() => {
    if (!playlistDownloads.some((entry) => entry.state === "downloading")) return;
    const timer = setInterval(() => void refreshPlaylistDownloads(), POLL_MS);
    return () => clearInterval(timer);
  }, [playlistDownloads, refreshPlaylistDownloads]);

  // A song finishing (or failing) inside a playlist download is a per-song `download-state`
  // event; refresh the playlist row when one ends so progress moves without waiting for the poll.
  useEffect(() => {
    let stop: (() => void) | undefined;
    void listenEvent("download-state", (payload) => {
      if (payload.state === "completed" || payload.state === "failed" || payload.state === "cancelled") {
        void refreshPlaylistDownloads();
      }
    }).then((unlisten) => {
      stop = unlisten;
    });
    return () => stop?.();
  }, [refreshPlaylistDownloads]);

  const statusForPlaylist = useCallback(
    (playlistId: string | null | undefined) =>
      playlistId ? (playlistDownloads.find((entry) => entry.playlistId === playlistId) ?? null) : null,
    [playlistDownloads],
  );

  /**
   * Starts (or retries) a whole-playlist download. Already-downloaded songs are skipped by the
   * backend, so retrying after a partial download only fetches what failed. The command itself runs
   * until the playlist finishes, so it is fired without awaiting; progress comes from polling.
   */
  const startPlaylistDownload = useCallback(
    (playlist: YtItem, songs: YtItem[]) => {
      const downloadable = songs.filter((song) => song.videoId && !song.localPath);
      if (downloadable.length === 0) {
        setNotice("No song in this playlist has a remote source video to download.", "warning");
        return;
      }
      const total = songs.length;
      setNotice(`Downloading “${playlist.title}” for offline playback (${downloadable.length} of ${total} songs)…`);
      // Optimistic row so the button shows progress immediately; polling replaces it with the real counts.
      mergeStatus({
        playlistId: playlist.id,
        title: playlist.title,
        thumbnail: playlist.thumbnail,
        artworkPath: null,
        state: "downloading",
        totalSongs: total,
        completedSongs: 0,
        failedSongs: 0,
        failures: [],
        error: null,
        startedAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      });
      void invoke<PlaylistDownloadStatus>("playlist_download_start", {
        playlist,
        songs,
        audioQuality,
      })
        .then((status) => {
          mergeStatus(status);
          if (status.state === "completed") {
            setNotice(`“${playlist.title}” is downloaded for offline playback.`, "success");
          } else if (status.state === "partial") {
            setNotice(
              `“${playlist.title}” downloaded with ${status.failedSongs} failed song${status.failedSongs === 1 ? "" : "s"} — retry to fetch the rest.`,
              "warning",
            );
          } else if (status.state === "failed") {
            setNotice(`Could not download “${playlist.title}”: ${status.error ?? "every song failed."}`, "error");
          }
        })
        .catch((error) => {
          setNotice(`Playlist download failed: ${errorMessage(error)}`, "error");
          void refreshPlaylistDownload(playlist.id);
        });
    },
    [audioQuality, mergeStatus, refreshPlaylistDownload, setNotice],
  );

  const cancelPlaylistDownload = useCallback(
    async (playlistId: string, title: string) => {
      try {
        await invoke("playlist_download_cancel", { playlistId });
        setNotice(`Cancelling playlist download for “${title}”…`);
      } catch (error) {
        setNotice(`Could not cancel playlist download: ${errorMessage(error)}`, "error");
      }
    },
    [setNotice],
  );

  /** Removes the playlist-download record and its photo (permanent: asks first). The playlist, its songs and their individual downloads stay. */
  const removePlaylistDownload = useCallback(
    (playlistId: string, title: string) =>
      destructive({
        severity: "permanent",
        key: `playlist-download-remove:${playlistId}`,
        confirm: {
          title: "Remove playlist download?",
          message: `The playlist download record and photo for “${title}” are removed. The playlist and any individually downloaded songs stay.`,
          confirmLabel: "Remove playlist download",
        },
        commit: async () => {
          await invoke("playlist_download_remove", { playlistId });
          setPlaylistDownloads((current) => current.filter((entry) => entry.playlistId !== playlistId));
        },
        success: `Removed playlist download for “${title}”.`,
        failure: "Could not remove playlist download",
      }),
    [destructive],
  );

  return {
    playlistDownloads,
    statusForPlaylist,
    refreshPlaylistDownload,
    refreshPlaylistDownloads,
    startPlaylistDownload,
    cancelPlaylistDownload,
    removePlaylistDownload,
  };
}

/** "3 of 12" progress text for a playlist download status, or null when it has no total yet. */
export function playlistDownloadProgress(status: PlaylistDownloadStatus | null): string | null {
  if (!status || status.totalSongs <= 0) return null;
  return `${status.completedSongs + status.failedSongs} of ${status.totalSongs}`;
}

/** Everything a playlist screen needs to show and drive a whole-playlist download. */
export type PlaylistDownloadActions = ReturnType<typeof usePlaylistDownloads>;
