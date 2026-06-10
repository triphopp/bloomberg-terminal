import type { Metadata } from "next";
import { Suspense } from "react";
import "../styles/globals.css";

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
    <html lang="en" suppressHydrationWarning>
      <body>
        <Suspense fallback={<AppSkeleton />}>
          {children}
        </Suspense>
      </body>
    </html>
  );
}
