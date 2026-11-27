// PR C canonical order (Romany's decision): official providers first
// (LrcLib, LyricsOvh), then the unofficial group, then the video
// providers. This must match `REGISTRY_ORDER` in
// `ordered_lyrics_providers` (src-tauri/src/lib.rs) from a fresh install,
// or the UI and the engine silently disagree about the chain.
export const lyricsProviderNames = [
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
] as const;
export const lyricProviderSettingKeys: Record<string, string> = {
  LrcLib: "enableLrclib",
  LyricsOvh: "enableLyricsOvh",
  BetterLyrics: "enableBetterLyrics",
  QQMusic: "enableQQMusic",
  NetEase: "enableNetEase",
  KuGou: "enableKugou",
  Paxsenix: "enablePaxsenix",
  LyricsPlus: "enableLyricsPlus",
  Musixmatch: "enableMusixmatch",
};
