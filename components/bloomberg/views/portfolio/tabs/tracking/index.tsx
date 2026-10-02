"use client";
import { toolsThesisIdAtom } from "@/components/bloomberg/atoms";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useEffect, useState } from "react";
import type { Colors } from "../../helpers";
import { Chip, Errors, Label } from "../questions";
import { STATUS_COLOR, actorTag } from "../questions/types";
import { NavRail, ThesisNavigator, useThesisList } from "../theses/ThesisNavigator";
import { ReadDot, UNREAD_COLOR, UnreadBar, useReads } from "../theses/useReads";
import { API, ExpectForm, MetricForm, ReadForm, call } from "./forms";
import {
  type TCountsPayload,
  type TDetail,
  type TExpectation,
  type TList,
  type TMetric,
  type TPeriod,
  type TQuestion,
  type TReading,
  T_CADENCE,
  T_GAP,
  T_STATUS,
  T_VERDICT,
  band,
  fmtVal,
  whenText,
} from "./types";

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** Red = a number came due, missed, or crossed its kill line. Amber = a metric
 *  that cannot be tracked yet because something is not filled in. */
export function TrackBadges({ alert, setup }: { alert: number; setup: number }) {
  if (!alert && !setup) return null;
  return (
    <span className="inline-flex gap-0.5 ml-1 align-middle">
      {alert > 0 && (
        <span
          className="text-[8px] px-1 font-bold"
          title={`${alert} ตัวเลขถึงวัน / ไม่ตรง / แตะเส้น killer`}
          style={{ background: "#7f1d1d", color: "#fecaca" }}
        >
          {alert}
        </span>
      )}
      {setup > 0 && (
        <span
          className="text-[8px] px-1 font-bold"
          title={`${setup} ตัวเลขยังตั้งไม่ครบ`}
          style={{ background: "#78350f", color: "#fde68a" }}
        >
          {setup}
        </span>
      )}
    </span>
  );
}

