"use client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Colors } from "../../helpers";
import { NumInput } from "../../ui/NumInput";
import { Chip, Errors, Label } from "../questions";
import type { QCalendar } from "../questions/types";
import { QuickTopic } from "../theses/QuickTopic";
import type { Thesis } from "../theses/types";
import {
  type TDetail,
  type TQuestion,
  T_CADENCE,
  T_VERDICT,
  band,
  crossesKill,
  fmtVal,
  previewVerdict,
} from "./types";

export const API = "/api/v2/tracking";

/** The backend refuses with either a sentence or `{missing: [...]}` — both come
 *  back as lines. On success the parsed body is handed over. */
export async function call<T>(
  url: string,
  method: string,
  body?: unknown
): Promise<{ data: T | null; errors: string[] | null }> {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (r.ok) return { data: d as T, errors: null };
  const detail = d?.detail;
  if (detail && typeof detail === "object" && Array.isArray(detail.missing))
    return { data: null, errors: detail.missing };
  return { data: null, errors: [typeof detail === "string" ? detail : `HTTP ${r.status}`] };
}

const FIELD = "w-full px-1.5 py-1 border outline-none";
const num = (s: string) => (s.trim() === "" ? null : Number(s));
const today = () => new Date().toLocaleDateString("en-CA");

function fieldOf(colors: Colors) {
  return { background: colors.surface, borderColor: colors.border, color: colors.text };
}

function Buttons({
  colors,
  busy,
  disabled,
  onSave,
  onCancel,
}: {
  colors: Colors;
  busy: boolean;
  disabled?: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex gap-1.5 mt-3">
      <button
        type="button"
        disabled={busy || disabled}
        className="px-2 py-0.5 border font-bold disabled:opacity-40"
        style={{ borderColor: colors.border, color: colors.accent }}
        onClick={onSave}
      >
        บันทึก
      </button>
      <button
        type="button"
        className="px-2 py-0.5 border"
        style={{ borderColor: colors.border, color: colors.textSecondary }}
        onClick={onCancel}
      >
        ยกเลิก
      </button>
    </div>
  );
}

const KILL_OPS = ["<", "<=", ">", ">="];

/** A new metric, or an edit of one. Only the title is required — what is left
 *  out shows on the row as still missing. */
