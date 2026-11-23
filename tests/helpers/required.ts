/** Returns a value the test depends on, failing with a named error instead of a later TypeError. */
export function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Missing required test value: ${label}`);
  return value;
}
