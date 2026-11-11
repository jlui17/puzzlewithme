/**
 * The street, bokeh, rain and drops seen through the window, generated from
 * the same seeds as the approved mock so the band looks the same every load.
 * Coordinates are in the band's 1000×400 SVG viewBox; bokeh is in % of the band.
 */

/** Seeded PRNG (mulberry32): the mock's `mulberry`. */
export function mulberry(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f1 = (n: number): number => Math.round(n * 10) / 10;

/** Where the street meets the buildings. */
const STREET_Y = 330;

export interface Street {
  buildings: { x: number; y: number; width: number; height: number }[];
  litWindows: { x: number; y: number }[];
}

export function streetArt(): Street {
  const r = mulberry(11);
  const buildings: Street["buildings"] = [];
  let x = 0;
  while (x < 1000) {
    const width = 50 + Math.floor(r() * 80);
    const height = 40 + Math.floor(r() * 95);
    buildings.push({ x, y: STREET_Y - height, width, height: height + 80 });
    x += width + (r() < 0.3 ? 6 : 0);
  }
  const litWindows: Street["litWindows"] = [];
  for (const b of buildings) {
    for (let wy = b.y + 14; wy < 318; wy += 20) {
      for (let wx = b.x + 8; wx < b.x + b.width - 10; wx += 16) {
        if (r() < 0.16) litWindows.push({ x: wx, y: wy });
      }
    }
  }
  return { buildings, litWindows };
}

export const STREETLAMP_XS = [140, 420, 760] as const;

export interface BokehDot {
  left: number;
  top: number;
  size: number;
  color: string;
}

const BOKEH_COLORS = [
  "rgba(255,196,120,.9)",
  "rgba(255,214,150,.8)",
  "rgba(170,205,255,.75)",
  "rgba(255,170,90,.8)",
  "rgba(230,240,255,.7)",
];

export function bokehArt(): BokehDot[] {
  const r = mulberry(5);
  const dots: BokehDot[] = [];
  for (let i = 0; i < 14; i++) {
    const size = 10 + r() * 30;
    const left = r() * 100;
    const top = 40 + r() * 48;
    const color = BOKEH_COLORS[Math.floor(r() * BOKEH_COLORS.length)]!;
    dots.push({ left: f1(left), top: f1(top), size: f1(size), color });
  }
  return dots;
}

export interface RainLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  opacity: number;
}

export interface Rain {
  /** Three depths of streaks, each falling at its own speed (class r1, r2, r3). */
  layers: { className: string; strokeWidth: number; lines: RainLine[] }[];
  drops: { cx: number; cy: number; rx: number; ry: number }[];
}

/** Streaks and the drops on the glass share one seed, as in the mock. */
export function rainArt(): Rain {
  const r = mulberry(23);
  const layers = (
    [
      ["r1", 34, 1.3],
      ["r2", 28, 1],
      ["r3", 22, 0.8],
    ] as const
  ).map(([className, count, strokeWidth]) => {
    const lines: RainLine[] = [];
    for (let i = 0; i < count; i++) {
      const x = r() * 1000;
      const y = r() * 400;
      const len = 14 + r() * 38;
      const opacity = f1(0.25 + r() * 0.5);
      // Each streak is drawn twice, one band height apart, so the layer loops seamlessly as it falls 400.
      lines.push({ x1: f1(x), y1: f1(y), x2: f1(x + 1.5), y2: f1(y + len), opacity });
      lines.push({ x1: f1(x), y1: f1(y - 400), x2: f1(x + 1.5), y2: f1(y + len - 400), opacity });
    }
    return { className, strokeWidth, lines };
  });
  const drops: Rain["drops"] = [];
  for (let i = 0; i < 40; i++) {
    const cx = r() * 1000;
    const cy = r() * 400;
    const rx = 1.5 + r() * 3;
    drops.push({ cx: f1(cx), cy: f1(cy), rx: f1(rx), ry: f1(rx * 1.4) });
  }
  return { layers, drops };
}
