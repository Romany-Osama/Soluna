import { describe, expect, it } from "vitest";
import {
  appendNewPlayable,
  arrangeQueue,
  mergeFailedPlayQueue,
  moveItem,
  removeAt,
  resolveFailedPlayRollback,
  shuffleAfterCurrent,
  shuffleInPlace,
  snapshotFailedPlay,
} from "./queue";

const songs = (...ids: string[]) => ids.map((id) => ({ id, videoId: `v-${id}` }));
const ids = (items: { id: string }[]) => items.map((item) => item.id);
/** Deterministic generator so shuffles are reproducible. */
const seeded =
  (seed = 7) =>
  () =>
    ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

describe("arrangeQueue (QUEUE-001)", () => {
  it("leaves the queue alone when shuffle is off or there is nothing to shuffle", () => {
    const queue = songs("a", "b", "c");
    expect(arrangeQueue(queue, 1, 3, { shuffle: false, playlistFirst: false })).toEqual({ items: queue, index: 1 });
    expect(arrangeQueue(songs("a"), 0, 1, { shuffle: true, playlistFirst: false }).index).toBe(0);
    expect(arrangeQueue(queue, -1, 3, { shuffle: true, playlistFirst: false }).index).toBe(-1);
  });

  it("moves the current song to the front and keeps every song exactly once", () => {
    const queue = songs("a", "b", "c", "d", "e", "f");
    const arranged = arrangeQueue(queue, 3, 6, { shuffle: true, playlistFirst: false, random: seeded() });
    expect(arranged.index).toBe(0);
    expect(arranged.items[0].id).toBe("d");
    expect([...ids(arranged.items)].sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("plays the original playlist before radio additions with shuffle-playlist-first", () => {
    const queue = songs("p1", "p2", "p3", "r1", "r2", "r3");
    for (let seed = 1; seed < 20; seed += 1) {
      const arranged = arrangeQueue(queue, 1, 3, { shuffle: true, playlistFirst: true, random: seeded(seed) });
      expect(arranged.items[0].id).toBe("p2");
      expect([...ids(arranged.items.slice(1, 3))].sort()).toEqual(["p1", "p3"]);
      expect([...ids(arranged.items.slice(3))].sort()).toEqual(["r1", "r2", "r3"]);
    }
  });
});

describe("queue edits", () => {
  it("shuffles only the songs after the current one", () => {
    const queue = songs("a", "b", "c", "d", "e");
    const result = shuffleAfterCurrent(queue, "b", seeded(3));
    expect(ids(result.slice(0, 2))).toEqual(["a", "b"]);
    expect([...ids(result.slice(2))].sort()).toEqual(["c", "d", "e"]);
    expect(shuffleAfterCurrent(queue, "e")).toBe(queue);
    expect(shuffleAfterCurrent(queue, null)).toBe(queue);
  });

  it("removing keeps the current song selected, or hands over to the next one", () => {
    const queue = songs("a", "b", "c", "d");
    expect(removeAt(queue, 2, 0)).toMatchObject({ index: 1, wasCurrent: false });
    expect(removeAt(queue, 2, 3)).toMatchObject({ index: 2, wasCurrent: false });
    const current = removeAt(queue, 2, 2)!;
    expect(current).toMatchObject({ index: 2, wasCurrent: true });
    expect(current.items[current.index].id).toBe("d");
    expect(removeAt(queue, 3, 3)).toMatchObject({ index: 2, wasCurrent: true });
    expect(removeAt(queue, 0, 9)).toBeNull();
  });

  it("moving follows the playing song", () => {
    const queue = songs("a", "b", "c", "d");
    const follow = (current: number, from: number, to: number) => {
      const moved = moveItem(queue, current, from, to)!;
      return moved.items[moved.index].id;
    };
    for (const [current, from, to] of [
      [1, 1, 3],
      [1, 0, 3],
      [1, 3, 0],
      [2, 0, 1],
      [0, 2, 3],
    ])
      expect(follow(current, from, to)).toBe(queue[current].id);
    expect(moveItem(queue, 0, 1, 1)).toBeNull();
  });

  it("continuation pages append only playable songs that are not queued yet", () => {
    const queue = songs("a", "b");
    const page = [...songs("b", "c", "c"), { id: "d", videoId: null }];
    expect(ids(appendNewPlayable(queue, page))).toEqual(["c"]);
  });

  it("shuffleInPlace is a permutation", () => {
    expect(shuffleInPlace([1, 2, 3, 4, 5], seeded(11)).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("mergeFailedPlayQueue (M4 rework)", () => {
  // `previous` is the queue before the failed play, `advanced` the queue the failed
  // play set before resolving, `current` the queue when the failure lands (advanced
  // plus any in-flight edits). Every case asserts the exact merged order and index:
  // a merge that misplaces, resurrects or duplicates a song must fail here.
  const merged = (previous: string[], advanced: string[], current: string[], previousIndex: number) =>
    mergeFailedPlayQueue({
      previous: songs(...previous),
      advanced: songs(...advanced),
      current: songs(...current),
      previousIndex,
    });
  const check = (
    previous: string[],
    advanced: string[],
    current: string[],
    previousIndex: number,
    items: string[],
    index: number,
    extended: boolean,
  ) => {
    const result = merged(previous, advanced, current, previousIndex);
    expect(ids(result.items)).toEqual(items);
    expect(result.index).toBe(index);
    expect(result.extended).toBe(extended);
  };

  it("extended: a flight add survives, index back to the playing song", () => {
    check(["a", "b"], ["a", "b"], ["a", "b", "c"], 0, ["a", "b", "c"], 0, true);
  });

  it("extended: a flight remove survives", () => {
    check(["a", "b", "c"], ["a", "b", "c"], ["a", "b"], 0, ["a", "b"], 0, true);
  });

  it("extended: the playing song keeps its position when it is not first", () => {
    check(["a", "b", "c"], ["a", "b", "c"], ["a", "b", "c", "d"], 1, ["a", "b", "c", "d"], 1, true);
  });

  it("replaced: a flight add survives at the end after an unrelated queue", () => {
    check(["a", "b"], ["x", "y"], ["x", "y", "c"], 0, ["a", "b", "c"], 0, false);
  });

  it("replaced: an item the advance itself dropped is restored", () => {
    check(["a", "b", "c"], ["b", "c"], ["b", "c"], 0, ["a", "b", "c"], 0, false);
  });

  it("replaced with partial overlap: a flight-removed advanced item stays removed, a dropped one is restored", () => {
    check(["a", "b", "c"], ["b", "c"], ["b"], 0, ["a", "b"], 0, false);
  });

  it("replaced: flight adds anchor after the nearest preceding surviving item", () => {
    check(["a", "b"], ["x", "y"], ["x", "y", "c", "d"], 1, ["a", "b", "c", "d"], 1, false);
  });

  it("replaced: a flight add after a shared song anchors after that song", () => {
    check(["a", "b", "c"], ["b", "d"], ["b", "e", "d"], 0, ["a", "b", "e", "c"], 0, false);
  });

  it("replaced: an early item dropped by the advance does not hide a later flight removal", () => {
    // The advance dropped `a`; the flight then removed `c`. `a` is restored,
    // `c` stays removed — the old subsequence matcher resurrected `c`.
    check(["a", "b", "c"], ["b", "c"], ["b"], 0, ["a", "b"], 0, false);
  });

  it("replaced: a flight add before an advanced item does not resurrect that item", () => {
    // The advance replaced the queue with [x, y]; the flight added `e` between
    // them. `y` belongs to the failed play, not the user — only `e` stays.
    check(["a"], ["x", "y"], ["x", "e", "y"], 0, ["a", "e"], 0, false);
  });

  it("replaced: an early item dropped by the advance does not hide a flight removal of the only other item", () => {
    // Minimal form of the case above: the advance dropped `a`, the flight
    // removed `b` — the merged queue is just the restored `a`.
    check(["a", "b"], ["b"], [], 0, ["a"], 0, false);
  });

  it("replaced: a shuffled same-queue play plus a mid-flight play-next does not duplicate songs", () => {
    // Shuffle on reordered [a, b, c] to [b, a, c]; the flight queued `d` to play
    // next after `b`. The merged queue is the pre-play queue with `d` kept after
    // `b` — no resurrected or duplicated songs.
    check(["a", "b", "c"], ["b", "a", "c"], ["b", "d", "a", "c"], 0, ["a", "b", "d", "c"], 0, false);
  });

  it("replaced: a shuffled same-queue play with no flight edit still restores", () => {
    check(["a", "b", "c"], ["b", "c", "a"], ["b", "c", "a"], 0, ["a", "b", "c"], 0, false);
  });

  it("nothing playing: the old queue stands as-is", () => {
    check(["a"], ["x"], ["x", "c"], -1, ["a"], -1, false);
  });

  it("duplicate ids: the playing occurrence keeps its rank", () => {
    // The second copy of `a` is playing (rank 1): the rollback points at that copy,
    // not the first occurrence of the id.
    check(["a", "b", "a"], ["a", "b", "a"], ["a", "b", "a", "c"], 2, ["a", "b", "a", "c"], 2, true);
  });

  it("duplicate ids: the playing occurrence keeps its rank after a reorder", () => {
    check(["a", "b", "a"], ["b", "a", "a"], ["b", "a", "a"], 2, ["a", "b", "a"], 2, false);
  });

  it("duplicate ids: the third copy keeps its rank", () => {
    check(["a", "a", "a"], ["a", "a", "a"], ["a", "a", "a", "b"], 2, ["a", "a", "a", "b"], 2, true);
  });

  it("duplicate ids: when the same-rank occurrence is gone, the remaining copy is used", () => {
    // One copy was removed mid-flight, so the rank-1 occurrence no longer exists;
    // the remaining copy is the playing (later) one.
    check(["a", "b", "a"], ["a", "b", "a"], ["a", "b"], 2, ["a", "b"], 0, true);
  });

  it("playing song removed from the live queue leaves no active song", () => {
    check(["a", "b"], ["a", "b"], ["b"], 0, ["b"], -1, true);
  });

  it("playing song removed from the live queue leaves no active song after a replaced queue", () => {
    // The advance replaced the queue with [a]; the flight then removed `a` itself.
    check(["a", "b"], ["a"], [], 0, ["b"], -1, false);
  });
});

describe("resolveFailedPlayRollback (M4 size cap)", () => {
  // `previous` is the pre-play snapshot, `advanced` the queue the failed play set,
  // `live` the render mirror. Identity matters: the mirror holds the SAME array as
  // the snapshot until a render after the advance replaces it, so cases that depend
  // on that share one array reference. Every case asserts the exact decision: the
  // queue, the index, and which continuation/kind survives.
  const decide = ({
    previous,
    previousIndex,
    previousContinuation,
    previousKind,
    advanced,
    advancedContinuation,
    advancedKind,
    live,
    liveContinuation,
    liveKind,
  }: {
    previous: { id: string; videoId: string }[];
    previousIndex: number;
    previousContinuation: string | null;
    previousKind: "next" | "playlist" | null;
    advanced: { id: string; videoId: string }[];
    advancedContinuation: string | null;
    advancedKind: "next" | "playlist" | null;
    live: { id: string; videoId: string }[];
    liveContinuation: string | null;
    liveKind: "next" | "playlist" | null;
  }) =>
    resolveFailedPlayRollback({
      previous: snapshotFailedPlay(previous, previousIndex, previousContinuation, previousKind, false),
      advanced,
      advancedContinuation,
      advancedKind,
      live: { items: live, continuation: liveContinuation, kind: liveKind },
    });

  it("uses the live queue and continuation once the mirror rendered after the advance", () => {
    const result = decide({
      previous: songs("a", "b"),
      previousIndex: 0,
      previousContinuation: "prev-cont",
      previousKind: "playlist",
      advanced: songs("a", "b"),
      advancedContinuation: "adv-cont",
      advancedKind: "next",
      live: songs("a", "b", "c"),
      liveContinuation: "live-cont",
      liveKind: "next",
    });
    expect(ids(result.items)).toEqual(["a", "b", "c"]);
    expect(result.index).toBe(0);
    expect(result.continuation).toBe("live-cont");
    expect(result.kind).toBe("next");
  });

  it("falls back to the advanced queue when the mirror still holds the snapshot", () => {
    // The failure landed before the mirror's first render after the advance, so
    // the live queue IS the snapshot (same array) — the advanced queue stands in.
    const snapshot = songs("a", "b");
    const result = decide({
      previous: snapshot,
      previousIndex: 0,
      previousContinuation: "prev-cont",
      previousKind: "playlist",
      advanced: songs("x", "y"),
      advancedContinuation: "adv-cont",
      advancedKind: "next",
      live: snapshot,
      liveContinuation: "prev-cont",
      liveKind: "playlist",
    });
    expect(ids(result.items)).toEqual(["a", "b"]);
    expect(result.index).toBe(0);
    expect(result.continuation).toBe("prev-cont");
    expect(result.kind).toBe("playlist");
  });

  it("keeps the live continuation when the failed play only extended the queue", () => {
    const result = decide({
      previous: songs("a", "b", "c"),
      previousIndex: 1,
      previousContinuation: "prev-cont",
      previousKind: "next",
      advanced: songs("a", "b", "c"),
      advancedContinuation: "adv-cont",
      advancedKind: "next",
      live: songs("a", "b"),
      liveContinuation: "live-cont",
      liveKind: "next",
    });
    expect(ids(result.items)).toEqual(["a", "b"]);
    expect(result.index).toBe(1);
    expect(result.continuation).toBe("live-cont");
    expect(result.kind).toBe("next");
  });

  it("restores the previous continuation when the failed play replaced the queue", () => {
    const result = decide({
      previous: songs("a", "b"),
      previousIndex: 0,
      previousContinuation: "prev-cont",
      previousKind: "playlist",
      advanced: songs("x", "y"),
      advancedContinuation: "adv-cont",
      advancedKind: "next",
      live: songs("x", "y", "c"),
      liveContinuation: "live-cont",
      liveKind: "next",
    });
    expect(ids(result.items)).toEqual(["a", "b", "c"]);
    expect(result.index).toBe(0);
    expect(result.continuation).toBe("prev-cont");
    expect(result.kind).toBe("playlist");
  });

  it("leaves no active song when the playing song was removed mid-flight", () => {
    const result = decide({
      previous: songs("a", "b"),
      previousIndex: 0,
      previousContinuation: "prev-cont",
      previousKind: "playlist",
      advanced: songs("a", "b"),
      advancedContinuation: "adv-cont",
      advancedKind: "next",
      live: songs("b"),
      liveContinuation: "live-cont",
      liveKind: "next",
    });
    expect(ids(result.items)).toEqual(["b"]);
    expect(result.index).toBe(-1);
    expect(result.continuation).toBe("live-cont");
    expect(result.kind).toBe("next");
  });

  it("same-queue play where the mirror never changed identity keeps the live continuation", () => {
    // The advance did not replace the queue array (same reference throughout), so
    // the mirror still holds the snapshot array — but its continuation already
    // reflects the advance, and that is the continuation to keep.
    const queue = songs("a", "b");
    const result = decide({
      previous: queue,
      previousIndex: 0,
      previousContinuation: "prev-cont",
      previousKind: "playlist",
      advanced: queue,
      advancedContinuation: "adv-cont",
      advancedKind: "next",
      live: queue,
      liveContinuation: "adv-cont",
      liveKind: "next",
    });
    expect(ids(result.items)).toEqual(["a", "b"]);
    expect(result.index).toBe(0);
    expect(result.continuation).toBe("adv-cont");
    expect(result.kind).toBe("next");
  });
});
