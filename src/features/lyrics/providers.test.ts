import { describe, expect, it } from "vitest";
import { lyricsProviderNames, lyricProviderSettingKeys } from "./providers";

// PR C (Romany's decision): official providers first, unofficial only as a
// fallback tier, video providers last. The engine order in
// `ordered_lyrics_providers` (src-tauri/src/lib.rs) must match this list
// from a fresh install, or the UI and the engine silently disagree.
describe("lyrics provider registry order (PR C)", () => {
  it("lists official providers first, then unofficial, then video", () => {
    expect([...lyricsProviderNames]).toEqual([
      "LrcLib",
      "LyricsOvh",
      "BetterLyrics",
      "QQMusic",
      "NetEase",
      "KuGou",
      "Paxsenix",
      "LyricsPlus",
      "Musixmatch",
      "YouTubeSubtitle",
      "YouTube",
    ]);
  });

  it("has a settings toggle for every provider that has one", () => {
    for (const provider of [
      "LrcLib",
      "LyricsOvh",
      "BetterLyrics",
      "QQMusic",
      "NetEase",
      "KuGou",
      "Paxsenix",
      "LyricsPlus",
      "Musixmatch",
    ]) {
      expect(lyricProviderSettingKeys[provider]).toBeDefined();
    }
    expect(lyricProviderSettingKeys["YouTubeSubtitle"]).toBeUndefined();
    expect(lyricProviderSettingKeys["YouTube"]).toBeUndefined();
  });
});
