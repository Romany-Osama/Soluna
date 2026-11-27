// Queue arithmetic shared by the player (QUEUE-001: one implementation, tested here).
// Pure functions: no React state, no IPC. `random` is injectable so shuffles are testable.

export type Keyed = { id: string };
export type Random = () => number;

export function shuffleInPlace<T>(values: T[], random: Random = Math.random): T[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
}

export type ShuffleOptions = { shuffle: boolean; playlistFirst: boolean; random?: Random };

/** Repeat mode from the queue (`useQueue`): off, repeat the whole queue, repeat one song. */
export type RepeatMode = "off" | "all" | "one";

/**
 * The next song a lyrics prefetch may warm (PR 1): exactly one song ahead in the
 * arranged queue. Returns null when there is nothing safe to prefetch: end of
 * queue, single-item queue, repeat-one (the next song is the current one, so its
 * lyrics are already being fetched for this play), the next item is a local file,
 * or the next item is the same song as the current one (same id).
 */
export function nextLyricsPrefetchTarget<T extends Keyed & { localPath?: string | null }>(
  items: T[],
  currentIndex: number,
  repeatMode: RepeatMode,
): T | null {
  if (repeatMode === "one") return null;
  if (currentIndex < 0 || currentIndex >= items.length) return null;
  const next = items[currentIndex + 1];
  if (!next) return null;
  if (next.localPath) return null;
  if (next.id === items[currentIndex].id) return null;
  return next;
}

/**
 * Order a freshly started queue for the shuffle setting. The current item always moves to the front.
 * With "shuffle playlist first", the original items (indexes below `originalQueueSize`) play before radio additions.
 */
export function arrangeQueue<T>(
  items: T[],
  currentIndex: number,
  originalQueueSize: number,
  { shuffle, playlistFirst, random = Math.random }: ShuffleOptions,
): { items: T[]; index: number } {
  if (!shuffle || items.length < 2 || currentIndex < 0 || currentIndex >= items.length)
    return { items, index: currentIndex };
  const indexes = (count: number) => [...Array(count).keys()];
  const original = shuffleInPlace(
    indexes(Math.min(originalQueueSize, items.length)).filter((index) => index !== currentIndex),
    random,
  );
  const added = shuffleInPlace(
    indexes(items.length).filter((index) => index >= originalQueueSize && index !== currentIndex),
    random,
  );
  const order =
    playlistFirst && original.length > 0 && added.length > 0
      ? [currentIndex, ...original, ...added]
      : [
          currentIndex,
          ...shuffleInPlace(
            indexes(items.length).filter((index) => index !== currentIndex),
            random,
          ),
        ];
  return { items: order.map((index) => items[index]), index: 0 };
}

/** Shuffle only what comes after the current item (enabling shuffle mid-queue keeps history and the current song). */
export function shuffleAfterCurrent<T extends Keyed>(
  items: T[],
  currentId: string | null,
  random: Random = Math.random,
) {
  if (!currentId) return items;
  const currentPosition = items.findIndex((item) => item.id === currentId);
  if (currentPosition < 0 || currentPosition >= items.length - 1) return items;
  return [...items.slice(0, currentPosition + 1), ...shuffleInPlace(items.slice(currentPosition + 1), random)];
}

/** Remove one entry. `wasCurrent` tells the caller to start the item now at `index`. */
export function removeAt<T>(items: T[], currentIndex: number, index: number) {
  if (index < 0 || index >= items.length) return null;
  const next = items.filter((_, itemIndex) => itemIndex !== index);
  const wasCurrent = index === currentIndex;
  const nextIndex =
    currentIndex > index ? currentIndex - 1 : wasCurrent ? Math.min(index, next.length - 1) : currentIndex;
  return { items: next, index: nextIndex, wasCurrent };
}

/** Move one entry; the current index follows the song that was playing. */
export function moveItem<T>(items: T[], currentIndex: number, from: number, to: number) {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return null;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  const index =
    currentIndex === from
      ? to
      : currentIndex > from && currentIndex <= to
        ? currentIndex - 1
        : currentIndex >= to && currentIndex < from
          ? currentIndex + 1
          : currentIndex;
  return { items: next, index };
}

/** Continuation pages may repeat songs already queued; only playable songs not yet queued are appended. */
export function appendNewPlayable<T extends Keyed & { videoId?: string | null }>(items: T[], page: T[]): T[] {
  const seen = new Set(items.map((item) => item.id));
  const additions: T[] = [];
  for (const item of page) {
    if (!item.videoId || seen.has(item.id)) continue;
    seen.add(item.id);
    additions.push(item);
  }
  return additions;
}

