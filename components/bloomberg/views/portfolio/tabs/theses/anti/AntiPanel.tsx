"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Colors } from "../../../helpers";
import { Chip, Errors, Label } from "../../questions";
import { STATUS_COLOR, actorTag } from "../../questions/types";
import { call } from "../../tracking/forms";
import {
  type AAngle,
  type ABoard,
  type AClaim,
  type ACountsPayload,
  type AObjection,
  type AResult,
  type AVerdict,
  type AZettel,
  A_ANGLE,
  A_ANGLE_STATE,
  A_CLAIM,
  A_GAP,
  A_OBJ,
  A_RESULT,
  A_SUMMARY,
  threaded,
} from "./types";

export const ANTI_API = "/api/v2/antithesis";

const FIELD = "w-full px-1.5 py-1 border outline-none";
const day = (s?: string | null) => (s ?? "").slice(0, 10);

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** Whole book and per thesis — the number on the ANTI-THESIS tab comes from here,
 *  so a thesis that was never opened on that tab still shows what it owes. */
export function useAntiCounts() {
  return useQuery({
    queryKey: ["antithesis", "counts"],
    queryFn: ({ signal }) => getJson<ACountsPayload>(`${ANTI_API}/counts`, signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

type Mode =
  | { kind: "view" }
  | { kind: "claim" }
  | { kind: "edit"; claimId: string }
  | { kind: "revise"; claimId: string }
  | { kind: "object"; claimId: string; angle?: AAngle; parent?: AObjection }
  | { kind: "sweep"; claimId: string; angle?: AAngle }
  | { kind: "verdict"; claimId: string; objection: AObjection }
  | {
      kind: "reason";
      claimId: string;
      title: string;
      hint: string;
      url: string;
      body: (text: string) => Record<string, unknown>;
    };

/** Step back from one thesis: what it believes, the negation of each belief, the
 *  objections raised against it and what became of them. Status is the
 *  backend's — nothing here decides whether a claim stands. */
export function AntiPanel({
  thesisId,
  colors,
  onChange,
}: {
  thesisId: string;
  colors: Colors;
  /** A verdict lands on the thesis timeline — let the parent reload it. */
  onChange?: () => void;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [showClosed, setShowClosed] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["antithesis", "board", thesisId],
    queryFn: ({ signal }) =>
      getJson<ABoard>(`${ANTI_API}?thesis_id=${encodeURIComponent(thesisId)}`, signal),
    staleTime: 30_000,
  });

  const done = () => {
    setMode({ kind: "view" });
    setErr(null);
    // An objection can be sent to QUESTIONS, so that badge moves with this one.
    void Promise.all([
      qc.invalidateQueries({ queryKey: ["antithesis"] }),
      qc.invalidateQueries({ queryKey: ["questions"] }),
    ]);
    onChange?.();
  };
  /** One-click actions: no form, so a refusal is shown at the top of the board. */
  const act = async (url: string, method = "POST", body?: unknown) => {
    const r = await call(url, method, body);
    if (r.errors) setErr(r.errors);
    else done();
  };
  const open = (m: Mode) => {
    setErr(null);
    setMode(m);
  };

  const border = { borderColor: colors.border };
  const dim = { color: colors.textSecondary };
  const c = data?.counts;
  const claims = data?.claims ?? [];
  const closed = claims.filter((x) => x.state.status === "REVISED" || x.state.status === "RETIRED");
  const shown = showClosed ? claims : claims.filter((x) => !closed.includes(x));
  const summary = data ? A_SUMMARY[data.summary.verdict] : null;
  const ctx = { colors, mode, open, act, done, cancel: () => open({ kind: "view" }) };

  return (
    <div className="flex-1 flex flex-col min-h-0 text-[10px]">
      <div className="shrink-0 flex items-center gap-3 px-3 py-1 border-b flex-wrap" style={border}>
        {summary && (
          <span className="font-bold" style={{ color: summary.color }}>
            {summary.text}
          </span>
        )}
        {c &&
          (["FALLEN", "BROKEN", "CONTESTED", "UNTESTED", "STANDS"] as const).map((s) => {
            const n = c[s.toLowerCase() as "fallen"];
            return n ? (
              <span key={s} style={{ color: A_CLAIM[s].color }}>
                {n} {A_CLAIM[s].text}
              </span>
            ) : null;
          })}
        {!!c?.pending && <span style={{ color: A_OBJ.PENDING.color }}>{c.pending} รอรับรอง</span>}
        {data?.summary.challenged_at && (
          <span style={dim}>ท้าล่าสุด {day(data.summary.challenged_at)}</span>
        )}
        <span className="flex-1" />
        {closed.length > 0 && (
          <button
            type="button"
            aria-pressed={showClosed}
            onClick={() => setShowClosed((v) => !v)}
            className="hover:opacity-80"
            style={{ color: showClosed ? colors.accent : colors.textSecondary }}
          >
            รอบก่อน / เลิกใช้ ({closed.length})
          </button>
        )}
        <button
          type="button"
          aria-pressed={mode.kind === "claim"}
          className="px-1.5 border font-bold hover:opacity-80"
          style={{ ...border, color: colors.accent }}
          onClick={() => open(mode.kind === "claim" ? { kind: "view" } : { kind: "claim" })}
        >
          {mode.kind === "claim" ? "ปิด" : "+ ข้อที่เชื่อ"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="prose-measure">
          {mode.kind === "view" && <Errors lines={err} />}
          {mode.kind === "claim" && (
            <ClaimForm colors={colors} thesisId={thesisId} onDone={done} onCancel={ctx.cancel} />
          )}
          {!isLoading && claims.length === 0 && mode.kind !== "claim" && (
            <div className="leading-relaxed" style={dim}>
              ถอยออกมาหนึ่งก้าว: เขียนสิ่งที่ thesis นี้เชื่อทีละข้อ แล้วเขียนด้านกลับของมัน — ถ้าข้อนี้ไม่จริง
              โลกจะหน้าตาอย่างไร และเราจะเห็นหลักฐานอะไร จากนั้นหาเหตุผลมาหักล้างทีละมุม
              ข้อโต้แย้งยกได้โดยไม่ต้องมีหลักฐาน แต่จะปัดตกได้ต้องมีหลักฐานที่เปิดตรวจได้ ข้อที่ยังไม่เคยถูกท้าไม่นับว่าผ่าน
            </div>
          )}
          {shown.map((x) => (
            <ClaimCard key={x.id} claim={x} {...ctx} />
          ))}
        </div>
      </div>
    </div>
  );
}

type Ctx = {
  colors: Colors;
  mode: Mode;
  open: (m: Mode) => void;
  act: (url: string, method?: string, body?: unknown) => Promise<void>;
  done: () => void;
  cancel: () => void;
};

function Act({
  children,
  onClick,
  color,
  title,
  pressed,
}: {
  children: React.ReactNode;
  onClick: () => void;
  color: string;
  title?: string;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className="hover:opacity-80"
      style={{ color }}
    >
      {children}
    </button>
  );
}

function ClaimCard({ claim: c, colors, mode, open, act, done, cancel }: Ctx & { claim: AClaim }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dim = { color: colors.textSecondary };
  const s = c.state;
  const status = A_CLAIM[s.status];
  const isClosed = s.status === "REVISED" || s.status === "RETIRED";
  const here = mode.kind !== "view" && mode.kind !== "claim" && mode.claimId === c.id ? mode : null;
  const rows = threaded(c.objections);

  return (
    <div
      className="mb-4 pl-2 border-l-2"
      style={{ borderColor: status.color, opacity: isClosed ? 0.6 : 1 }}
    >
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-mono" style={dim}>
          {c.ref}
        </span>
        {c.stake === "KEY" && <Chip text="ข้อหลัก" color="#f87171" />}
        <Chip text={status.text} color={status.color} />
        {s.settled && <Chip text="ครบทุกมุม" color="#4ade80" />}
        {s.round > 1 && <span style={dim}>รอบ {s.round}</span>}
        {actorTag(c.actor) && <span style={dim}>{actorTag(c.actor)}</span>}
        {s.challenged_at && <span style={dim}>ท้าล่าสุด {day(s.challenged_at)}</span>}
      </div>

      <div className="mt-0.5 leading-relaxed">
        <span style={dim}>เราเชื่อ </span>
        <span className="font-bold" style={{ color: colors.text }}>
          {c.statement}
        </span>
      </div>
      <div className="leading-relaxed">
        <span style={dim}>ถ้าไม่จริง </span>
        {c.negation ? (
          <span style={{ color: colors.text }}>{c.negation}</span>
        ) : (
          <span style={{ color: A_CLAIM.UNTESTED.color }}>
            ยังไม่ได้เขียนด้านกลับ — ถ้าข้อนี้ผิด โลกจะหน้าตาอย่างไร
          </span>
        )}
      </div>
      {c.basis && (
        <div className="leading-relaxed" style={dim}>
          เพราะ {c.basis}
        </div>
      )}
      {c.revises && (
        <div className="leading-relaxed" style={dim}>
          แก้มาจาก {c.revises.ref}: {c.revises.statement}
        </div>
      )}
      {c.revised_by && (
        <div className="leading-relaxed" style={dim}>
          ถูกแทนที่ด้วย {c.revised_by.ref}: {c.revised_by.statement}
        </div>
      )}
      {c.retired_at && (
        <div className="leading-relaxed" style={dim}>
          เลิกใช้ {day(c.retired_at)}: {c.retire_reason}
        </div>
      )}

      {!isClosed && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          <span style={dim}>มุมที่ท้า</span>
          {(Object.keys(s.angles) as AAngle[]).map((a) => {
            const st = A_ANGLE_STATE[s.angles[a]];
            const pressed = here?.kind === "object" && here.angle === a && !here.parent;
            return (
              <Act
                key={a}
                color={st.color}
                pressed={pressed}
                title={`${st.text} — ${A_ANGLE[a].ask}`}
                onClick={() =>
                  open(pressed ? { kind: "view" } : { kind: "object", claimId: c.id, angle: a })
                }
              >
                {st.mark} {A_ANGLE[a].text}
              </Act>
            );
          })}
        </div>
      )}

      {rows.map(({ o, depth }) => (
        <ObjectionRow
          key={o.id}
          claim={c}
          o={o}
          depth={depth}
          closed={isClosed}
          {...{ colors, mode, open, act, done, cancel }}
        />
      ))}
      {c.sweeps.map((w) => (
        <div key={w.id} className="mt-1 ml-3 leading-relaxed" style={dim}>
          <span style={{ color: A_ANGLE_STATE.none_found.color }}>– {A_ANGLE[w.angle].text}</span>{" "}
          ค้นแล้วไม่พบข้อโต้แย้ง: {w.look_where}
          {actorTag(w.actor) && ` · ${actorTag(w.actor)}`} · {day(w.created_at)}
        </div>
      ))}

      {!isClosed && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
          <Act
            color={colors.accent}
            pressed={here?.kind === "object" && !here.angle && !here.parent}
            onClick={() => open({ kind: "object", claimId: c.id })}
          >
            + ข้อโต้แย้ง
          </Act>
          {s.untried.length > 0 && (
            <Act
              color={colors.textSecondary}
              pressed={here?.kind === "sweep"}
              title="บันทึกว่าค้นมุมนี้แล้วไม่พบข้อโต้แย้ง — ต้องบอกว่าค้นที่ไหน"
              onClick={() => open({ kind: "sweep", claimId: c.id })}
            >
              ค้นแล้วไม่พบ
            </Act>
          )}
          <Act
            color={colors.textSecondary}
            pressed={here?.kind === "edit"}
            onClick={() => open({ kind: "edit", claimId: c.id })}
          >
            แก้ไข
          </Act>
          <Act
            color={colors.textSecondary}
            pressed={here?.kind === "revise"}
            title="เขียนข้อที่เชื่อใหม่ — ข้อเดิมและสิ่งที่เถียงกันไว้ถูกเก็บ ข้อใหม่เริ่มจากยังไม่เคยถูกท้า"
            onClick={() => open({ kind: "revise", claimId: c.id })}
          >
            เขียนใหม่
          </Act>
          <Act
            color={colors.textSecondary}
            onClick={() =>
              open({
                kind: "reason",
                claimId: c.id,
                title: `เลิกใช้ ${c.ref}`,
                hint: "ทำไม thesis ไม่ได้ยืนบนข้อนี้แล้ว",
                url: `${ANTI_API}/${c.id}/retire`,
                body: (reason) => ({ reason }),
              })
            }
          >
            เลิกใช้
          </Act>
          {confirmDelete ? (
            <>
              <Act color="#f87171" onClick={() => void act(`${ANTI_API}/${c.id}`, "DELETE")}>
                ยืนยันลบ
              </Act>
              <Act color={colors.textSecondary} onClick={() => setConfirmDelete(false)}>
                ไม่ลบ
              </Act>
            </>
          ) : (
            <Act
              color={colors.textSecondary}
              title="เฉพาะข้อที่ใส่ผิด — ข้อที่เลิกเชื่อให้ใช้ เลิกใช้"
              onClick={() => setConfirmDelete(true)}
            >
              ลบ
            </Act>
          )}
        </div>
      )}
      {s.status === "RETIRED" && (
        <div className="mt-1">
          <Act color={colors.accent} onClick={() => void act(`${ANTI_API}/${c.id}/reopen`)}>
            นำกลับมา
          </Act>
        </div>
      )}

      {here?.kind === "edit" && (
        <ClaimForm
          colors={colors}
          thesisId={c.thesis_id}
          claim={c}
          onDone={done}
          onCancel={cancel}
        />
      )}
      {here?.kind === "revise" && (
        <ReviseForm colors={colors} claim={c} onDone={done} onCancel={cancel} />
      )}
      {here?.kind === "object" && (
        <ObjectionForm
          key={`${here.angle ?? ""}-${here.parent?.id ?? ""}`}
          colors={colors}
          claim={c}
          angle={here.angle}
          parent={here.parent}
          onDone={done}
          onCancel={cancel}
        />
      )}
      {here?.kind === "sweep" && (
        <SweepForm colors={colors} claim={c} onDone={done} onCancel={cancel} />
      )}
      {here?.kind === "verdict" && (
        <VerdictForm
          key={here.objection.id}
          colors={colors}
          claim={c}
          objection={here.objection}
          onDone={done}
          onCancel={cancel}
        />
      )}
      {here?.kind === "reason" && (
        <ReasonForm
          key={here.url}
          colors={colors}
          title={here.title}
          hint={here.hint}
          url={here.url}
          body={here.body}
          onDone={done}
          onCancel={cancel}
        />
      )}
    </div>
  );
}

function ZRefs({ items, colors }: { items: AZettel[]; colors: Colors }) {
  return (
    <>
      {items.map((z) => (
        <div key={z.id} className="leading-relaxed">
          <span className="font-mono font-bold" style={{ color: colors.accent }}>
            {z.ref}
          </span>{" "}
          <span style={{ color: colors.text }}>{z.title}</span>
          {z.sources
            .filter((src) => src.url)
            .map((src) => (
              <a
                key={src.url}
                href={src.url}
                target="_blank"
                rel="noreferrer"
                className="ml-1 underline"
                style={{ color: colors.textSecondary }}
              >
                {src.publisher || "source"}
                {src.reliability === "primary" ? " · primary" : ""}
              </a>
            ))}
        </div>
      ))}
    </>
  );
}

function VerdictBlock({ v, colors, old }: { v: AVerdict; colors: Colors; old?: boolean }) {
  const dim = { color: colors.textSecondary };
  const color = old
    ? colors.textSecondary
    : v.result === "REBUTTED"
      ? A_OBJ.REBUTTED.color
      : v.result === "CONCEDED"
        ? A_OBJ.CONCEDED.color
        : A_OBJ.UNDECIDED.color;
  return (
    <div className="leading-relaxed" style={{ opacity: old ? 0.7 : 1 }}>
      <span style={{ color }}>{A_RESULT[v.result]}</span>
      <span style={dim}>
        {actorTag(v.actor) && ` · ${actorTag(v.actor)}`} · {day(v.created_at)}
        {v.review?.result === "REJECTED" && ` · ไม่รับ: ${v.review.note}`}
      </span>
      <div style={{ color: colors.text }}>{v.reasoning}</div>
      {v.consequence === "REVISE" && (
        <div style={dim}>
          แก้เป็น: <span style={{ color: colors.text }}>{v.revised_statement}</span>
          {v.revised_negation && ` · ถ้าไม่จริง: ${v.revised_negation}`}
        </div>
      )}
      {v.consequence === "FALLS" && <div style={dim}>ผล: เลิกเชื่อข้อนี้</div>}
      {v.searched && <div style={dim}>ค้นที่: {v.searched}</div>}
      {v.next_check && <div style={dim}>ดูอีกครั้ง {v.next_check}</div>}
      <ZRefs items={v.evidence} colors={colors} />
    </div>
  );
}

function ObjectionRow({
  claim: c,
  o,
  depth,
  closed,
  colors,
  mode,
  open,
  act,
}: Ctx & { claim: AClaim; o: AObjection; depth: number; closed: boolean }) {
  const dim = { color: colors.textSecondary };
  const st = A_OBJ[o.state.status];
  const withdrawn = o.state.status === "WITHDRAWN";
  const judging = mode.kind === "verdict" && mode.objection.id === o.id;
  const [showOld, setShowOld] = useState(false);

  return (
    <div
      className="mt-1.5 leading-relaxed"
      style={{ marginLeft: 12 + depth * 14, opacity: withdrawn ? 0.5 : 1 }}
    >
      <div className="flex items-baseline gap-1.5 flex-wrap">
        <span className="font-mono" style={dim}>
          {depth > 0 ? "↳ " : ""}
          {o.ref}
        </span>
        <Chip text={A_ANGLE[o.angle].text} color={colors.textSecondary} />
        <Chip text={o.state.due ? "ถึงวันดูอีกครั้ง" : st.text} color={st.color} />
        {actorTag(o.actor) && <span style={dim}>{actorTag(o.actor)}</span>}
      </div>
      <div style={{ color: colors.text }}>{o.argument}</div>
      {o.would_see ? (
        <div style={dim}>ถ้าข้อโต้แย้งจริงจะเห็น: {o.would_see}</div>
      ) : (
        !withdrawn &&
        !o.verdict && (
          <div style={{ color: A_CLAIM.UNTESTED.color }}>ยังไม่ได้บอกว่าถ้าข้อโต้แย้งนี้จริง จะเห็นอะไร</div>
        )
      )}
      {o.look_where && <div style={dim}>ดูที่: {o.look_where}</div>}
      {withdrawn && <div style={dim}>ถอน: {o.withdraw_reason}</div>}
      {o.question && (
        <div style={dim}>
          → คำถาม{" "}
          <span className="font-mono" style={{ color: colors.accent }}>
            {o.question.ref}
          </span>{" "}
          <span
            style={{ color: STATUS_COLOR[o.question.status as "OPEN"] ?? colors.textSecondary }}
          >
            {o.question.status}
          </span>
        </div>
      )}

      {o.verdict && (
        <div className="mt-0.5 pl-2 border-l" style={{ borderColor: colors.border }}>
          <VerdictBlock v={o.verdict} colors={colors} />
        </div>
      )}
      {o.proposal && (
        <div className="mt-0.5 pl-2 border-l" style={{ borderColor: A_OBJ.PENDING.color }}>
          <div style={{ color: A_OBJ.PENDING.color }}>ข้อเสนอ รอคุณรับรอง</div>
          <VerdictBlock v={o.proposal} colors={colors} />
          <div className="flex gap-3">
            <Act
              color="#4ade80"
              onClick={() =>
                void act(`${ANTI_API}/verdicts/${o.proposal?.id}/review`, "POST", {
                  decision: "ACCEPTED",
                })
              }
            >
              รับ
            </Act>
            <Act
              color="#f87171"
              onClick={() =>
                open({
                  kind: "reason",
                  claimId: c.id,
                  title: `ไม่รับคำตัดสินของ ${o.ref}`,
                  hint: "ทำไมไม่รับ — รอบถัดไปต้องรู้",
                  url: `${ANTI_API}/verdicts/${o.proposal?.id}/review`,
                  body: (note) => ({ decision: "REJECTED", note }),
                })
              }
            >
              ไม่รับ
            </Act>
          </div>
        </div>
      )}
      {o.history.length > 0 && (
        <>
          <Act color={colors.textSecondary} pressed={showOld} onClick={() => setShowOld((v) => !v)}>
            คำตัดสินก่อนหน้า ({o.history.length})
          </Act>
          {showOld && (
            <div className="pl-2 border-l" style={{ borderColor: colors.border }}>
              {o.history.map((v) => (
                <VerdictBlock key={v.id} v={v} colors={colors} old />
              ))}
            </div>
          )}
        </>
      )}

      {!withdrawn && !closed && (
        <div className="flex flex-wrap gap-x-3">
          <Act
            color={colors.accent}
            pressed={judging}
            onClick={() =>
              open(judging ? { kind: "view" } : { kind: "verdict", claimId: c.id, objection: o })
            }
          >
            {o.verdict ? "ตัดสินใหม่" : "ตัดสิน"}
          </Act>
          <Act
            color={colors.textSecondary}
            title="ข้อโต้แย้งต่อจากข้อนี้ — เช่น หลักฐานที่ใช้หักล้างมีปัญหา"
            onClick={() => open({ kind: "object", claimId: c.id, angle: o.angle, parent: o })}
          >
            ท้าต่อ
          </Act>
          {!o.question && (
            <Act
              color={colors.textSecondary}
              title="ยังตัดสินไม่ได้ — ส่งไปเป็นคำถามใน QUESTIONS ให้ค้นต่อตามขั้นตอนของคำถาม"
              onClick={() => void act(`${ANTI_API}/objections/${o.id}/question`)}
            >
              ส่งเป็นคำถาม
            </Act>
          )}
          <Act
            color={colors.textSecondary}
            title="เฉพาะข้อที่ซ้ำหรือยกผิดข้อ — ข้อโต้แย้งจริงต้องปิดด้วยคำตัดสิน"
            onClick={() =>
              open({
                kind: "reason",
                claimId: c.id,
                title: `ถอน ${o.ref}`,
                hint: "ทำไมข้อโต้แย้งนี้ไม่ควรถูกยกขึ้นมา",
                url: `${ANTI_API}/objections/${o.id}/withdraw`,
                body: (reason) => ({ reason }),
              })
            }
          >
            ถอน
          </Act>
        </div>
      )}
    </div>
  );
}

// ── Forms ────────────────────────────────────────────────────────────────────

function fieldOf(colors: Colors) {
  return { background: colors.surface, borderColor: colors.border, color: colors.text };
}

function Pick<T extends string>({
  value,
  options,
  onPick,
  colors,
}: {
  value: T | "";
  options: { key: T; text: string; title?: string }[];
  onPick: (k: T) => void;
  colors: Colors;
}) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
      {options.map((o) => (
        <Act
          key={o.key}
          pressed={value === o.key}
          title={o.title}
          color={value === o.key ? colors.accent : colors.textSecondary}
          onClick={() => onPick(o.key)}
        >
          {o.text}
        </Act>
      ))}
    </div>
  );
}

