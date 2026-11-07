/**
 * Every project carries an accent drawn from the brand palette, used for its
 * dot in the switcher, its glyph in the library, and its rows in the account
 * modal. One helper so all three always agree.
 */

/**
 * The palette, in rotation order. Warm and cool alternate so neighbouring
 * projects never read as the same hue; burgundy comes last because it is the
 * brand, and a project wearing it first would look like the app's own chrome.
 */
export const PROJECT_PALETTE = [
  "#c94e3a", // coral
  "#e0a020", // saffron
  "#3e7bc9", // cloud
  "#8e4a9c", // orchid
  "#5a2620", // burgundy
] as const;

/**
 * Each accent's tint from the brand tokens (solid / node / tint): the wash a
 * project's colour leaves behind its own selected rows and labels. Burgundy,
 * which the tokens give no project tint, takes its own at the same lightness.
 */
const PROJECT_TINT: Record<string, string> = {
  "#c94e3a": "#fce4de", // coral
  "#e0a020": "#fcefd2", // saffron
  "#3e7bc9": "#e2edfb", // cloud
  "#8e4a9c": "#f3e4f5", // orchid
  "#5a2620": "#f3e6e3", // burgundy
};

export function accentTint(accent: string): string {
  return PROJECT_TINT[accent.toLowerCase()] ?? `color-mix(in srgb, ${accent} 14%, white)`;
}

/**
 * The ink a project's name takes when it is set on its own tint, as in the
 * Dashboard's thread labels: dark enough to read at 11px, but softened from
 * the solid so the label stays a pastel rather than a stamp. Coral's is the
 * brand's rosewood.
 */
const PROJECT_INK: Record<string, string> = {
  "#c94e3a": "#a8423a", // coral
  "#e0a020": "#7a5b0f", // saffron
  "#3e7bc9": "#2e5c94", // cloud
  "#8e4a9c": "#74407f", // orchid
  "#5a2620": "#6b4b36", // burgundy
};

export function accentInk(accent: string): string {
  return PROJECT_INK[accent.toLowerCase()] ?? `color-mix(in srgb, ${accent} 70%, #241412)`;
}

/** The palest stop of a ramp: a third of the accent, the rest white. Still
 *  a coloured chip on the white rail, never a blank one. */
const RAMP_FLOOR = 0.34;

/** `weight` of `color` over `ground`, in sRGB, as CSS `color-mix` does. */
function mix(color: string, ground: string, weight: number): string {
  const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const [over, under] = [channels(color), channels(ground)];
  return `#${over
    .map((channel, at) => Math.round(channel * weight + under[at] * (1 - weight)))
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

const mixWithWhite = (accent: string, weight: number) => mix(accent, "#ffffff", weight);

/**
 * One project's colour in `count` steps, in order: the accent at full
 * strength first, easing evenly to a pastel last. For things that belong to
 * a single project but still need telling apart — the collapsed library's
 * document chips — so they read as one family rather than as the palette.
 *
 * Derived from the accent rather than listed per colour, so every palette
 * entry has a ramp, and dropping one from the palette leaves nothing here to
 * update.
 */
export function accentRamp(accent: string, count: number): string[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) =>
    mixWithWhite(accent, count <= 1 ? 1 : 1 - (index / (count - 1)) * (1 - RAMP_FLOOR)));
}

/** Palette entry for a position in any list — projects, papers in a rail. */
export function accentAt(index: number): string {
  const size = PROJECT_PALETTE.length;
  return PROJECT_PALETTE[((index % size) + size) % size];
}

/**
 * Position in the project list drives the accent, so neighbouring projects
 * never collide — and the colour stays put across reloads instead of
 * reshuffling under the reader.
 */
export function projectAccent(
  projectId: string | undefined,
  order: Array<{ id: string }>,
): string {
  if (!projectId) return PROJECT_PALETTE[0];
  const index = order.findIndex((item) => item.id === projectId);
  if (index >= 0) return accentAt(index);
  // Not in the list yet (still loading) — stay stable via the id itself.
  let hash = 0;
  for (const char of projectId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PROJECT_PALETTE[hash % PROJECT_PALETTE.length];
}

function luminance(color: string): number {
  const hex = color.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const channel = (value: number) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Saffron is light enough that white text on it fails contrast while the
 * others need white. Pick the readable foreground per accent.
 */
export function onAccent(accent: string): string {
  return luminance(accent) > 0.4 ? "#241412" : "#ffffff";
}

const contrast = (one: string, other: string) => {
  const [light, dark] = [luminance(one), luminance(other)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
};

/**
 * The letter on one step of a project's ramp. A chip's letter is a glyph that
 * identifies it rather than text to be read, so it needs 3:1: white while the
 * step is strong enough to carry it, then a deep shade of the same accent (the
 * accent sunk into the palette's umber), so a light chip stays in its family
 * rather than taking a neutral brown. Derived like the ramp, so it holds for
 * any accent; the plain umber is only for one too pale to shade.
 */
export function onRampStep(accent: string, step: string): string {
  if (contrast("#ffffff", step) >= 3) return "#ffffff";
  const deep = mix(accent, "#241412", 0.45);
  return contrast(deep, step) >= 3 ? deep : "#241412";
}
