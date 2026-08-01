"use client";

/**
 * AlertPickerDialog — searchable replacement for the old grouped/capped
 * quick-alert list. Every indicator's every label is searchable by name
 * (type "rsi" or "squeeze" or "bull cross"), so there's no need to curate
 * or cap what's shown — the filter box does that job instead. Falls
 * through to a Custom condition builder for anything not covered by a
 * curated label (any indicator with `outputs` declared works there, even
 * without alertLabels — plan §2's fallback path).
 */

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Comparator } from "@/lib/alerts/ast";
import { useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { chartIndicatorSpecsAtom } from "../atoms";
import { useAlertRules } from "../hooks/useAlertRules";
import type { NotifyChannel } from "../hooks/useAlertRules";
import { useWatchlistSignals } from "../hooks/useWatchlistSignals";
import type { bloombergColors } from "../lib/theme-config";
import {
  COMPARATOR_OPTIONS,
  type CustomOperandDraft,
  DEFAULT_NOTIFY_OPTIONS,
  NEEDS_SECOND_VALUE,
  type NotifyOptions,
  type OperandKind,
  PRICE_FIELDS,
  buildCustomRule,
  defaultParamsFor,
  draftToOperand,
  emptyOperandDraft,
  indicatorsWithOutputs,
} from "./customCondition";
import {
  type QuickAlertItem,
  allQuickAlertItems,
  buildRuleFromLabel,
  commonQuickAlertItems,
  itemsFromActiveIndicators,
} from "./quickAlerts";

interface AlertPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  symbol: string;
  targets: string[];
  colors: typeof bloombergColors.dark;
}