function Buttons({
  colors,
  busy,
  onSave,
  onCancel,
}: {
  colors: Colors;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex gap-1.5 mt-3">
      <button
        type="button"
        disabled={busy}
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

type FormProps = { colors: Colors; onDone: () => void; onCancel: () => void };

/** Shared submit: the backend's refusal comes back as lines under the form. */
function useSubmit(onDone: () => void) {
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (url: string, method: string, body: unknown) => {
    setBusy(true);
    const r = await call(url, method, body);
    setBusy(false);
    setErr(r.errors);
    if (!r.errors) onDone();
  };
  return { err, busy, submit };
}

function Form({
  title,
  colors,
  children,
}: { title: string; colors: Colors; children: React.ReactNode }) {
  // A form opens under its claim, which on a long claim is below the fold —
  // without this the click looks like it did nothing.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  return (
    <div
      ref={ref}
      className="mt-2 mb-3 p-2 border leading-relaxed"
      style={{ borderColor: colors.border }}
    >
      <span className="font-bold" style={{ color: colors.accent }}>
        {title}
      </span>
      {children}
    </div>
  );
}

function ClaimForm({
  colors,
  thesisId,
  claim,
  onDone,
  onCancel,
}: FormProps & { thesisId: string; claim?: AClaim }) {
  const [f, setF] = useState({
    statement: claim?.statement ?? "",
    negation: claim?.negation ?? "",
    basis: claim?.basis ?? "",
    stake: claim?.stake ?? ("SUPPORT" as "KEY" | "SUPPORT"),
  });
  const { err, busy, submit } = useSubmit(onDone);
  const style = fieldOf(colors);
  const argued = !!claim && (claim.objections.length > 0 || claim.sweeps.length > 0);
  const set =
    (k: "statement" | "negation" | "basis") => (e: React.ChangeEvent<HTMLTextAreaElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }));

  const save = () => {
    if (!claim) return void submit(ANTI_API, "POST", { ...f, thesis_id: thesisId });
    const changed = Object.fromEntries(
      (Object.keys(f) as (keyof typeof f)[]).filter((k) => f[k] !== claim[k]).map((k) => [k, f[k]])
    );
    if (Object.keys(changed).length === 0) return onCancel();
    void submit(`${ANTI_API}/${claim.id}`, "PATCH", changed);
  };

  return (
    <Form title={claim ? `แก้ไข ${claim.ref}` : "ข้อที่เชื่อ"} colors={colors}>
      <Label colors={colors}>เราเชื่อว่า — หนึ่งประโยคที่มีทางผิดได้</Label>
      <textarea
        className={FIELD}
        style={style}
        rows={2}
        value={f.statement}
        onChange={set("statement")}
        disabled={argued}
        placeholder="เช่น อุปสงค์ HBM โตเร็วกว่าอุปทานไปจนถึงปี 2027"
      />
      {argued && (
        <div style={{ color: colors.textSecondary }}>
          ข้อนี้ถูกท้าแล้ว จึงแก้ข้อความตรงนี้ไม่ได้ — ใช้ "เขียนใหม่" เพื่อให้ข้อเดิมและสิ่งที่เถียงกันไว้ยังอยู่
        </div>
      )}
      <Label colors={colors}>ถ้าไม่จริง — โลกจะหน้าตาอย่างไร</Label>
      <textarea
        className={FIELD}
        style={style}
        rows={2}
        value={f.negation}
        onChange={set("negation")}
        placeholder="เช่น อุปทาน HBM ตามทันก่อนปี 2027"
      />
      <Label colors={colors}>เพราะอะไรจึงเชื่อ (ไม่บังคับ)</Label>
      <textarea className={FIELD} style={style} rows={1} value={f.basis} onChange={set("basis")} />
      <Label colors={colors}>น้ำหนักต่อ THESIS</Label>
      <Pick
        colors={colors}
        value={f.stake}
        onPick={(stake) => setF((p) => ({ ...p, stake }))}
        options={[
          { key: "KEY", text: "ข้อหลัก — ข้อนี้ล้ม thesis ล้ม" },
          { key: "SUPPORT", text: "ข้อเสริม" },
        ]}
      />
      <Errors lines={err} />
      <Buttons colors={colors} busy={busy} onSave={save} onCancel={onCancel} />
    </Form>
  );
}

