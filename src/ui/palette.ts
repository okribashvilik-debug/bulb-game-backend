/**
 * Locked bulb color palette — one bold, high-contrast hue per bulb position
 * (1-indexed), stable regardless of bulb count or which bulb is secretly
 * the favorite. Hues are spaced roughly 36° apart at fixed, hand-tuned
 * saturation/lightness so all 10 stay mutually distinct at a glance, which
 * is the whole point: a player should be able to track "my bulb" by color
 * without reading the number every time.
 *
 * This is intentionally a SEPARATE palette from the UI chrome tokens in
 * styles.css — bulbs are the one place saturated color is allowed to run
 * wild; everything else (panels, text, borders) stays inside the small
 * locked neutral+accent set.
 */
export const BULB_PALETTE: readonly string[] = [
  '#ff5a5f', // 1 coral red
  '#ff9f2e', // 2 amber
  '#f5d033', // 3 gold-yellow
  '#8bd346', // 4 lime green
  '#1fc2a1', // 5 teal
  '#2f9bff', // 6 sky blue
  '#6c6cff', // 7 indigo
  '#b46cf2', // 8 violet
  '#ef4fa0', // 9 magenta
  '#ff7a3d', // 10 deep orange
];

export function getBulbColor(bulbId: string): string {
  const index = Number(bulbId.split('_')[1]) - 1;
  return BULB_PALETTE[index % BULB_PALETTE.length];
}
