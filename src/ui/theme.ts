// Creator theming: @bg / @accent / @font map onto the CSS custom properties
// the player UI is built from. Shades (panel, border, dim text) are derived
// from the chosen background so one color is enough to restyle everything.

import type { Theme, FontChoice } from "../dsl/types";

export const FONTS: Record<FontChoice, string> = {
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  serif: 'Georgia, "Times New Roman", Times, serif',
  book: '"Iowan Old Style", Palatino, "Palatino Linotype", "Book Antiqua", Georgia, serif',
  sans: 'system-ui, "Helvetica Neue", Helvetica, Arial, sans-serif',
  humanist: "Verdana, Geneva, Tahoma, sans-serif",
};

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHex([r, g, b]: RGB): string {
  const h = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function luminance([r, g, b]: RGB): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Set theme CSS variables on an element (the player container or the page root). */
export function applyTheme(el: HTMLElement, theme: Theme): void {
  if (theme.bg) {
    const bg = hexToRgb(theme.bg);
    // Readable neutral foreground for the chosen background.
    const fg = luminance(bg) > 0.5 ? hexToRgb("#222222") : hexToRgb("#d8d8d8");
    el.style.setProperty("--bg", theme.bg);
    el.style.setProperty("--fg", rgbToHex(fg));
    el.style.setProperty("--fg-strong", luminance(bg) > 0.5 ? "#000000" : "#ffffff");
    el.style.setProperty("--bg-panel", rgbToHex(mix(bg, fg, 0.05)));
    el.style.setProperty("--bg-raised", rgbToHex(mix(bg, fg, 0.1)));
    el.style.setProperty("--border", rgbToHex(mix(bg, fg, 0.18)));
    el.style.setProperty("--fg-dim", rgbToHex(mix(fg, bg, 0.28)));
    el.style.setProperty("--fg-faint", rgbToHex(mix(fg, bg, 0.48)));
  }
  if (theme.accent) el.style.setProperty("--accent", theme.accent);
  if (theme.font) el.style.setProperty("--font", FONTS[theme.font]);
}
