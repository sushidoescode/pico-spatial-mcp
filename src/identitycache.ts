/**
 * identitycache.ts — the one-entry cache every selected-SDK resource in this server uses.
 *
 * The bug class this exists to kill: a module-level `let cached = null; if (cached) return cached`
 * answers "have I run before?" when the question is "is this still the thing that was selected?".
 * A server that resolved adb / the emulator proto / the agent-vault once then kept serving that
 * answer across a toolchain switch, a payload replacement or a vault re-materialization — with no
 * restart in sight — is reporting the identity of a file that is no longer there.
 *
 * So the cache is keyed on WHAT WAS LOADED, never on WHETHER something was loaded. The caller
 * computes a cheap identity string for the current inputs (paths + sizes + mtimes, or content
 * hashes where the inputs are small) and hands it in; a different key is a different resource.
 *
 * Deliberately one entry, not a Map. These caches exist to skip repeated work on a hot path, not
 * to retain history — and an unbounded Map keyed on file content is a memory leak that grows every
 * time a payload is rebuilt. A consumer that genuinely serves several resources at once (the vault
 * does: a diff loads two roots) keeps one IdentityCache per resource instead.
 *
 * Two invariants the tests pin:
 *  - nothing is published until `load` returns. A throw, or a structured "unavailable" the caller
 *    refuses through `getOr`, leaves the cache EMPTY — absence is never cached, so a resource that
 *    appears later is picked up without a restart.
 *  - a differing key evicts BEFORE `load` runs, so a failed reload can never resurface the value
 *    that the previous key produced.
 */
export class IdentityCache<T> {
  private key: string | null = null;
  private value: T | undefined = undefined;
  // Presence is its own flag rather than `value !== undefined`, so a value that IS `undefined`
  // still counts as published instead of silently missing on every call.
  private loaded = false;

  /** The cached value for `key`, loading (and publishing) it when the identity has changed. */
  get(key: string, load: () => T): T {
    return this.getOr(key, load, () => true);
  }

  /**
   * As `get`, but the caller decides whether the loaded value may be published. Use it when the
   * loader reports failure as a value rather than as a throw (`{error}` results, a null index):
   * `cacheable` returning false leaves the cache empty so the next call retries.
   */
  getOr<U extends T>(key: string, load: () => U, cacheable: (value: U) => boolean): U {
    if (this.loaded && this.key === key) return this.value as U;
    // Evict first: a loader that throws must not leave the PREVIOUS key's value reachable under
    // a key it does not belong to, and must not leave this key pointing at stale bytes.
    this.clear();
    const value = load();
    if (cacheable(value)) {
      this.key = key;
      this.value = value;
      this.loaded = true;
    }
    return value;
  }

  /** Drop the entry. Tests use this to prove a cache miss; production rarely needs it. */
  clear(): void {
    this.key = null;
    this.value = undefined;
    this.loaded = false;
  }
}
