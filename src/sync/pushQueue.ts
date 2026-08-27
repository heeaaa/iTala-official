// Serialized mirror of local mutations to the server.
//
// WHY THIS EXISTS
//
// Every dispatch used to fire its own `pushAction` without waiting for the
// previous one, so two writes issued milliseconds apart raced each other over
// the network. On the same row that is not a style problem, it is data loss:
//
//   tap 3PM   -> INSERT events (slow request)
//   tap Undo  -> DELETE events (fast request)
//
// If the DELETE is served first it matches nothing and removes nothing, then the
// INSERT lands. The device that undid the basket shows the correct score; the
// server and every other device show the basket. The next pull - which fires
// automatically on the realtime echo - copies the server's version back over the
// top, so the undo silently reverts on the device that performed it too.
//
// Undoing a mis-tap straight away is the single most common use of undo on a live
// scoreboard, and request reordering on gym wifi is ordinary, so this was not a
// rare race.
//
// The fix is to give the sync layer the one guarantee it was written assuming:
// pushes reach the server in dispatch order. A promise chain is enough - the
// volume is a few writes per possession, and a serialized chain still overlaps
// with rendering because nothing awaits it on the UI thread.
//
// A rejected push must not stall the queue, so the chain continues on failure.
// Callers still see their own rejection (pushAction rethrows only for writes
// where a silent failure loses visible data).

let tail: Promise<unknown> = Promise.resolve();

/**
 * Queue a server write. Runs after every previously queued write has settled,
 * so pushes are applied in the order they were dispatched. The returned promise
 * resolves/rejects with the caller's own result, not the queue's.
 */
export function enqueuePush<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn); // run regardless of how the previous one ended
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** How many writes are still queued or in flight. Diagnostics only. */
export function pushQueueIdle(): Promise<void> {
  return tail.then(
    () => undefined,
    () => undefined,
  );
}

/** Test hook: drop any queued work so suites start from a clean chain. */
export function __resetPushQueue(): void {
  tail = Promise.resolve();
}
