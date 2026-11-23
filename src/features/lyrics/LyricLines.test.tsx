// @vitest-environment jsdom
// The shared lyrics list shows the instrumental interlude — with the wavy
// circle — in place of lyric lines for the music-only part the playhead
// is inside, and shows plain lines otherwise.
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LyricLines } from "./LyricLines";
import type { LyricLine } from "../../types";

afterEach(cleanup);

const wordTimed: LyricLine[] = [
  {
    timeMs: 9730,
    text: "The club isn't",
    words: [
      { timeMs: 9730, endMs: 9930, text: "The" },
      { timeMs: 9930, endMs: 10280, text: "club" },
      { timeMs: 10280, endMs: 12105, text: "isn't" },
    ],
  },
  { timeMs: 30000, text: "So the bar is where I go", words: [] },
];

const plain: LyricLine[] = [
  { timeMs: 9730, text: "The club isn't" },
  { timeMs: 30000, text: "So the bar is where I go" },
];

function renderLines(props: Partial<Parameters<typeof LyricLines>[0]> = {}) {
  const audioRef = createRef<HTMLAudioElement | null>();
  const containerRef = createRef<HTMLDivElement | null>();
  const activeRef = createRef<HTMLButtonElement | null>();
  return render(
    <LyricLines
      lines={wordTimed}
      activeLyricIndex={0}
      activeLyricRef={activeRef}
      audioRef={audioRef}
      lyricsContainerRef={containerRef}
      playbackSeconds={10.1}
      durationSeconds={60}
      setLyricsAutoScrollEnabled={() => undefined}
      {...props}
    />,
  );
}

describe("LyricLines instrumental interlude", () => {
  it("shows the intro with the wavy circle before the first line", () => {
    renderLines({ playbackSeconds: 2 });
    expect(screen.getByText("Intro")).toBeTruthy();
    expect(document.querySelector('[role="progressbar"]')).toBeTruthy();
  });

  it("does not show the intro once singing starts", () => {
    renderLines({ playbackSeconds: 10.1 });
    expect(screen.queryByText("Intro")).toBeNull();
  });

  it("shows the break with the wavy circle in a word-timed gap", () => {
    renderLines({ playbackSeconds: 20 });
    expect(screen.getByText("Instrumental break")).toBeTruthy();
    expect(document.querySelector('[role="progressbar"]')).toBeTruthy();
  });

  it("shows no interlude for a gap with no word timings", () => {
    renderLines({ lines: plain, playbackSeconds: 20 });
    expect(screen.queryByText("Instrumental break")).toBeNull();
    expect(screen.getByText("The club isn't")).toBeTruthy();
  });

  it("shows the break for a provider marker line", () => {
    renderLines({
      lines: [
        { timeMs: 9730, text: "The club isn't" },
        { timeMs: 20000, text: "[Instrumental]" },
        { timeMs: 40000, text: "So the bar is where I go" },
      ],
      playbackSeconds: 30,
    });
    expect(screen.getByText("Instrumental break")).toBeTruthy();
  });

  it("shows the outro after the last line", () => {
    renderLines({ lines: wordTimed.slice(0, 1), playbackSeconds: 30 });
    expect(screen.getByText("Outro")).toBeTruthy();
  });

  it("keeps the lines clickable to seek", () => {
    renderLines({ playbackSeconds: 10.1 });
    const line = screen.getByText("So the bar is where I go");
    expect(line.closest("button")).toBeTruthy();
  });
});