function ReviseForm({ colors, claim, onDone, onCancel }: FormProps & { claim: AClaim }) {
  const [f, setF] = useState({ statement: "", negation: "", reason: "" });
  const { err, busy, submit } = useSubmit(onDone);
  const style = fieldOf(colors);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Form title={`เขียน ${claim.ref} ใหม่`} colors={colors}>
      <div style={{ color: colors.textSecondary }}>
        ข้อเดิม: {claim.statement} — ถูกเก็บไว้พร้อมข้อโต้แย้งทั้งหมด ข้อใหม่เริ่มจากยังไม่เคยถูกท้า
      </div>
      <Label colors={colors}>ข้อที่เชื่อ ฉบับใหม่</Label>
      <textarea
        className={FIELD}
        style={style}
        rows={2}
        value={f.statement}
        onChange={set("statement")}
      />
      <Label colors={colors}>ถ้าไม่จริง</Label>
      <textarea
        className={FIELD}
        style={style}
        rows={2}
        value={f.negation}
        onChange={set("negation")}
      />
      <Label colors={colors}>ทำไมข้อเดิมอยู่ไม่ได้</Label>
      <textarea
        className={FIELD}
        style={style}
        rows={2}
        value={f.reason}
        onChange={set("reason")}
      />
      <Errors lines={err} />
      <Buttons
        colors={colors}
        busy={busy}
        onSave={() => void submit(`${ANTI_API}/${claim.id}/revise`, "POST", f)}
        onCancel={onCancel}
      />
    </Form>
  );
}

