"use client";

/**
 * The one place the UI pins, moves and creates-a-group-and-pins.
 *
 * Rule: one symbol = one pin in exactly one group (multi-category is what tags
 * are for). Every entry point - global search, stock view, WATCHLIST's ADD row -
 * goes through `pin()`, which calls `PUT /api/pins/by-symbol/{symbol}`. The
 * server decides created / moved / unchanged and creates the group in the same
 * transaction, so there is no "pin landed in a group that does not exist" state.
 *
 * Writes are optimistic with a rollback and a visible error: an earlier version
 * swallowed failures with `.catch(console.error)`, the pin showed until the next
 * reload and then vanished (memory/reference/gotchas.md, "optimistic write +
 * catch(console.error)"). There is deliberately no localStorage here - the
 * server response is the truth; WATCHLIST keeps its own offline cache.
 */

import { atom, useAtom } from "jotai";
import { useCallback } from "react";
import { toast } from "sonner";
import { type PinGroup, type PinnedAsset, pinGroupsAtom, pinnedAssetsAtom } from "../atoms";

export const DEFAULT_WATCHLIST_GROUP: PinGroup = {
  id: "watchlist",
  name: "Watchlist",
  color: "#f59e0b",
};

/** Where the symbol should end up: an existing group, or one to create. */
export type PinTarget =
  | { groupId: string; newGroup?: undefined }
  | { newGroup: { name: string; color?: string }; groupId?: undefined };

/** Optional pin fields; leave one out to keep the existing pin's value. */
export interface PinExtras {
  comment?: string;
  buyTarget?: number | null;
  sellTarget?: number | null;
  priceAtPin?: number | null;
  priority?: number;
  tags?: string[];
}

export type PinAction = "created" | "moved" | "unchanged" | "updated";

export interface PinResult {
  action: PinAction;
  pin: PinnedAsset;
  group: PinGroup;
}

interface PinRow {
  id: string;
  symbol: string;
  group_id: string;
  comment?: string | null;
  added_at?: string | null;
  buy_target?: number | null;
  sell_target?: number | null;
  price_at_pin?: number | null;
  priority?: number | null;
  tags?: string[] | null;
}

interface GroupRow {
  id: string;
  name: string;
  color: string;
}

const today = () => new Date().toISOString().split("T")[0];

function mapPin(a: PinRow): PinnedAsset {
  return {
    id: a.id,
    symbol: a.symbol,
    groupId: a.group_id,
    comment: a.comment ?? "",
    addedAt: a.added_at ?? "",
    buyTarget: a.buy_target ?? null,
    sellTarget: a.sell_target ?? null,
    priceAtPin: a.price_at_pin ?? undefined,
    priority: a.priority ?? 1,
    tags: a.tags ?? [],
  };
}

const mapGroup = (g: GroupRow): PinGroup => ({ id: g.id, name: g.name, color: g.color });

/** Last write error, for any surface that wants an inline badge as well as the toast. */
export const pinErrorAtom = atom<string>("");

/** Set once the atoms hold server data, so a second picker does not refetch. */
let hydrated = false;
export const markPinsHydrated = () => {
  hydrated = true;
};

const normSymbol = (s: string) => s.trim().toUpperCase();

