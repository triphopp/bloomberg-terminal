/**
 * Type sizes of the TICK DATA grammar — one mono line per symbol, SYM · LAST ·
 * CHG · extra — shared by the MKT TICK DATA board, the watchlist compact view
 * (pinned-assets) and the FREQ / ACTIVE lists (discover-lists).
 *
 * One place so the three never drift apart: they sit side by side on MKT and
 * a size difference between them reads as a bug. Full class strings (not
 * pieces) so Tailwind's scanner sees them.
 *
 * 2026-09-26: rows 9px → 10.5px (line 13 → 15px) — readable at a glance
 * without squinting, ~15% taller rows.
 */

/** The table itself: every symbol row inherits this. */
export const TICK_TABLE = "w-full text-[10.5px] leading-[15px] font-mono";

/** Sticky column header (SYM / LAST / CHG …). */
export const TICK_HEAD = "text-[8px] font-bold tracking-wider leading-[13px]";

/** Collapsible section header (AMERICAS, RATES·US, a watchlist sector …). */
export const TICK_REGION = "text-[9px] font-bold tracking-widest leading-[16px]";

/** Sub-group label inside a section (S&P TERM, VOL OF VOL …). */
export const TICK_SUBGROUP = "text-[8px] font-bold tracking-widest leading-[13px]";

/** One-line notice in place of rows (loading / empty / error). */
export const TICK_NOTE = "text-[9px] font-mono leading-[15px]";
