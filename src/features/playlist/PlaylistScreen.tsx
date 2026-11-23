import { InlineLikeButton } from "../../components/InlineLikeButton";
import { AudioQuality } from "../../lib/audioQuality";
import { mediaSrc } from "../../lib/media";
import { YtItem, LoadState, PlaylistPage } from "../../types";
import { withOccurrences } from "../../lib/identity";
import type { PlaylistDownloadActions } from "../downloads/usePlaylistDownloads";
import { useEffect, useRef } from "react";

export type PlaylistScreenProps = {
  audioQuality: AudioQuality;
  loadPlaylistMore: () => Promise<void>;
  openMenu: (item: YtItem) => Promise<void>;
  playItem: (
    item: YtItem,
    sourceQueue?: YtItem[],
    sourceIndex?: number,
    sourceContinuation?: string | null,
    autoMixStart?: boolean,
    sourceContinuationKind?: "next" | "playlist",
  ) => Promise<void>;
  playlist: LoadState<PlaylistPage> | null;
  /** Whether the row with this occurrence key is selected (U4-015). */
  isSelected: (key: string) => boolean;
  selectionMode: boolean;
  closePlaylist: () => void;
  settings: Record<string, boolean>;
  toggleSelectedItem: (item: YtItem, key?: string) => void;
  /** Whole-playlist download state and actions for the open playlist. */
  playlistDownloads?: PlaylistDownloadActions | null;
};

