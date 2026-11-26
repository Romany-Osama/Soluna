import type { HistoryEntry } from "../../app/history";
import { RefObject, Dispatch, SetStateAction } from "react";
import { mediaSrc } from "../../lib/media";
import { LoadState, LyricsPayload, YtItem, PlayerPayload, LibraryItemState } from "../../types";
import { LyricLines } from "../lyrics/LyricLines";
import { InstrumentalInterlude } from "../lyrics/InstrumentalInterlude";
import type { LyricsFollow } from "../lyrics/useLyrics";
import type { FullscreenPlayerState } from "./useFullscreenPlayer";

/** The player view state App hands down: fullscreen mode + lyrics follow. */
export type PlayerViewProps = {
  fullscreen: FullscreenPlayerState;
  lyricsFollow: LyricsFollow;
};

export type ExpandedPlayerProps = {
  playerView: PlayerViewProps;
  activeLyricRef: RefObject<HTMLButtonElement | null>;
  adjustVolumeByWheel: (event: { deltaY: number; preventDefault: () => void }) => void;
  audioRef: RefObject<HTMLAudioElement | null>;
  backStack: HistoryEntry[];
  changeLyricsProvider: (provider: string) => Promise<void>;
  cycleRepeat: () => Promise<void>;
  durationSeconds: number;
  formatTime: (seconds: number) => string;
  forwardStack: HistoryEntry[];
  goBack: () => void;
  hasTransientLayer: boolean;
  isPlaying: boolean;
  lyrics: LoadState<LyricsPayload> | null;
  lyricsAutoScrollEnabled: boolean;
  lyricsContainerRef: RefObject<HTMLDivElement | null>;
  lyricsProviderLoading: boolean;
  lyricsProviderOrder: string[];
  lyricsProviderSelection: string;
  navigateForward: () => void;
  openLyrics: (item: YtItem) => Promise<void>;
  openPlayerMenu: () => Promise<void>;
  playbackSeconds: number;
  player: { item: YtItem; payload: PlayerPayload; session: number } | null;
  playerExpanded: boolean;
  playerItemState: LibraryItemState | null;
  playQueueIndex: (index: number) => Promise<void>;
  queueContinuation: string | null;
  queueIndex: number;
  queueItems: YtItem[];
  repeatMode: "off" | "all" | "one";
  seekByPlayerGesture: (direction: -1 | 1) => void;
  seekPlayback: (value: number) => void;
  setLyrics: Dispatch<SetStateAction<LoadState<LyricsPayload> | null>>;
  setLyricsAutoScrollEnabled: Dispatch<SetStateAction<boolean>>;
  setPlayerExpanded: Dispatch<SetStateAction<boolean>>;
  setQueueOpen: Dispatch<SetStateAction<boolean>>;
  shareItem: (item: YtItem) => Promise<void>;
  shuffleEnabled: boolean;
  togglePlayback: () => void;
  togglePlayerFavorite: () => Promise<void>;
  toggleShuffle: () => Promise<void>;
  updateVolume: (value: number) => void;
  volume: number;
};