/**
 * Which occurrences of `source` survive in `target`, matched in order by id. A greedy
 * in-order match: the first unmatched `target` occurrence with the same id claims each
 * `source` occurrence, so a repeated id is only counted as surviving as many times as
 * it actually appears in `target`. The scan stops at the first unmatched `source` item,
 * so this is subsequence semantics, not presence semantics: it answers "is `source`
 * still present, in order, in `target`?" and must only be used for that question —
 * the extended check below. Everywhere the question is presence ("was this item in
 * the other queue, regardless of order?"), use `presentById` instead: this matcher
 * misclassifies everything after the first item the other queue dropped or the first
 * item inserted before it.
 */
function survivorsById<T extends Keyed>(source: T[], target: T[]): boolean[] {
  const survived = source.map(() => false);
  let targetIndex = 0;
  for (let index = 0; index < source.length; index += 1) {
    while (targetIndex < target.length && target[targetIndex].id !== source[index].id) targetIndex += 1;
    if (targetIndex >= target.length) break;
    survived[index] = true;
    targetIndex += 1;
  }
  return survived;
}

/**
 * Which occurrences of `source` are present in `target`, by id occurrence count: each
 * `target` occurrence claims at most one `source` occurrence with the same id, in order
 * among same-id occurrences. Unlike `survivorsById`, order across different ids does
 * not matter — a source item is present whenever `target` contains that many occurrences
 * of its id, even if an earlier item was dropped or another item was inserted before it.
 */
function presentById<T extends Keyed>(source: T[], target: T[]): boolean[] {
  const remaining = new Map<string, number>();
  for (const item of target) remaining.set(item.id, (remaining.get(item.id) ?? 0) + 1);
  return source.map((item) => {
    const count = remaining.get(item.id) ?? 0;
    if (count <= 0) return false;
    remaining.set(item.id, count - 1);
    return true;
  });
}

export type FailedPlayRollback<T> = {
  /** The queue to restore. */
  items: T[];
  /** The index of the song that is still playing in `items` (or -1 when there is none). */
  index: number;
  /**
   * True when the failed play only extended the queue it was called on (its advanced queue
   * still contains the whole pre-play queue, e.g. a continuation append made just before the
   * call). The caller then keeps the live continuation, which belongs to that extended queue;
   * otherwise it restores the pre-play continuation.
   */
  extended: boolean;
};

/**
 * Merge a failed playItem's rollback with queue edits made while the play was in flight (M4 rework).
 *
 * `previous` is the queue before the failed play, `advanced` the queue the failed play set
 * before resolving, and `current` the queue as it actually is when the failure lands (the
 * advanced queue plus any in-flight edits). The old rollback restored `previous` wholesale,
 * which clobbered those edits: an added song vanished, a removed song came back, and a
 * continuation append made just before the call was lost.
 *
 * When the advanced queue still contains the whole pre-play queue (the common case: playing
 * inside one list, or a continuation append), the pre-play queue IS the advanced queue, so
 * the merged queue is simply `current` — the advanced queue with the flight edits already
 * applied — and only the current index moves back to the song that is still playing.
 *
 * When the failed play replaced the queue with an unrelated one, the merged queue is the
 * pre-play queue with the flight edits re-applied: an item the flight removed (present in
 * `advanced`, gone from `current`) stays removed, an item the flight added (in `current`,
 * not in `advanced`) stays added after the nearest preceding surviving item, and an item
 * the advance itself dropped is restored. The current index is the still-playing song's
 * place in the merged queue.
 */
