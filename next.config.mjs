import { networkInterfaces } from "node:os";

import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

/**
 * Hosts the dev server will serve its internal assets to.
 *
 * Next 16 refuses `/_next/*` for a request whose Host is not one it recognises.
 * Opening the terminal from a phone at `http://<lan-ip>:9318` therefore returned
 * the page HTML (200) and then nothing else: the client bundle was blocked, the
 * terminal never mounted, and the static BootScreen markup sat there until the
 * boot watchdog reloaded into exactly the same wall. Nothing in the browser said
 * why — the dev server logged the refusal on this machine, not on the phone.
 *
 * Read live instead of hardcoded, because DHCP hands this machine a different
 * address on a different network and a pinned IP would silently stop working.
 * `DEV_ORIGINS` (comma-separated) covers anything this cannot see: a tunnel
 * host, a container bridge, a second NIC.
 */
const lanHosts = Object.values(networkInterfaces())
  .flat()
  .filter((n) => n && n.family === "IPv4" && !n.internal)
  .map((n) => n.address);

const allowedDevOrigins = [
  ...new Set([
    "localhost",
    "127.0.0.1",
    "bloomberg.localhost",
    ...lanHosts,
    ...(process.env.DEV_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ]),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins,
  experimental: {
    optimizePackageImports: [
      "@radix-ui/react-accordion",
      "@radix-ui/react-alert-dialog",
      "@radix-ui/react-aspect-ratio",
      "@radix-ui/react-avatar",
      "@radix-ui/react-checkbox",
      "@radix-ui/react-collapsible",
      "@radix-ui/react-context-menu",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-hover-card",
      "@radix-ui/react-label",
      "@radix-ui/react-menubar",
      "@radix-ui/react-navigation-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-progress",
      "@radix-ui/react-radio-group",
      "@radix-ui/react-scroll-area",
      "@radix-ui/react-select",
      "@radix-ui/react-separator",
      "@radix-ui/react-slider",
      "@radix-ui/react-slot",
      "@radix-ui/react-switch",
      "@radix-ui/react-tabs",
      "@radix-ui/react-toast",
      "@radix-ui/react-toggle",
      "@radix-ui/react-toggle-group",
      "@radix-ui/react-tooltip",
      "lucide-react",
      "recharts",
    ],
  },
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
};

export default withBundleAnalyzer(nextConfig);
