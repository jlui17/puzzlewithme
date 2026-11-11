import type { ReactNode } from "react";

/**
 * The window seat every screen sits in: put a WindowBand, a Sill and a Table
 * inside. `screen` picks the home's tall window or the room's thin one.
 */
export function Scene({ screen, children }: { screen: "home" | "room"; children: ReactNode }) {
  return (
    <div className="scene" data-screen={screen}>
      {children}
      <SceneShapes />
    </div>
  );
}

/** The lamp and cup drawings and the soft shadow they share, referenced by `<use>`. Kept rendered (not display:none) so `<use>` can reach them. */
function SceneShapes() {
  return (
    <svg className="scene-shapes" aria-hidden="true">
      <defs>
        <filter id="soft" x="-30%" y="-100%" width="160%" height="300%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
        <linearGradient id="shade-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--lamp-shade)" />
          <stop offset="1" stopColor="var(--lamp-shade-2)" />
        </linearGradient>
        <symbol id="lamp-shape" viewBox="0 0 150 178">
          <ellipse cx="75" cy="167" rx="50" ry="7" fill="rgba(0,0,0,.6)" filter="url(#soft)" />
          <ellipse cx="75" cy="88" rx="30" ry="9" fill="var(--bulb)" opacity=".9" />
          <path d="M44 18 H106 L134 86 H16 Z" fill="url(#shade-grad)" />
          <path d="M16 86 H134 L136 92 H14 Z" fill="var(--lamp-shade-2)" />
          <rect x="71" y="92" width="8" height="62" rx="2" fill="var(--lamp-metal)" />
          <ellipse cx="75" cy="160" rx="34" ry="9" fill="var(--lamp-metal)" />
          <ellipse cx="75" cy="157" rx="34" ry="8" fill="var(--lamp-metal-2)" />
          <ellipse cx="75" cy="155" rx="20" ry="4" fill="rgba(255,255,255,.1)" />
        </symbol>
        {/* Seen from the seat, a little above. The ring is drawn in currentColor. */}
        <symbol id="cup-shape" viewBox="0 0 64 64">
          <ellipse cx="33" cy="58" rx="27" ry="5" fill="rgba(0,0,0,.5)" filter="url(#soft)" />
          <ellipse cx="32" cy="55" rx="26" ry="6.5" fill="var(--cup)" />
          <ellipse cx="32" cy="55" rx="26" ry="6.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
          <ellipse cx="32" cy="54" rx="15" ry="3.5" fill="rgba(0,0,0,.18)" />
          <path d="M51 29 C61 27, 62 43, 50 43" fill="none" stroke="var(--cup)" strokeWidth="4.5" strokeLinecap="round" />
          <path d="M12 23 C12 42, 16 52, 32 52 C48 52, 52 42, 52 23 Z" fill="var(--cup)" />
          <path
            d="M12 23 C12 42, 16 52, 32 52 C40 52, 44 48, 46 40 C40 44, 30 44, 24 40 C18 36, 14 30, 12 23 Z"
            fill="rgba(0,0,0,.14)"
          />
          <path d="M13.5 32 C17 39, 24 41.5, 32 41.5 C40 41.5, 47 39, 50.5 32" fill="none" stroke="currentColor" strokeWidth="3" />
          <ellipse cx="32" cy="23" rx="20" ry="6" fill="#d9ccb6" />
          <ellipse cx="32" cy="23.5" rx="16.5" ry="4.5" fill="var(--coffee)" />
          <ellipse cx="28" cy="22.5" rx="5" ry="1.4" fill="rgba(255,235,200,.3)" />
        </symbol>
      </defs>
    </svg>
  );
}
