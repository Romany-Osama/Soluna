import { describe, expect, it } from "vitest";
import { shouldSyncLikedSongsOnOpen } from "./likedSync";

const open = {
  authenticated: true,
  ytmSync: true,
  likedSongsSync: true,
  online: true,
  alreadySynced: false,
};

describe("shouldSyncLikedSongsOnOpen", () => {
  it("syncs once per app open when signed in, online, and both sync toggles are on", () => {
    expect(shouldSyncLikedSongsOnOpen(open)).toBe(true);
  });

  it("does not sync a second time in the same app open", () => {
    expect(shouldSyncLikedSongsOnOpen({ ...open, alreadySynced: true })).toBe(false);
  });

  it("does not sync offline: the local SQLite liked list stays in use", () => {
    expect(shouldSyncLikedSongsOnOpen({ ...open, online: false })).toBe(false);
  });

  it("does not sync while signed out", () => {
    expect(shouldSyncLikedSongsOnOpen({ ...open, authenticated: false })).toBe(false);
  });

  it("does not sync when the Liked Songs toggle is off", () => {
    expect(shouldSyncLikedSongsOnOpen({ ...open, likedSongsSync: false })).toBe(false);
  });

  it("does not sync when the master YouTube Music library sync is off", () => {
    expect(shouldSyncLikedSongsOnOpen({ ...open, ytmSync: false })).toBe(false);
  });
});