export function AlertPickerDialog({
  open,
  onOpenChange,
  symbol,
  targets,
  colors,
}: AlertPickerDialogProps) {
  const [mode, setMode] = useState<"pick" | "custom">("pick");
  const specs = useAtomValue(chartIndicatorSpecsAtom);
  const { signals } = useWatchlistSignals([symbol]);
  const { createRule } = useAlertRules();
  const signal = signals[symbol];

  const fromChart = useMemo(() => itemsFromActiveIndicators(specs, signal), [specs, signal]);
  const common = useMemo(
    () => commonQuickAlertItems(signal).filter((c) => !fromChart.some((f) => f.key === c.key)),
    [fromChart, signal]
  );
  const everything = useMemo(() => {
    const shown = new Set([...fromChart, ...common].map((i) => i.key));
    return allQuickAlertItems(signal).filter((i) => !shown.has(i.key));
  }, [fromChart, common, signal]);

  function handlePick(item: QuickAlertItem) {
    const body = buildRuleFromLabel(item, targets);
    createRule.mutate(body, {
      onSuccess: () => {
        toast.success(`Created "${body.name}"`);
        onOpenChange(false);
      },
      onError: (err) => toast.error(`Couldn't create alert: ${(err as Error).message}`),
    });
  }

  function close(next: boolean) {
    if (!next) setMode("pick");
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="rounded-none p-0 overflow-hidden max-w-[520px]"
        style={{ background: colors.surface, border: `1px solid ${colors.border}` }}
      >
        <DialogHeader className="px-3 pt-3 pb-0">
          <DialogTitle
            className="text-[11px] font-mono uppercase tracking-widest"
            style={{ color: colors.text }}
          >
            {mode === "pick"
              ? `Alert · ${targets.length > 1 ? `${targets.length} symbols` : symbol}`
              : `Custom condition · ${symbol}`}
          </DialogTitle>
        </DialogHeader>

        {mode === "pick" ? (
          <QuickPick
            colors={colors}
            fromChart={fromChart}
            common={common}
            everything={everything}
            onPick={handlePick}
            onCustom={() => setMode("custom")}
          />
        ) : (
          <CustomBuilder
            colors={colors}
            targets={targets}
            onBack={() => setMode("pick")}
            onCreated={(name) => {
              toast.success(`Created "${name}"`);
              close(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Search / pick ────────────────────────────────────────────────────────────

function QuickPick({
  colors,
  fromChart,
  common,
  everything,
  onPick,
  onCustom,
}: {
  colors: typeof bloombergColors.dark;
  fromChart: QuickAlertItem[];
  common: QuickAlertItem[];
  everything: QuickAlertItem[];
  onPick: (item: QuickAlertItem) => void;
  onCustom: () => void;
}) {
  const itemClass =
    "text-[10px] font-mono rounded-none aria-selected:bg-white/10 flex items-center justify-between gap-3";

  return (
    <Command className="rounded-none bg-transparent" style={{ color: colors.text }}>
      <div className="px-2 pt-2">
        <CommandInput
          placeholder="Search indicators, e.g. rsi oversold, macd cross..."
          className="text-[10px] font-mono h-8"
        />
      </div>
      <CommandList className="max-h-[360px] px-1 pb-2">
        <CommandEmpty className="text-[10px] font-mono px-2 py-3 opacity-60">
          No matches — try a different search, or build a custom condition.
        </CommandEmpty>
        {fromChart.length > 0 && (
          <CommandGroup
            heading="From chart indicators"
            className="text-[8px] font-mono uppercase tracking-widest"
            style={{ color: colors.textSecondary }}
          >
            {fromChart.map((item) => (
              <CommandItem
                key={item.key}
                value={`${item.entry.name} ${item.title}`}
                onSelect={() => onPick(item)}
                className={itemClass}
              >
                <span>{item.title}</span>
                {item.currentValue && (
                  <span className="opacity-50 shrink-0">{item.currentValue}</span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {common.length > 0 && (
          <CommandGroup
            heading="Commonly used"
            className="text-[8px] font-mono uppercase tracking-widest"
            style={{ color: colors.textSecondary }}
          >
            {common.map((item) => (
              <CommandItem
                key={item.key}
                value={`${item.entry.name} ${item.title}`}
                onSelect={() => onPick(item)}
                className={itemClass}
              >
                <span>{item.title}</span>
                {item.currentValue && (
                  <span className="opacity-50 shrink-0">{item.currentValue}</span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup
          heading="All indicators"
          className="text-[8px] font-mono uppercase tracking-widest"
          style={{ color: colors.textSecondary }}
        >
          {everything.map((item) => (
            <CommandItem
              key={item.key}
              value={`${item.entry.name} ${item.title}`}
              onSelect={() => onPick(item)}
              className={itemClass}
            >
              <span>{item.title}</span>
              {item.currentValue && (
                <span className="opacity-50 shrink-0">{item.currentValue}</span>
              )}
            </CommandItem>
          ))}
          <CommandItem
            value="custom condition build your own"
            onSelect={onCustom}
            className={itemClass}
            style={{ color: colors.accent }}
          >
            <span>⚙ Custom condition…</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

// ── Custom builder ───────────────────────────────────────────────────────────

function OperandEditor({
  draft,
  onChange,
  colors,
}: {
  draft: CustomOperandDraft;
  onChange: (d: CustomOperandDraft) => void;
  colors: typeof bloombergColors.dark;
}) {
  const entries = indicatorsWithOutputs();
  const selectClass = "h-7 text-[10px] font-mono rounded-none";

  return (
    <div className="flex items-center gap-1 flex-wrap">
      <Select value={draft.kind} onValueChange={(k: OperandKind) => onChange(emptyOperandDraft(k))}>
        <SelectTrigger
          className={`${selectClass} w-[86px]`}
          style={{ borderColor: colors.border, color: colors.text }}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="rounded-none text-[10px] font-mono">
          <SelectItem value="indicator">Indicator</SelectItem>
          <SelectItem value="price">Price</SelectItem>
          <SelectItem value="const">Value</SelectItem>
        </SelectContent>
      </Select>

      {draft.kind === "indicator" && (
        <>
          <Select
            value={draft.indicatorId}
            onValueChange={(id) => {
              const entry = entries.find((e) => e.id === id);
              onChange({
                kind: "indicator",
                indicatorId: id,
                outputKey: entry?.outputs?.[0]?.key,
                params: entry ? defaultParamsFor(entry) : {},
              });
            }}
          >
            <SelectTrigger
              className={`${selectClass} w-[110px]`}
              style={{ borderColor: colors.border, color: colors.text }}
            >
              <SelectValue placeholder="Indicator" />
            </SelectTrigger>
            <SelectContent className="rounded-none text-[10px] font-mono">
              {entries.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {(entries.find((e) => e.id === draft.indicatorId)?.outputs?.length ?? 0) > 1 && (
            <Select
              value={draft.outputKey}
              onValueChange={(outputKey) => onChange({ ...draft, outputKey })}
            >
              <SelectTrigger
                className={`${selectClass} w-[80px]`}
                style={{ borderColor: colors.border, color: colors.text }}
              >
                <SelectValue placeholder="Output" />
              </SelectTrigger>
              <SelectContent className="rounded-none text-[10px] font-mono">
                {entries
                  .find((e) => e.id === draft.indicatorId)
                  ?.outputs?.map((o) => (
                    <SelectItem key={o.key} value={o.key}>
                      {o.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          )}

          {Object.entries(draft.params ?? {}).map(([key, value]) => (
            <Input
              key={key}
              type="number"
              value={value}
              title={key}
              onChange={(e) =>
                onChange({ ...draft, params: { ...draft.params, [key]: Number(e.target.value) } })
              }
              className="h-7 w-14 text-[10px] font-mono rounded-none px-1"
              style={{ borderColor: colors.border, color: colors.text, background: "transparent" }}
            />
          ))}
        </>
      )}

      {draft.kind === "price" && (
        <Select
          value={draft.priceField}
          onValueChange={(priceField) =>
            onChange({ ...draft, priceField: priceField as CustomOperandDraft["priceField"] })
          }
        >
          <SelectTrigger
            className={`${selectClass} w-[86px]`}
            style={{ borderColor: colors.border, color: colors.text }}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-none text-[10px] font-mono">
            {PRICE_FIELDS.map((f) => (
              <SelectItem key={f} value={f}>
                {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {draft.kind === "const" && (
        <Input
          type="number"
          value={draft.constValue ?? ""}
          onChange={(e) =>
            onChange({
              ...draft,
              constValue: e.target.value === "" ? undefined : Number(e.target.value),
            })
          }
          className="h-7 w-20 text-[10px] font-mono rounded-none px-1"
          style={{ borderColor: colors.border, color: colors.text, background: "transparent" }}
        />
      )}
    </div>
  );
}

// ── Notify channels ──────────────────────────────────────────────────────────

const CHANNEL_LABELS: { value: NotifyChannel; label: string }[] = [
  { value: "ticker", label: "Ticker" },
  { value: "toast", label: "Toast" },
  { value: "sound", label: "Sound" },
  { value: "webhook", label: "Webhook" },
];

/** Only surfaced in the Custom builder (plan §9.5: quick alerts stay
 * zero-friction on purpose, this is the "full control" path). */
function NotifyChannelsEditor({
  value,
  onChange,
  colors,
}: {
  value: NotifyOptions;
  onChange: (v: NotifyOptions) => void;
  colors: typeof bloombergColors.dark;
}) {
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  function toggle(channel: NotifyChannel) {
    const has = value.channels.includes(channel);
    onChange({
      ...value,
      channels: has ? value.channels.filter((c) => c !== channel) : [...value.channels, channel],
    });
  }

  async function testWebhook() {
    if (!value.webhookUrl.trim()) return;
    setTestState("testing");
    setTestError(null);
    try {
      const res = await fetch("/api/alerts/notify/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: value.webhookUrl.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestState("ok");
      } else {
        setTestState("fail");
        setTestError(data.error ?? "Failed");
      }
    } catch (err) {
      setTestState("fail");
      setTestError((err as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span
        className="text-[8px] font-mono uppercase tracking-widest opacity-60"
        style={{ color: colors.text }}
      >
        Notify
      </span>
      <div className="flex items-center gap-3 flex-wrap">
        {CHANNEL_LABELS.map((c) => (
          <label
            key={c.value}
            className="flex items-center gap-1.5 text-[9px] font-mono cursor-pointer"
            style={{ color: colors.text }}
          >
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={value.channels.includes(c.value)}
              onChange={() => toggle(c.value)}
            />
            {c.label}
          </label>
        ))}
      </div>

      {value.channels.includes("webhook") && (
        <div className="flex items-center gap-1.5">
          <Input
            type="url"
            placeholder="https://discord.com/api/webhooks/… or ntfy.sh/topic"
            value={value.webhookUrl}
            onChange={(e) => {
              onChange({ ...value, webhookUrl: e.target.value });
              setTestState("idle");
            }}
            className="h-7 flex-1 text-[10px] font-mono rounded-none px-2"
            style={{ borderColor: colors.border, color: colors.text, background: "transparent" }}
          />
          <button
            type="button"
            disabled={!value.webhookUrl.trim() || testState === "testing"}
            onClick={testWebhook}
            className="h-7 px-2 text-[9px] font-mono uppercase tracking-widest border shrink-0 disabled:opacity-40"
            style={{
              borderColor:
                testState === "ok" ? "#4ade80" : testState === "fail" ? "#f87171" : colors.border,
              color:
                testState === "ok" ? "#4ade80" : testState === "fail" ? "#f87171" : colors.text,
            }}
          >
            {testState === "testing"
              ? "…"
              : testState === "ok"
                ? "✓ sent"
                : testState === "fail"
                  ? "✗ failed"
                  : "Test"}
          </button>
        </div>
      )}
      {testState === "fail" && testError && (
        <span className="text-[8px] font-mono" style={{ color: "#f87171" }}>
          {testError}
        </span>
      )}
    </div>
  );
}

function CustomBuilder({
  colors,
  targets,
  onBack,
  onCreated,
}: {
  colors: typeof bloombergColors.dark;
  targets: string[];
  onBack: () => void;
  onCreated: (name: string) => void;
}) {
  const { createRule } = useAlertRules();
  const [left, setLeft] = useState<CustomOperandDraft>(() => emptyOperandDraft("indicator"));
  const [cmp, setCmp] = useState<Comparator>("gt");
  const [right, setRight] = useState<CustomOperandDraft>(() => emptyOperandDraft("const"));
  const [right2, setRight2] = useState<CustomOperandDraft>(() => emptyOperandDraft("const"));
  const [notifyOptions, setNotifyOptions] = useState<NotifyOptions>(DEFAULT_NOTIFY_OPTIONS);

  const needsSecond = NEEDS_SECOND_VALUE.has(cmp);
  const preview = buildCustomRule(
    left,
    cmp,
    right,
    needsSecond ? right2 : null,
    targets,
    notifyOptions
  );

  return (
    <div className="px-3 pb-3 flex flex-col gap-2">
      <button
        type="button"
        onClick={onBack}
        className="text-[9px] font-mono opacity-60 hover:opacity-100 self-start"
        style={{ color: colors.text }}
      >
        ← back to search
      </button>

      <OperandEditor draft={left} onChange={setLeft} colors={colors} />

      <Select value={cmp} onValueChange={(v) => setCmp(v as Comparator)}>
        <SelectTrigger
          className="h-7 w-[180px] text-[10px] font-mono rounded-none"
          style={{ borderColor: colors.border, color: colors.text }}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="rounded-none text-[10px] font-mono">
          {COMPARATOR_OPTIONS.map((c) => (
            <SelectItem key={c.value} value={c.value}>
              {c.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <OperandEditor draft={right} onChange={setRight} colors={colors} />
      {needsSecond && (
        <>
          <span className="text-[9px] font-mono opacity-50" style={{ color: colors.text }}>
            and
          </span>
          <OperandEditor draft={right2} onChange={setRight2} colors={colors} />
        </>
      )}

      <NotifyChannelsEditor value={notifyOptions} onChange={setNotifyOptions} colors={colors} />

      {preview.error && (
        <div className="text-[9px] font-mono" style={{ color: "#f87171" }}>
          {preview.error}
        </div>
      )}
      {preview.rule && (
        <div className="text-[9px] font-mono opacity-60" style={{ color: colors.text }}>
          {preview.rule.name}
        </div>
      )}

      <button
        type="button"
        disabled={!preview.rule || createRule.isPending}
        onClick={() => {
          const rule = preview.rule;
          if (!rule) return;
          createRule.mutate(rule, {
            onSuccess: () => onCreated(rule.name),
            onError: (err) => toast.error(`Couldn't create alert: ${(err as Error).message}`),
          });
        }}
        className="mt-1 h-7 text-[10px] font-mono uppercase tracking-widest border disabled:opacity-40"
        style={{ borderColor: colors.accent, color: colors.accent }}
      >
        Create alert
      </button>
    </div>
  );
}
