/** WCAG contrast of white text on a colour given as "#rrggbb" or "r g b" (the --cm-* token format). */
export const contrastWithWhite = (color: string): number => {
  const rgb = color.startsWith('#')
    ? [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
    : color.trim().split(/\s+/).map(Number);
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
};

export const AA_TEXT = 4.5;
