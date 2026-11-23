import { describe, expect, it } from "vitest";
import { playlistDownloadProgress } from "./usePlaylistDownloads";
import type { PlaylistDownloadStatus } from "../../types";

function status(partial: Partial<PlaylistDownloadStatus>): PlaylistDownloadStatus {
  return {
    playlistId: "PL1",
    title: "Mix",
    thumbnail: null,
    artworkPath: null,
    state: "downloading",
    totalSongs: 5,
    completedSongs: 2,
    failedSongs: 1,
    failures: [],
    error: null,
    startedAt: 7,
    updatedAt: 7,
    ...partial,
  };
}

describe("playlistDownloadProgress", () => {
  it("is null without a status or a total", () => {
    expect(playlistDownloadProgress(null)).toBeNull();
    expect(playlistDownloadProgress(status({ totalSongs: 0 }))).toBeNull();
  });

  it("counts finished songs (completed plus failed) against the total", () => {
    expect(playlistDownloadProgress(status({}))).toBe("3 of 5");
    expect(playlistDownloadProgress(status({ completedSongs: 5, failedSongs: 0 }))).toBe("5 of 5");
  });
});