const ANGLE_KEYS = Object.keys(A_ANGLE) as AAngle[];

function ObjectionForm({
  colors,
  claim,
  angle,
  parent,
  onDone,
  onCancel,
}: FormProps & { claim: AClaim; angle?: AAngle; parent?: AObjection }) {
  const [f, setF] = useState({
    angle: angle ?? ("" as AAngle | ""),
    argument: "",
    would_see: "",
    look_where: "",
  });
  const { err, busy, submit } = useSubmit(onDone);
  const style = fieldOf(colors);
  const set =
    (k: "argument" | "would_see" | "look_where") => (e: React.ChangeEvent<HTMLTextAreaElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Form title={parent ? `ท้าต่อจาก ${parent.ref}` : `ข้อโต้แย้งต่อ ${claim.ref}`} colors={colors}>
      <div style={{ color: colors.textSecondary }}>
        {parent
          ? `${parent.ref}: ${parent.argument}`
          : `ด้านกลับ: ${claim.negation || claim.statement}`}
      </div>
      <Label colors={colors}>มุมที่ท้า</Label>
      <Pick
        colors={colors}
        value={f.angle}
        onPick={(a) => setF((p) => ({ ...p, angle: a }))}
        options={ANGLE_KEYS.map((a) => ({ key: a, text: A_ANGLE[a].text, title: A_ANGLE[a].ask }))}
      />
      {f.angle && A_ANGLE[f.angle].ask && (
        <div style={{ color: colors.textSecondary }}>{A_ANGLE[f.angle].ask}</div>
      )}
      <Label colors={colors}>ข้อโต้แย้ง — เหตุผลที่ข้อที่เชื่ออาจผิด</Label>
      <textarea
        className={FIELD}
        style={style}
        rows={2}
        value={f.argument}
        onChange={set("argument")}
      />
      <Label colors={colors}>ถ้าข้อโต้แย้งนี้จริง เราจะเห็นอะไร</Label>
      <textarea
        className={FIELD}
        style={style}
        rows={2}
        value={f.would_see}
        onChange={set("would_see")}
      />
      <Label colors={colors}>ไปดูที่ไหน</Label>
      <textarea
        className={FIELD}
        style={style}
        rows={1}
        value={f.look_where}
        onChange={set("look_where")}
        placeholder="เอกสาร ตาราง หรือเครื่องมือที่ใช้ดึง"
      />
      <Errors lines={err} />
      <Buttons
        colors={colors}
        busy={busy}
        onSave={() =>
          void submit(`${ANTI_API}/${claim.id}/objections`, "POST", {
            ...f,
            angle: f.angle || "OTHER",
            parent: parent?.id ?? null,
          })
        }
        onCancel={onCancel}
      />
    </Form>
  );
}

