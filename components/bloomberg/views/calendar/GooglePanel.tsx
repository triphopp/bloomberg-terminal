"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Colors } from "../portfolio/helpers";
import { CAT_COLOR, CAT_LABEL } from "./DayPanel";
import { CATEGORIES } from "./month";
import type { CalCategory } from "./types";

/** GET /api/gcal/status — backend/gcal_sync.py status(). Never a token. */
export interface GcalStatus {
  configured: boolean;
  connected: boolean;
  revoked: boolean;
  calendar_id: string | null;
  shared_calendar: boolean;
  connected_at: number | null;
  scope: string;
  settings: { categories: CalCategory[]; macro_impact: "high" | "medium" | "all" };
  last_sync: {
    at: number;
    ok: boolean;
    events?: number;
    created: number;
    updated: number;
    deleted: number;
    unchanged?: number;
    failed: number;
    error: string | null;
  } | null;
  window_days: [number, number];
  token_dir: string;
}

const IMPACT: [GcalStatus["settings"]["macro_impact"], string][] = [
  ["high", "สำคัญมาก"],
  ["medium", "สำคัญ+กลาง"],
  ["all", "ทั้งหมด"],
];

export function useGcalStatus(open: boolean) {
  return useQuery({
    queryKey: ["gcal-status"],
    queryFn: async ({ signal }) => {
      const r = await fetch("/api/gcal/status", { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as GcalStatus;
    },
    staleTime: 30_000,
    // While the panel is open a pass started elsewhere (connect, a setting) shows up.
    refetchInterval: open ? 8_000 : 5 * 60_000,
  });
}

function ago(at: number): string {
  const s = Math.max(0, Math.round(Date.now() / 1000 - at));
  if (s < 60) return `${s} วินาทีก่อน`;
  if (s < 3600) return `${Math.round(s / 60)} นาทีก่อน`;
  if (s < 86400) return `${Math.round(s / 3600)} ชม.ก่อน`;
  return `${Math.round(s / 86400)} วันก่อน`;
}

async function errorText(r: Response): Promise<string> {
  const d = await r.json().catch(() => ({}));
  const detail = d?.detail;
  return (typeof detail === "object" ? detail?.error : detail) ?? d?.error ?? `HTTP ${r.status}`;
}

/** CAL → Google Calendar: connect, what goes up, push now. One way — nothing comes back. */
export function GooglePanel({ colors }: { colors: Colors }) {
  const qc = useQueryClient();
  const { data: st, isError } = useGcalStatus(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  // The sign-in tab says when it is done (backend/routers/gcal.py callback page).
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data === "gcal:ok" || e.data === "gcal:error") {
        void qc.invalidateQueries({ queryKey: ["gcal-status"] });
        setMsg(
          e.data === "gcal:ok"
            ? { text: "เชื่อมแล้ว — กำลังส่งเหตุการณ์ขึ้น Google" }
            : { text: "เชื่อมไม่สำเร็จ — ดูข้อความในแท็บที่เปิดไว้", bad: true }
        );
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [qc]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["gcal-status"] });
  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const connect = () =>
    run("connect", async () => {
      const r = await fetch("/api/gcal/connect", { method: "POST" });
      if (!r.ok) throw new Error(await errorText(r));
      const { auth_url } = (await r.json()) as { auth_url: string };
      window.open(auth_url, "_blank", "width=520,height=680");
      setMsg({ text: "ลงชื่อเข้า Google ในหน้าต่างที่เปิดขึ้น แล้วกลับมาที่นี่" });
    });

  const syncNow = () =>
    run("sync", async () => {
      const r = await fetch("/api/gcal/sync", { method: "POST" });
      if (!r.ok) throw new Error(await errorText(r));
      const d = (await r.json()) as NonNullable<GcalStatus["last_sync"]>;
      setMsg({
        text: `ส่งแล้ว: ใหม่ ${d.created} · แก้ ${d.updated} · ลบ ${d.deleted}${d.failed ? ` · พลาด ${d.failed}` : ""}`,
        bad: d.failed > 0,
      });
    });

  const save = (settings: GcalStatus["settings"]) =>
    run("settings", async () => {
      const r = await fetch("/api/gcal/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!r.ok) throw new Error(await errorText(r));
      qc.setQueryData<GcalStatus>(["gcal-status"], (old) => (old ? { ...old, settings } : old));
    });

  const disconnect = () => {
    if (!window.confirm("เลิกเชื่อม Google Calendar บนเครื่องนี้?")) return;
    const drop = window.confirm(
      'ลบปฏิทิน "Bloomberg Terminal" ใน Google ทิ้งด้วยหรือไม่?\n\nOK = ลบปฏิทิน (ทุกเครื่องที่ใช้ปฏิทินนี้จะสร้างใหม่ตอนเชื่อมครั้งหน้า)\nCancel = เก็บปฏิทินไว้ แค่หยุดส่ง'
    );
    void run("disconnect", async () => {
      const r = await fetch(`/api/gcal/disconnect?delete_calendar=${drop}`, { method: "POST" });
      if (!r.ok) throw new Error(await errorText(r));
      setMsg({ text: drop ? "เลิกเชื่อมและลบปฏิทินแล้ว" : "เลิกเชื่อมแล้ว — ปฏิทินยังอยู่ใน Google" });
    });
  };

  const dim = { color: colors.textSecondary };
  const chip =
    "text-[9px] px-1.5 py-0.5 font-bold whitespace-nowrap hover:opacity-80 disabled:opacity-40";
  const sep = <span style={{ color: colors.border }}>│</span>;

  let body: React.ReactNode;
  if (isError || !st) {
    body = (
      <span style={isError ? { color: "#f87171" } : dim}>
        {isError ? "backend ไม่ตอบ" : "กำลังอ่านสถานะ…"}
      </span>
    );
  } else if (!st.configured) {
    body = (
      <span style={dim}>
        ยังไม่ได้ตั้งค่า — ใส่ <code>GOOGLE_CALENDAR_CLIENT_ID</code> และ{" "}
        <code>GOOGLE_CALENDAR_CLIENT_SECRET</code> (OAuth client แบบ Desktop app, เปิด Google
        Calendar API) ใน <code>backend/.env</code> แล้ว restart backend — ขั้นตอนอยู่ใน{" "}
        <code>backend/.env.example</code>
      </span>
    );
  } else if (!st.connected) {
    body = (
      <>
        <button
          type="button"
          className={chip}
          style={{ color: colors.accent }}
          disabled={busy !== null}
          onClick={() => void connect()}
        >
          {busy === "connect" ? "…" : "CONNECT"}
        </button>
        <span style={st.revoked ? { color: "#B06000" } : dim}>
          {st.revoked
            ? "Google ไม่รับการเชื่อมเดิมแล้ว (ถูกยกเลิก หรือแอปยังอยู่ในโหมด Testing ซึ่งหมดอายุใน 7 วัน) — กด CONNECT ใหม่"
            : 'ส่งเหตุการณ์ใน CAL ขึ้นปฏิทินแยกชื่อ "Bloomberg Terminal" ใน Google ทางเดียว — กดจากเครื่องที่รันแอป ไม่ใช่จากมือถือ'}
        </span>
      </>
    );
  } else {
    const s = st.settings;
    const last = st.last_sync;
    body = (
      <>
        <span className="font-bold" style={{ color: "#4ade80" }}>
          ● เชื่อมแล้ว
        </span>
        {sep}
        <span style={dim}>ส่งขึ้น</span>
        {CATEGORIES.map((c) => {
          const active = s.categories.includes(c);
          return (
            <button
              type="button"
              key={c}
              aria-pressed={active}
              className={`${chip} flex items-center gap-1`}
              style={{ color: active ? CAT_COLOR[c] : colors.textDimmed }}
              disabled={busy !== null}
              title={
                c === "PORT"
                  ? "วันหมดอายุ option และ HOLD review — ข้อมูลพอร์ตจะไปอยู่ใน Google"
                  : undefined
              }
              onClick={() =>
                void save({
                  ...s,
                  categories: active ? s.categories.filter((x) => x !== c) : [...s.categories, c],
                })
              }
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: CAT_COLOR[c] }} />
              {CAT_LABEL[c]}
            </button>
          );
        })}
        {s.categories.includes("MACRO") && (
          <>
            {sep}
            <span style={dim}>มหภาค</span>
            {IMPACT.map(([id, text]) => (
              <button
                type="button"
                key={id}
                aria-pressed={s.macro_impact === id}
                className={chip}
                style={{ color: s.macro_impact === id ? colors.accent : colors.textSecondary }}
                disabled={busy !== null}
                onClick={() => void save({ ...s, macro_impact: id })}
              >
                {text}
              </button>
            ))}
          </>
        )}
        {sep}
        <button
          type="button"
          className={chip}
          style={{ color: colors.accent }}
          disabled={busy !== null}
          onClick={() => void syncNow()}
        >
          {busy === "sync" ? "กำลังส่ง…" : "SYNC NOW"}
        </button>
        <span
          style={last && !last.ok ? { color: "#f87171" } : dim}
          title={
            last?.error ??
            `ช่วง ${st.window_days[0]} วันก่อน ถึง ${st.window_days[1]} วันข้างหน้า · ส่งเองทุกรอบของ calendar scheduler`
          }
        >
          {last
            ? last.ok
              ? `ส่งล่าสุด ${ago(last.at)} · ${last.events ?? 0} เหตุการณ์`
              : `ส่งล่าสุดพลาด ${ago(last.at)}: ${last.error ?? ""}`
            : "ยังไม่เคยส่ง"}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className={chip}
          style={dim}
          disabled={busy !== null}
          onClick={disconnect}
        >
          DISCONNECT
        </button>
      </>
    );
  }

  return (
    <div
      className="shrink-0 px-2 py-0.5 border-b flex items-center flex-wrap gap-x-2 text-[9px]"
      style={{ borderColor: colors.border }}
    >
      <span className="font-bold" style={{ color: colors.text }}>
        GOOGLE CALENDAR
      </span>
      {body}
      {msg && <span style={{ color: msg.bad ? "#f87171" : colors.textSecondary }}>{msg.text}</span>}
    </div>
  );
}
