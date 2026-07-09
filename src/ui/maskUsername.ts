/**
 * Masks a player id/username for display in public feeds — first
 * character, a run of asterisks, and often a trailing character, e.g.
 * "Nino" -> "N****O", "Data" -> "D***1". Deterministic per name (hashed,
 * not re-randomized on every render) so the same player looks the same
 * across every row they appear in, but the star-count and whether there's
 * a trailing character both vary name to name so the feed doesn't read as
 * mechanically uniform.
 *
 * Never shows the real username past its first character — this is a
 * display-layer mask, not a reversible encoding.
 */

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function maskUsername(name: string): string {
  if (!name) return '*****';

  const hash = hashString(name);
  const first = name[0]!.toUpperCase(); // safe: the `!name` check above excludes ''
  const starCount = 3 + (hash % 4); // 3..6 asterisks
  const stars = '*'.repeat(starCount);

  const includeTrailing = name.length >= 2 && (hash >> 3) % 3 !== 0; // ~2/3 of names
  if (!includeTrailing) {
    return `${first}${stars}`;
  }

  const useDigit = (hash >> 5) % 2 === 0;
  // safe: only reached when includeTrailing required name.length >= 2
  const trailing = useDigit ? String((hash >> 7) % 10) : name[name.length - 1]!.toUpperCase();
  return `${first}${stars}${trailing}`;
}
