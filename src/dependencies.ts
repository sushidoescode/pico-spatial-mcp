/** Select live dependencies only when no overrides were supplied. Never mix the
 * production effect lanes into a nonempty injected dependency set. The factory
 * stays lazy so incomplete injection fails before any live adapter is created. */
export function completeDependencies<T extends object>(
  owner: string,
  overrides: Partial<T> | undefined,
  requiredKeys: { [K in keyof T]-?: true },
  createLive: () => T,
): T {
  if (overrides === undefined) return createLive();
  const prototype = Object.getPrototypeOf(overrides);
  if (Reflect.ownKeys(overrides).length === 0 && (prototype === Object.prototype || prototype === null)) {
    return createLive();
  }
  const injected: Partial<T> = { ...overrides };
  const keys = Object.keys(requiredKeys) as Array<keyof T>;
  // Class/prototype methods are supplied dependencies too, never an empty request
  // for production defaults. Snapshot them along with the caller's own fields.
  for (const key of keys) {
    if (!Object.hasOwn(injected, key) && key in overrides) injected[key] = overrides[key];
  }
  const missing = keys
    .filter((key) => injected[key] === undefined || injected[key] === null);
  if (missing.length) {
    throw new Error(`${owner}: incomplete dependency injection; missing keys: ${missing.map(String).join(", ")}`);
  }
  return injected as T;
}
