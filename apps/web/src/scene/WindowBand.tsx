import { Fragment } from "react";
import { bokehArt, rainArt, STREETLAMP_XS, streetArt } from "./window-art";

const STREET = streetArt();
const BOKEH = bokehArt();
const RAIN = rainArt();

/**
 * The band of window across the top of every screen: a rainy street, the
 * lamp's halo and reflection in the glass, and the title written in the fog.
 * The title is the page's heading; everything else is decoration, hidden from
 * assistive tech.
 */
export function WindowBand({ rainPaused = false }: { rainPaused?: boolean }) {
  return (
    <div className="window">
      <svg className="street" aria-hidden="true" viewBox="0 0 1000 400" preserveAspectRatio="xMidYMax slice">
        <defs>
          <linearGradient id="wet-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffd79a" stopOpacity=".45" />
            <stop offset="1" stopColor="#ffd79a" stopOpacity="0" />
          </linearGradient>
        </defs>
        {STREET.buildings.map((b) => (
          <rect key={b.x} className="building" x={b.x} y={b.y} width={b.width} height={b.height} />
        ))}
        {STREET.litWindows.map((w) => (
          <rect key={`${w.x},${w.y}`} className="lit" x={w.x} y={w.y} width="5" height="7" rx="1" />
        ))}
        <g className="wet">
          {STREETLAMP_XS.map((x) => (
            <Fragment key={x}>
              <rect x={x - 2} y="268" width="4" height="62" fill="#1d1a16" />
              <circle cx={x} cy="264" r="4.5" fill="#ffd79a" />
              <rect x={x - 10} y="330" width="20" height="70" fill="url(#wet-grad)" />
            </Fragment>
          ))}
        </g>
      </svg>
      <div className="bokeh" aria-hidden="true">
        {BOKEH.map((d, i) => (
          <i
            key={i}
            className="bk"
            style={{
              left: `${d.left}%`,
              top: `${d.top}%`,
              width: d.size,
              height: d.size,
              background: `radial-gradient(circle, ${d.color} 0%, transparent 70%)`,
            }}
          />
        ))}
      </div>
      <svg className={rainPaused ? "rain is-paused" : "rain"} aria-hidden="true" viewBox="0 0 1000 400" preserveAspectRatio="none">
        {RAIN.layers.map((layer) => (
          <g key={layer.className} className={layer.className}>
            {layer.lines.map((l, i) => (
              <line key={i} {...l} strokeWidth={layer.strokeWidth} />
            ))}
          </g>
        ))}
      </svg>
      <svg className="drops" aria-hidden="true" viewBox="0 0 1000 400" preserveAspectRatio="none">
        {RAIN.drops.map((d, i) => (
          <ellipse key={i} {...d} />
        ))}
      </svg>
      <div className="fog" aria-hidden="true" />
      <div className="lamp-halo" aria-hidden="true" />
      <div className="mullion" aria-hidden="true" />
      <h1 className="fog-title">
        PuzzleWithMe
        <span className="drip" aria-hidden="true" />
        <small>one jigsaw, as many hands as you like</small>
      </h1>
      <div className="lamp-reflection" aria-hidden="true">
        <svg viewBox="0 0 150 178">
          <use href="#lamp-shape" />
        </svg>
      </div>
    </div>
  );
}
