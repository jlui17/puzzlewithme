import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Caveat, Lora, Nunito } from "next/font/google";
import "./globals.css";

// The café's three hands: Nunito sets everything, Lora is the chalkboard
// serif on headings, Caveat is the pen the owner writes asides with. All
// self-hosted by next/font at build time, so no runtime Google request;
// globals.css falls back to system faces if a variable is ever absent.
const nunito = Nunito({ subsets: ["latin"], variable: "--font-round" });
const lora = Lora({ subsets: ["latin"], variable: "--font-serif" });
const caveat = Caveat({ subsets: ["latin"], variable: "--font-script" });

export const metadata: Metadata = {
  title: "PuzzleWithMe",
  description: "Cooperative jigsaw puzzles, solved together.",
};

// Runs before first paint so a saved night choice never flashes daylight. Key
// literal must match THEME_STORAGE_KEY in src/theme.ts; an unknown stored value
// is harmless (CSS falls back to :root, and getTheme to THEMES[0]).
const themeInit = `try{var t=localStorage.getItem("pwm-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className={`${nunito.variable} ${lora.variable} ${caveat.variable}`}>{children}</body>
    </html>
  );
}
