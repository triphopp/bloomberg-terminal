"use client";

/**
 * useAlertRules — CRUD + events for the Alert Rule Engine
 * (backend/routers/alert_rules.py, memory/plans/alert-rule-engine.md §6/§9.5).
 *
 *   const { rules, createRule } = useAlertRules();
 *   createRule.mutate({ name, scope, expr, trigger: "edge", cooldown_bars: 1, notify: ["ticker"] });
 */

import type { RuleNode } from "@/lib/alerts/ast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type AlertScope = { type: "watchlist" } | { type: "symbols"; symbols: string[] };
export type AlertTrigger = "edge" | "level";
export type NotifyChannel = "ticker" | "toast" | "sound" | "webhook";

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  scope: AlertScope;
  timeframe: string;
  expr: RuleNode;
  trigger: AlertTrigger;
  cooldownBars: number;
  maxFiresPerDay: number | null;
  notify: NotifyChannel[];
  webhookUrl: string | null;
  expiresAt: string | null;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface AlertRuleWithWarnings extends AlertRule {
  warnings: { kind: string; operandKey?: string; detail: string }[];
}

export interface CreateAlertRuleInput {
  name: string;
  scope: AlertScope;
  expr: RuleNode;
  timeframe?: string;
  enabled?: boolean;
  trigger?: AlertTrigger;
  cooldown_bars?: number;
  max_fires_per_day?: number | null;
  expires_at?: string | null;
  notify?: NotifyChannel[];
  webhook_url?: string | null;
}

export interface AlertEvent {
  id: number;
  ruleId: string;
  symbol: string;
  firedAt: string;
  barTime: string;
  snapshot: Record<string, number | null>;
  acked: boolean;
  /** null when the rule was deleted — the event is kept for audit (no FK). */
  ruleName: string | null;
  /** Render hints copied from the rule by the events endpoint's join.
   *  ticker/toast/sound are delivered here on the client; `webhook` is the
   *  backend's job (backend/alerts/notify.py) and is ignored by the UI. */
  notify: NotifyChannel[];
  notifiedAt: string | null;
  notifyError: string | null;
}

const RULES_KEY = ["alert-rules"] as const;
const EVENTS_KEY = ["alert-events"] as const;

async function jsonOrThrow(res: Response) {
  const data = await res.json();
  if (!res.ok) {
    const detail =
      typeof data?.detail === "object"
        ? JSON.stringify(data.detail)
        : (data?.detail ?? data?.error);
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return data;
}

export function useAlertRules() {
  const qc = useQueryClient();

  const query = useQuery<AlertRule[]>({
    queryKey: RULES_KEY,
    queryFn: () => fetch("/api/alerts/rules").then((r) => r.json()),
    staleTime: 60_000,
  });

  const createRule = useMutation({
    mutationFn: (body: CreateAlertRuleInput): Promise<AlertRuleWithWarnings> =>
      fetch("/api/alerts/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(jsonOrThrow),
    onSuccess: () => qc.invalidateQueries({ queryKey: RULES_KEY }),
  });

  const patchRule = useMutation({
    mutationFn: ({
      id,
      body,
    }: { id: string; body: Partial<CreateAlertRuleInput & { enabled: boolean }> }) =>
      fetch(`/api/alerts/rules/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(jsonOrThrow),
    onSuccess: () => qc.invalidateQueries({ queryKey: RULES_KEY }),
  });

  const deleteRule = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/alerts/rules/${encodeURIComponent(id)}`, { method: "DELETE" }).then(jsonOrThrow),
    onSuccess: () => qc.invalidateQueries({ queryKey: RULES_KEY }),
  });

  return {
    rules: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    createRule,
    patchRule,
    deleteRule,
  };
}

/** Rules whose scope covers `symbol` — either scoped directly to it, or watchlist-wide. */
export function rulesForSymbol(rules: AlertRule[], symbol: string): AlertRule[] {
  return rules.filter(
    (r) =>
      r.scope.type === "watchlist" ||
      (r.scope.type === "symbols" && r.scope.symbols.includes(symbol))
  );
}

/**
 * A single-symbol rule's own `name` is generated as `"{symbol} · {desc}"`
 * (quickAlerts.ts / customCondition.ts) so it reads standalone in the rule
 * list. Anywhere the symbol is ALSO shown as its own field alongside the
 * rule name (event feed rows, the ticker pill, toasts) that prefix repeats
 * the symbol back — "SNDK  SNDK · RSI(14)…". Strip it there; leave rule
 * names untouched everywhere else.
 */
export function ruleDisplayName(ruleName: string | null, symbol: string): string {
  if (!ruleName) return "(deleted rule)";
  const prefix = `${symbol} · `;
  return ruleName.startsWith(prefix) ? ruleName.slice(prefix.length) : ruleName;
}

export function useAlertEvents(opts: { limit?: number; acked?: boolean; ruleId?: string } = {}) {
  const qc = useQueryClient();
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.acked !== undefined) params.set("acked", String(opts.acked));
  if (opts.ruleId) params.set("rule_id", opts.ruleId);
  const qs = params.toString();

  const query = useQuery<AlertEvent[]>({
    queryKey: [...EVENTS_KEY, qs],
    queryFn: () => fetch(`/api/alerts/events${qs ? `?${qs}` : ""}`).then((r) => r.json()),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const ackEvents = useMutation({
    mutationFn: (ids: number[]) =>
      fetch("/api/alerts/events/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      }).then(jsonOrThrow),
    onSuccess: () => qc.invalidateQueries({ queryKey: EVENTS_KEY }),
  });

  return { events: query.data ?? [], isLoading: query.isLoading, ackEvents };
}
