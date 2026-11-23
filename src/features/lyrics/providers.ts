export const lyricsProviderNames = [
  "BetterLyrics",
  "Paxsenix",
  "LrcLib",
  "KuGou",
  "Musixmatch",
  "NetEase",
  "QQMusic",
  "YouTube",
  "LyricsOvh",
] as const;
export const lyricProviderSettingKeys: Record<string, string> = {
  BetterLyrics: "enableBetterLyrics",
  Paxsenix: "enablePaxsenix",
  LrcLib: "enableLrclib",
  KuGou: "enableKugou",
  Musixmatch: "enableMusixmatch",
  NetEase: "enableNetEase",
  QQMusic: "enableQQMusic",
  LyricsOvh: "enableLyricsOvh",
};
