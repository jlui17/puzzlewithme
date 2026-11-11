import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Figtree, Kalam, Newsreader } from "next/font/google";
import "./globals.css";
import "./scene.css";
import "./home.css";
import "./room.css";

// Figtree sets everything, Newsreader is the serif on headings, Kalam is the
// handwriting. All self-hosted by next/font at build time, so no runtime Google
// request; globals.css falls back to system faces if a variable is ever absent.
// Newsreader carries its optical-size axis: the headings set "opsz" as the mock does.
const figtree = Figtree({ subsets: ["latin"], variable: "--fs" });
const newsreader = Newsreader({ subsets: ["latin"], style: ["normal", "italic"], axes: ["opsz"], variable: "--fserif" });
const kalam = Kalam({ subsets: ["latin"], weight: "700", variable: "--fhand" });

export const metadata: Metadata = {
  title: "PuzzleWithMe",
  description: "Cooperative jigsaw puzzles, solved together.",
};

// Runs before first paint so a saved choice never flashes the other light. Key
// literal, default and legacy id pairs must match src/theme.ts; an unknown
// stored value is harmless (CSS falls back to :root, and getTheme to THEMES[0]).
const themeInit = `var d=document.documentElement,t;try{t=localStorage.getItem("pwm-theme")}catch(e){}d.dataset.theme=t?{day:"morning",night:"evening"}[t]??t:"evening"`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className={`${figtree.variable} ${newsreader.variable} ${kalam.variable}`}>{children}</body>
    </html>
  );
}
