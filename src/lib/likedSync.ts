/**
 * Liked Songs sync on app open: syncs the YouTube Music Liked Songs playlist into the local SQLite
 * library once per app open, only while online and signed in, and only when both the Liked Songs
 * toggle and the master YouTube Music library sync are on. Offline (or signed out, or toggled off)
 * the full liked list already in SQLite is what the Liked filter shows.
 */
export function shouldSyncLikedSongsOnOpen(input: {
  authenticated: boolean;
  ytmSync: boolean;
  likedSongsSync: boolean;
  online: boolean;
  alreadySynced: boolean;
}): boolean {
  return input.authenticated && input.ytmSync && input.likedSongsSync && input.online && !input.alreadySynced;
}
