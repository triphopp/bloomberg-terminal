"use client";

import type { NavItem } from "./terminal-header";
import { handleViewLinkClick } from "./view-navigation";

type MobileNavProps = {
  currentView: string;
  navItems: NavItem[];
  colors: { border: string; accent: string; textSecondary: string; background: string };
};

/**
 * MobileNav — bottom view switcher for phones (<768px).
 *
 * The desktop header packs the nav into a 22px strip beside the key indicators;
 * on a phone that strip is a thumb's width from the top of the screen and each
 * target is ~12px tall. Here the same items sit at the bottom, one row, full
 * height taps. Text only — the active view is the accent colour, nothing else.
 */
export function MobileNav({ currentView, navItems, colors }: MobileNavProps) {
  return (
    <nav
      className="shrink-0 flex items-stretch overflow-x-auto font-mono select-none"
      style={{
        borderTop: `1px solid ${colors.border}`,
        backgroundColor: colors.background,
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      {navItems.map((item) => {
        const isActive = currentView === item.id;
        return (
          <a
            key={item.id}
            href={item.href}
            onClick={(event) => handleViewLinkClick(event, item.href, item.onClick)}
            className="flex-1 min-w-[48px] h-11 flex items-center justify-center text-[11px] tracking-wider"
            style={{
              color: isActive ? colors.accent : colors.textSecondary,
              fontWeight: isActive ? 700 : 400,
            }}
            aria-current={isActive ? "page" : undefined}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
