"use client";

import type { Auction, BondIssuance, BondKpi, Deal, EventStudy } from "./types";
import { C, Panel, bpColor, fmtBp } from "./ui";

// ── KPI strip ─────────────────────────────────────────────────────────────────

export function KpiStrip({ kpis }: { kpis: BondKpi[] }) {
  return (
    <div
      className="grid gap-px"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))", background: C.border }}
    >
      {kpis.map((k) => (
        <div
          key={k.id}
          className="flex flex-col px-2 py-1 bg-black"
          title={`${k.fred_id ?? "derived"} · as of ${k.asOf ?? "—"} · 1Y percentile ${k.pctile_1y ?? "—"}`}
        >
          <span style={{ color: C.label, fontSize: 9, letterSpacing: "0.08em" }}>{k.label}</span>
          <div className="flex items-baseline gap-1.5">
            <span style={{ color: C.amber, fontSize: 15 }}>
              {k.value == null ? "—" : `${k.value.toFixed(2)}%`}
            </span>
            <span style={{ color: bpColor(k.chg1d_bp), fontSize: 10 }}>{fmtBp(k.chg1d_bp)}</span>
          </div>
          <div className="flex gap-2" style={{ fontSize: 9, color: C.dim }}>
            <span>
              5D <span style={{ color: bpColor(k.chg5d_bp) }}>{fmtBp(k.chg5d_bp)}</span>
            </span>
            <span>
              20D <span style={{ color: bpColor(k.chg20d_bp) }}>{fmtBp(k.chg20d_bp)}</span>
            </span>
            {k.pctile_1y != null && <span className="ml-auto">P{k.pctile_1y}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Event study ───────────────────────────────────────────────────────────────

const H_LABEL: Record<number, string> = { 0: "t", 1: "t+1", 3: "t+3" };

export function EventStudyPanel({
  es,
  backfill,
}: { es: EventStudy; backfill: BondIssuance["backfill"] }) {
  return (
    <Panel
      title="EVENT STUDY"
      note={
        es.ready
          ? `heavy day = ≥${es.threshold} deals · ${es.n_event} vs ${es.n_other} days`
          : undefined
      }
    >
      {!es.ready ? (
        <span style={{ color: C.dim, fontSize: 10 }}>
          {es.note} ({backfill.days_stored}/{backfill.days_total})
        </span>
      ) : (
        <>
          <div
            className="grid"
            style={{
              gridTemplateColumns: "1fr 42px 58px 58px 52px 40px",
              fontSize: 9,
              color: C.dim,
              columnGap: 6,
            }}
          >
            <span>Δ from t−1 close</span>
            <span className="text-right">TO</span>
            <span className="text-right">HEAVY bp</span>
            <span className="text-right">OTHER bp</span>
            <span className="text-right">DIFF</span>
            <span className="text-right">t</span>
          </div>
          {es.rows?.map((r) => {
            const sig = r.t != null && Math.abs(r.t) >= 2;
            return (
              <div
                key={`${r.series}-${r.h}`}
                className="grid"
                style={{
                  gridTemplateColumns: "1fr 42px 58px 58px 52px 40px",
                  fontSize: 10.5,
                  columnGap: 6,
                }}
              >
                <span style={{ color: "#aaa" }}>
                  {r.series === "UST10Y" ? "UST 10Y" : "IG OAS"}
                </span>
                <span className="text-right" style={{ color: C.dim }}>
                  {H_LABEL[r.h] ?? `t+${r.h}`}
                </span>
                <span className="text-right" style={{ color: bpColor(r.event_mean_bp) }}>
                  {fmtBp(r.event_mean_bp, 1)}
                </span>
                <span className="text-right" style={{ color: bpColor(r.other_mean_bp) }}>
                  {fmtBp(r.other_mean_bp, 1)}
                </span>
                <span className="text-right" style={{ color: bpColor(r.diff_bp) }}>
                  {fmtBp(r.diff_bp, 1)}
                </span>
                <span className="text-right" style={{ color: sig ? C.amber : "#666" }}>
                  {r.t == null ? "—" : r.t.toFixed(1)}
                </span>
              </div>
            );
          })}
          {es.weekly_corr && (
            <div style={{ fontSize: 9.5, color: C.dim, paddingTop: 3 }}>
              WEEKLY corr(deals, Δ):{" "}
              {(["UST10Y", "IG_OAS"] as const).map((k) => (
                <span key={k} className="mr-3">
                  {k === "UST10Y" ? "10Y" : "IG OAS"}{" "}
                  <span style={{ color: "#bbb" }}>{es.weekly_corr?.[k].r?.toFixed(2) ?? "—"}</span>
                  <span style={{ color: "#444" }}> n={es.weekly_corr?.[k].n}</span>
                </span>
              ))}
            </div>
          )}
          <span style={{ color: "#6a6a6a", fontSize: 9 }}>{es.note}</span>
        </>
      )}
    </Panel>
  );
}

// ── Recent deals ──────────────────────────────────────────────────────────────

export function DealsPanel({ deals, method }: { deals: Deal[]; method: BondIssuance["method"] }) {
  return (
    <Panel title="RECENT DEALS" note={`ex-bank · ${method.forms.join("/")}`}>
      <div className="overflow-y-auto" style={{ maxHeight: 300 }}>
        {deals.length === 0 && (
          <span style={{ color: C.dim, fontSize: 10 }}>ยังไม่มีข้อมูล — backfill กำลังดึงจาก EDGAR</span>
        )}
        {deals.map((d) => (
          <div
            key={d.adsh}
            className="grid items-baseline"
            style={{ gridTemplateColumns: "44px 1fr 44px 34px", fontSize: 10.5, columnGap: 6 }}
          >
            <span style={{ color: C.dim }}>{d.file_date.slice(5)}</span>
            {d.url ? (
              <a
                href={d.url}
                target="_blank"
                rel="noreferrer"
                className="truncate hover:underline"
                style={{ color: "#ccc" }}
                title={`${d.issuer} · SIC ${d.sic || "—"} · ${d.adsh}`}
              >
                {d.issuer}
                {d.filings > 1 && <span style={{ color: "#666" }}> ×{d.filings}</span>}
              </a>
            ) : (
              <span className="truncate" style={{ color: "#ccc" }}>
                {d.issuer}
              </span>
            )}
            <span style={{ color: "#666", fontSize: 9 }}>{d.form}</span>
            <span style={{ color: d.category === "FIN" ? "#6b8fc7" : "#3B82F6", fontSize: 9 }}>
              {d.category === "FIN" ? "FIN" : "NFC"}
            </span>
          </div>
        ))}
      </div>
      <span style={{ color: "#555", fontSize: 9 }}>{method.caveat}</span>
    </Panel>
  );
}

// ── Treasury auctions ─────────────────────────────────────────────────────────

const AUCTION_COLS = "46px 1fr 44px 50px 40px 40px 40px";

function AuctionRow({ a }: { a: Auction }) {
  const coupon = a.type !== "Bill" && a.type !== "CMB";
  return (
    <div
      className="grid items-baseline"
      style={{ gridTemplateColumns: AUCTION_COLS, fontSize: 10.5, columnGap: 6 }}
    >
      <span style={{ color: C.dim }}>{a.auction_date.slice(5)}</span>
      <span className="truncate" style={{ color: coupon ? "#F59E0B" : "#999" }}>
        {a.term}
        {a.type !== "Note" && a.type !== "Bond" && a.type !== "Bill" ? ` ${a.type}` : ""}
        {a.reopening ? " r" : ""}
      </span>
      <span className="text-right" style={{ color: "#bbb" }}>
        {a.offering_bn ?? "—"}
      </span>
      <span className="text-right" style={{ color: C.amber }}>
        {a.high_yield != null ? a.high_yield.toFixed(3) : "—"}
      </span>
      <span className="text-right" style={{ color: "#aaa" }}>
        {a.bid_to_cover != null ? a.bid_to_cover.toFixed(2) : "—"}
      </span>
      <span className="text-right" style={{ color: (a.dealer_pct ?? 0) > 20 ? C.up : "#888" }}>
        {a.dealer_pct != null ? a.dealer_pct.toFixed(0) : "—"}
      </span>
      <span className="text-right" style={{ color: "#888" }}>
        {a.indirect_pct != null ? a.indirect_pct.toFixed(0) : "—"}
      </span>
    </div>
  );
}

export function AuctionsTable({
  upcoming,
  recent,
  couponsOnly,
}: {
  upcoming: Auction[];
  recent: Auction[];
  couponsOnly: boolean;
}) {
  const keep = (a: Auction) => !couponsOnly || (a.type !== "Bill" && a.type !== "CMB");
  const up = upcoming.filter(keep);
  const past = recent.filter(keep);
  return (
    <div className="flex flex-col gap-0.5">
      <div
        className="grid"
        style={{ gridTemplateColumns: AUCTION_COLS, fontSize: 9, color: C.dim, columnGap: 6 }}
      >
        <span>DATE</span>
        <span>TERM</span>
        <span className="text-right">$BN</span>
        <span className="text-right">HIGH Y</span>
        <span className="text-right">BTC</span>
        <span className="text-right" title="Primary dealer takedown, % of competitive">
          DLR%
        </span>
        <span
          className="text-right"
          title="Indirect bidders (foreign/official proxy), % of competitive"
        >
          IND%
        </span>
      </div>
      {up.length > 0 && (
        <>
          <span style={{ color: C.label, fontSize: 9, paddingTop: 2 }}>ANNOUNCED</span>
          {up.map((a) => (
            <AuctionRow key={`u-${a.auction_date}-${a.term}-${a.type}`} a={a} />
          ))}
          <span style={{ color: C.label, fontSize: 9, paddingTop: 2 }}>RESULTS</span>
        </>
      )}
      <div className="overflow-y-auto" style={{ maxHeight: 220 }}>
        {past.map((a) => (
          <AuctionRow key={`r-${a.auction_date}-${a.term}-${a.type}`} a={a} />
        ))}
      </div>
    </div>
  );
}
