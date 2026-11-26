// @vitest-environment jsdom
// Word-by-word lyrics: the active line highlights word by word from the
// provider's word timings, and the intro gets the instrumental animation.
import { createRef, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LyricLines } from "./LyricLines";
import type { LyricsPayload } from "../../types";

afterEach(cleanup);

const lines: LyricsPayload["lines"] = [
  {
    timeMs: 9730,
    text: "The club isn't",
    words: [
      { timeMs: 9730, endMs: 9930, text: "The" },
      { timeMs: 9930, endMs: 10280, text: "club" },
      { timeMs: 10280, endMs: 12105, text: "isn't" },
    ],
  },
  { timeMs: 12105, text: "So the bar is where I go", words: [] },
];

function renderLines(props: Partial<Parameters<typeof LyricLines>[0]> = {}) {
  const audioRef = createRef<HTMLAudioElement | null>();
  const containerRef = createRef<HTMLDivElement | null>();
  const activeRef = createRef<HTMLButtonElement | null>();
  return render(
    <LyricLines
      lines={lines}
      activeLyricIndex={0}
      activeWordIndex={1}
      activeLyricRef={activeRef}
      audioRef={audioRef}
      lyricsContainerRef={containerRef}
      lyricsAutoScrollEnabled
      playbackSeconds={10.1}
      setLyricsAutoScrollEnabled={() => undefined}
      {...props}
    />,
  );
}

describe("LyricLines word-by-word highlight", () => {
  it("marks sung words and the word under the playhead", () => {
    renderLines();
    const sung = document.querySelectorAll(".lyric-word.sung");
    expect(sung.length).toBe(2);
    expect(sung[0].textContent).toBe("The");
    expect(sung[1].textContent).toBe("club");
    expect(sung[1].classList.contains("current")).toBe(true);
    const upcoming = screen.getByText("isn't");
    expect(upcoming.classList.contains("sung")).toBe(false);
  });

  it("highlights whole lines without word timings", () => {
    renderLines({ activeLyricIndex: 1, activeWordIndex: -1 });
    const line = screen.getByText("So the bar is where I go");
    expect(line.closest("button")?.classList.contains("active")).toBe(true);
    expect(line.closest("button")?.querySelector(".lyric-word")).toBeNull();
  });

  it("shows the intro animation before the first line", () => {
    renderLines({ playbackSeconds: 2 });
    expect(screen.getByText("Intro")).toBeTruthy();
  });

  it("does not show the intro once singing starts", () => {
    renderLines({ playbackSeconds: 10.1 });
    expect(screen.queryByText("Intro")).toBeNull();
  });
});

// Re-sync button: scrolling away disables follow and the pill appears;
// tapping it re-enables follow without seeking; 8s idle re-enables follow
// on its own (Meld's LYRICS_PREVIEW_TIME).
function renderResync(
  props: {
    initialEnabled?: boolean;
    activeLyricIndex?: number;
    playbackSeconds?: number;
    audioCurrentTime?: number;
  } = {},
) {
  // A stand-in audio element: LyricLines only reads/writes currentTime on
  // it, so a plain object proves the pill tap does not seek.
  const audioRef = { current: { currentTime: props.audioCurrentTime ?? 30 } as unknown as HTMLAudioElement };
  function Harness() {
    const [enabled, setEnabled] = useState(props.initialEnabled ?? true);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const activeRef = useRef<HTMLButtonElement | null>(null);
    return (
      <LyricLines
        lines={lines}
        activeLyricIndex={props.activeLyricIndex ?? 1}
        activeWordIndex={-1}
        activeLyricRef={activeRef}
        audioRef={audioRef}
        lyricsContainerRef={containerRef}
        lyricsAutoScrollEnabled={enabled}
        playbackSeconds={props.playbackSeconds ?? 12.5}
        setLyricsAutoScrollEnabled={setEnabled}
      />
    );
  }
  render(<Harness />);
  return { audioRef };
}

describe("LyricLines re-sync button", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const pill = () => document.querySelector(".lyrics-resync");
  const visiblePill = () => document.querySelector(".lyrics-resync.visible");
  const scrollLines = () => {
    const container = document.querySelector(".lyrics-lines");
    expect(container).not.toBeNull();
    fireEvent.wheel(container!);
  };

  it("hides the pill while follow is on", () => {
    renderResync();
    expect(pill()).not.toBeNull();
    expect(visiblePill()).toBeNull();
    expect(pill()?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows the pill after a wheel scroll disables follow", () => {
    renderResync();
    scrollLines();
    expect(visiblePill()).not.toBeNull();
    expect(screen.getByText("Re-sync")).toBeTruthy();
    expect(pill()?.getAttribute("aria-hidden")).toBe("false");
  });

  it("tapping the pill re-enables follow without seeking", () => {
    const { audioRef } = renderResync({ audioCurrentTime: 30 });
    scrollLines();
    expect(visiblePill()).not.toBeNull();
    fireEvent.click(screen.getByText("Re-sync"));
    expect(visiblePill()).toBeNull();
    expect(audioRef.current.currentTime).toBe(30);
  });

  it("re-enables follow 8s after the last scroll input", () => {
    vi.useFakeTimers();
    renderResync();
    scrollLines();
    expect(visiblePill()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(7999);
    });
    expect(visiblePill()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(visiblePill()).toBeNull();
  });

  it("restarts the 8s wait on each new scroll input", () => {
    vi.useFakeTimers();
    renderResync();
    scrollLines();
    act(() => {
      vi.advanceTimersByTime(7000);
    });
    scrollLines();
    act(() => {
      vi.advanceTimersByTime(7000);
    });
    expect(visiblePill()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(visiblePill()).toBeNull();
  });

  it("does not show the pill before the first line is active", () => {
    renderResync({ initialEnabled: false, activeLyricIndex: -1, playbackSeconds: 2 });
    expect(visiblePill()).toBeNull();
  });

  it("line click still seeks and re-enables follow", () => {
    const { audioRef } = renderResync({ initialEnabled: false, audioCurrentTime: 0 });
    expect(visiblePill()).not.toBeNull();
    fireEvent.click(screen.getByText("So the bar is where I go"));
    expect(audioRef.current.currentTime).toBeCloseTo(12.105);
    expect(visiblePill()).toBeNull();
  });
});