export function usePinActions() {
  const [groups, setGroups] = useAtom(pinGroupsAtom);
  const [pins, setPins] = useAtom(pinnedAssetsAtom);
  const [error, setError] = useAtom(pinErrorAtom);

  /** Group id the symbol is pinned in, if any. */
  const groupOf = useCallback(
    (symbol: string) => pins.find((p) => p.symbol === normSymbol(symbol))?.groupId,
    [pins]
  );

  /**
   * Fill the atoms from the server when nothing has (WATCHLIST hydrates them on
   * mount, but global search and stock view can open first). Cheap and once.
   */
  const ensureLoaded = useCallback(async () => {
    if (hydrated) return;
    try {
      const [gr, ar] = await Promise.all([fetch("/api/pins/groups"), fetch("/api/pins/assets")]);
      if (!gr.ok || !ar.ok) throw new Error(`HTTP ${gr.ok ? ar.status : gr.status}`);
      const [g, a] = (await Promise.all([gr.json(), ar.json()])) as [GroupRow[], PinRow[]];
      setGroups(g.map(mapGroup));
      setPins(a.map(mapPin));
      hydrated = true;
    } catch (err) {
      console.error("[pins] load failed", err);
      setError("Could not load pin groups");
    }
  }, [setGroups, setPins, setError]);

  /**
   * Pin `symbol` into `target` (or move it there if it is already pinned).
   * Resolves to the server result, or null after rolling back and reporting.
   */
  const pin = useCallback(
    async (
      symbolRaw: string,
      target?: PinTarget,
      extras: PinExtras = {}
    ): Promise<PinResult | null> => {
      const symbol = normSymbol(symbolRaw);
      if (!symbol) return null;
      setError("");

      // ── optimistic state ──────────────────────────────────────────────────
      const prevPin = pins.find((p) => p.symbol === symbol);
      let optimisticGroup: PinGroup | undefined;
      let groupId =
        target?.groupId ?? prevPin?.groupId ?? groups[0]?.id ?? DEFAULT_WATCHLIST_GROUP.id;
      let addedGroup = false;
      if (target?.newGroup) {
        const name = target.newGroup.name.trim();
        const same = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
        optimisticGroup = same ?? {
          id: `tmp-${Date.now()}`,
          name,
          color: target.newGroup.color ?? DEFAULT_WATCHLIST_GROUP.color,
        };
        groupId = optimisticGroup.id;
        addedGroup = !same;
      } else if (groups.length === 0) {
        optimisticGroup = DEFAULT_WATCHLIST_GROUP;
        addedGroup = true;
      }
      const tmpId = `tmp-pin-${Date.now()}`;
      const optimisticPin: PinnedAsset = prevPin
        ? { ...prevPin, groupId, ...extrasToPin(extras) }
        : {
            id: tmpId,
            symbol,
            groupId,
            comment: extras.comment ?? "",
            addedAt: today(),
            ...extrasToPin(extras),
          };
      if (addedGroup && optimisticGroup) {
        const g = optimisticGroup;
        setGroups((gs) => [...gs, g]);
      }
      setPins((ps) =>
        prevPin ? ps.map((p) => (p.symbol === symbol ? optimisticPin : p)) : [...ps, optimisticPin]
      );

      const rollback = (msg: string, err: unknown) => {
        console.error(`[pins] ${msg}`, err);
        if (addedGroup && optimisticGroup) {
          const gid = optimisticGroup.id;
          setGroups((gs) => gs.filter((g) => g.id !== gid));
        }
        setPins((ps) =>
          prevPin
            ? ps.map((p) => (p.symbol === symbol ? prevPin : p))
            : ps.filter((p) => p.symbol !== symbol)
        );
        setError(msg);
        toast.error(msg);
      };

      // ── server ────────────────────────────────────────────────────────────
      try {
        const body: Record<string, unknown> = {};
        if (target?.newGroup) body.new_group = target.newGroup;
        else if (target?.groupId) body.group_id = target.groupId;
        if (extras.comment !== undefined) body.comment = extras.comment;
        if (extras.buyTarget !== undefined) body.buy_target = extras.buyTarget;
        if (extras.sellTarget !== undefined) body.sell_target = extras.sellTarget;
        if (extras.priceAtPin !== undefined) body.price_at_pin = extras.priceAtPin;
        if (extras.priority !== undefined) body.priority = extras.priority;
        if (extras.tags !== undefined) body.tags = extras.tags;

        const res = await fetch(`/api/pins/by-symbol/${encodeURIComponent(symbol)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const detail =
            typeof data?.detail === "string" ? data.detail : (data?.error ?? `HTTP ${res.status}`);
          throw new Error(detail);
        }
        const result: PinResult = {
          action: data.action,
          pin: mapPin(data.pin),
          group: mapGroup(data.group),
        };
        // The server's group/pin replace the optimistic (temp-id) ones.
        setGroups((gs) => {
          const rest = gs.filter((g) => g.id !== optimisticGroup?.id || g.id === result.group.id);
          return rest.some((g) => g.id === result.group.id)
            ? rest.map((g) => (g.id === result.group.id ? result.group : g))
            : [...rest, result.group];
        });
        setPins((ps) => {
          const kept = ps.filter((p) => p.symbol !== symbol);
          const at = ps.findIndex((p) => p.symbol === symbol);
          if (at < 0) return [...kept, result.pin];
          const out = [...kept];
          out.splice(Math.min(at, out.length), 0, result.pin);
          return out;
        });
        hydrated = true;
        return result;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        rollback(`Could not pin ${symbol}: ${why}`, err);
        return null;
      }
    },
    [pins, groups, setGroups, setPins, setError]
  );

  return { groups, pins, error, clearError: () => setError(""), groupOf, ensureLoaded, pin };
}

function extrasToPin(e: PinExtras): Partial<PinnedAsset> {
  const out: Partial<PinnedAsset> = {};
  if (e.comment !== undefined) out.comment = e.comment;
  if (e.buyTarget !== undefined) out.buyTarget = e.buyTarget;
  if (e.sellTarget !== undefined) out.sellTarget = e.sellTarget;
  if (e.priceAtPin !== undefined) out.priceAtPin = e.priceAtPin ?? undefined;
  if (e.priority !== undefined) out.priority = e.priority;
  if (e.tags !== undefined) out.tags = e.tags;
  return out;
}