function SweepForm({ colors, claim, onDone, onCancel }: FormProps & { claim: AClaim }) {
  const [angle, setAngle] = useState<AAngle | "">(claim.state.untried[0] ?? "");
  const [searched, setSearched] = useState("");
  const { err, busy, submit } = useSubmit(onDone);
  return (
    <Form title={`ค้นแล้วไม่พบข้อโต้แย้ง — ${claim.ref}`} colors={colors}>
      <Label colors={colors}>มุม</Label>
      <Pick
        colors={colors}
        value={angle}
        onPick={setAngle}
        options={claim.state.untried.map((a) => ({
          key: a,
          text: A_ANGLE[a].text,
          title: A_ANGLE[a].ask,
        }))}
      />
      {angle && <div style={{ color: colors.textSecondary }}>{A_ANGLE[angle].ask}</div>}
      <Label colors={colors}>ค้นที่ไหน หาอะไร — มุมที่ไม่ได้ค้นไม่นับว่าสะอาด</Label>
      <textarea
        className={FIELD}
        style={fieldOf(colors)}
        rows={2}
        value={searched}
        onChange={(e) => setSearched(e.target.value)}
      />
      <Errors lines={err} />
      <Buttons
        colors={colors}
        busy={busy}
        onSave={() => void submit(`${ANTI_API}/${claim.id}/sweeps`, "POST", { angle, searched })}
        onCancel={onCancel}
      />
    </Form>
  );
}

