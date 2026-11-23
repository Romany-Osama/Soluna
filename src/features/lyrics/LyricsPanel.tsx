import type { HistoryEntry } from "../../app/history";
import { RefObject, Dispatch, SetStateAction } from "react";
import { LoadState, LyricsPayload } from "../../types";
import { LyricLines } from "./LyricLines";
import { InstrumentalInterlude } from "./InstrumentalInterlude";
import { findInstrumentalSection } from "./instrumental";

export type LyricsPanelProps = {
  activeLyricIndex: number;
  activeLyricRef: RefObject<HTMLButtonElement | null>;
  audioRef: RefObject<HTMLAudioElement | null>;
  backStack: HistoryEntry[];
  changeLyricsProvider: (provider: string) => Promise<void>;
  forwardStack: HistoryEntry[];
  goBack: () => void;
  hasTransientLayer: boolean;
  lyrics: LoadState<LyricsPayload> | null;
  lyricsContainerRef: RefObject<HTMLDivElement | null>;
  lyricsProviderLoading: boolean;
  lyricsProviderOrder: string[];
  lyricsProviderSelection: string;
  navigateForward: () => void;
  playerExpanded: boolean;
  playbackSeconds: number;
  /** Track duration in seconds; 0 when unknown (the outro/whole-track end). */
  durationSeconds: number;
  setLyrics: Dispatch<SetStateAction<LoadState<LyricsPayload> | null>>;
  setLyricsAutoScrollEnabled: Dispatch<SetStateAction<boolean>>;
};

export function LyricsPanel({
  activeLyricIndex,
  activeLyricRef,
  audioRef,
  backStack,
  changeLyricsProvider,
  forwardStack,
  goBack,
  hasTransientLayer,
  lyrics,
  lyricsContainerRef,
  lyricsProviderLoading,
  lyricsProviderOrder,
  lyricsProviderSelection,
  navigateForward,
  playerExpanded,
  playbackSeconds,
  durationSeconds,
  setLyrics,
  setLyricsAutoScrollEnabled,
}: LyricsPanelProps) {
  // Whole-track instrumental: the wavy circle spans the track (0 to the
  // track duration when known) and completes at the end of the music.
  const instrumentalSection =
    lyrics?.status === "ready" && lyrics.data.instrumental
      ? findInstrumentalSection({
          lines: [],
          playbackMs: playbackSeconds * 1000,
          durationMs: durationSeconds * 1000,
          instrumental: true,
        })
      : null;
  return (
    <>
      {!playerExpanded && lyrics && (
        <div className="detail-overlay" role="dialog" aria-modal="true">
          <div className="detail-panel lyrics-panel">
            <button className="close-button" title="Close" aria-label="Close" onClick={() => setLyrics(null)}>
              ×
            </button>
            {lyrics.status === "loading" && (
              <div className="state-panel">
                <div className="spinner" />
                <p>Loading lyrics from Soluna providers…</p>
              </div>
            )}
            {lyrics.status === "error" && (
              <div className="state-panel error">
                <h2>Lyrics unavailable</h2>
                <p>{lyrics.error}</p>
              </div>
            )}
            {lyrics.status === "ready" && (
              <>
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">
                      {lyrics.data.provider}
                      {lyrics.data.instrumental ? " · Instrumental" : lyrics.data.synced ? " · Synced" : " · Plain"}
                    </p>
                    <h2>{lyrics.data.matchedTitle}</h2>
                    <p>{lyrics.data.matchedArtist}</p>
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
                </div>
                {lyrics.data.instrumental && instrumentalSection ? (
                  <div className="lyrics-lines lyrics-lines--standalone">
                    <InstrumentalInterlude
                      label="Instrumental — no lyrics, just the music"
                      section={instrumentalSection}
                      playbackMs={playbackSeconds * 1000}
                      audioRef={audioRef}
                      size={84}
                    />
                  </div>
                ) : lyrics.data.synced && lyrics.data.lines.length > 0 ? (
                  <LyricLines
                    lines={lyrics.data.lines}
                    activeLyricIndex={activeLyricIndex}
                    activeLyricRef={activeLyricRef}
                    audioRef={audioRef}
                    lyricsContainerRef={lyricsContainerRef}
                    playbackSeconds={playbackSeconds}
                    durationSeconds={durationSeconds}
                    setLyricsAutoScrollEnabled={setLyricsAutoScrollEnabled}
                  />
                ) : (
                  <pre className="lyrics-text">{lyrics.data.text}</pre>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