export function useTrackCounts() {
  return useQuery({
    queryKey: ["tracking", "counts"],
    queryFn: ({ signal }) => getJson<TCountsPayload>(`${API}/counts`, signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

type Mode =
  | { kind: "view" }
  | { kind: "add" }
  | { kind: "edit" }
  | { kind: "expect" }
  | { kind: "read"; period?: string };

export function TrackingTab({
  colors,
  onOpenQuestion,
}: {
  colors: Colors;
  onOpenQuestion: (thesisId: string | null, questionId: string) => void;
}) {
  const qc = useQueryClient();
  // A reading can open a question, so the question badge moves with this one.
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["tracking"] }),
      qc.invalidateQueries({ queryKey: ["questions"] }),
    ]);

  // "" = every thesis: what is due does not care which thesis it belongs to.
  // Shared with THESES and QUESTIONS.
  const [thesisId, setThesisId] = useAtom(toolsThesisIdAtom);
  const reads = useReads();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [opened, setOpened] = useState<TQuestion | null>(null);

  const { data: thesesData } = useThesisList();
  const theses = thesesData?.theses ?? [];
  const { data: counts } = useTrackCounts();

  // A remembered thesis that no longer exists would leave the tab empty.
  useEffect(() => {
    if (thesisId && theses.length && !theses.some((t) => t.id === thesisId)) setThesisId("");
  }, [theses, thesisId, setThesisId]);

  const { data: list, isLoading } = useQuery({
    queryKey: ["tracking", "list", thesisId],
    queryFn: ({ signal }) =>
      getJson<TList>(
        `${API}${thesisId ? `?thesis_id=${encodeURIComponent(thesisId)}` : ""}`,
        signal
      ),
    staleTime: 30_000,
  });
  const rows = list?.metrics ?? [];

  useEffect(() => {
    if (!list) return;
    if (selectedId && list.metrics.some((m) => m.id === selectedId)) return;
    setSelectedId(list.metrics[0]?.id ?? null);
  }, [list, selectedId]);

  const { data: detail } = useQuery({
    queryKey: ["tracking", "detail", selectedId],
    queryFn: ({ signal }) => getJson<TDetail>(`${API}/${selectedId}`, signal),
    enabled: !!selectedId,
    staleTime: 30_000,
  });

  const border = { borderColor: colors.border };
  const dim = { color: colors.textSecondary };
  const c = list?.counts;
  const pick = (id: string) => {
    setThesisId(id);
    setSelectedId(null);
    setMode({ kind: "view" });
    setOpened(null);
  };
  const done = (id?: string) => {
    setMode({ kind: "view" });
    // Select only once the list knows the new row, or the "selection no longer
    // exists" fallback snaps back to the first one.
    void refresh().then(() => {
      if (id) setSelectedId(id);
    });
  };

  const unreadReadings = thesisId
    ? (reads.byThesis[thesisId]?.reading ?? 0)
    : Object.values(reads.byThesis).reduce((n, x) => n + x.reading, 0);

  return (
    <div className="reading flex h-full overflow-hidden">
      <NavRail colors={colors}>
        <ThesisNavigator
          colors={colors}
          selectedId={thesisId}
          onSelect={pick}
          allLabel="ทุก thesis"
        />
      </NavRail>

      <div className="flex-1 min-w-0 flex flex-col overflow-hidden text-[10px]">
        <div
          className="shrink-0 flex items-center gap-3 px-2 py-1 border-b flex-wrap"
          style={border}
        >
          {(["KILL", "DUE", "OFF", "SETUP", "WAITING"] as const).map((s) => {
            const n = c?.[s.toLowerCase() as "kill" | "due" | "off" | "setup" | "waiting"] ?? 0;
            return (
              <span key={s} style={{ color: n ? T_STATUS[s].color : colors.textSecondary }}>
                {n} {T_STATUS[s].text}
              </span>
            );
          })}
          {!!thesisId && (
            <UnreadBar
              count={unreadReadings}
              onMarkAll={() => void reads.markThesis(thesisId, ["reading"])}
              colors={colors}
            />
          )}
          <button
            type="button"
            className="ml-auto px-1.5 border font-bold hover:opacity-80"
            style={{ ...border, color: colors.accent }}
            onClick={() => setMode(mode.kind === "add" ? { kind: "view" } : { kind: "add" })}
          >
            {mode.kind === "add" ? "ปิด" : "+ ตัวเลข"}
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          <div className="w-[40%] min-w-[240px] border-r overflow-y-auto" style={border}>
            {rows.map((m) => (
              <MetricRow
                key={m.id}
                m={m}
                colors={colors}
                unread={reads.unreadUnder("reading", m.id).length}
                showSymbol={!thesisId}
                selected={selectedId === m.id}
                onClick={() => {
                  setSelectedId(m.id);
                  setMode({ kind: "view" });
                  setOpened(null);
                }}
              />
            ))}
            {!isLoading && rows.length === 0 && (
              <div className="p-3 leading-relaxed" style={dim}>
                ยังไม่มีตัวเลขที่จับตา เริ่มจาก killer condition ของ thesis: ตัวเลขอะไร อ่านจากที่ไหน คาดว่าเท่าไร
                และออกวันไหน
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0 overflow-y-auto p-3">
            {mode.kind === "add" ? (
              <MetricForm
                colors={colors}
                theses={theses}
                thesisId={thesisId}
                onDone={done}
                onCancel={() => setMode({ kind: "view" })}
              />
            ) : !detail ? (
              <div style={dim}>{rows.length ? "เลือกตัวเลขทางซ้าย" : ""}</div>
            ) : mode.kind === "edit" ? (
              <MetricForm
                key={detail.metric.id}
                colors={colors}
                theses={theses}
                thesisId={thesisId}
                detail={detail}
                onDone={done}
                onCancel={() => setMode({ kind: "view" })}
              />
            ) : mode.kind === "expect" ? (
              <ExpectForm
                key={detail.metric.id}
                colors={colors}
                detail={detail}
                onDone={() => done()}
                onCancel={() => setMode({ kind: "view" })}
              />
            ) : mode.kind === "read" ? (
              <ReadForm
                key={`${detail.metric.id}-${mode.period ?? ""}`}
                colors={colors}
                detail={detail}
                period={mode.period}
                onDone={(q) => {
                  setOpened(q);
                  done();
                }}
                onCancel={() => setMode({ kind: "view" })}
              />
            ) : (
              <Detail
                d={detail}
                colors={colors}
                opened={opened}
                reads={reads}
                onMode={setMode}
                onChange={() => void Promise.all([refresh(), reads.refresh()])}
                onOpenQuestion={(q) => onOpenQuestion(detail.metric.thesis_id, q.id)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricRow({
  m,
  colors,
  unread,
  showSymbol,
  selected,
  onClick,
}: {
  m: TMetric;
  colors: Colors;
  /** Readings of this metric the user has not looked at yet. */
  unread: number;
  showSymbol: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const s = m.state;
  const dim = { color: colors.textSecondary };
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-2 py-1 border-b hover:opacity-90"
      style={{
        borderColor: colors.border,
        background: selected ? colors.bgSelected : "transparent",
      }}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono shrink-0" style={dim}>
          {m.ref}
        </span>
        {showSymbol && (
          <span className="font-bold shrink-0" style={{ color: colors.accent }}>
            {m.symbol}
          </span>
        )}
        <span className="flex-1 min-w-0 truncate" style={{ color: colors.text }}>
          {m.title}
        </span>
        {unread > 0 && (
          <span className="shrink-0" style={{ color: UNREAD_COLOR }} title="มีค่าจริงที่ยังไม่อ่าน">
            ●
          </span>
        )}
        {m.role === "KILLER" && <Chip text="KILLER" color="#f87171" />}
        <Chip text={T_STATUS[s.status].text} color={T_STATUS[s.status].color} />
      </div>
      <div className="truncate" style={dim}>
        {s.next ? (
          <>
            {s.next.period} · คาด {s.next.expected}
            {s.next.date && (
              <span style={{ color: s.next.due ? T_STATUS.DUE.color : colors.textSecondary }}>
                {" "}
                · {s.next.date} ({whenText(s.next.days_until)})
              </span>
            )}
          </>
        ) : s.last ? (
          <>
            ล่าสุด {s.last.period}: {s.last.value_text} — {T_VERDICT[s.last.verdict].text}
          </>
        ) : (
          <>ยังขาด: {s.gaps.map((g) => T_GAP[g] ?? g).join(" · ")}</>
        )}
      </div>
    </button>
  );
}

const Q_STATUS_TEXT: Record<string, string> = {
  OPEN: "ยังไม่มีคำอธิบาย",
  WATCH: "อธิบายแล้ว รอตรวจสมมติฐาน",
  CLEAR: "อธิบายแล้ว",
  DROPPED: "เลิกหาเหตุผล",
};

function QuestionLink({
  q,
  colors,
  onOpen,
}: {
  q: TQuestion;
  colors: Colors;
  onOpen: (q: TQuestion) => void;
}) {
  return (
    <button
      type="button"
      className="text-left hover:opacity-80"
      onClick={() => onOpen(q)}
      title={q.title}
    >
      <span className="font-mono font-bold" style={{ color: STATUS_COLOR[q.status] }}>
        {q.ref}
      </span>{" "}
      <span style={{ color: colors.textSecondary }}>{Q_STATUS_TEXT[q.status] ?? q.status}</span>
    </button>
  );
}

function ExpectCell({ e, unit, colors }: { e: TExpectation; unit: string; colors: Colors }) {
  const b = band(e.low, e.high);
  return (
    <>
      <div style={{ color: colors.text }}>
        {e.expected}
        {b && (
          <span className="font-mono">
            {" "}
            [{b}
            {unit ? ` ${unit}` : ""}]
          </span>
        )}
      </div>
      <div style={{ color: colors.textSecondary }}>
        เพราะ {e.basis}
        {e.evidence.map((z) => (
          <span key={z.id} className="font-mono" title={z.title}>
            {" "}
            {z.ref}
          </span>
        ))}
        {actorTag(e.actor) ? ` · ${actorTag(e.actor)}` : ""}
      </div>
    </>
  );
}

function Evidence({ r, colors }: { r: TReading; colors: Colors }) {
  const url = r.zettel?.sources.find((s) => s.url)?.url ?? r.source_url;
  const label = r.zettel?.ref ?? "หลักฐาน";
  if (!url) return <span className="font-mono">{label}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="underline font-mono"
      style={{ color: colors.textSecondary }}
      title={r.zettel?.title ?? r.quote}
    >
      {label}
    </a>
  );
}

function PeriodRow({
  p,
  unit,
  colors,
  reads,
  onCorrect,
  onOpenQuestion,
}: {
  p: TPeriod;
  unit: string;
  colors: Colors;
  reads: ReturnType<typeof useReads>;
  onCorrect: (period: string) => void;
  onOpenQuestion: (q: TQuestion) => void;
}) {
  const dim = { color: colors.textSecondary };
  const e = p.expectation;
  const r = p.reading;
  const cell = "align-top py-1.5 pr-2 border-b";
  const border = { borderColor: colors.border };
  return (
    <tr>
      <td className={`${cell} whitespace-nowrap`} style={border}>
        <div className="font-bold" style={{ color: colors.text }}>
          {p.period}
        </div>
        {e?.date && (
          <div className="font-mono" style={dim}>
            {e.date}
          </div>
        )}
        {e?.late && <Chip text="ตั้งย้อนหลัง" color="#fbbf24" />}
      </td>
      <td className={cell} style={border}>
        {e ? <ExpectCell e={e} unit={unit} colors={colors} /> : <span style={dim}>—</span>}
        {p.revisions.map((x) => (
          <div key={x.id} style={dim}>
            เดิม ({x.created_at.slice(0, 10)}): {x.expected}
            {band(x.low, x.high) ? ` [${band(x.low, x.high)}]` : ""}
          </div>
        ))}
      </td>
      <td className={cell} style={border}>
        {r ? (
          <>
            <div className="font-mono font-bold" style={{ color: colors.text }}>
              <ReadDot type="reading" id={r.id} colors={colors} reads={reads} /> {r.value_text}
            </div>
            <div style={dim}>
              ณ {r.as_of} · <Evidence r={r} colors={colors} />
              {actorTag(r.actor) ? ` · ${actorTag(r.actor)}` : ""} ·{" "}
              <button type="button" className="underline" onClick={() => onCorrect(p.period)}>
                แก้ค่า
              </button>
            </div>
            {r.note && <div style={dim}>{r.note}</div>}
            {p.corrections.map((x) => (
              <div key={x.id} style={dim}>
                เดิม ({x.created_at.slice(0, 10)}): {x.value_text}
              </div>
            ))}
          </>
        ) : (
          <span style={dim}>ยังไม่ออก</span>
        )}
      </td>
      <td className={`${cell} whitespace-nowrap`} style={border}>
        {r && (
          <div className="flex flex-col gap-0.5 items-start">
            <Chip text={T_VERDICT[r.verdict].text} color={T_VERDICT[r.verdict].color} />
            {r.kill && <Chip text="แตะเส้น killer" color="#f87171" />}
          </div>
        )}
      </td>
      <td className={cell} style={border}>
        {r?.question && <QuestionLink q={r.question} colors={colors} onOpen={onOpenQuestion} />}
      </td>
    </tr>
  );
}

function Detail({
  d,
  colors,
  reads,
  opened,
  onMode,
  onChange,
  onOpenQuestion,
}: {
  d: TDetail;
  colors: Colors;
  reads: ReturnType<typeof useReads>;
  /** The question the reading just recorded opened, if it missed. */
  opened: TQuestion | null;
  onMode: (m: Mode) => void;
  onChange: () => void;
  onOpenQuestion: (q: TQuestion) => void;
}) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the drafts when another metric is opened
  useEffect(() => {
    setReason("");
    setErr(null);
    setConfirmDelete(false);
  }, [d.metric.id]);

  const m = d.metric;
  const s = d.state;
  const next = s.next;
  const nextRow = d.periods.find((p) => p.expectation?.id === next?.expectation_id)?.expectation;
  const dim = { color: colors.textSecondary };
  const text = { color: colors.text };
  const btn = "px-2 py-0.5 border font-bold hover:opacity-80 disabled:opacity-40";
  const retired = s.status === "RETIRED";

  const act = async (url: string, method = "POST", body?: unknown) => {
    setBusy(true);
    const r = await call(url, method, body);
    setBusy(false);
    setErr(r.errors);
    if (!r.errors) {
      setReason("");
      onChange();
    }
  };

  return (
    <div className="leading-relaxed">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-mono" style={dim}>
          {m.ref}
        </span>
        <span className="font-bold" style={{ color: colors.accent }}>
          {m.symbol}
        </span>
        <Chip text={T_STATUS[s.status].text} color={T_STATUS[s.status].color} />
        <Chip
          text={m.role === "KILLER" ? "KILLER" : "จับตา"}
          color={m.role === "KILLER" ? "#f87171" : "#888"}
        />
        <span style={dim}>{T_CADENCE[m.cadence] ?? m.cadence}</span>
        {s.gaps.length > 0 && (
          <span style={{ color: T_STATUS.SETUP.color }}>
            ยังขาด: {s.gaps.map((g) => T_GAP[g] ?? g).join(" · ")}
          </span>
        )}
        {actorTag(m.actor) && <Chip text={actorTag(m.actor)} color="#f472b6" />}
      </div>
      <div className="text-[13px] font-bold mt-1" style={text}>
        {m.title}
        {m.unit && (
          <span className="font-normal text-[10px]" style={dim}>
            {" "}
            ({m.unit})
          </span>
        )}
      </div>

      {opened && (
        <div className="mt-2 p-1.5 border" style={{ borderColor: "#fb923c88", color: "#fb923c" }}>
          ค่าที่บันทึกไม่ตรงกับที่คาด — เปิดคำถามให้หาเหตุผลแล้ว:{" "}
          <button
            type="button"
            className="underline font-bold"
            onClick={() => onOpenQuestion(opened)}
          >
            {opened.ref} ไปที่คำถาม
          </button>
        </div>
      )}

      {next && (
        <div
          className="mt-2 p-1.5 border"
          style={{
            borderColor: next.due ? `${T_STATUS.DUE.color}88` : colors.border,
            background: next.due ? colors.bgSelected : "transparent",
          }}
        >
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className="font-bold"
              style={{ color: next.due ? T_STATUS.DUE.color : colors.text }}
            >
              {next.due ? "ถึงวันแล้ว — เปิดแหล่งด้านล่างแล้วบันทึกค่าจริง" : "รอบถัดไป"}
            </span>
            <span className="font-bold" style={text}>
              {next.period}
            </span>
            {next.date && (
              <span className="font-mono" style={text}>
                {next.date}
              </span>
            )}
            {next.release_time && <span style={dim}>{next.release_time}</span>}
            <span style={dim}>{whenText(next.days_until)}</span>
            {next.date_status && (
              <Chip
                text={next.date_status === "CONFIRMED" ? "วันยืนยัน" : "วันประมาณ"}
                color={next.date_status === "CONFIRMED" ? "#4ade80" : "#fbbf24"}
              />
            )}
            {next.date_ref && (
              <span style={dim}>
                {next.date_ref} {next.date_title}
              </span>
            )}
          </div>
          {nextRow && <ExpectCell e={nextRow} unit={m.unit} colors={colors} />}
          {nextRow?.calendar && <div style={dim}>ที่มาของวันที่: {nextRow.calendar.source}</div>}
        </div>
      )}

      <Label colors={colors}>อ่านตัวเลขได้ที่</Label>
      {m.source_name || m.source_url || m.source_locator || m.source_tool ? (
        <>
          <div style={text}>
            {m.source_name || <span style={dim}>ยังไม่ได้ระบุผู้เผยแพร่</span>}
            {m.source_url && (
              <a
                href={m.source_url}
                target="_blank"
                rel="noreferrer"
                className="ml-2 underline font-bold"
                style={{ color: colors.accent }}
              >
                เปิดแหล่ง
              </a>
            )}
          </div>
          {m.source_locator && <div style={text}>ตำแหน่ง: {m.source_locator}</div>}
          {m.source_tool && (
            <div style={dim}>
              ดึงด้วย: <span className="font-mono">{m.source_tool}</span>
            </div>
          )}
        </>
      ) : (
        <div style={{ color: T_STATUS.SETUP.color }}>
          ยังไม่ได้ระบุ — ถึงวันแล้วจะต้องค้นใหม่ กด "แก้ไข" เพื่อใส่แหล่ง
        </div>
      )}
      {d.series && (
        <div style={dim}>
          ระบบเก็บเอง <span className="font-mono">{d.series.id}</span> ({d.series.label}):{" "}
          {d.series.points.length ? (
            <>
              <span className="font-mono font-bold" style={text}>
                {fmtVal(d.series.points[0].value)} {d.series.unit}
              </span>{" "}
              ณ {d.series.points[0].date.slice(0, 10)}
              {d.series.points[1] &&
                ` · ก่อนหน้า ${fmtVal(d.series.points[1].value)} ณ ${d.series.points[1].date.slice(0, 10)}`}
            </>
          ) : (
            "ยังไม่มีจุดข้อมูล"
          )}
        </div>
      )}

      {m.definition && (
        <>
          <Label colors={colors}>นิยาม / วิธีคิด</Label>
          <div style={text}>{m.definition}</div>
        </>
      )}
      {m.why && (
        <>
          <Label colors={colors}>บอกอะไรเกี่ยวกับ THESIS</Label>
          <div style={text}>{m.why}</div>
        </>
      )}
      {(m.kill_rule || m.role === "KILLER") && (
        <>
          <Label colors={colors}>เส้น KILLER</Label>
          <div style={{ color: m.kill_rule ? "#f87171" : T_STATUS.SETUP.color }}>
            {m.kill_rule || "ยังไม่ได้ระบุ"}
            {m.kill_op && m.kill_value !== null && (
              <span className="font-mono" style={dim}>
                {" "}
                — ตรวจอัตโนมัติ: {m.kill_op} {fmtVal(m.kill_value)}
                {m.unit ? ` ${m.unit}` : ""}
              </span>
            )}
          </div>
        </>
      )}
      {d.question && (
        <>
          <Label colors={colors}>ช่วยตอบคำถาม</Label>
          <button
            type="button"
            className="text-left"
            onClick={() => onOpenQuestion(d.question as TQuestion)}
          >
            <span className="font-mono font-bold" style={{ color: colors.accent }}>
              {d.question.ref}
            </span>{" "}
            <span style={text}>{d.question.title}</span>
          </button>
        </>
      )}

      <Label colors={colors}>คาดการณ์เทียบค่าจริง</Label>
      {d.periods.length ? (
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left text-[8px] tracking-widest" style={dim}>
              <th className="font-normal pr-2 pb-0.5">งวด</th>
              <th className="font-normal pr-2 pb-0.5">คาดว่า</th>
              <th className="font-normal pr-2 pb-0.5">ค่าจริง</th>
              <th className="font-normal pr-2 pb-0.5">ผล</th>
              <th className="font-normal pb-0.5">เหตุผลเมื่อไม่ตรง</th>
            </tr>
          </thead>
          <tbody>
            {d.periods.map((p) => (
              <PeriodRow
                key={p.period}
                p={p}
                unit={m.unit}
                colors={colors}
                reads={reads}
                onCorrect={(period) => onMode({ kind: "read", period })}
                onOpenQuestion={onOpenQuestion}
              />
            ))}
          </tbody>
        </table>
      ) : (
        <div style={dim}>ยังไม่มีค่าคาดการณ์ — กด "ตั้งค่าคาดการณ์" พร้อมเหตุผลและวันที่ตัวเลขออก</div>
      )}

      {retired && (
        <>
          <Label colors={colors}>เหตุที่เลิกติดตาม</Label>
          <div style={text}>{m.retire_reason}</div>
        </>
      )}

      <div className="mt-4 pt-2 border-t" style={{ borderColor: colors.border }}>
        <div className="flex gap-1.5 flex-wrap items-center">
          {!retired && (
            <>
              <button
                type="button"
                className={btn}
                style={{ borderColor: colors.border, color: colors.accent }}
                onClick={() => onMode({ kind: "read" })}
              >
                บันทึกค่าจริง
              </button>
              <button
                type="button"
                className={btn}
                style={{ borderColor: colors.border, color: colors.accent }}
                onClick={() => onMode({ kind: "expect" })}
              >
                ตั้งค่าคาดการณ์
              </button>
              <button
                type="button"
                className={btn}
                style={{ borderColor: colors.border, color: colors.textSecondary }}
                onClick={() => onMode({ kind: "edit" })}
              >
                แก้ไข
              </button>
            </>
          )}
          {retired ? (
            <button
              type="button"
              disabled={busy}
              className={btn}
              style={{ borderColor: colors.border, color: colors.accent }}
              onClick={() => act(`${API}/${m.id}/reopen`)}
            >
              กลับมาติดตาม
            </button>
          ) : (
            <>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="เหตุผล (บังคับเมื่อเลิกติดตาม)"
                className="flex-1 min-w-[160px] px-1.5 py-0.5 border outline-none ml-2"
                style={{
                  background: colors.surface,
                  borderColor: colors.border,
                  color: colors.text,
                }}
              />
              <button
                type="button"
                disabled={busy}
                className={btn}
                style={{ borderColor: colors.border, color: colors.textSecondary }}
                onClick={() => act(`${API}/${m.id}/retire`, "POST", { reason })}
              >
                เลิกติดตาม
              </button>
            </>
          )}
          <button
            type="button"
            disabled={busy}
            className={btn}
            style={{
              borderColor: colors.border,
              color: confirmDelete ? "#f87171" : colors.textDimmed,
            }}
            title="สำหรับตัวเลขที่กรอกผิดเท่านั้น — ตัวเลขที่เคยติดตามให้เลิกติดตามแทน"
            onClick={() =>
              confirmDelete ? act(`${API}/${m.id}`, "DELETE") : setConfirmDelete(true)
            }
          >
            {confirmDelete ? "ยืนยันลบ" : "ลบ"}
          </button>
        </div>
        <Errors lines={err} />
      </div>
    </div>
  );
}
