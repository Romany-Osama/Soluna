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

// Gap ring (Meld's IntervalIndicator): rendered in-flow after the last sung
// line while the playhead is inside a >4s silence; distance classes on each
// line drive the fullscreen fade (jsdom proves the classes, not the layout
// — the mocked-render probe proves the sizes and opacities).
const gapLines: LyricsPayload["lines"] = [
  {
    timeMs: 0,
    text: "I used to rule the world",
    words: [{ timeMs: 0, endMs: 3600, text: "world" }],
  },
  {
    timeMs: 4000,
    text: "Seas would rise when I gave the word",
    words: [{ timeMs: 4000, endMs: 8500, text: "word" }],
  },
  {
    timeMs: 8000,
    text: "Now in the morning, I sleep alone",
    words: [{ timeMs: 8000, endMs: 12000, text: "alone" }],
  },
  {
    timeMs: 22000,
    text: "Be my mirror, my sword and shield",
    words: [{ timeMs: 22000, endMs: 26000, text: "shield" }],
  },
  {
    timeMs: 26000,
    text: "My missionaries in a foreign field",
    words: [{ timeMs: 26000, endMs: 29500, text: "field" }],
  },
  {
    timeMs: 29000,
    text: "For some reason, I can't explain",
    words: [{ timeMs: 29000, endMs: 31800, text: "explain" }],
  },
];

function renderGapLines(props: { playbackSeconds?: number; activeLyricIndex?: number } = {}) {
  const audioRef = createRef<HTMLAudioElement | null>();
  const containerRef = createRef<HTMLDivElement | null>();
  const activeRef = createRef<HTMLButtonElement | null>();
  render(
    <LyricLines
      lines={gapLines}
      activeLyricIndex={props.activeLyricIndex ?? 2}
      activeWordIndex={-1}
      activeLyricRef={activeRef}
      audioRef={audioRef}
      lyricsContainerRef={containerRef}
      lyricsAutoScrollEnabled
      playbackSeconds={props.playbackSeconds ?? 17}
      setLyricsAutoScrollEnabled={() => undefined}
    />,
  );
}

describe("LyricLines gap ring", () => {
  const ring = () => document.querySelector(".lyrics-gap-row .gap-ring");

  it("shows the ring 50% filled at 17s in the 12s -> 22s gap", () => {
    renderGapLines();
    expect(ring()).not.toBeNull();
    expect(ring()?.getAttribute("data-fill")).toBe("0.50");
    expect(ring()?.getAttribute("data-waves")).toBe("10");
    expect(ring()?.getAttribute("data-amplitude")).toBe("2");
    // In-flow, right after the active (last sung) line.
    const row = document.querySelector(".lyrics-gap-row");
    const prev = row?.previousElementSibling;
    expect(prev?.classList.contains("lyric-line")).toBe(true);
    expect(prev?.classList.contains("active")).toBe(true);
  });

  it("hides the ring before the gap starts", () => {
    renderGapLines({ playbackSeconds: 10 });
    expect(ring()).toBeNull();
  });

  it("hides the ring after gapEnd - 650ms", () => {
    renderGapLines({ playbackSeconds: 21.5 });
    expect(ring()).toBeNull();
  });

  it("keeps the ring at gapEnd - 650ms", () => {
    renderGapLines({ playbackSeconds: 21.35 });
    expect(ring()).not.toBeNull();
  });

  it("shows the ring at 0% at the gap start", () => {
    renderGapLines({ playbackSeconds: 12 });
    expect(ring()?.getAttribute("data-fill")).toBe("0.00");
  });

  it("shows no ring when the gap is 4000ms or less", () => {
    // The two-line fixture has a 2375ms gap: nothing to fill.
    renderLines({ playbackSeconds: 10.1 });
    expect(ring()).toBeNull();
  });
});

describe("LyricLines fullscreen distance classes", () => {
  it("marks each line by its distance from the active line, capped at 3", () => {
    renderGapLines({ activeLyricIndex: 2 });
    const buttons = Array.from(document.querySelectorAll(".lyric-line"));
    expect(buttons.length).toBe(6);
    expect(buttons[2].classList.contains("lyric-dist-0")).toBe(true);
    expect(buttons[2].classList.contains("active")).toBe(true);
    expect(buttons[1].classList.contains("lyric-dist-1")).toBe(true);
    expect(buttons[3].classList.contains("lyric-dist-1")).toBe(true);
    expect(buttons[0].classList.contains("lyric-dist-2")).toBe(true);
    expect(buttons[4].classList.contains("lyric-dist-2")).toBe(true);
    expect(buttons[5].classList.contains("lyric-dist-3")).toBe(true);
  });

  it("marks no distance before the first line is active", () => {
    renderGapLines({ activeLyricIndex: -1, playbackSeconds: 0 });
    expect(document.querySelector(".lyric-dist-0")).toBeNull();
    expect(document.querySelector(".lyric-dist-1")).toBeNull();
    expect(document.querySelector(".lyric-dist-2")).toBeNull();
    expect(document.querySelector(".lyric-dist-3")).toBeNull();
  });
});