export function mergeFailedPlayQueue<T extends Keyed>({
  previous,
  advanced,
  current,
  previousIndex,
}: {
  previous: T[];
  advanced: T[];
  current: T[];
  previousIndex: number;
}): FailedPlayRollback<T> {
  const previousCurrent = previous[previousIndex] ?? null;
  // Nothing was playing: there is no song to roll back to, so the old queue stands as-is.
  if (!previousCurrent) return { items: previous, index: previousIndex, extended: false };
  const previousCurrentId = previousCurrent.id;
  // Which copy of the playing song was playing: how many earlier items in the pre-play
  // queue share its id. With the same song queued twice and the second copy playing, the
  // rollback must point at that second copy, not the first occurrence of the id.
  const previousRank = previous.slice(0, previousIndex).filter((item) => item.id === previousCurrentId).length;
  const indexOfCurrent = (items: T[]) => {
    const occurrences: number[] = [];
    items.forEach((item, index) => {
      if (item.id === previousCurrentId) occurrences.push(index);
    });
    // No copy left: the song that is still playing was removed mid-flight, so there is
    // no active song (-1) instead of highlighting an unrelated song at index 0.
    if (occurrences.length === 0) return -1;
    // The same-rank occurrence when it is still there; otherwise the last remaining
    // copy — an earlier copy was removed mid-flight, so the playing (later) copy is
    // the one that survives.
    return occurrences[Math.min(previousRank, occurrences.length - 1)];
  };
  // The failed play only extended the pre-play queue when every pre-play occurrence is
  // still present, in order, in the advanced queue.
  if (survivorsById(previous, advanced).every(Boolean)) {
    return { items: current, index: indexOfCurrent(current), extended: true };
  }
  const previousInAdvanced = presentById(previous, advanced);
  const previousInCurrent = presentById(previous, current);
  // Keep a pre-play item unless the flight removed it: it was in the advanced queue and
  // is no longer in the live queue. An item the advance itself dropped is restored.
  // Presence is by occurrence count, not in order: the advance may have dropped an
  // earlier item (or reordered the queue, e.g. shuffle), which must not hide a later
  // item's flight removal.
  const kept = previous.map((_, index) => !(previousInAdvanced[index] && !previousInCurrent[index]));
  const merged: T[] = previous.filter((_, index) => kept[index]);
  const currentInAdvanced = presentById(current, advanced);
  // Flight additions stay, placed after the nearest preceding surviving item in the live
  // queue (or at the end when there is none to anchor to).
  const lastPlacedAfter = new Map<T, T>();
  current.forEach((item, index) => {
    if (currentInAdvanced[index]) return;
    let anchor: T | null = null;
    for (let before = index - 1; before >= 0; before -= 1) {
      if (!currentInAdvanced[before]) continue;
      const candidate = previous.find((prev, prevIndex) => kept[prevIndex] && prev.id === current[before].id);
      if (candidate) {
        anchor = candidate;
        break;
      }
    }
    const after = anchor ? (lastPlacedAfter.get(anchor) ?? anchor) : null;
    const at = after ? merged.indexOf(after) : merged.length - 1;
    merged.splice(at + 1, 0, item);
    if (anchor) lastPlacedAfter.set(anchor, item);
  });
  return { items: merged, index: indexOfCurrent(merged), extended: false };
}

/** The queue as last rendered, with its continuation: what the live mirror holds. */
export type QueueState<T> = {
  items: T[];
  continuation: string | null;
  kind: "next" | "playlist" | null;
};

/**
 * The pre-play state a failed playItem rolls back to (M4): the render-time queue with
 * its index/continuation/kind, and whether shuffle was on. Captured before the play
 * advances anything — when ytm_player fails, the <audio> element keeps the previous
 * song (it is only re-sourced from `player`, which is only set on success), so the
 * queue must roll back to the song actually playing.
 */
export type FailedPlaySnapshot<T> = QueueState<T> & {
  index: number;
  shuffle: boolean;
};

/** Capture the pre-play state for a failed-play rollback. */
export function snapshotFailedPlay<T>(
  items: T[],
  index: number,
  continuation: string | null,
  kind: "next" | "playlist" | null,
  shuffle: boolean,
): FailedPlaySnapshot<T> {
  return { items, index, continuation, kind, shuffle };
}

export type FailedPlayRollbackDecision<T> = QueueState<T> & { index: number };

/**
 * Decide the queue, index, continuation and kind a failed playItem rolls back to (M4).
 *
 * `previous` is the pre-play snapshot, `advanced` the queue the failed play set before
 * resolving (with its continuation/kind), and `live` the queue as last rendered. The
 * caller applies the decision and must guard it with the play requestId: a failure
 * superseded by a newer play (or clearQueue) must never clobber it.
 *
 * When the failed play only extended the pre-play queue, the live continuation belongs
 * to the merged queue (a continuation append included); otherwise the pre-play
 * continuation is restored. The live queue is read from the render mirror because
 * playItem's closure only sees the queue from its render. When the failure lands
 * before that mirror's first render after the advance, the live queue is still the
 * snapshot, so the advanced queue stands in for it (no edit could have been applied yet).
 */
export function resolveFailedPlayRollback<T extends Keyed>({
  previous,
  advanced,
  advancedContinuation,
  advancedKind,
  live,
}: {
  previous: FailedPlaySnapshot<T>;
  advanced: T[];
  advancedContinuation: string | null;
  advancedKind: "next" | "playlist" | null;
  live: QueueState<T>;
}): FailedPlayRollbackDecision<T> {
  const renderedAfterAdvance = live.items !== previous.items || live.items === advanced;
  const current = renderedAfterAdvance ? live.items : advanced;
  const merged = mergeFailedPlayQueue({
    previous: previous.items,
    advanced,
    current,
    previousIndex: previous.index,
  });
  if (merged.extended) {
    return {
      items: merged.items,
      index: merged.index,
      continuation: renderedAfterAdvance ? live.continuation : advancedContinuation,
      kind: renderedAfterAdvance ? live.kind : advancedKind,
    };
  }
  return { items: merged.items, index: merged.index, continuation: previous.continuation, kind: previous.kind };
}
