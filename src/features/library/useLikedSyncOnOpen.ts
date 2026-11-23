import { useEffect, useEffectEvent, useRef } from "react";
import { invokeCancellable } from "../../lib/cancellable";
import { shouldSyncLikedSongsOnOpen } from "../../lib/likedSync";
import type { SessionStatus } from "../../types";
import type { LibraryItemsMode } from "./useLibraryData";

export type LikedSyncOnOpenDeps = {
  sessionStatus: SessionStatus;
  settings: Record<string, boolean>;
  settingsLoading: boolean;
  loadLibrary: (mode: LibraryItemsMode) => Promise<void>;
  lastLibrarySyncRef: { current: Record<string, number> };
};

/**
 * Liked Songs sync on app open: once per launch, while online and signed in and with the Liked
 * Songs toggle (and the master YouTube Music library sync) on, syncs the "LM" Liked Songs playlist
 * into the local SQLite library so new likes are picked up. Silent by design: offline, or with a
 * stale session, the full liked list already in SQLite is what the Liked filter shows, and opening
 * that filter surfaces any sync error then. Marks the 5-minute library throttle so opening the
 * Liked filter right after start-up does not sync twice. If the app opens offline, the sync runs
 * once the network returns instead of waiting for the next launch.
 */
export function useLikedSyncOnOpen({
  sessionStatus,
  settings,
  settingsLoading,
  loadLibrary,
  lastLibrarySyncRef,
}: LikedSyncOnOpenDeps) {
  const syncedRef = useRef(false);
  // `settingsLoading` starts false, goes true while the stored settings load, then false again:
  // only sync once a real stored value (not the in-code default) has been seen.
  const sawSettingsLoadingRef = useRef(false);
  const sync = useEffectEvent(() => {
    // Only sync once the stored settings have finished loading: the in-code defaults must not
    // trigger a sync before a stored `likedSongsSync: false` has been read.
    if (syncedRef.current || settingsLoading || !sawSettingsLoadingRef.current) return;
    if (
      !shouldSyncLikedSongsOnOpen({
        authenticated: sessionStatus.authenticated,
        ytmSync: settings.ytmSync !== false,
        likedSongsSync: settings.likedSongsSync !== false,
        online: navigator.onLine,
        alreadySynced: false,
      })
    ) {
      return;
    }
    syncedRef.current = true;
    void (async () => {
      try {
        await invokeCancellable<{ likedSongs: number; librarySongs: number; uploadedSongs: number }>(
          "sync_youtube_library",
          { mode: "liked" },
        );
        lastLibrarySyncRef.current.liked = Date.now();
        await loadLibrary("liked");
      } catch {
        // Offline or session expired: stay on the local liked list; the flag stays set so a failed
        // start-up sync is not retried until the next app open.
      }
    })();
  });
  useEffect(() => {
    if (settingsLoading) sawSettingsLoadingRef.current = true;
    sync();
  }, [sessionStatus.authenticated, settingsLoading, settings.ytmSync, settings.likedSongsSync]);
  useEffect(() => {
    window.addEventListener("online", sync);
    return () => window.removeEventListener("online", sync);
  }, []);
}