export function PlaylistScreen({
  audioQuality,
  loadPlaylistMore,
  openMenu,
  playItem,
  playlist,
  isSelected,
  selectionMode,
  closePlaylist,
  settings,
  toggleSelectedItem,
  playlistDownloads,
}: PlaylistScreenProps) {
  // Latest playlist page for the download handler: `loadPlaylistMore` updates the cache (and this
  // component) after it resolves, so the closure's `playlist` would still hold the first page.
  const playlistRef = useRef(playlist);
  useEffect(() => {
    playlistRef.current = playlist;
  });
  const playlistDownload = playlistDownloads?.statusForPlaylist(
    playlist?.status === "ready" ? playlist.data.playlist.id : null,
  );
  /** Loads every remaining page first, so the download covers the whole playlist, not just the songs loaded so far (the backend also tops up from YouTube when signed in). */
  const downloadPlaylist = async () => {
    if (!playlistDownloads) return;
    let guard = 0;
    while (playlistRef.current?.status === "ready" && playlistRef.current.data.continuation && guard < 25) {
      guard += 1;
      await loadPlaylistMore();
    }
    const current = playlistRef.current;
    if (current?.status === "ready") playlistDownloads.startPlaylistDownload(current.data.playlist, current.data.songs);
  };
  const downloadDone = (playlistDownload?.completedSongs ?? 0) + (playlistDownload?.failedSongs ?? 0);
  const downloadTotal = playlistDownload?.totalSongs ?? 0;
  const downloadPercent = downloadTotal > 0 ? Math.round((downloadDone / downloadTotal) * 100) : 0;
  return (
    <>
      {playlist && (
        <div className="detail-overlay" role="dialog" aria-modal="true">
          <div className="detail-panel" data-screen-scroll>
            <button className="close-button" title="Close" aria-label="Close" onClick={closePlaylist}>
              ×
            </button>
            {playlist.status === "loading" && (
              <div className="state-panel">
                <div className="spinner" />
                <p>Loading playlist songs…</p>
              </div>
            )}
            {playlist.status === "error" && (
              <div className="state-panel error">
                <h2>Playlist unavailable</h2>
                <p>{playlist.error}</p>
              </div>
            )}
            {playlist.status === "ready" && (
              <>
                <div className="playlist-header">
                  {mediaSrc(playlistDownload?.artworkPath ?? playlist.data.playlist.thumbnail) && (
                    <img
                      src={mediaSrc(playlistDownload?.artworkPath ?? playlist.data.playlist.thumbnail) as string}
                      alt=""
                    />
                  )}
                  <div>
                    <p className="eyebrow">Playlist</p>
                    <h2>{playlist.data.playlist.title}</h2>
                    <p>{playlist.data.playlist.subtitle}</p>
                  </div>
                  {playlistDownloads && (
                    <div className="playlist-download">
                      {playlistDownload?.state === "downloading" ? (
                        <>
                          <p>
                            Downloading… {downloadDone} of {downloadTotal}
                          </p>
                          <div
                            className="download-progress"
                            role="progressbar"
                            aria-valuenow={downloadDone}
                            aria-valuemin={0}
                            aria-valuemax={downloadTotal}
                            aria-label={`Playlist download progress ${downloadPercent}%`}
                          >
                            <span style={{ width: `${downloadPercent}%` }} />
                          </div>
                          <button
                            className="secondary-button"
                            onClick={() =>
                              void playlistDownloads.cancelPlaylistDownload(
                                playlist.data.playlist.id,
                                playlist.data.playlist.title,
                              )
                            }
                          >
                            Cancel download
                          </button>
                        </>
                      ) : playlistDownload?.state === "completed" ? (
                        <>
                          <p>Downloaded for offline playback</p>
                          <button
                            className="secondary-button"
                            onClick={() =>
                              void playlistDownloads.removePlaylistDownload(
                                playlist.data.playlist.id,
                                playlist.data.playlist.title,
                              )
                            }
                          >
                            Remove download
                          </button>
                        </>
                      ) : playlistDownload?.state === "partial" ? (
                        <>
                          <p>
                            Downloaded with {playlistDownload.failedSongs} failed song
                            {playlistDownload.failedSongs === 1 ? "" : "s"}
                          </p>
                          <button className="primary-button" onClick={() => void downloadPlaylist()}>
                            Retry failed songs
                          </button>
                          <button
                            className="secondary-button"
                            onClick={() =>
                              void playlistDownloads.removePlaylistDownload(
                                playlist.data.playlist.id,
                                playlist.data.playlist.title,
                              )
                            }
                          >
                            Remove download
                          </button>
                          {playlistDownload.failures.length > 0 && (
                            <details className="playlist-download-failures">
                              <summary>See failed songs ({playlistDownload.failures.length})</summary>
                              <ul>
                                {playlistDownload.failures.map((failure) => (
                                  <li key={failure.songId}>
                                    <strong>{failure.title}</strong> — {failure.error}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </>
                      ) : playlistDownload?.state === "failed" ? (
                        <>
                          <p>Download failed{playlistDownload.error ? `: ${playlistDownload.error}` : ""}</p>
                          <button className="primary-button" onClick={() => void downloadPlaylist()}>
                            Retry download
                          </button>
                        </>
                      ) : (
                        <button className="primary-button" onClick={() => void downloadPlaylist()}>
                          Download playlist
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="playlist-songs">
                  {playlist.data.songs.length === 0 ? (
                    <div className="state-panel">
                      <p>YouTube Music returned no playlist songs.</p>
                    </div>
                  ) : (
                    withOccurrences(playlist.data.songs, `playlist:${playlist.data.playlist.id}`).map(
                      ({ item: song, key, index }) => (
                        <div className="song-row-wrap" key={key}>
                          {selectionMode && (
                            <input
                              className="selection-checkbox"
                              type="checkbox"
                              checked={isSelected(key)}
                              onChange={() => toggleSelectedItem(song, key)}
                              aria-label={`Select ${song.title}`}
                            />
                          )}
                          <button
                            className="song-row"
                            onClick={() =>
                              void playItem(
                                song,
                                playlist.data.songs,
                                index,
                                playlist.data.continuation ?? null,
                                false,
                                "playlist",
                              )
                            }
                          >
                            <span className="song-index">{index + 1}</span>
                            {mediaSrc(song.thumbnail) && <img src={mediaSrc(song.thumbnail) as string} alt="" />}
                            <span className="song-copy">
                              <strong>{song.title}</strong>
                              <small>{song.subtitle}</small>
                            </span>
                            <span className="song-kind">{song.kind}</span>
                          </button>
                          {song.kind === "song" && (
                            <InlineLikeButton
                              item={song}
                              autoDownloadOnLike={settings.autoDownloadOnLike === true}
                              audioQuality={audioQuality}
                            />
                          )}
                          <button
                            className="song-row-menu"
                            onClick={() => void openMenu(song)}
                            title={`More options for ${song.title}`}
                            aria-label={`More options for ${song.title}`}
                          >
                            ⋮
                          </button>
                        </div>
                      ),
                    )
                  )}
                </div>
                {playlist.data.continuation && (
                  <button className="primary-button playlist-more" onClick={() => void loadPlaylistMore()}>
                    Load more songs
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