function VerdictForm({
  colors,
  claim,
  objection: o,
  onDone,
  onCancel,
}: FormProps & { claim: AClaim; objection: AObjection }) {
  const [f, setF] = useState({
    result: "" as AResult | "",
    reasoning: "",
    evidence: "",
    searched: "",
    next_check: "",
    consequence: "" as "REVISE" | "FALLS" | "",
    revised_statement: "",
    revised_negation: "",
  });
  const { err, busy, submit } = useSubmit(onDone);
  const style = fieldOf(colors);
  const dim = { color: colors.textSecondary };
  const set =
    (
      k:
        | "reasoning"
        | "evidence"
        | "searched"
        | "next_check"
        | "revised_statement"
        | "revised_negation"
    ) =>
    (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }));

  const save = () => {
    const conceded = f.result === "CONCEDED";
    const revise = conceded && f.consequence === "REVISE";
    void submit(`${ANTI_API}/objections/${o.id}/verdicts`, "POST", {
      result: f.result,
      reasoning: f.reasoning,
      evidence: f.evidence
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean),
      searched: f.searched,
      next_check: f.result === "UNDECIDED" ? f.next_check || null : null,
      consequence: conceded ? f.consequence || null : null,
      revised_statement: revise ? f.revised_statement : "",
      revised_negation: revise ? f.revised_negation : "",
    });
  };

  return (
    <Form title={`ตัดสิน ${o.ref}`} colors={colors}>
      <div style={dim}>
        {claim.ref} เราเชื่อ: {claim.statement}
      </div>
      <div style={dim}>
        {o.ref} โต้แย้ง: {o.argument}
        {o.would_see && ` — ถ้าจริงจะเห็น: ${o.would_see}`}
      </div>
      <Label colors={colors}>ผล</Label>
      <Pick
        colors={colors}
        value={f.result}
        onPick={(result) => setF((p) => ({ ...p, result }))}
        options={(Object.keys(A_RESULT) as AResult[]).map((k) => ({ key: k, text: A_RESULT[k] }))}
      />
      <Label colors={colors}>เหตุผล</Label>
      <textarea
        className={FIELD}
        style={style}
        rows={3}
        value={f.reasoning}
        onChange={set("reasoning")}
      />

      {f.result === "REBUTTED" && (
        <>
          <Label colors={colors}>หลักฐาน — Z-REF คั่นด้วยจุลภาค (ต้องมี URL + ประโยคที่อ้าง)</Label>
          <input
            className={FIELD}
            style={style}
            value={f.evidence}
            onChange={set("evidence")}
            placeholder="Z-0012, Z-0040"
          />
          <div style={dim}>ปัดข้อโต้แย้งตกด้วยความเชื่อไม่ได้ — หลักฐานอยู่ในแท็บ KB</div>
        </>
      )}
      {f.result === "CONCEDED" && (
        <>
          <Label colors={colors}>แล้วข้อที่เชื่อเป็นอย่างไร</Label>
          <Pick
            colors={colors}
            value={f.consequence}
            onPick={(consequence) => setF((p) => ({ ...p, consequence }))}
            options={[
              { key: "REVISE", text: "แก้ให้แคบลง — เขียนข้อใหม่แทน" },
              { key: "FALLS", text: "ล้ม — เลิกเชื่อข้อนี้" },
            ]}
          />
          {f.consequence === "REVISE" && (
            <>
              <Label colors={colors}>ข้อที่เชื่อ ฉบับใหม่ (จะเริ่มจากยังไม่เคยถูกท้า)</Label>
              <textarea
                className={FIELD}
                style={style}
                rows={2}
                value={f.revised_statement}
                onChange={set("revised_statement")}
              />
              <Label colors={colors}>ถ้าไม่จริง</Label>
              <textarea
                className={FIELD}
                style={style}
                rows={2}
                value={f.revised_negation}
                onChange={set("revised_negation")}
              />
            </>
          )}
          {f.consequence === "FALLS" && claim.stake === "KEY" && (
            <div style={{ color: "#f87171" }}>
              นี่คือข้อหลัก — เมื่อล้ม thesis ต้องทบทวน ระบบจะไม่แก้ thesis ให้เอง
            </div>
          )}
        </>
      )}
      {f.result === "UNDECIDED" && (
        <>
          <Label colors={colors}>ค้นที่ไหนแล้ว</Label>
          <textarea
            className={FIELD}
            style={style}
            rows={2}
            value={f.searched}
            onChange={set("searched")}
          />
          <Label colors={colors}>ดูอีกครั้งวันไหน</Label>
          <input
            type="date"
            className={FIELD}
            style={style}
            value={f.next_check}
            onChange={set("next_check")}
          />
        </>
      )}
      {f.result !== "REBUTTED" && f.result !== "" && (
        <>
          <Label colors={colors}>หลักฐาน — Z-REF (ไม่บังคับ)</Label>
          <input className={FIELD} style={style} value={f.evidence} onChange={set("evidence")} />
        </>
      )}
      <Errors lines={err} />
      <Buttons colors={colors} busy={busy} onSave={save} onCancel={onCancel} />
    </Form>
  );
}

function ReasonForm({
  colors,
  title,
  hint,
  url,
  body,
  onDone,
  onCancel,
}: FormProps & {
  title: string;
  hint: string;
  url: string;
  body: (text: string) => Record<string, unknown>;
}) {
  const [text, setText] = useState("");
  const { err, busy, submit } = useSubmit(onDone);
  return (
    <Form title={title} colors={colors}>
      <Label colors={colors}>{hint}</Label>
      <textarea
        className={FIELD}
        style={fieldOf(colors)}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Errors lines={err} />
      <Buttons
        colors={colors}
        busy={busy}
        onSave={() => void submit(url, "POST", body(text))}
        onCancel={onCancel}
      />
    </Form>
  );
}
