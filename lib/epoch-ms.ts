/** Unix seconds stay below 1e12 through year 33658; Unix ms for 2001+ are >= 1e12. */
const MILLIS_THRESHOLD = 1e12;

export function epochMillis(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.abs(value) < MILLIS_THRESHOLD ? Math.round(value * 1000) : value;
}
