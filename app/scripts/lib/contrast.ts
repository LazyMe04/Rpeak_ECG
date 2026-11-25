/**
 * WCAG contrast, so a theme can be asserted rather than eyeballed.
 *
 * The light theme shipped in G2 with screenshots and no assertions. A
 * regression that made the light theme's text unreadable would have passed
 * every test in the project, because every check reads structure or numbers and
 * none of them reads colour.
 *
 * These helpers take the *resolved* custom properties from the live document,
 * composite the panel's translucent fill over the page behind it, and return
 * the contrast ratio the reader actually gets.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** `#rgb`, `#rrggbb`, `rgb(...)`, `rgba(...)`. Anything else throws. */
export function parseColor(value: string): Rgb {
  const s = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    if (h.length === 6 || h.length === 8) {
      const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
      return {
        r: n(0),
        g: n(2),
        b: n(4),
        a: h.length === 8 ? n(6) / 255 : 1,
      };
    }
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (fn) {
    const parts = fn[1]!
      .split(/[,/\s]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length >= 3 && parts.every((p) => Number.isFinite(p))) {
      return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
    }
  }
  throw new Error(`cannot parse colour: ${JSON.stringify(value)}`);
}

/** `fg` over `bg`, both opaque results. */
export function over(fg: Rgb, bg: Rgb): Rgb {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function luminance(c: Rgb): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG 2.1 contrast ratio, 1 (identical) to 21 (black on white). */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
