import { Toaster } from "@/components/ui/sonner";
import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_Thai } from "next/font/google";
import { Suspense } from "react";
import { BootWatchdog } from "./boot-watchdog";
import "../styles/globals.css";

// Reading faces for the thesis workspace (`.reading` in globals.css) — the same
// pair the research pages name. next/font serves them from this app's own
// origin, so nothing is fetched from Google while the terminal runs.
const readSans = IBM_Plex_Sans_Thai({
  weight: ["400", "500", "600", "700"],
  subsets: ["thai", "latin"],
  variable: "--font-read",
  display: "swap",
});
const readMono = IBM_Plex_Mono({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-read-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Bloomberg Terminal",
  description: "Next.js Minimal Trader Terminal",
};

function AppSkeleton() {
  return (
    <div className="flex items-center justify-center h-screen" style={{ background: "#000" }}>
      <div className="flex flex-col items-center gap-4">
        <span className="text-sm font-bold font-mono tracking-[0.3em]" style={{ color: "#ff9900" }}>
          BLOOMBERG
        </span>
        <div className="flex gap-1">
          {[...Array(12)].map((_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decorative array, never reordered or mutated
              key={i}
              className="w-2 h-6 animate-pulse"
              style={{
                background: i < 3 ? "#ff9900" : i < 6 ? "#333" : "#1a1a1a",
                animationDelay: `${i * 80}ms`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${readSans.variable} ${readMono.variable}`}
    >
      <body>
        <BootWatchdog />
        <Suspense fallback={<AppSkeleton />}>{children}</Suspense>
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
