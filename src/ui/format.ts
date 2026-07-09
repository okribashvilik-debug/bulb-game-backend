/** Small formatting helpers shared across UI components — no game logic here. */

export function formatCurrency(value: number): string {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatCoefficient(value: number): string {
  return `${value.toFixed(2)}x`;
}

/** "bulb_3" -> 3. Bulb ids are always "bulb_<1-based index>". */
export function bulbNumber(bulbId: string): number {
  return Number(bulbId.split('_')[1]);
}

export function relativeTime(timestampMs: number, nowMs: number = Date.now()): string {
  const deltaSeconds = Math.max(0, Math.round((nowMs - timestampMs) / 1000));
  if (deltaSeconds < 5) return 'just now';
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}