export function ExpandedPlayer({
  playerView,
  activeLyricRef,
  adjustVolumeByWheel,
  audioRef,
  backStack,
  changeLyricsProvider,
  cycleRepeat,
  durationSeconds,
  formatTime,
  forwardStack,
  goBack,
  hasTransientLayer,
  isPlaying,
  lyrics,
  lyricsAutoScrollEnabled,
  lyricsContainerRef,
  lyricsProviderLoading,
  lyricsProviderOrder,
  lyricsProviderSelection,
  navigateForward,
  openLyrics,
  openPlayerMenu,
  playbackSeconds,
  player,
  playerExpanded,
  playerItemState,
  playQueueIndex,
  queueContinuation,
  queueIndex,
  queueItems,
  repeatMode,
  seekByPlayerGesture,
  seekPlayback,
  setLyrics,
  setLyricsAutoScrollEnabled,
  setPlayerExpanded,
  setQueueOpen,
  shareItem,
  shuffleEnabled,
  togglePlayback,
  togglePlayerFavorite,
  toggleShuffle,
  updateVolume,
  volume,
}: ExpandedPlayerProps) {
  const lyricsStatus =
    lyrics?.status === "ready"
      ? lyrics.data.instrumental
        ? "Instrumental"
        : lyrics.data.lines.some((line) => (line.words?.length ?? 0) > 0)
          ? `${lyrics.data.provider} · Word-synced`
          : lyrics.data.synced
            ? `${lyrics.data.provider} · Synced`
            : `${lyrics.data.provider} · Plain`
      : null;
  return (
    <>
      {playerExpanded && player && (
        <div
          className={
            playerView.fullscreen.view
              ? "detail-overlay player-overlay player-fullscreen-view"
              : "detail-overlay player-overlay"
          }
          role="dialog"
          aria-modal="true"
          onClick={() => {
            setPlayerExpanded(false);
            setLyrics(null);
          }}
        >
          {/* Fullscreen player ambient backdrop (behaviour studied from Liner
              as a design reference; styling values are Soluna's own): the
              cover art fills the backdrop, blurred and dimmed, so the player
              sits on the song's own colours instead of a flat gradient. */}
          {mediaSrc(player.item.thumbnail) ? (
            <div className="full-player-ambient" aria-hidden="true">
              <img src={mediaSrc(player.item.thumbnail) as string} alt="" />
            </div>
          ) : null}
          <div className="full-player-panel" onClick={(event) => event.stopPropagation()}>
            <button
              className="close-button"
              title="Close"
              aria-label="Close"
              onClick={() => {
                setPlayerExpanded(false);
                setLyrics(null);
              }}
            >
              ×
            </button>
            <div
              className="full-player-art"
              onDoubleClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                seekByPlayerGesture(event.clientX < bounds.left + bounds.width / 2 ? -1 : 1);
              }}
              title="Double-click the left or right side to seek"
            >
              {mediaSrc(player.item.thumbnail) ? (
                <img src={mediaSrc(player.item.thumbnail) as string} alt="" />
              ) : (
                <div className="item-art empty-art">M</div>
              )}
            </div>
            <div className="full-player-meta">
              <p className="eyebrow">Now playing in Soluna</p>
              <h2 className="full-player-title" title={player.payload.title || player.item.title}>
                {player.payload.title || player.item.title}
              </h2>
              <p>{player.payload.artist || player.item.subtitle}</p>
              <div className="full-player-action-row">
                <div className="full-player-actions">
                  <button
                    className="player-action"
                    onClick={() => void shareItem(player.item)}
                    title="Share"
                    aria-label="Share"
                  >
                    ↗
                  </button>
                  <button
                    className={playerItemState?.liked ? "player-action active-control" : "player-action"}
                    onClick={() => void togglePlayerFavorite()}
                    title={playerItemState?.liked ? "Remove from Soluna Liked Songs" : "Add to Soluna Liked Songs"}
                    aria-label={playerItemState?.liked ? "Remove from Soluna Liked Songs" : "Add to Soluna Liked Songs"}
                  >
                    {playerItemState?.liked ? "♥" : "♡"}
                  </button>
                  <button
                    className="player-action"
                    onClick={playerView.fullscreen.toggle}
                    title={playerView.fullscreen.view ? "Exit full screen" : "Full screen"}
                    aria-label={playerView.fullscreen.view ? "Exit full screen" : "Full screen"}
                    aria-pressed={playerView.fullscreen.view}
                  >
                    {playerView.fullscreen.view ? "⤡" : "⤢"}
                  </button>
                  <button
                    className="player-action"
                    onClick={() => void openPlayerMenu()}
                    title="More actions"
                    aria-label="More actions"
                  >
                    ⋮
                  </button>
                </div>
                <div className="full-player-controls">
                  <button
                    className="transport-button"
                    disabled={queueIndex <= 0}
                    onClick={() => void playQueueIndex(queueIndex - 1)}
                    title="Previous"
                  >
                    ‹
                  </button>
                  <button
                    className="transport-button play-button"
                    onClick={togglePlayback}
                    title={isPlaying ? "Pause" : "Play"}
                  >
                    {isPlaying ? "Ⅱ" : "▶"}
                  </button>
                  <button
                    className="transport-button"
                    disabled={queueIndex < 0 || (queueIndex + 1 >= queueItems.length && !queueContinuation)}
                    onClick={() => void playQueueIndex(queueIndex + 1)}
                    title="Next"
                  >
                    ›
                  </button>
                  <button
                    className={shuffleEnabled ? "queue-button active-control" : "queue-button"}
                    onClick={() => void toggleShuffle()}
                    title={shuffleEnabled ? "Turn shuffle off" : "Turn shuffle on"}
                    aria-label={shuffleEnabled ? "Turn shuffle off" : "Turn shuffle on"}
                    aria-pressed={shuffleEnabled}
                  >
                    ⤨
                  </button>
                  <button
                    className={repeatMode === "off" ? "queue-button" : "queue-button active-control"}
                    onClick={() => void cycleRepeat()}
                    title={`Repeat mode: ${repeatMode}`}
                    aria-label={`Repeat mode: ${repeatMode}`}
                  >
                    ↻
                  </button>
                  <button
                    className="queue-button"
                    onClick={() => setQueueOpen(true)}
                    title="Open queue"
                    aria-label="Open queue"
                  >
                    ☷
                  </button>
                </div>
              </div>
              <div className="full-player-progress">
                <span>{formatTime(playbackSeconds)}</span>
                <input
                  className="seek-slider"
                  type="range"
                  min="0"
                  max={Math.max(durationSeconds, 1)}
                  step="0.1"
                  value={Math.min(playbackSeconds, Math.max(durationSeconds, 1))}
                  onChange={(event) => seekPlayback(Number(event.currentTarget.value))}
                  aria-label="Seek"
                />
                <span>{formatTime(durationSeconds)}</span>
              </div>
              <label className="full-volume-control" title="Volume · scroll to adjust" onWheel={adjustVolumeByWheel}>
                <span>Volume</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={(event) => updateVolume(Number(event.currentTarget.value))}
                  aria-label="Volume"
                />
              </label>
            </div>
            <div className="full-player-lyrics">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Lyrics</p>
                  <h3>{lyricsStatus ?? "Soluna lyric providers"}</h3>
                  <label className="lyrics-provider-picker">
                    <span>Provider</span>
                    <select
                      value={lyricsProviderSelection}
                      onChange={(event) => void changeLyricsProvider(event.target.value)}
                      disabled={lyricsProviderLoading}
                      aria-label="Lyrics provider"
                    >
                      <option value="auto">Automatic · provider order</option>
                      {lyricsProviderOrder.map((provider) => (
                        <option key={provider} value={provider}>
                          {provider}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="lyrics-navigation">
                  <button
                    className="topbar-button icon-button"
                    onClick={goBack}
                    disabled={!hasTransientLayer && backStack.length === 0}
                    title="Back"
                    aria-label="Back"
                  >
                    ‹
                  </button>
                  <button
                    className="topbar-button icon-button"
                    onClick={navigateForward}
                    disabled={forwardStack.length === 0}
                    title="Forward"
                    aria-label="Forward"
                  >
                    ›
                  </button>
                </div>
                {lyrics?.status !== "ready" && (
                  <button className="text-button" onClick={() => void openLyrics(player.item)}>
                    Load lyrics
                  </button>
                )}
              </div>
              {lyrics?.status === "ready" && lyrics.data.synced && lyrics.data.lines.length > 0 ? (
                <LyricLines
                  lines={lyrics.data.lines}
                  activeLyricIndex={playerView.lyricsFollow.activeLyricIndex}
                  activeWordIndex={playerView.lyricsFollow.activeWordIndex}
                  activeLyricRef={activeLyricRef}
                  audioRef={audioRef}
                  lyricsContainerRef={lyricsContainerRef}
                  lyricsAutoScrollEnabled={lyricsAutoScrollEnabled}
                  playbackSeconds={playerView.lyricsFollow.playbackSeconds}
                  setLyricsAutoScrollEnabled={setLyricsAutoScrollEnabled}
                />
              ) : lyrics?.status === "ready" && lyrics.data.instrumental ? (
                <InstrumentalInterlude label="Instrumental — no lyrics, just the music" />
              ) : lyrics?.status === "ready" ? (
                <pre className="lyrics-text">{lyrics.data.text}</pre>
              ) : (
                <div className="state-panel">
                  <p>Open lyrics to load the source provider chain.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
