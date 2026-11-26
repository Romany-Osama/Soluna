// @vitest-environment jsdom
// Word-by-word lyrics: the active line highlights word by word from the
// provider's word timings, and the intro gets the instrumental animation.
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
