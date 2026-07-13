// Deterministic fixture image for browser validation. Four contrasting
// quadrants plus a grid make it obvious in a screenshot whether pieces
// rendered, scattered, and carry the right part of the image — a solid color
// (what the server e2e test uses) can't show any of that.
//
// Usage: node scripts/make-test-image.mjs [outPath]  (default .e2e/fixture.png)
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

// sharp is a server dependency; reuse it rather than adding a root dep for a
// dev-only script.
const require = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), "../apps/server/package.json"),
);
const sharp = require("sharp");

// 800x600 stays under any upload downscale threshold and keeps piece tabs
// visibly larger than the grid lines at default browser zoom.
const W = 800;
const H = 600;

const cells = [];
// 8x6 checker-tinted cells: adjacent pieces almost always differ in color,
// so a misplaced or missing piece is visible at a glance.
const COLS = 8;
const ROWS = 6;
const palette = ["#e74c3c", "#3498db", "#2ecc71", "#f1c40f", "#9b59b6", "#e67e22"];
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const fill = palette[(r * COLS + c) % palette.length];
    cells.push(
      `<rect x="${(c * W) / COLS}" y="${(r * H) / ROWS}" width="${W / COLS}" height="${H / ROWS}" fill="${fill}"/>`,
      `<text x="${(c * W) / COLS + W / COLS / 2}" y="${(r * H) / ROWS + H / ROWS / 2}" font-size="20" font-family="sans-serif" fill="black" text-anchor="middle" dominant-baseline="middle">${r},${c}</text>`,
    );
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${cells.join("")}</svg>`;

const out = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "../.e2e/fixture.png");
await mkdir(dirname(out), { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(out);
console.log(out);
