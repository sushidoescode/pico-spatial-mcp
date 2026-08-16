const MAX_RUN_SNAPSHOT_BYTES = 512 * 1024 * 1024;

/**
 * Fixed-ceiling accumulator shared by the store and its exact-boundary tests.
 * This intentionally accepts no limit argument, so callers cannot broaden the
 * Task 2 admission ceiling.
 */
export function accumulateRunSnapshotBytes(current: number, bytes: number): number | null {
  if (!Number.isSafeInteger(current) || current < 0
    || !Number.isSafeInteger(bytes) || bytes < 0) return null;
  const next = current + bytes;
  return Number.isSafeInteger(next) && next <= MAX_RUN_SNAPSHOT_BYTES ? next : null;
}