export function MetricForm({
  colors,
  theses,
  thesisId,
  detail,
  onDone,
  onCancel,
}: {
  colors: Colors;
  theses: Thesis[];
  thesisId: string;
  detail?: TDetail;
  onDone: (id?: string) => void;
  onCancel: () => void;
}) {
  const m = detail?.metric;
  const [f, setF] = useState({
    thesis_id: m?.thesis_id ?? thesisId ?? "",
    title: m?.title ?? "",
    role: m?.role ?? "WATCH",
    cadence: m?.cadence ?? "QUARTERLY",
    unit: m?.unit ?? "",
    definition: m?.definition ?? "",
    why: m?.why ?? "",
    kill_rule: m?.kill_rule ?? "",
    kill_op: m?.kill_op ?? "",
    kill_value: m?.kill_value === null || m?.kill_value === undefined ? "" : String(m.kill_value),
    source_name: m?.source_name ?? "",
    source_url: m?.source_url ?? "",
    source_locator: m?.source_locator ?? "",
    source_tool: m?.source_tool ?? "",
    series_id: m?.series_id ?? "",
    question: detail?.question?.ref ?? "",
    reason: "",
  });
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldStyle = fieldOf(colors);
  const set =
    (k: keyof typeof f) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async () => {
    setBusy(true);
    const { thesis_id, reason, kill_value, ...rest } = f;
    const body = { ...rest, kill_op: f.kill_op || null, kill_value: num(kill_value) };
    const r = m
      ? await call<TDetail>(`${API}/${m.id}`, "PATCH", { ...body, reason })
      : await call<TDetail>(API, "POST", {
          ...body,
          thesis_id,
          series_id: f.series_id || null,
          question: f.question || null,
        });
    setBusy(false);
    setErr(r.errors);
    if (r.data) onDone(r.data.metric.id);
  };

  return (
    <div className="leading-relaxed max-w-[680px]">
      <span className="font-bold" style={{ color: colors.accent }}>
        {m ? `แก้ไข ${m.ref}` : "ตัวเลขที่จับตาใหม่"}
      </span>

      {!m && (
        <>
          <Label colors={colors}>THESIS</Label>
          <select
            className={FIELD}
            style={fieldStyle}
            value={f.thesis_id}
            onChange={set("thesis_id")}
          >
            <option value="">— เลือก thesis —</option>
            {theses.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title.startsWith(t.symbol) ? t.title : `${t.symbol} — ${t.title}`}
              </option>
            ))}
          </select>
          {/* A number about something with no thesis yet: open the subject first. */}
          <div className="mt-1">
            <QuickTopic
              colors={colors}
              onCreated={(id) => setF((p) => ({ ...p, thesis_id: id }))}
            />
          </div>
        </>
      )}

      <Label colors={colors}>ตัวเลขที่จับตา</Label>
      <input
        className={FIELD}
        style={fieldStyle}
        value={f.title}
        onChange={set("title")}
        placeholder="เช่น จำนวนวันสินค้าคงคลัง (DIO)"
      />

      <div className="flex gap-2">
        <div className="flex-1">
          <Label colors={colors}>บทบาท</Label>
          <select className={FIELD} style={fieldStyle} value={f.role} onChange={set("role")}>
            <option value="WATCH">จับตา</option>
            <option value="KILLER">KILLER — ข้ามเส้นแล้ว thesis พัง</option>
          </select>
        </div>
        <div className="flex-1">
          <Label colors={colors}>รอบ</Label>
          <select className={FIELD} style={fieldStyle} value={f.cadence} onChange={set("cadence")}>
            {Object.entries(T_CADENCE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="w-24">
          <Label colors={colors}>หน่วย</Label>
          <input
            className={FIELD}
            style={fieldStyle}
            value={f.unit}
            onChange={set("unit")}
            placeholder="วัน, %"
          />
        </div>
      </div>

      <Label colors={colors}>นิยาม / วิธีคิด — ใช้สูตรเดิมทุกงวด</Label>
      <textarea
        className={FIELD}
        style={fieldStyle}
        rows={2}
        value={f.definition}
        onChange={set("definition")}
        placeholder="เช่น สินค้าคงคลังปลายงวด ÷ ต้นทุนขายของไตรมาส × 91"
      />
      <Label colors={colors}>ตัวเลขนี้บอกอะไรเกี่ยวกับ thesis</Label>
      <textarea className={FIELD} style={fieldStyle} rows={2} value={f.why} onChange={set("why")} />

      <Label colors={colors}>เส้น KILLER — เงื่อนไขเต็มเป็นคำ</Label>
      <input
        className={FIELD}
        style={fieldStyle}
        value={f.kill_rule}
        onChange={set("kill_rule")}
        placeholder="เช่น DIO > 140 วัน พร้อม finished goods เพิ่ม"
      />
      <div className="flex gap-2 items-end">
        <div className="w-24">
          <Label colors={colors}>ส่วนที่เป็นตัวเลข</Label>
          <select className={FIELD} style={fieldStyle} value={f.kill_op} onChange={set("kill_op")}>
            <option value="">—</option>
            {KILL_OPS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        <div className="w-32">
          <NumInput
            allowNegative
            className={FIELD}
            style={fieldStyle}
            value={f.kill_value}
            onChange={set("kill_value")}
          />
        </div>
        <span className="pb-1" style={{ color: colors.textSecondary }}>
          {f.unit} — ระบบตรวจทุกครั้งที่บันทึกค่าจริง
        </span>
      </div>

      <Label colors={colors}>อ่านตัวเลขได้ที่ — ใคร / เอกสารอะไร</Label>
      <input
        className={FIELD}
        style={fieldStyle}
        value={f.source_name}
        onChange={set("source_name")}
        placeholder="เช่น Micron 10-Q"
      />
      <Label colors={colors}>ลิงก์ที่เปิดแล้วถึง</Label>
      <input
        className={FIELD}
        style={fieldStyle}
        value={f.source_url}
        onChange={set("source_url")}
        placeholder="https://"
      />
      <Label colors={colors}>อยู่ตรงไหนในเอกสาร</Label>
      <input
        className={FIELD}
        style={fieldStyle}
        value={f.source_locator}
        onChange={set("source_locator")}
        placeholder="เช่น Balance sheet → Inventories; Income statement → Cost of goods sold"
      />
      <Label colors={colors}>AGENT ดึงด้วยอะไร</Label>
      <input
        className={`${FIELD} font-mono`}
        style={fieldStyle}
        value={f.source_tool}
        onChange={set("source_tool")}
        placeholder="เช่น get_stock_data(MU, kind=balance-sheet)"
      />

      <div className="flex gap-2">
        <div className="flex-1">
          <Label colors={colors}>SERIES ที่ระบบเก็บเอง (ไม่บังคับ)</Label>
          <input
            className={`${FIELD} font-mono`}
            style={fieldStyle}
            value={f.series_id}
            onChange={set("series_id")}
            placeholder="dx.contract.dram.ddr4_8gb_1gx8"
          />
        </div>
        <div className="w-40">
          <Label colors={colors}>ช่วยตอบคำถาม (Q-ref)</Label>
          <input
            className={`${FIELD} font-mono`}
            style={fieldStyle}
            value={f.question}
            onChange={set("question")}
            placeholder="Q-0022"
          />
        </div>
      </div>

      {m && (
        <>
          <Label colors={colors}>เหตุผล — บังคับเมื่อแก้เส้น KILLER ที่ตั้งไว้แล้ว หรือเปลี่ยนบทบาท</Label>
          <input className={FIELD} style={fieldStyle} value={f.reason} onChange={set("reason")} />
        </>
      )}

      <Buttons
        colors={colors}
        busy={busy}
        disabled={!f.title.trim() || !f.thesis_id}
        onSave={submit}
        onCancel={onCancel}
      />
      <Errors lines={err} />
    </div>
  );
}

type DateMode = "calendar" | "new" | "plain";

/** The forecast for one period. It needs a reason and the date the number comes
 *  out; once that number is recorded the forecast can no longer be changed. */
export function ExpectForm({
  colors,
  detail,
  onDone,
  onCancel,
}: {
  colors: Colors;
  detail: TDetail;
  onDone: () => void;
  onCancel: () => void;
}) {
  const m = detail.metric;
  const { data: cal } = useQuery({
    queryKey: ["questions", "calendar"],
    queryFn: async ({ signal }) => {
      const r = await fetch("/api/v2/questions/calendar", { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as QCalendar;
    },
    staleTime: 30_000,
  });
  const dates = cal?.dates ?? [];
  const [mode, setMode] = useState<DateMode>("new");
  const [f, setF] = useState({
    period: detail.state.next?.period ?? "",
    expected: "",
    low: "",
    high: "",
    basis: "",
    evidence: "",
    release_time: "",
    date: "",
    due_date: "",
    nd_title: "",
    nd_date: "",
    nd_status: "ESTIMATED",
    nd_source: "",
    nd_url: "",
    nd_kind: "EARNINGS",
  });
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldStyle = fieldOf(colors);
  const dim = { color: colors.textSecondary };
  const set =
    (k: keyof typeof f) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async () => {
    setBusy(true);
    const r = await call<TDetail>(`${API}/${m.id}/expectations`, "POST", {
      period: f.period,
      expected: f.expected,
      low: num(f.low),
      high: num(f.high),
      basis: f.basis,
      release_time: f.release_time,
      evidence: f.evidence
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      date: mode === "calendar" ? f.date || null : null,
      due_date: mode === "plain" ? f.due_date || null : null,
      new_date:
        mode === "new" && (f.nd_title || f.nd_date)
          ? {
              title: f.nd_title,
              date: f.nd_date,
              status: f.nd_status,
              source: f.nd_source,
              source_url: f.nd_url,
              kind: f.nd_kind,
            }
          : null,
    });
    setBusy(false);
    setErr(r.errors);
    if (r.data) onDone();
  };

  const modes: { id: DateMode; label: string }[] = [
    { id: "new", label: "เหตุการณ์ใหม่ลงปฏิทิน" },
    { id: "calendar", label: `เลือกจากปฏิทิน (${dates.length})` },
    { id: "plain", label: "กำหนดวันดูเอง" },
  ];

  return (
    <div className="leading-relaxed max-w-[680px]">
      <span className="font-bold" style={{ color: colors.accent }}>
        ค่าคาดการณ์ — {m.ref} {m.title}
      </span>
      <div style={dim}>ตั้งก่อนตัวเลขออก · ตั้งซ้ำงวดเดิมได้ (เก็บของเก่าไว้) · ตัวเลขออกแล้วแก้ไม่ได้</div>

      <Label colors={colors}>งวด</Label>
      <input
        className={FIELD}
        style={fieldStyle}
        value={f.period}
        onChange={set("period")}
        placeholder="เช่น FQ1 FY27, 2026-10"
      />
      <Label colors={colors}>คาดว่า</Label>
      <input
        className={FIELD}
        style={fieldStyle}
        value={f.expected}
        onChange={set("expected")}
        placeholder="เช่น ลดลงเหลือราว 120 วัน"
      />
      <div className="flex gap-2 items-end">
        <div className="w-32">
          <Label colors={colors}>ช่วงที่ถือว่าตรง — ต่ำสุด</Label>
          <NumInput
            allowNegative
            className={FIELD}
            style={fieldStyle}
            value={f.low}
            onChange={set("low")}
          />
        </div>
        <div className="w-32">
          <Label colors={colors}>สูงสุด</Label>
          <NumInput
            allowNegative
            className={FIELD}
            style={fieldStyle}
            value={f.high}
            onChange={set("high")}
          />
        </div>
        <span className="pb-1" style={dim}>
          {m.unit} — ใส่ข้างเดียวได้ · ไม่ใส่ = ตัดสินด้วยคนตอนบันทึก
        </span>
      </div>
      <Label colors={colors}>เพราะอะไรถึงคาดแบบนี้</Label>
      <textarea
        className={FIELD}
        style={fieldStyle}
        rows={2}
        value={f.basis}
        onChange={set("basis")}
        placeholder="guidance, แบบจำลอง, แนวโน้ม"
      />
      <Label colors={colors}>หลักฐานของเหตุผล (Z-ref คั่นด้วย , — ไม่บังคับ)</Label>
      <input
        className={`${FIELD} font-mono`}
        style={fieldStyle}
        value={f.evidence}
        onChange={set("evidence")}
      />

      <Label colors={colors}>ตัวเลขออกวันไหน</Label>
      <div className="flex gap-1.5 mb-1 flex-wrap">
        {modes.map((x) => (
          <button
            aria-pressed={mode === x.id}
            type="button"
            key={x.id}
            onClick={() => setMode(x.id)}
            className="px-1.5 border"
            style={{
              borderColor: colors.border,
              color: mode === x.id ? colors.accent : colors.textSecondary,
            }}
          >
            {x.label}
          </button>
        ))}
      </div>
      {mode === "calendar" && (
        <select className={FIELD} style={fieldStyle} value={f.date} onChange={set("date")}>
          <option value="">— เลือกเหตุการณ์ —</option>
          {dates.map((d) => (
            <option key={d.id} value={d.ref}>
              {d.date} · {d.title} ({d.ref}, {d.status === "CONFIRMED" ? "ยืนยัน" : "ประมาณ"})
            </option>
          ))}
        </select>
      )}
      {mode === "new" && (
        <>
          <div className="flex gap-2">
            <input
              className={FIELD}
              style={fieldStyle}
              value={f.nd_title}
              onChange={set("nd_title")}
              placeholder="เหตุการณ์ เช่น Micron ประกาศงบ FQ1 FY27"
            />
            <input
              type="date"
              className="px-1.5 py-1 border outline-none"
              style={fieldStyle}
              value={f.nd_date}
              onChange={set("nd_date")}
            />
          </div>
          <div className="flex gap-2 mt-1">
            <select
              className="px-1.5 py-1 border outline-none"
              style={fieldStyle}
              value={f.nd_status}
              onChange={set("nd_status")}
            >
              <option value="ESTIMATED">ประมาณ</option>
              <option value="CONFIRMED">ยืนยัน (ผู้เผยแพร่ประกาศวันเอง)</option>
            </select>
            <select
              className="px-1.5 py-1 border outline-none"
              style={fieldStyle}
              value={f.nd_kind}
              onChange={set("nd_kind")}
            >
              <option value="EARNINGS">งบ</option>
              <option value="FILING">filing</option>
              <option value="DATA_RELEASE">ข้อมูล</option>
              <option value="EVENT">เหตุการณ์</option>
              <option value="OTHER">อื่น ๆ</option>
            </select>
          </div>
          <input
            className={`${FIELD} mt-1`}
            style={fieldStyle}
            value={f.nd_source}
            onChange={set("nd_source")}
            placeholder="ที่มาของวันที่ เช่น ประมาณจากรอบก่อน / ประกาศของบริษัท"
          />
          <input
            className={`${FIELD} mt-1`}
            style={fieldStyle}
            value={f.nd_url}
            onChange={set("nd_url")}
            placeholder="ลิงก์ประกาศวัน (บังคับเมื่อยืนยัน)"
          />
        </>
      )}
      {mode === "plain" && (
        <input
          type="date"
          className="px-1.5 py-1 border outline-none"
          style={fieldStyle}
          value={f.due_date}
          onChange={set("due_date")}
        />
      )}
      <Label colors={colors}>เวลา (ไม่บังคับ)</Label>
      <input
        className={FIELD}
        style={fieldStyle}
        value={f.release_time}
        onChange={set("release_time")}
        placeholder="เช่น 16:05 ET หลังตลาดปิด"
      />

      <Buttons colors={colors} busy={busy} onSave={submit} onCancel={onCancel} />
      <Errors lines={err} />
    </div>
  );
}

/** What the number came out as. With a numeric band the verdict shown here is
 *  the one the server will reach; evidence is required either way. */
export function ReadForm({
  colors,
  detail,
  period,
  onDone,
  onCancel,
}: {
  colors: Colors;
  detail: TDetail;
  /** Set when correcting a number already recorded for that period. */
  period?: string;
  onDone: (opened: TQuestion | null) => void;
  onCancel: () => void;
}) {
  const m = detail.metric;
  const target = period
    ? (detail.periods.find((p) => p.period === period)?.expectation ?? null)
    : (detail.periods.find((p) => p.expectation?.id === detail.state.next?.expectation_id)
        ?.expectation ?? null);
  const [f, setF] = useState({
    value: "",
    value_text: "",
    as_of: today(),
    zettel: "",
    source_url: m.source_url,
    quote: "",
    verdict: "",
    note: "",
    period: period ?? "",
  });
  const [kill, setKill] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldStyle = fieldOf(colors);
  const dim = { color: colors.textSecondary };
  const set =
    (k: keyof typeof f) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }));

  const value = num(f.value);
  const hasBand = !!target && (target.low !== null || target.high !== null);
  const preview = target && value !== null ? previewVerdict(value, target.low, target.high) : null;
  // Asked for by hand only when the numbers cannot decide: a forecast in words,
  // or a reading given as text against a numeric band.
  const needVerdict = !!target && (!hasBand || (value === null && f.value_text.trim() !== ""));
  const numericKill = !!m.kill_op && m.kill_value !== null;
  const killPreview = value !== null && crossesKill(value, m.kill_op, m.kill_value);
  const latest = detail.series?.points[0];

  const submit = async () => {
    setBusy(true);
    const r = await call<TDetail>(`${API}/${m.id}/readings`, "POST", {
      value,
      value_text: f.value_text,
      as_of: f.as_of || null,
      zettel: f.zettel.trim() || null,
      source_url: f.source_url,
      quote: f.quote,
      verdict: needVerdict ? f.verdict || null : null,
      kill: !numericKill && m.kill_rule ? kill : null,
      note: f.note,
      period: f.period,
    });
    setBusy(false);
    setErr(r.errors);
    if (r.data) onDone(r.data.opened_question ?? null);
  };

  return (
    <div className="leading-relaxed max-w-[680px]">
      <span className="font-bold" style={{ color: colors.accent }}>
        {period ? "แก้ค่าจริง" : "บันทึกค่าจริง"} — {m.ref} {m.title}
      </span>
      {target ? (
        <div style={{ color: colors.text }}>
          งวด {target.period} · คาดว่า {target.expected}
          {hasBand && (
            <span className="font-mono">
              {" "}
              [{band(target.low, target.high)}
              {m.unit ? ` ${m.unit}` : ""}]
            </span>
          )}
        </div>
      ) : (
        <div style={dim}>ไม่มีค่าคาดการณ์ของงวดนี้ — จะบันทึกโดยไม่มีผลเทียบ</div>
      )}
      {m.kill_rule && <div style={{ color: "#f87171" }}>เส้น killer: {m.kill_rule}</div>}

      {!target && (
        <>
          <Label colors={colors}>งวด</Label>
          <input className={FIELD} style={fieldStyle} value={f.period} onChange={set("period")} />
        </>
      )}

      <div className="flex gap-2 items-end">
        <div className="w-36">
          <Label colors={colors}>ค่าจริง</Label>
          <NumInput
            allowNegative
            className={FIELD}
            style={fieldStyle}
            value={f.value}
            onChange={set("value")}
          />
        </div>
        <span className="pb-1" style={dim}>
          {m.unit}
        </span>
        {preview && (
          <span className="pb-1">
            <Chip text={T_VERDICT[preview].text} color={T_VERDICT[preview].color} />
          </span>
        )}
        {killPreview && (
          <span className="pb-1">
            <Chip text="แตะเส้น killer" color="#f87171" />
          </span>
        )}
        <div className="w-36 ml-auto">
          <Label colors={colors}>ข้อมูล ณ วันที่</Label>
          <input
            type="date"
            className={FIELD}
            style={fieldStyle}
            value={f.as_of}
            onChange={set("as_of")}
          />
        </div>
      </div>
      {latest && detail.series && (
        <button
          type="button"
          className="mt-1 underline text-left"
          style={dim}
          onClick={() =>
            setF((p) => ({
              ...p,
              value: String(latest.value),
              as_of: latest.date.slice(0, 10),
              source_url: detail.series?.source_url ?? p.source_url,
              quote: `${detail.series?.label} ${fmtVal(latest.value)} ${detail.series?.unit ?? ""} ณ ${latest.date.slice(0, 10)}`,
            }))
          }
        >
          ใช้ค่าล่าสุดที่ระบบเก็บ: {fmtVal(latest.value)} {detail.series.unit} ณ {latest.date.slice(0, 10)}
        </button>
      )}
      <Label colors={colors}>ค่าตามที่ประกาศ เป็นข้อความ (ใช้เมื่อไม่ใช่ตัวเลข)</Label>
      <input
        className={FIELD}
        style={fieldStyle}
        value={f.value_text}
        onChange={set("value_text")}
      />

      {needVerdict && (
        <>
          <Label colors={colors}>ตรงกับที่คาดไหม — ค่าคาดการณ์นี้ไม่มีช่วงตัวเลข จึงต้องตัดสินเอง</Label>
          <select className={FIELD} style={fieldStyle} value={f.verdict} onChange={set("verdict")}>
            <option value="">— เลือก —</option>
            <option value="IN_LINE">ตรงตามคาด</option>
            <option value="OFF">ไม่ตรง</option>
          </select>
        </>
      )}
      {!numericKill && m.kill_rule && (
        <label className="flex items-center gap-1.5 mt-2" style={{ color: colors.text }}>
          <input type="checkbox" checked={kill} onChange={(e) => setKill(e.target.checked)} />
          แตะเส้น killer แล้ว
        </label>
      )}

      <Label colors={colors}>หลักฐาน — Z-ref ของ ZETTEL ที่มีลิงก์ + ข้อความที่อ้าง</Label>
      <input
        className={`${FIELD} font-mono`}
        style={fieldStyle}
        value={f.zettel}
        onChange={set("zettel")}
        placeholder="Z-0096"
      />
      <Label colors={colors}>หรือ ลิงก์ + บรรทัดที่อ่านตัวเลขมา</Label>
      <input
        className={FIELD}
        style={fieldStyle}
        value={f.source_url}
        onChange={set("source_url")}
        placeholder="https://"
      />
      <input
        className={`${FIELD} mt-1`}
        style={fieldStyle}
        value={f.quote}
        onChange={set("quote")}
        placeholder="ประโยคหรือบรรทัดในตารางที่ตัวเลขนี้มาจาก"
      />
      <Label colors={colors}>หมายเหตุ (ไม่บังคับ)</Label>
      <input className={FIELD} style={fieldStyle} value={f.note} onChange={set("note")} />

      <div className="mt-2" style={dim}>
        ถ้าไม่ตรงหรือแตะเส้น killer ระบบจะเปิดคำถาม "ทำไม" ใน QUESTIONS ให้ทันที
      </div>
      <Buttons colors={colors} busy={busy} onSave={submit} onCancel={onCancel} />
      <Errors lines={err} />
    </div>
  );
}
