"use client";

// DEPOSITS — money a member puts into the fund. A deposit is turned into units
// at the fund's value per unit just before the money arrived; the server does
// the sums and PREVIEW shows them before anything is kept. Rows are never
// edited: a mistake is reversed, and the reversal is a row of its own.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type Colors, fmtAmt, fmtPx, fmtQty } from "../portfolio/helpers";
import { NumInput } from "../portfolio/ui/NumInput";
import { type AttachedSlip, SlipBox } from "./SlipBox";
import {
  type Contribution,
  type ContributionIn,
  type FundDetail,
  type FundMember,
  fundApi,
  num,
} from "./api";

const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const SOURCE: Record<Contribution["price_source"], string> = {
  par: "ราคาเริ่มต้นของกอง",
  live: "มูลค่ากองตามราคาตลาดตอนบันทึก",
  snapshot: "มูลค่ากองที่เก็บไว้ของวันนั้น",
  manual: "กรอกเอง",
};

const n2 = (v: string | null) => {
  const n = num(v);
  return n == null ? "—" : fmtAmt(n);
};

export function DepositsPage({
  colors,
  fund,
  members,
  onChanged,
  onOpenEntry,
}: {
  colors: Colors;
  fund: FundDetail;
  members: FundMember[];
  onChanged: () => void;
  /** A broker order slip was dropped on the slip box → the fund's ENTRY page. */
  onOpenEntry?: () => void;
}) {
  const [memberId, setMemberId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [fx, setFx] = useState("");
  const [evidence, setEvidence] = useState("");
  const [note, setNote] = useState("");
  const [manual, setManual] = useState(false);
  const [unitPrice, setUnitPrice] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Contribution | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // The transfer slip the deposit is made with (optional): its fields as the
  // user left them go with the deposit.
  const [slip, setSlip] = useState<AttachedSlip | null>(null);
  const [reversing, setReversing] = useState<string | null>(null);
  const [reverseReason, setReverseReason] = useState("");

  const listQ = useQuery({
    queryKey: ["fund", fund.id, "contributions"],
    queryFn: () => fundApi.contributions(fund.id),
    staleTime: 30_000,
  });

  const member = memberId || members[0]?.id || "";
  const account = fund.accounts.find((a) => a.id === (accountId || fund.accounts[0]?.id));
  const needsFx = !!account && account.currency !== "THB";
  const memberName = (id: string) => members.find((m) => m.id === id)?.name ?? id;

  const body = (): ContributionIn => ({
    member_id: member,
    account_id: account?.id ?? "",
    date,
    amount,
    currency: account?.currency,
    ...(needsFx ? { fx_rate: fx } : {}),
    ...(manual ? { unit_price: unitPrice, price_reason: reason } : {}),
    evidence_ref: evidence,
    note,
    ...(slip ? { slip: { sha256: slip.sha256, bank: slip.bank, ...slip.fields } } : {}),
  });
  const ready = !!member && !!account && !!date && Number(amount) > 0;

  // Any change to the form makes the shown preview a preview of something else.
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPreview(null);
      setErr("");
    };

  const run = async (write: boolean) => {
    setBusy(true);
    setErr("");
    try {
      if (write) {
        await fundApi.contribute(fund.id, body());
        setAmount("");
        setEvidence("");
        setNote("");
        setUnitPrice("");
        setReason("");
        setManual(false);
        setPreview(null);
        setSlip(null);
        listQ.refetch();
        onChanged();
      } else {
        setPreview(await fundApi.preview(fund.id, body()));
      }
    } catch (e) {
      setPreview(null);
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reverse = async (id: string) => {
    setBusy(true);
    setErr("");
    try {
      await fundApi.reverse(fund.id, id, reverseReason);
      setReversing(null);
      setReverseReason("");
      listQ.refetch();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const input = "px-2 py-1 text-[11px] border bg-transparent";
  const label = "flex flex-col gap-1";
  const dim = { color: colors.textSecondary };
  const box = { borderColor: colors.border, color: colors.text };
  const th = "text-right px-2 py-1 font-normal";
  const td = "text-right px-2 py-1 tabular-nums";
  const rows = listQ.data?.contributions ?? [];

  if (members.length === 0)
    return (
      <div className="p-3 text-[11px]" style={dim}>
        ยังไม่มีสมาชิก เพิ่มสมาชิกในหน้า MEMBERS ก่อนรับเงินเข้า
      </div>
    );
  if (fund.accounts.length === 0)
    return (
      <div className="p-3 text-[11px]" style={dim}>
        กองนี้ยังไม่มีบัญชีโบรก เพิ่มบัญชีในหน้า SETUP ก่อนรับเงินเข้า
      </div>
    );

  return (
    <div className="p-2 text-[11px]">
      <div className="text-[10px] font-bold mb-1" style={{ color: colors.accent }}>
        รับเงินเข้า
      </div>
      <SlipBox
        colors={colors}
        fundId={fund.id}
        slip={slip}
        onOpenEntry={onOpenEntry}
        onChange={(next, filled) => {
          setSlip(next);
          setPreview(null);
          setErr("");
          // A freshly read slip fills the form; the user still checks it.
          if (filled) {
            if (filled.amount) setAmount(filled.amount);
            if (filled.date) setDate(filled.date);
            if (filled.ref) setEvidence(filled.ref);
          }
        }}
      />
      <div className="flex flex-wrap items-end gap-2">
        <label className={label}>
          <span style={dim}>สมาชิก</span>
          <select
            value={member}
            onChange={(e) => edit(setMemberId)(e.target.value)}
            className={input}
            style={{ borderColor: colors.border }}
          >
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          <span style={dim}>เข้าบัญชี</span>
          <select
            value={account?.id ?? ""}
            onChange={(e) => edit(setAccountId)(e.target.value)}
            className={input}
            style={{ borderColor: colors.border }}
          >
            {fund.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.currency})
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          <span style={dim}>วันที่เงินเข้า</span>
          <input
            type="date"
            value={date}
            max={today()}
            onChange={(e) => edit(setDate)(e.target.value)}
            className={input}
            style={box}
          />
        </label>
        <div className={label}>
          <span style={dim}>จำนวน ({account?.currency})</span>
          <NumInput
            value={amount}
            onChange={(e) => edit(setAmount)(e.target.value)}
            className={`${input} w-36 text-right`}
            style={box}
          />
        </div>
        {needsFx && (
          <div className={label}>
            <span style={dim}>บาทต่อ 1 {account?.currency} ของวันนั้น</span>
            <NumInput
              value={fx}
              onChange={(e) => edit(setFx)(e.target.value)}
              className={`${input} w-24 text-right`}
              style={box}
            />
          </div>
        )}
        <label className={label}>
          <span style={dim}>หลักฐาน (เลขสลิป / ไฟล์)</span>
          <input
            value={evidence}
            onChange={(e) => edit(setEvidence)(e.target.value)}
            className={`${input} w-44`}
            style={box}
          />
        </label>
        <label className={label}>
          <span style={dim}>หมายเหตุ</span>
          <input
            value={note}
            onChange={(e) => edit(setNote)(e.target.value)}
            className={`${input} w-44`}
            style={box}
          />
        </label>
      </div>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <button
          type="button"
          aria-pressed={manual}
          onClick={() => edit(setManual)(!manual)}
          className="px-2 py-1 text-[10px] border"
          style={{
            borderColor: manual ? colors.accentWarn : colors.border,
            color: manual ? colors.accentWarn : colors.textSecondary,
          }}
        >
          กรอกราคาต่อหน่วยเอง
        </button>
        {manual && (
          <>
            <div className={label}>
              <span style={dim}>ราคาต่อหน่วย ({fund.base_currency})</span>
              <NumInput
                value={unitPrice}
                onChange={(e) => edit(setUnitPrice)(e.target.value)}
                className={`${input} w-28 text-right`}
                style={box}
              />
            </div>
            <label className={label}>
              <span style={dim}>เหตุผล (ต้องมี)</span>
              <input
                value={reason}
                onChange={(e) => edit(setReason)(e.target.value)}
                className={`${input} w-72`}
                style={box}
              />
            </label>
          </>
        )}
        <button
          type="button"
          disabled={busy || !ready}
          onClick={() => run(false)}
          className="px-3 py-1 text-[10px] font-bold border disabled:opacity-40"
          style={{ borderColor: colors.border, color: colors.text }}
        >
          PREVIEW
        </button>
        <button
          type="button"
          disabled={busy || !preview}
          onClick={() => run(true)}
          title={preview ? undefined : "กด PREVIEW ก่อน เพื่อดูราคาต่อหน่วยและหน่วยที่จะได้"}
          className="px-3 py-1 text-[10px] font-bold border disabled:opacity-40"
          style={{ borderColor: colors.accent, color: colors.accent }}
        >
          บันทึกเงินเข้า
        </button>
      </div>

      {preview && (
        <div
          className="mt-2 p-2 border text-[11px] max-w-3xl"
          style={{ borderColor: colors.accent }}
        >
          <b>{memberName(preview.member_id)}</b> ลง {n2(preview.amount)} {preview.currency}
          {preview.currency !== fund.base_currency && (
            <>
              {" "}
              = {n2(preview.amount_base)} {fund.base_currency}
            </>
          )}{" "}
          · ราคาต่อหน่วย <b>{fmtPx(Number(preview.unit_price))}</b> ({SOURCE[preview.price_source]}
          {preview.nav_before != null && preview.price_source !== "par" && (
            <>
              : มูลค่ากองก่อนเงินเข้า {n2(preview.nav_before)} ÷ {fmtQty(Number(preview.units_before))}{" "}
              หน่วย
            </>
          )}
          ) · ได้ <b>{fmtQty(Number(preview.units_issued))}</b> หน่วย
        </div>
      )}
      {err && (
        <div className="mt-2" style={{ color: colors.negative }}>
          {err}
        </div>
      )}

      <div className="text-[10px] font-bold mt-4 mb-1" style={{ color: colors.accent }}>
        รายการเงินเข้า ({rows.length})
      </div>
      {listQ.isLoading && <div style={dim}>กำลังโหลด…</div>}
      {!listQ.isLoading && rows.length === 0 && <div style={dim}>ยังไม่มีรายการ</div>}
      {rows.length > 0 && (
        <table className="w-full border-collapse">
          <thead>
            <tr style={{ ...dim, borderBottom: `1px solid ${colors.border}` }}>
              <th className="text-left px-2 py-1 font-normal">วันที่</th>
              <th className="text-left px-2 py-1 font-normal">สมาชิก</th>
              <th className="text-left px-2 py-1 font-normal">บัญชี</th>
              <th className={th}>จำนวน</th>
              <th className={th}>เป็น {fund.base_currency}</th>
              <th className={th}>ราคาต่อหน่วย</th>
              <th className={th}>หน่วย</th>
              <th className="text-left px-2 py-1 font-normal">ที่มาของราคา</th>
              <th className="text-left px-2 py-1 font-normal">หลักฐาน / หมายเหตุ</th>
              <th className="px-2 py-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isReversal = !!r.reverses_id;
              const struck = r.reversed || isReversal;
              return (
                <tr
                  key={r.id}
                  style={{
                    borderBottom: `1px solid ${colors.borderFaint}`,
                    color: struck ? colors.textDimmed : colors.text,
                  }}
                >
                  <td className="px-2 py-1">{r.date}</td>
                  <td className="px-2 py-1">{memberName(r.member_id)}</td>
                  <td className="px-2 py-1">{r.account_id}</td>
                  <td className={td}>
                    {n2(r.amount)} {r.currency}
                  </td>
                  <td className={td}>{n2(r.amount_base)}</td>
                  <td className={td}>{fmtPx(Number(r.unit_price))}</td>
                  <td className={td}>{fmtQty(Number(r.units_issued))}</td>
                  <td className="px-2 py-1">
                    {isReversal ? "กลับรายการ" : SOURCE[r.price_source]}
                    {r.price_reason && !isReversal ? ` — ${r.price_reason}` : ""}
                  </td>
                  <td className="px-2 py-1">
                    {r.slip && (
                      <a
                        href={fundApi.slipImage(fund.id, r.slip.sha256)}
                        target="_blank"
                        rel="noreferrer"
                        className="underline mr-1"
                        style={{ color: colors.accentBlue }}
                        title={[
                          r.slip.transferred_at?.replace("T", " "),
                          r.slip.from_name &&
                            `จาก ${r.slip.from_name} ${r.slip.from_account ?? ""}`,
                          r.slip.to_name && `ไปยัง ${r.slip.to_name} ${r.slip.to_account ?? ""}`,
                          r.slip.memo && `บันทึก: ${r.slip.memo}`,
                        ]
                          .filter(Boolean)
                          .join("\n")}
                      >
                        สลิป{r.slip.from_name ? ` · ${r.slip.from_name}` : ""}
                      </a>
                    )}
                    {[r.evidence_ref, r.note].filter(Boolean).join(" · ")}
                    {r.reversed && " (ถูกกลับรายการแล้ว)"}
                  </td>
                  <td className="px-2 py-1 text-right whitespace-nowrap">
                    {!struck &&
                      (reversing === r.id ? (
                        <span className="inline-flex items-center gap-1">
                          <input
                            value={reverseReason}
                            onChange={(e) => setReverseReason(e.target.value)}
                            placeholder="เหตุผลที่กลับรายการ"
                            className={`${input} w-48`}
                            style={box}
                          />
                          <button
                            type="button"
                            disabled={busy || !reverseReason.trim()}
                            onClick={() => reverse(r.id)}
                            className="px-2 py-1 text-[10px] font-bold border disabled:opacity-40"
                            style={{ borderColor: colors.negative, color: colors.negative }}
                          >
                            ยืนยัน
                          </button>
                          <button
                            type="button"
                            onClick={() => setReversing(null)}
                            className="px-1 text-[10px]"
                            style={dim}
                          >
                            ยกเลิก
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setReversing(r.id);
                            setReverseReason("");
                            setErr("");
                          }}
                          className="px-2 py-1 text-[10px] border"
                          style={{ borderColor: colors.border, color: colors.textSecondary }}
                        >
                          กลับรายการ
                        </button>
                      ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
