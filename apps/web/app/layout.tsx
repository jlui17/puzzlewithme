import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Nunito } from "next/font/google";
import "./globals.css";

// Rounded café-menu face for the soft themes; self-hosted by next/font at
// build time, so no runtime Google request. globals.css falls back to
// ui-rounded/system faces if the variable is ever absent.
const nunito = Nunito({ subsets: ["latin"], variable: "--font-round" });

export const metadata: Metadata = {
  title: "PuzzleWithMe",
  description: "Cooperative jigsaw puzzles, solved together.",
};

// Runs before first paint so a saved non-default theme never flashes the
// default (Latte) palette. Key literal must match THEME_STORAGE_KEY in
// src/theme.ts; an unknown stored value is harmless (CSS falls back to :root).
const themeInit = `try{var t=localStorage.getItem("pwm-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className={nunito.variable}>{children}</body>
    </html>
  );
}
