/** Deterministic small colour palette for session avatar dots and similar
 *  decorative chips. Pure HSL values so they read in both light and dark
 *  themes without needing a CSS variable indirection. */
const DOT_COLORS = [
  'hsl(214 84% 56%)', // blue
  'hsl(160 76% 42%)', // emerald
  'hsl(38 92% 50%)',  // amber
  'hsl(0 72% 58%)',   // red
  'hsl(280 70% 60%)', // violet
  'hsl(190 80% 45%)', // cyan
  'hsl(330 75% 60%)', // pink
  'hsl(90 55% 45%)',  // olive
]

export function hashColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0
  }
  return DOT_COLORS[Math.abs(hash) % DOT_COLORS.length]
}
