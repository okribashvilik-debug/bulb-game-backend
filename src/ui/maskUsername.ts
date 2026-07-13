/**
 * Masks a player id/username for display in public feeds — always a
 * fixed-width 7 characters: first character + 5 asterisks + last
 * character, e.g. "Nino" -> "N*****O", "Julia1" -> "J*****1". Fixed
 * width regardless of the original name's length, so name columns render
 * uniformly.
 *
 * Never shows the real username past its first and last characters —
 * this is a display-layer mask, not a reversible encoding.
 */

export function maskUsername(name: string): string {
  if (!name) return '*******';
  const first = name[0]!.toUpperCase(); // safe: the `!name` check above excludes ''
  const last = name[name.length - 1]!.toUpperCase(); // 1-char names repeat the char
  return `${first}*****${last}`;
}
