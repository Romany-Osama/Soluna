export type NavKey = "home" | "search_input" | "library" | "history" | "stats";
export type ItemKind = "song" | "episode" | "album" | "playlist" | "artist" | "podcast";
export type YtItem = {
  id: string;
  kind: ItemKind | string;
  title: string;
  subtitle: string;
  thumbnail?: string | null;
  artists: { name: string; id?: string | null }[];
  browseId?: string | null;
  playlistId?: string | null;
  videoId?: string | null;
  setVideoId?: string | null;
  playPlaylistId?: string | null;
  playVideoId?: string | null;
  params?: string | null;
  explicit?: boolean;
  musicVideoType?: string | null;
  historyRemoveToken?: string | null;
  albumId?: string | null;
  albumTitle?: string | null;
  localPath?: string | null;
  duration?: number;
};
export type HomeSection = {
  title: string;
  label?: string | null;
  thumbnail?: string | null;
  browseId?: string | null;
  params?: string | null;
  browseKind?: string | null;
  items: YtItem[];
};
export type HomePage = { sections: HomeSection[]; continuation?: string | null };
export type SearchPage = { items: YtItem[]; continuation?: string | null };
export type PlaylistPage = { playlist: YtItem; songs: YtItem[]; continuation?: string | null };
export type RemoteHistorySection = { title: string; songs: YtItem[] };
export type RemoteHistoryPage = { sections: RemoteHistorySection[] };
export type StatsRow = { item: YtItem; plays: number; minutes: number };
export type StatsGroup = { id: string; title: string; subtitle: string; thumbnail?: string | null; plays: number };
export type StatsPayload = {
  period: string;
  totalPlays: number;
  totalMinutes: number;
  uniqueSongs: number;
  rows: StatsRow[];
  artists: StatsGroup[];
  albums: StatsGroup[];
};
export type DetailPage = {
  kind: string;
  title: string;
  subtitle: string;
  thumbnail?: string | null;
  items: YtItem[];
  continuation?: string | null;
  browseId?: string | null;
};
export type LyricsPayload = {
  provider: string;
  text: string;
  synced: boolean;
  matchedTitle: string;
  matchedArtist: string;
  lines: { timeMs: number; text: string }[];
};
export type SettingEntry = { key: string; value: string };
export type SessionStatus = {
  authenticated: boolean;
  accountName?: string | null;
  accountEmail?: string | null;
  accountChannelHandle?: string | null;
  accountAvatar?: string | null;
};
export type SpotifySessionStatus = { authenticated: boolean; tokenExpiry?: number | null };
export type SpotifyProfile = { id: string; displayName?: string | null; avatar?: string | null };
export type SpotifyPlaylistItem = {
  id: string;
  name: string;
  description?: string | null;
  image?: string | null;
  owner?: string | null;
};
export type SpotifyFolderItem = { uri: string; name: string; totalChildren: number };
export type SpotifyLibraryNode = {
  folders: SpotifyFolderItem[];
  playlists: SpotifyPlaylistItem[];
  totalCount: number;
  offset: number;
  limit: number;
};
export type SpotifyTrackItem = {
  id: string;
  uri: string;
  uid?: string | null;
  name: string;
  artist: string;
  album: string;
  image?: string | null;
  durationMs: number;
};
export type SpotifyLikedTracksPayload = {
  tracks: SpotifyTrackItem[];
  totalCount: number;
  offset: number;
  limit: number;
};
export type SpotifyPlaylistPage = {
  playlists: SpotifyPlaylistItem[];
  totalCount: number;
  offset: number;
  limit: number;
};
// One "load more" pair: the function that fetches the next page plus the flag
// that guards it while a page is in flight. The three Spotify lists (library,
// liked songs, playlist tracks) each carry one; App.tsx threads them through
// as a single grouped object so the shell stays under its line cap.
export type SpotifyLoadMoreState = {
  loadMore: () => Promise<void>;
  loading: boolean;
};
export type SpotifyTrackPage = { tracks: SpotifyTrackItem[]; totalCount: number; offset: number; limit: number };
export type SpotifyTrackMatch = { id: string; uri: string; name: string; artist: string; durationMs: number };
export type LibraryItemState = {
  liked: boolean;
  youtubeLiked: boolean;
  inLibrary: boolean;
  uploaded: boolean;
  pinned: boolean;
  podcastSaved?: boolean;
};
export type DownloadInfo = {
  songId: string;
  path: string;
  bytes: number;
  totalBytes?: number | null;
  state: "downloading" | "completed" | "failed" | "cancelled" | string;
  error?: string | null;
  lyricsCached: boolean;
  artworkPath?: string | null;
};
export type PlaylistDownloadFailure = { songId: string; title: string; error: string };
export type PlaylistDownloadStatus = {
  playlistId: string;
  title: string;
  thumbnail?: string | null;
  artworkPath?: string | null;
  state: "downloading" | "completed" | "partial" | "failed" | "cancelled" | string;
  totalSongs: number;
  completedSongs: number;
  failedSongs: number;
  failures: PlaylistDownloadFailure[];
  error?: string | null;
  startedAt: number;
  updatedAt: number;
};
export type PlayerPayload = {
  videoId: string;
  title?: string | null;
  artist?: string | null;
  streamUrl: string;
  mimeType: string;
  bitrate: number;
  expiresInSeconds: number;
  duration: number;
  sourceClient?: string | null;
};
export type QueuePage = {
  title?: string | null;
  items: YtItem[];
  currentIndex?: number | null;
  continuation?: string | null;
  relatedBrowseId?: string | null;
  relatedParams?: string | null;
};
export type PlaylistContinuationPage = { songs: YtItem[]; continuation?: string | null };
export type LoadState<T> = { status: "idle" | "loading" | "ready" | "error"; data: T; error?: string };
export type PlaytimeSession = {
  historyId: number;
  songId: string;
  lastPosition: number;
  pendingMs: number;
  playing: boolean;
  flushing: boolean;
};
export type PersistentPlayback = {
  items: YtItem[];
  index: number;
  continuation: string | null;
  continuationKind: "next" | "playlist" | null;
  item?: YtItem | null;
  position?: number;
  playing?: boolean;
};
export type LibrarySongFilter = "liked" | "library" | "uploaded" | "downloaded" | "top";
export type LibrarySort = "created" | "name" | "artist" | "playtime";
export type PlaylistSort = "created" | "name" | "count";
export type LibraryPlaylistItem = YtItem & { songCount: number; savedAt: number };
export type LocalItem = YtItem & { localPath: string; duration: number };
export type YouTubeSyncResult = {
  likedSongs: number;
  librarySongs: number;
  uploadedSongs: number;
  playlists: number;
};
export type PlayerCacheUsage = { bytes: number; songs: number; limitMb: number };
export type SpotifyLikedTracks = { tracks: SpotifyTrackItem[]; totalCount: number; offset: number; limit: number };
export type UpdateSummary = {
  version: string;
  currentVersion: string;
  notes?: string | null;
  date?: string | null;
  portable: boolean;
};
