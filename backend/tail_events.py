"""
Market event classifier for TAIL — names what is happening, not which gauge lit.

The six risk dimensions answer "which kind of risk is elevated?". They cannot
answer "what just happened?", and on 2026-09-23 that gap was the whole story:
MOVE jumped 17.5% in one session, the 10Y broke 5%, stocks, bonds and gold fell
together and the dollar rose — and every dimension read NORMAL, because each
dimension needs two of its own signals and every signal measured a *level*
against its recent range, never the size of the move itself.

This module reads *moves*. Each input is scored as the z of its 1-session and
5-session change against its own trailing year of changes (never of its level —
see gotchas "z of level vs z of change"), and a rule book turns co-moving
shocks into a named, formally-defined market event:

    Rates Volatility Shock · Treasury Selloff — Bear Steepening · Flight to Quality ·
    Stock–Bond Joint Drawdown · Credit Spread Widening · US Dollar Liquidity Squeeze ·
    Yen Carry-Trade Unwind · Oil Supply Shock · …

Every event carries the evidence that raised it (trigger), the evidence that
agreed (confirm) and the readings that were checked and did not agree (context),
so a reader can see *why* a name was chosen and argue with it.

Pure functions over a DataFrame — no I/O. `routers/tail_risk.py` builds the
panel and calls `run()`. Nothing here is backtested; the payload says so.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date

import numpy as np
import pandas as pd

SEVERITIES = ("WATCH", "ACTIVE", "SEVERE")
SEV_RANK = {s: i + 1 for i, s in enumerate(SEVERITIES)}

#: A move this many sigmas from its trailing-year distribution is an event.
TRIGGER_Z = 2.0
#: A second input moving this far the same way counts as confirmation.
CONFIRM_Z = 1.5
#: Trailing distribution of changes. min_periods keeps a young series quiet
#: rather than scoring it against a handful of bars.
Z_WINDOW, Z_MIN = 252, 120
#: SKEW level that counts on its own, whatever its recent range.
SKEW_EXTREME = 160.0

#: How each input's move is measured. Prices and vol indices move in proportion
#: to their level (log change, shown in %); yields and spreads in basis points;
#: SKEW and the weekly stress indices are already on an additive scale.
KIND: dict[str, str] = {
    "SPY": "log", "QQQ": "log", "TLT": "log", "GLD": "log", "HYG": "log",
    "DXY": "log", "USDJPY": "log", "CRUDE": "log",
    "VIX": "log", "VIX3M": "log", "MOVE": "log", "VVIX": "log", "OVX": "log",
    "GVZ": "log", "VXN": "log", "SKEW": "diff",
    "UST3M": "bp", "UST5Y": "bp", "UST10Y": "bp", "UST30Y": "bp",
    "HY_OAS": "bp", "IG_OAS": "bp", "BE10": "bp",
    "STL_FSI": "diff", "NFCI": "diff",
    "SPY_VOL": "log",
    # Real yields (TIPS) and the 5Y breakeven — nominal = real + breakeven.
    "REAL5": "bp", "REAL10": "bp", "BE5": "bp",
    # Energy complex. Cracks are $/bbl margins that can sit near zero, so a
    # dollar difference, not a log change.
    "BRENT": "log", "HO": "log", "RB": "log",
    "DIESEL_CRACK": "diff", "GAS_CRACK": "diff", "CRACK_321": "diff", "BRENT_WTI": "diff",
}

LABEL: dict[str, str] = {
    "SPY": "S&P 500 (SPY)", "QQQ": "Nasdaq-100 (QQQ)", "TLT": "20Y+ Treasuries (TLT)",
    "GLD": "Gold (GLD)", "HYG": "High-yield bonds (HYG)", "DXY": "US Dollar Index",
    "USDJPY": "USD/JPY", "CRUDE": "WTI crude", "VIX": "VIX", "VIX3M": "VIX3M",
    "MOVE": "MOVE (Treasury implied vol)", "VVIX": "VVIX", "OVX": "OVX (oil vol)",
    "GVZ": "GVZ (gold vol)", "VXN": "VXN (Nasdaq vol)", "SKEW": "CBOE SKEW",
    "UST3M": "UST 3M", "UST5Y": "UST 5Y", "UST10Y": "UST 10Y", "UST30Y": "UST 30Y",
    "HY_OAS": "US HY OAS", "IG_OAS": "US IG OAS", "BE10": "10Y breakeven inflation",
    "STL_FSI": "St. Louis Fed FSI", "NFCI": "Chicago Fed NFCI", "SPY_VOL": "SPY volume",
    "REAL5": "5Y real yield (TIPS)", "REAL10": "10Y real yield (TIPS)",
    "BE5": "5Y breakeven inflation", "BRENT": "Brent crude", "HO": "ULSD / heating oil",
    "RB": "RBOB gasoline", "DIESEL_CRACK": "Diesel crack (HO − WTI)",
    "GAS_CRACK": "Gasoline crack (RB − WTI)", "CRACK_321": "3-2-1 crack spread",
    "BRENT_WTI": "Brent − WTI spread",
}

#: Units for inputs whose KIND does not say it ($/bbl spreads).
UNIT_OVERRIDE = {"DIESEL_CRACK": "$", "GAS_CRACK": "$", "CRACK_321": "$", "BRENT_WTI": "$"}

#: Slow series (FRED daily with a one-day lag, weekly stress indices) are read
#: as-of the evaluation date within this many calendar days instead of needing
#: a bar on that exact date.
ASOF_LAG_DAYS = {"HY_OAS": 5, "IG_OAS": 5, "BE10": 5, "BE5": 5, "REAL5": 5, "REAL10": 5,
                 "STL_FSI": 12, "NFCI": 12}

#: Channels group events for the composite: a rates-vol shock and a bear
#: steepener on the same day are one observation about the rates channel.
CHANNEL_LABEL = {
    "rates": "RATES", "equity_vol": "EQUITY VOL", "equity": "EQUITY",
    "cross_asset": "CROSS-ASSET", "credit": "CREDIT", "fx": "FX", "commodities": "COMMODITIES",
}


# ─── Readings ─────────────────────────────────────────────────────────────────


@dataclass
class Reading:
    key: str
    value: float | None
    chg1: float | None      # % for log kinds, bp for bp kinds, raw otherwise
    chg5: float | None
    z1: float | None
    z5: float | None
    lz63: float | None      # z of the LEVEL over 63 sessions — context only
    date: str | None

    def strongest(self, sign: int) -> tuple[float | None, int]:
        """Largest move in `sign` direction (+1 up, −1 down, 0 either) across
        the 1- and 5-session horizons, as a positive number, plus the horizon."""
        best, hz = None, 1
        for z, h in ((self.z1, 1), (self.z5, 5)):
            if z is None:
                continue
            v = abs(z) if sign == 0 else sign * z
            if best is None or v > best:
                best, hz = v, h
        return best, hz

    def change(self, horizon: int) -> float | None:
        return self.chg1 if horizon == 1 else self.chg5


def _unit(key: str) -> str:
    if key in UNIT_OVERRIDE:
        return UNIT_OVERRIDE[key]
    k = KIND.get(key, "diff")
    return "%" if k == "log" else "bp" if k == "bp" else ""


def _changes(s: pd.Series, kind: str, horizon: int) -> pd.Series:
    """Change against the previous *observed* bar. The series is never
    forward-filled first: a filled gap would read as a zero move and then land
    the whole move on the day the feed resumed, as a two-day change."""
    s = s.dropna()
    s = s[s > 0] if kind == "log" else s
    if kind == "log":
        return np.log(s).diff(horizon) * 100
    if kind == "bp":
        return s.diff(horizon) * 100
    return s.diff(horizon)


def _z_of_change(c: pd.Series) -> pd.Series:
    """z of today's change against the trailing year of changes, today excluded.
    sd floor relative to scale — a flat series has sd ≈ 1e-17, not 0."""
    past = c.shift(1)
    mu = past.rolling(Z_WINDOW, min_periods=Z_MIN).mean()
    sd = past.rolling(Z_WINDOW, min_periods=Z_MIN).std()
    floor = np.maximum(mu.abs(), 1e-12) * 1e-9
    sd = sd.where(sd > floor)
    return (c - mu) / sd


def _level_z(s: pd.Series, window: int = 63) -> pd.Series:
    s = s.dropna()
    mu = s.rolling(window, min_periods=window).mean()
    sd = s.rolling(window, min_periods=window).std()
    return (s - mu) / sd.where(sd > 0)


@dataclass
class Prepared:
    """Per-input change and z series, computed once for every date."""

    raw: dict[str, pd.Series] = field(default_factory=dict)
    cols: dict[str, dict[str, pd.Series]] = field(default_factory=dict)
    #: key → last official date; later points were estimated (see router).
    estimated_from: dict[str, str] = field(default_factory=dict)


def wti_roll_dates(years: range) -> set[pd.Timestamp]:
    """Sessions on which Yahoo's CL=F switches contract.

    NYMEX WTI trading ends 3 business days before the 25th calendar day of the
    month before delivery (4 if the 25th is not a business day); the continuous
    series shows the next contract from the following session. Holidays are
    ignored — at worst the mask lands one session off.
    """
    out: set[pd.Timestamp] = set()
    for y in years:
        for m in range(1, 13):
            d25 = pd.Timestamp(y, m, 25)
            anchor = d25 if d25.dayofweek < 5 else d25 - pd.offsets.BDay(1)
            expiry = anchor - pd.offsets.BDay(3)
            out.add((expiry + pd.offsets.BDay(1)).normalize())
    return out


def month_start_roll_dates(years: range) -> set[pd.Timestamp]:
    """HO, RB (NYMEX) and Brent (ICE) all expire on the last business day of a
    month, so their continuous series switch on the first business day."""
    out: set[pd.Timestamp] = set()
    for y in years:
        for m in range(1, 13):
            first = pd.Timestamp(y, m, 1)
            out.add((first if first.dayofweek < 5 else first + pd.offsets.BDay(1)).normalize())
    return out


#: Which continuous futures each input is built from. A change measured across
#: a contract switch is the calendar spread between two contracts, not a
#: market move — on 2026-09-23 the CL=F roll alone printed a +$6 Brent–WTI
#: "shock" and on 2026-09-01 the month-start roll a SEVERE crack collapse.
ROLL_LEGS: dict[str, tuple[str, ...]] = {
    "CRUDE": ("CL",), "BRENT": ("BZ",), "HO": ("HO",), "RB": ("RB",),
    "DIESEL_CRACK": ("CL", "HO"), "GAS_CRACK": ("CL", "RB"),
    "CRACK_321": ("CL", "HO", "RB"), "BRENT_WTI": ("CL", "BZ"),
}


def _roll_calendar(index: pd.DatetimeIndex) -> dict[str, set[pd.Timestamp]]:
    if len(index) == 0:
        return {}
    years = range(index.min().year, index.max().year + 1)
    wti, month = wti_roll_dates(years), month_start_roll_dates(years)
    return {"CL": wti, "BZ": month, "HO": month, "RB": month}


def _mask_rolls(c: pd.Series, rolls: set[pd.Timestamp], horizon: int) -> pd.Series:
    """Blank every change whose window spans a roll session. The roll date is
    snapped to the first observed bar on/after it (a holiday shifts it)."""
    if not rolls or c.empty:
        return c
    idx = c.index
    pos = sorted({int(idx.searchsorted(r)) for r in rolls if idx[0] <= r <= idx[-1]})
    bad = set()
    for i in pos:
        bad.update(range(i, min(i + horizon, len(idx))))
    if not bad:
        return c
    c = c.copy()
    c.iloc[sorted(bad)] = np.nan
    return c


def prepare(panel: pd.DataFrame) -> Prepared:
    p = Prepared(estimated_from=dict(panel.attrs.get("estimated_from", {})))
    cal = _roll_calendar(panel.index)
    for key in panel.columns:
        s = panel[key].dropna()
        if s.empty:
            continue
        kind = KIND.get(key, "diff")
        c1, c5 = _changes(s, kind, 1), _changes(s, kind, 5)
        rolls = set().union(*(cal.get(leg, set()) for leg in ROLL_LEGS.get(key, ())))
        if rolls:
            c1, c5 = _mask_rolls(c1, rolls, 1), _mask_rolls(c5, rolls, 5)
        p.raw[key] = s
        p.cols[key] = {
            "chg1": c1, "chg5": c5,
            "z1": _z_of_change(c1), "z5": _z_of_change(c5),
            "lz63": _level_z(s),
        }
    return p


def _num(v) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if not np.isfinite(f) else f


def readings_at(p: Prepared, d: pd.Timestamp) -> dict[str, Reading]:
    """Readings for one evaluation date. A daily market input with no bar on
    `d` has no reading — carrying yesterday's shock forward would report the
    same event twice. Slow series are read as-of within `ASOF_LAG_DAYS`."""
    out: dict[str, Reading] = {}
    for key, s in p.raw.items():
        lag = ASOF_LAG_DAYS.get(key)
        if lag is None:
            if d not in s.index:
                continue
            at = d
        else:
            prior = s.loc[:d]
            if prior.empty or (d - prior.index[-1]).days > lag:
                continue
            at = prior.index[-1]
        cols = p.cols[key]

        def g(name: str) -> float | None:
            ser = cols[name]
            return _num(ser.get(at)) if at in ser.index else None

        out[key] = Reading(
            key=key, value=_num(s.get(at)),
            chg1=g("chg1"), chg5=g("chg5"), z1=g("z1"), z5=g("z5"), lz63=g("lz63"),
            date=at.strftime("%Y-%m-%d"),
        )
    return out


# ─── Events ───────────────────────────────────────────────────────────────────


@dataclass
class Evidence:
    key: str
    label: str
    role: str                 # trigger | confirm | context
    value: float | None
    change: float | None
    unit: str
    horizon: int
    z: float | None
    note: str
    date: str | None


@dataclass
class Event:
    id: str
    name: str                 # formal English term
    definition: str           # what the term means, one line (EN)
    summary: str              # Thai explanation of what the data says today
    channel: str
    direction: str | None
    severity: str
    score: float              # trigger |z| — for ordering
    rule: str
    evidence: list[Evidence]
    catalyst: str | None = None

    def as_dict(self) -> dict:
        d = asdict(self)
        d["channel_label"] = CHANNEL_LABEL.get(self.channel, self.channel.upper())
        d["headline"] = HEADLINE.get(self.id, "")
        for e in d["evidence"]:
            e["short"] = SHORT.get(e["key"], e["key"])
        return d


#: One short Thai line per event — what the card shows. `summary` (the full
#: sentence) stays in the payload for the tooltip.
HEADLINE: dict[str, str] = {
    "rates_vol_shock": "ความผันผวนพันธบัตรพุ่ง",
    "treasury_selloff": "Yield พุ่ง ราคาพันธบัตรร่วง",
    "treasury_rally": "Yield ร่วง ราคาพันธบัตรขึ้น",
    "real_yield_surge": "ต้นทุนเงินจริงพุ่ง (ไม่ใช่เงินเฟ้อ)",
    "real_yield_decline": "ต้นทุนเงินจริงลดลง",
    "policy_repricing": "ตลาดปรับคาดการณ์ดอกเบี้ย Fed",
    "equity_vol_shock": "ความผันผวนหุ้นพุ่ง",
    "tail_hedging": "ซื้อประกันขาลงล่วงหน้า",
    "equity_selloff": "หุ้นร่วงแรงผิดปกติ",
    "tech_unwind": "เทคแย่กว่าตลาดรวม",
    "forced_liquidation": "ขายหนัก วอลุ่มสูงผิดปกติ",
    "flight_to_quality": "เงินหนีเข้าสินทรัพย์ปลอดภัย",
    "joint_drawdown": "หุ้น + พันธบัตร ร่วงพร้อมกัน",
    "correlation_spike": "ทุกสินทรัพย์วิ่งทางเดียวกัน",
    "credit_widening": "Spread หุ้นกู้กว้างขึ้น",
    "financial_conditions": "ภาวะการเงินตึงตัว",
    "usd_squeeze": "ดอลลาร์แข็ง + สินทรัพย์เสี่ยงร่วง",
    "usd_rally": "ดอลลาร์แข็งค่าผิดปกติ",
    "yen_carry_unwind": "เยนแข็ง บังคับปิด carry",
    "yen_appreciation": "เยนแข็งค่าเร็ว",
    "yen_depreciation": "เยนอ่อนเร็ว เสี่ยงแทรกแซง",
    "oil_supply_shock": "น้ำมันพุ่ง",
    "oil_demand_shock": "น้ำมันร่วง (อุปสงค์อ่อน)",
    "distillate_squeeze": "ดีเซลตึงตัว",
    "refining_margin_expansion": "ค่าการกลั่นพุ่ง",
    "refining_margin_compression": "ค่าการกลั่นหด",
    "brent_wti_dislocation": "Brent แพงกว่า WTI ผิดปกติ",
    "haven_demand": "ทองถูกไล่ซื้อ",
    "haven_liquidation": "ทองถูกเทขาย",
}

#: Compact labels for evidence chips.
SHORT: dict[str, str] = {
    "UST3M": "3M", "UST5Y": "5Y", "UST10Y": "10Y", "UST30Y": "30Y",
    "REAL5": "5Y real", "REAL10": "10Y real", "BE5": "5Y BE", "BE10": "10Y BE",
    "HY_OAS": "HY OAS", "IG_OAS": "IG OAS", "STL_FSI": "STL FSI", "SPY_VOL": "SPY vol",
    "USDJPY": "USDJPY", "CRUDE": "WTI", "BRENT": "Brent", "HO": "ULSD", "RB": "RBOB",
    "DIESEL_CRACK": "Diesel crack", "GAS_CRACK": "Gas crack", "CRACK_321": "3-2-1",
    "BRENT_WTI": "Brent−WTI", "FG": "F&G", "DCC": "DCC",
}


def _ev(r: Reading | None, role: str, horizon: int = 1, note: str = "") -> Evidence | None:
    if r is None:
        return None
    z = r.z1 if horizon == 1 else r.z5
    return Evidence(
        key=r.key, label=LABEL.get(r.key, r.key), role=role,
        value=None if r.value is None else round(r.value, 4),
        change=None if r.change(horizon) is None else round(r.change(horizon), 2),
        unit=_unit(r.key), horizon=horizon,
        z=None if z is None else round(z, 2), note=note, date=r.date,
    )


def _ev_level(key: str, value: float | None, role: str, note: str, unit: str = "") -> Evidence:
    return Evidence(
        key=key, label=LABEL.get(key, key), role=role,
        value=None if value is None else round(value, 4), change=None, unit=unit,
        horizon=0, z=None, note=note, date=None,
    )


def grade(trigger: float, confirms: int) -> str | None:
    """Severity from how extreme the trigger is and how many independent
    inputs agree. 2σ alone = WATCH; 3σ, or 2σ with two confirmations = ACTIVE;
    4σ, or 3σ with two confirmations = SEVERE."""
    t = abs(trigger)
    tier = 3 if t >= 4 else 2 if t >= 3 else 1 if t >= TRIGGER_Z else 0
    if tier == 0:
        return None
    if confirms >= 2:
        tier += 1
    return SEVERITIES[min(tier, 3) - 1]


class _Book:
    """Collects evidence for one candidate event while its rule runs."""

    def __init__(self, F: dict[str, Reading]):
        self.F = F
        self.evidence: list[Evidence] = []
        self.confirms = 0

    def add(self, e: Evidence | None) -> None:
        if e is not None:
            self.evidence.append(e)

    def check(self, key: str, sign: int, note_yes: str, note_no: str = "",
              thr: float = CONFIRM_Z, count: bool = True) -> bool:
        """Test one confirming input. A hit is recorded as `confirm`; a miss
        with a note is recorded as `context` so the reader sees it was checked."""
        r = self.F.get(key)
        if r is None:
            return False
        z, h = r.strongest(sign)
        hit = z is not None and z >= thr
        if hit:
            self.add(_ev(r, "confirm", h, note_yes))
            if count:
                self.confirms += 1
        elif note_no:
            self.add(_ev(r, "context", 1, note_no))
        return hit


def _bp(r: Reading | None, h: int = 1) -> float | None:
    return None if r is None else r.change(h)


# Each rule: (F, ctx) -> Event | None. `ctx` carries point-in-time inputs that
# exist only for the latest session (DCC, RSI, Fear & Greed) and the catalyst
# for the evaluation date.


def _rates_vol_shock(F, ctx) -> Event | None:
    m = F.get("MOVE")
    if m is None:
        return None
    t, h = m.strongest(+1)
    if t is None or t < TRIGGER_Z:
        return None
    b = _Book(F)
    b.add(_ev(m, "trigger", h, f"MOVE {'+' if (m.change(h) or 0) >= 0 else ''}"
                               f"{(m.change(h) or 0):.1f}% ใน {h} วัน"))
    y_hit = b.check("UST10Y", 0, "อัตราผลตอบแทน 10 ปีขยับแรงพร้อมกัน") or \
        b.check("UST5Y", 0, "อัตราผลตอบแทน 5 ปีขยับแรงพร้อมกัน")
    spill = b.check("VIX", +1, "ความผันผวนลามเข้าตลาดหุ้น",
                    "VIX ไม่ยืนยัน — ความเครียดยังอยู่ในตลาดดอกเบี้ย")
    b.check("DXY", 0, "ดอลลาร์ขยับแรงตาม", count=False)
    scope = "ลามสู่ตลาดหุ้นแล้ว" if spill else "ยังจำกัดอยู่ในตลาดพันธบัตร (VIX ไม่ยืนยัน)"
    ydir = ""
    y = F.get("UST10Y")
    if y_hit and y is not None and y.chg1 is not None:
        ydir = f" · 10Y {y.chg1:+.0f}bp"
    sev = grade(t, b.confirms)
    return Event(
        id="rates_vol_shock", name="Rates Volatility Shock",
        definition="Abrupt repricing of Treasury implied volatility (ICE BofA MOVE) "
                   "relative to its own history.",
        summary=f"ความผันผวนคาดการณ์ของพันธบัตรรัฐบาลสหรัฐพุ่งขึ้นผิดปกติ — ต้นทุนการป้องกัน"
                f"ความเสี่ยงอัตราดอกเบี้ยสูงขึ้นทันที; {scope}{ydir}",
        channel="rates", direction="up", severity=sev, score=t,
        rule=f"MOVE 1d/5d log-change z ≥ {TRIGGER_Z}; confirm: |Δ10Y| or |Δ5Y| z ≥ {CONFIRM_Z}, "
             f"VIX up z ≥ {CONFIRM_Z}",
        evidence=b.evidence,
    ) if sev else None


def _curve_shape(F, h: int, sign: int) -> tuple[str, str]:
    """Name the curve move from the 5Y and 30Y legs — the only two points
    Yahoo quotes same-day alongside the 10Y (FRED's 2Y lags a session)."""
    d5, d30 = _bp(F.get("UST5Y"), h), _bp(F.get("UST30Y"), h)
    if d5 is None or d30 is None:
        return "", ""
    slope = d30 - d5
    tag = f"5s30s {slope:+.0f}bp"
    if abs(slope) < 3:
        return "Parallel Shift", tag
    steep = slope > 0
    if sign > 0:
        return ("Bear Steepening" if steep else "Bear Flattening"), tag
    return ("Bull Steepening" if steep else "Bull Flattening"), tag


_SHAPE_TH = {
    "Bear Steepening": "ปลายยาวขึ้นมากกว่าปลายสั้น — ตลาดเรียกค่าชดเชยการถือพันธบัตรระยะยาว "
                       "(term premium / อุปทานพันธบัตร / ความเสี่ยงเงินเฟ้อ) ไม่ใช่แค่คาดการณ์ดอกเบี้ยนโยบาย",
    "Bear Flattening": "ปลายสั้นขึ้นนำ — ตลาดตั้งราคาดอกเบี้ยนโยบายสูงขึ้น (hawkish repricing)",
    "Bull Steepening": "ปลายสั้นลงนำ — ตลาดคาดการลดดอกเบี้ยเร็วขึ้น มักมากับความกังวลเศรษฐกิจ",
    "Bull Flattening": "ปลายยาวลงนำ — เงินไหลเข้าพันธบัตรระยะยาว สะท้อนมุมมองการเติบโต/เงินเฟ้อที่อ่อนลง",
    "Parallel Shift": "ทั้งเส้นขยับพอๆ กัน",
}


def _treasury_repricing(F, ctx) -> Event | None:
    y = F.get("UST10Y")
    if y is None:
        return None
    t, h = y.strongest(0)
    if t is None or t < TRIGGER_Z:
        return None
    move = y.change(h) or 0.0
    sign = 1 if move > 0 else -1
    shape, tag = _curve_shape(F, h, sign)
    b = _Book(F)
    b.add(_ev(y, "trigger", h, f"10Y {move:+.1f}bp ใน {h} วัน · ระดับ {y.value:.2f}%"
                               if y.value is not None else f"10Y {move:+.1f}bp"))
    b.check("UST5Y", sign, "5Y ขยับทิศเดียวกัน", thr=CONFIRM_Z)
    b.check("MOVE", +1, "ความผันผวนพันธบัตรเพิ่มขึ้นพร้อมกัน",
            "MOVE ไม่ขยับ — การปรับราคาเป็นระเบียบ")
    b.check("TLT", -sign, "ราคาพันธบัตรระยะยาว (TLT) ยืนยัน", count=False)
    if tag:
        b.add(_ev(F.get("UST30Y"), "context", h, f"รูปทรงเส้น: {tag}"))
    # Nominal = real + breakeven. Both legs read off their own series (TIPS
    # real yield, market breakeven) rather than one inferred from the other.
    driver = ""
    dr, dbe = decompose(F, "10", h)
    if dr is not None and dbe is not None and move:
        real_share = dr / move
        driver = (
            f"real yield {dr:+.1f}bp + breakeven {dbe:+.1f}bp — "
            + ("ขับเคลื่อนโดยอัตราผลตอบแทนที่แท้จริง (นโยบาย/term premium) ไม่ใช่คาดการณ์เงินเฟ้อ"
               if real_share >= 0.6 else
               "ขับเคลื่อนโดยคาดการณ์เงินเฟ้อ" if real_share <= 0.4 else
               "ทั้ง real yield และคาดการณ์เงินเฟ้อร่วมกัน")
        )
        b.add(_ev(F.get("REAL10"), "context", h, f"real yield {dr:+.1f}bp ({real_share:.0%} ของ nominal)"))
        b.add(_ev(F.get("BE10"), "context", h, f"breakeven {dbe:+.1f}bp"))
    sev = grade(t, b.confirms)
    if not sev:
        return None
    head = "Treasury Selloff" if sign > 0 else "Treasury Rally"
    name = f"{head} — {shape}" if shape else head
    level = ""
    if sign > 0 and y.value is not None and y.value >= 5.0 and (y.value - move / 100) < 5.0:
        level = " · 10Y ทะลุ 5% ในรอบนี้"
    return Event(
        id="treasury_selloff" if sign > 0 else "treasury_rally", name=name,
        definition=("Rise in Treasury yields (fall in bond prices) beyond the normal daily range."
                    if sign > 0 else
                    "Fall in Treasury yields (rise in bond prices) beyond the normal daily range."),
        summary=(f"อัตราผลตอบแทนพันธบัตรรัฐบาลสหรัฐ{'พุ่งขึ้น' if sign > 0 else 'ร่วงลง'}ผิดปกติ — "
                 f"{_SHAPE_TH.get(shape, '')}" + (f"; {driver}" if driver else "") + level),
        channel="rates", direction="up" if sign > 0 else "down", severity=sev, score=t,
        rule=f"|Δ10Y| z ≥ {TRIGGER_Z} (1d/5d, bp); shape from Δ30Y − Δ5Y (±3bp = parallel); "
             "driver: Δreal (TIPS) share of Δnominal ≥ 60% = real, ≤ 40% = inflation expectations",
        evidence=b.evidence,
    )


def decompose(F, tenor: str, h: int = 1) -> tuple[float | None, float | None]:
    """(Δreal, Δbreakeven) in bp for a tenor ('5' or '10') over horizon h.

    Only when both legs are dated the same session as the nominal yield. The
    slow series are read as-of, so without this check yesterday's +1bp real
    move was set against today's +15bp nominal move and the decomposition
    called a real-rate day an inflation scare."""
    r, be, n = F.get(f"REAL{tenor}"), F.get(f"BE{tenor}"), F.get(f"UST{tenor}Y")
    if r is None or be is None or n is None or not (r.date == be.date == n.date):
        return None, None
    return r.change(h), be.change(h)


def _real_yield_shock(F, ctx) -> Event | None:
    """The real rate is the price of money after inflation — what discounts
    long-duration equity cash flows and what gold competes against."""
    r = F.get("REAL10")
    if r is None or (ctx.get("date") and r.date != ctx["date"]):
        return None     # an as-of print from an earlier session is not today's move
    t, h = r.strongest(0)
    if t is None or t < TRIGGER_Z:
        return None
    move = r.change(h) or 0.0
    sign = 1 if move > 0 else -1
    b = _Book(F)
    b.add(_ev(r, "trigger", h, f"10Y real {move:+.1f}bp ใน {h} วัน · ระดับ {r.value:.2f}%"
                               if r.value is not None else f"10Y real {move:+.1f}bp"))
    b.check("REAL5", sign, "real yield 5 ปีขยับทิศเดียวกัน")
    b.check("GLD", -sign, "ทองคำเคลื่อนสวนทาง real yield ตามทฤษฎี", "ทองคำไม่ตอบสนอง", thr=1.0)
    b.check("QQQ", -sign, "หุ้น duration ยาว (เทค) ตอบสนอง", thr=1.0)
    be = F.get("BE10")
    if be is not None and be.change(h) is not None:
        b.add(_ev(be, "context", h, f"breakeven {be.change(h):+.1f}bp — คาดการณ์เงินเฟ้อ"
                                    + (" แทบไม่ขยับ" if abs(be.change(h)) < 3 else "")))
    if r.value is not None and r.value >= 2.5 and sign > 0:
        b.add(_ev_level("REAL10", r.value, "context",
                        f"real yield {r.value:.2f}% — ระดับเข้มงวด (2010–2021 แทบไม่เกิน 1%)", "%"))
    sev = grade(t, b.confirms)
    if not sev:
        return None
    up = sign > 0
    return Event(
        id="real_yield_surge" if up else "real_yield_decline",
        name="Real Yield Surge" if up else "Real Yield Decline",
        definition=("Sharp rise in inflation-adjusted (TIPS) yields — a tightening of financial "
                    "conditions independent of inflation expectations."
                    if up else
                    "Sharp fall in inflation-adjusted (TIPS) yields — an easing of real financial conditions."),
        summary=("อัตราผลตอบแทนที่แท้จริง (หลังหักคาดการณ์เงินเฟ้อ) พุ่งขึ้นผิดปกติ — ต้นทุนเงินจริงแพงขึ้น "
                 "กดมูลค่าหุ้นเติบโต/เทคและทองคำ โดยไม่ได้มาจากความกลัวเงินเฟ้อ"
                 if up else
                 "อัตราผลตอบแทนที่แท้จริงร่วงผิดปกติ — ต้นทุนเงินจริงถูกลง หนุนทองคำและหุ้นเติบโต"),
        channel="rates", direction="up" if up else "down", severity=sev, score=t,
        rule=f"|Δ10Y TIPS real yield| z ≥ {TRIGGER_Z} (1d/5d); confirm: 5Y real same way, "
             "gold opposite, QQQ opposite (z ≥ 1)",
        evidence=b.evidence,
    )


def _refining_margins(F, ctx) -> Event | None:
    """Crack spread = refined product price − crude: what refiners earn and
    what fuel buyers pay above crude. A diesel crack blowout with crude flat is
    a *product* shortage (refinery outages, export pull, sanctions), and it
    reaches CPI through freight and trucking without crude moving at all."""
    dc, c321, gc = F.get("DIESEL_CRACK"), F.get("CRACK_321"), F.get("GAS_CRACK")
    lead = None
    for r in (dc, c321):
        if r is None:
            continue
        t, h = r.strongest(0)
        if t is not None and t >= TRIGGER_Z and (lead is None or t > lead[1]):
            lead = (r, t, h)
    if lead is None:
        return None
    r, t, h = lead
    move = r.change(h) or 0.0
    up = move > 0
    diesel_led = r.key == "DIESEL_CRACK"
    b = _Book(F)
    b.add(_ev(r, "trigger", h, f"{LABEL[r.key]} {move:+.1f} $/bbl ใน {h} วัน · ระดับ ${r.value:.1f}"
                               if r.value is not None else LABEL[r.key]))
    other = c321 if diesel_led else dc
    if other is not None:
        b.check(other.key, 1 if up else -1, "crack อีกตัวยืนยัน")
    if gc is not None:
        b.add(_ev(gc, "context", 1, "gasoline crack (RBOB เปลี่ยนเกรดตามฤดูกาล เม.ย./ก.ย. — กระโดดได้เอง)"))
    crude = F.get("CRUDE")
    if crude is not None:
        cz, _ = crude.strongest(0)
        b.add(_ev(crude, "context", 1,
                  "น้ำมันดิบนิ่ง — การขยับมาจากฝั่งผลิตภัณฑ์" if (cz or 0) < 1.5
                  else "น้ำมันดิบขยับแรงด้วย"))
    pct = (ctx.get("pctile") or {}).get(r.key)
    if pct is not None:
        b.add(_ev_level(r.key, pct, "context", f"ระดับอยู่ percentile {pct:.0f} ของ 1 ปี"))
        if up and pct >= 90:
            b.confirms += 1
    sev = grade(t, b.confirms)
    if not sev:
        return None
    if up:
        name = "Distillate Supply Squeeze" if diesel_led else "Refining Margin Expansion"
        idd = "distillate_squeeze" if diesel_led else "refining_margin_expansion"
        summ = ("ส่วนต่างราคาดีเซลเหนือน้ำมันดิบกว้างขึ้นผิดปกติ — ดีเซลตึงตัว (โรงกลั่น/ส่งออก/คว่ำบาตร) "
                "ส่งผ่านเข้าค่าขนส่งและเงินเฟ้อโดยไม่ต้องรอราคาน้ำมันดิบ"
                if diesel_led else
                "ค่าการกลั่นรวม (3-2-1) กว้างขึ้นผิดปกติ — ผลิตภัณฑ์น้ำมันตึงกว่าน้ำมันดิบ")
    else:
        name, idd = "Refining Margin Compression", "refining_margin_compression"
        summ = ("ค่าการกลั่นหดตัวผิดปกติ — ความต้องการเชื้อเพลิงสำเร็จรูปอ่อนลง หรือความตึงตัวของ"
                "ผลิตภัณฑ์คลายตัว")
    return Event(
        id=idd, name=name,
        definition="Abnormal move in refining margins (product price minus crude, $/bbl).",
        summary=summ, channel="commodities", direction="up" if up else "down",
        severity=sev, score=t,
        rule=f"diesel crack (HO×42 − WTI) or 3-2-1 crack change z ≥ {TRIGGER_Z} ($/bbl, 1d/5d); "
             "confirm: the other crack, level ≥ 90th pctile 1y. Front-month roll days can jump",
        evidence=b.evidence,
    )


def _brent_wti(F, ctx) -> Event | None:
    r = F.get("BRENT_WTI")
    if r is None:
        return None
    t, h = r.strongest(+1)
    if t is None or t < TRIGGER_Z:
        return None
    b = _Book(F)
    b.add(_ev(r, "trigger", h, f"Brent − WTI {(r.change(h) or 0):+.2f} $/bbl · ระดับ ${r.value:.2f}"
                               if r.value is not None else "Brent − WTI"))
    b.check("BRENT", +1, "Brent นำการขึ้น — ความเสี่ยงอุปทานทางทะเล")
    b.check("OVX", +1, "ความผันผวนน้ำมันเพิ่ม")
    sev = grade(t, b.confirms)
    return Event(
        id="brent_wti_dislocation", name="Brent–WTI Spread Dislocation",
        definition="Seaborne (Brent) crude reprices above US inland (WTI) crude — a waterborne or "
                   "geopolitical supply disruption rather than a global demand shift.",
        summary="ส่วนต่าง Brent เหนือ WTI กว้างขึ้นผิดปกติ — ความเสี่ยงอุปทานน้ำมันทางทะเล/ภูมิรัฐศาสตร์ "
                "(ช่องแคบ คว่ำบาตร การขนส่ง) มากกว่าอุปสงค์โลก",
        channel="commodities", direction="up", severity=sev, score=t,
        rule=f"Brent − WTI change z ≥ {TRIGGER_Z} ($/bbl, 1d/5d); confirm: Brent up, OVX up",
        evidence=b.evidence,
    ) if sev else None


def _policy_repricing(F, ctx) -> Event | None:
    r = F.get("UST3M")
    if r is None:
        return None
    t, h = r.strongest(0)
    if t is None or t < 2.5:
        return None
    move = r.change(h) or 0.0
    if abs(move) < 4:          # bills tick in single bp; a sub-4bp move is noise
        return None
    sign = 1 if move > 0 else -1
    b = _Book(F)
    b.add(_ev(r, "trigger", h, f"ตั๋วเงินคลัง 3M {move:+.1f}bp"))
    b.check("UST5Y", sign, "5Y ขยับทิศเดียวกัน")
    b.check("DXY", sign, "ดอลลาร์ขยับตามทิศดอกเบี้ย")
    if ctx.get("catalyst"):
        b.confirms += 1
    sev = grade(t, b.confirms)
    if not sev:
        return None
    stance = "Hawkish" if sign > 0 else "Dovish"
    return Event(
        id="policy_repricing", name=f"Monetary Policy Repricing ({stance})",
        definition="Front-end Treasury yields move sharply as the market re-prices "
                   "the expected Fed policy path.",
        summary=("ตลาดปรับคาดการณ์ดอกเบี้ยนโยบาย Fed " +
                 ("ขึ้น (เข้มงวดกว่าที่คิด)" if sign > 0 else "ลง (ผ่อนคลายเร็วกว่าที่คิด)") +
                 " — เห็นจากตั๋วเงินคลังระยะสั้นที่ผูกกับดอกเบี้ยนโยบาย"),
        channel="rates", direction="up" if sign > 0 else "down", severity=sev, score=t,
        rule="|Δ3M bill| z ≥ 2.5 and ≥ 4bp; confirm: 5Y same way, DXY same way, scheduled catalyst",
        evidence=b.evidence,
    )


def _equity_vol_shock(F, ctx) -> Event | None:
    v = F.get("VIX")
    if v is None:
        return None
    t, h = v.strongest(+1)
    level_panic = v.value is not None and v.value >= 30
    if (t is None or t < TRIGGER_Z) and not level_panic:
        return None
    t = max(t or 0.0, 3.0 if level_panic else 0.0)
    b = _Book(F)
    b.add(_ev(v, "trigger", h, f"VIX {v.value:.1f}" + (" (≥ 30)" if level_panic else "")))
    v3 = F.get("VIX3M")
    inverted = v3 is not None and v.value is not None and v3.value is not None and v.value > v3.value
    if inverted:
        b.confirms += 1
        b.add(_ev_level("VIX3M", v3.value, "confirm",
                        f"VIX {v.value:.1f} > VIX3M {v3.value:.1f} — term structure กลับหัว"))
    b.check("VVIX", +1, "vol-of-vol ถูกไล่ซื้อ")
    b.check("SPY", -1, "หุ้นร่วงจริง ไม่ใช่แค่ความกังวล", "SPY ไม่ได้ร่วงแรง")
    sev = grade(t, b.confirms)
    if not sev:
        return None
    return Event(
        id="equity_vol_shock", name="Equity Volatility Shock",
        definition="Sudden repricing of S&P 500 implied volatility (VIX) versus its own history.",
        summary="ความผันผวนคาดการณ์ของหุ้นสหรัฐพุ่งขึ้นฉับพลัน — ความต้องการประกันพอร์ตหุ้นเพิ่มขึ้น" +
                ("; VIX ระยะสั้นสูงกว่าระยะยาว = ความเครียดเฉียบพลัน" if inverted else ""),
        channel="equity_vol", direction="up", severity=sev, score=t,
        rule=f"VIX 1d/5d log-change z ≥ {TRIGGER_Z} or VIX ≥ 30; confirm: VIX > VIX3M, "
             f"VVIX up, SPY down (z ≥ {CONFIRM_Z})",
        evidence=b.evidence,
    )


def _tail_hedging(F, ctx) -> Event | None:
    skew, vvix, vix = F.get("SKEW"), F.get("VVIX"), F.get("VIX")
    calm = vix is not None and vix.lz63 is not None and vix.lz63 < 1.0
    if not calm:
        return None     # with spot vol already bid, this is part of an equity vol shock
    t, b = 0.0, _Book(F)
    if skew is not None and skew.value is not None:
        # Level alone is not evidence: SKEW 145 was the 1-year MEDIAN in 2026-09,
        # so the old "> 145" rule lit most days. Read it against its own range,
        # with an absolute backstop only well above anything recent.
        tz = max(skew.lz63 or 0.0, 2.5 if skew.value >= SKEW_EXTREME else 0.0)
        if tz >= TRIGGER_Z:
            t = tz
            b.add(_ev_level("SKEW", skew.value, "trigger",
                            f"SKEW {skew.value:.1f} · z63 {skew.lz63:+.2f}" if skew.lz63 is not None
                            else f"SKEW {skew.value:.1f}"))
    if vvix is not None:
        z, h = vvix.strongest(+1)
        if z is not None and z >= TRIGGER_Z:
            if t == 0.0:
                b.add(_ev(vvix, "trigger", h, "VVIX ถูกไล่ซื้อขณะที่ VIX ยังต่ำ"))
                t = z
            else:
                b.add(_ev(vvix, "confirm", h, "VVIX ยืนยัน"))
                b.confirms += 1
    if t < TRIGGER_Z:
        return None
    b.add(_ev_level("VIX", vix.value, "context", f"VIX ยังต่ำ (z63 {vix.lz63:+.2f})"))
    sev = grade(t, b.confirms)
    return Event(
        id="tail_hedging", name="Tail-Risk Hedging Demand",
        definition="Out-of-the-money index puts or VIX calls bid while spot volatility stays low.",
        summary="ราคาประกันความเสียหายรุนแรง (OTM put / VIX call) แพงขึ้น ขณะที่ความผันผวนปัจจุบัน"
                "ยังต่ำ — ผู้เล่นซื้อประกันล่วงหน้าก่อนเหตุการณ์",
        channel="equity_vol", direction="up", severity=sev, score=t,
        rule=f"VIX z63 < 1 and (SKEW z63 ≥ 2 or SKEW ≥ {SKEW_EXTREME:.0f}, or VVIX change z ≥ 2)",
        evidence=b.evidence,
    ) if sev else None


def _equity_selloff(F, ctx) -> Event | None:
    s = F.get("SPY")
    if s is None:
        return None
    t, h = s.strongest(-1)
    if t is None or t < TRIGGER_Z:
        return None
    b = _Book(F)
    b.add(_ev(s, "trigger", h, f"SPY {(s.change(h) or 0):+.2f}% ใน {h} วัน"))
    b.check("VIX", +1, "VIX ขึ้นยืนยัน")
    b.check("HYG", -1, "หุ้นกู้ high-yield ร่วงตาม — ความเสี่ยงเครดิตถูกตั้งราคา")
    b.check("SPY_VOL", +1, "ปริมาณซื้อขายสูงผิดปกติ", count=False)
    sev = grade(t, b.confirms)
    return Event(
        id="equity_selloff", name="Broad Equity Selloff",
        definition="Decline in the S&P 500 well beyond its normal daily/weekly range.",
        summary="ตลาดหุ้นสหรัฐร่วงแรงผิดปกติเมื่อเทียบกับการแกว่งตัวปกติของตัวเอง",
        channel="equity", direction="down", severity=sev, score=t,
        rule=f"SPY 1d/5d return z ≤ −{TRIGGER_Z}; confirm: VIX up, HYG down",
        evidence=b.evidence,
    ) if sev else None


def _flight_to_quality(F, ctx) -> Event | None:
    s, y = F.get("SPY"), F.get("UST10Y")
    if s is None or y is None:
        return None
    t, h = s.strongest(-1)
    if t is None or t < TRIGGER_Z:
        return None
    dy = y.change(h)
    if dy is None or dy > -3:          # yields must actually fall
        return None
    b = _Book(F)
    b.add(_ev(s, "trigger", h, "หุ้นร่วง"))
    b.add(_ev(y, "confirm", h, f"10Y {dy:+.1f}bp — เงินไหลเข้าพันธบัตร"))
    b.confirms += 1
    b.check("GLD", +1, "ทองคำขึ้น")
    b.check("USDJPY", -1, "เยนแข็งค่า (สกุลเงินปลอดภัย)")
    sev = grade(t, b.confirms)
    return Event(
        id="flight_to_quality", name="Flight to Quality",
        definition="Capital rotates out of risk assets into Treasuries and other havens.",
        summary="เงินไหลออกจากหุ้นเข้าสินทรัพย์ปลอดภัย (พันธบัตรรัฐบาล/ทองคำ/เยน) — "
                "พันธบัตรยังทำหน้าที่กันชนพอร์ตได้",
        channel="cross_asset", direction="risk_off", severity=sev, score=t,
        rule=f"SPY return z ≤ −{TRIGGER_Z} with 10Y yield down ≥ 3bp; confirm: gold up, yen up",
        evidence=b.evidence,
    ) if sev else None


def _joint_drawdown(F, ctx) -> Event | None:
    """Stocks and long bonds falling together — the day a 60/40 portfolio has
    no cushion. Scored on the combined size of the two drops."""
    s, tl = F.get("SPY"), F.get("TLT")
    if s is None or tl is None or s.z1 is None or tl.z1 is None:
        return None
    if not (s.z1 <= -0.75 and tl.z1 <= -1.0):
        return None
    t = float(np.hypot(s.z1, tl.z1))
    if t < TRIGGER_Z:
        return None
    b = _Book(F)
    b.add(_ev(s, "trigger", 1, f"SPY {(s.chg1 or 0):+.2f}%"))
    b.add(_ev(tl, "trigger", 1, f"TLT {(tl.chg1 or 0):+.2f}%"))
    b.check("GLD", -1, "ทองคำร่วงด้วย — สินทรัพย์ปลอดภัยไม่ทำงาน", thr=1.0)
    b.check("DXY", +1, "ดอลลาร์แข็ง — เงินกลับเข้าดอลลาร์สด", thr=1.0)
    b.check("MOVE", +1, "ต้นเหตุมาจากฝั่งดอกเบี้ย")
    corr = ctx.get("stock_bond_corr")
    if corr is not None:
        b.add(_ev_level("TLT", corr, "context",
                        f"corr(SPY, TLT) 63 วัน {corr:+.2f}" +
                        (" — เป็นบวก: หุ้นกับพันธบัตรไปทางเดียวกันเป็นโครงสร้าง" if corr > 0.2 else "")))
    sev = grade(t, b.confirms)
    return Event(
        id="joint_drawdown", name="Stock–Bond Joint Drawdown",
        definition="Equities and long-duration Treasuries fall together (positive stock–bond "
                   "correlation), removing the usual diversification cushion.",
        summary="หุ้นและพันธบัตรระยะยาวร่วงพร้อมกัน — พอร์ตหุ้น/พันธบัตรไม่มีตัวกันชน; มักเกิดเมื่อตลาด"
                "กังวลดอกเบี้ย/เงินเฟ้อมากกว่ากังวลเศรษฐกิจชะลอ",
        channel="cross_asset", direction="risk_off", severity=sev, score=t,
        rule="SPY z1 ≤ −0.75 and TLT z1 ≤ −1, combined √(z²+z²) ≥ 2; confirm: gold down, "
             "dollar up, MOVE up",
        evidence=b.evidence,
    ) if sev else None


def _credit_widening(F, ctx) -> Event | None:
    hy = F.get("HY_OAS")
    if hy is None:
        return None
    t, h = hy.strongest(+1)
    lvl_thr = ctx.get("hy_threshold")
    breach = lvl_thr is not None and hy.value is not None and hy.value >= lvl_thr
    if (t is None or t < TRIGGER_Z) and not breach:
        return None
    t = max(t or 0.0, 3.0 if breach else 0.0)
    b = _Book(F)
    b.add(_ev(hy, "trigger", h, f"HY OAS {hy.value:.2f}% ({(hy.change(h) or 0):+.0f}bp ใน {h} วัน)"))
    b.check("IG_OAS", +1, "หุ้นกู้ investment-grade กว้างขึ้นด้วย — ไม่ใช่แค่ junk")
    b.check("HYG", -1, "ราคา HYG ร่วงยืนยัน")
    sev = grade(t, b.confirms)
    return Event(
        id="credit_widening", name="Credit Spread Widening",
        definition="Corporate bond spreads over Treasuries widen — the market prices "
                   "more default risk.",
        summary="ส่วนต่างผลตอบแทนหุ้นกู้เอกชนเหนือพันธบัตรรัฐบาลกว้างขึ้นผิดปกติ — ตลาดตั้งราคาความเสี่ยง"
                "ผิดนัดชำระสูงขึ้น ต้นทุนระดมทุนของบริษัทแพงขึ้น",
        channel="credit", direction="up", severity=sev, score=t,
        rule=f"HY OAS change z ≥ {TRIGGER_Z} (1d/5d) or level ≥ crisis threshold; "
             "confirm: IG OAS wider, HYG down",
        evidence=b.evidence,
    ) if sev else None


def _financial_conditions(F, ctx) -> Event | None:
    vals = [(k, F.get(k)) for k in ("STL_FSI", "NFCI")]
    lit = [(k, r) for k, r in vals if r is not None and r.value is not None and r.value > 0]
    if not lit:
        return None
    t = max(3.0 if r.value > 1 else 2.0 for _, r in lit)
    b = _Book(F)
    for i, (k, r) in enumerate(lit):
        b.add(_ev_level(k, r.value, "trigger" if i == 0 else "confirm",
                        f"{LABEL[k]} {r.value:+.2f} (> 0 = ตึงกว่าค่าเฉลี่ย) · ณ {r.date}"))
    b.confirms = len(lit) - 1
    sev = grade(t, b.confirms)
    return Event(
        id="financial_conditions", name="Financial Conditions Tightening",
        definition="Composite funding, credit and market-stress indices above their "
                   "long-run average.",
        summary="ดัชนีภาวะการเงินรวม (สภาพคล่อง/เครดิต/ความเครียดตลาด) ตึงกว่าค่าเฉลี่ยระยะยาว — "
                "เงื่อนไขการระดมทุนแย่ลงทั้งระบบ (ข้อมูลรายสัปดาห์)",
        channel="credit", direction="up", severity=sev, score=t,
        rule="St. Louis FSI > 0 or Chicago NFCI > 0 (weekly); > 1 = severe tier",
        evidence=b.evidence,
    ) if sev else None


def _dollar(F, ctx) -> Event | None:
    d = F.get("DXY")
    if d is None:
        return None
    t, h = d.strongest(+1)
    if t is None or t < TRIGGER_Z:
        return None
    b = _Book(F)
    b.add(_ev(d, "trigger", h, f"DXY {(d.change(h) or 0):+.2f}% ใน {h} วัน"))
    risk_off = b.check("SPY", -1, "สินทรัพย์เสี่ยงร่วงพร้อมกัน", "หุ้นไม่ได้ร่วง", thr=1.0)
    b.check("GLD", -1, "ทองคำถูกขายเพื่อหาดอลลาร์", thr=1.0, count=False)
    sev = grade(t, b.confirms)
    if not sev:
        return None
    if risk_off:
        name, idd = "US Dollar Liquidity Squeeze", "usd_squeeze"
        summ = ("ดอลลาร์แข็งค่าผิดปกติพร้อมสินทรัพย์เสี่ยงร่วง — ความต้องการเงินดอลลาร์สดทั่วโลกสูงขึ้น "
                "ต้นทุนเงินทุนดอลลาร์แพง กดดันตลาดเกิดใหม่และสินทรัพย์เสี่ยง")
    else:
        name, idd = "Broad US Dollar Rally", "usd_rally"
        summ = "ดอลลาร์แข็งค่าผิดปกติ โดยสินทรัพย์เสี่ยงยังไม่ถูกขาย — ติดตามว่าจะลามเป็นภาวะตึงตัวหรือไม่"
    return Event(
        id=idd, name=name,
        definition="Trade-weighted US dollar strengthens well beyond its normal range.",
        summary=summ, channel="fx", direction="up", severity=sev, score=t,
        rule=f"DXY 1d/5d log-change z ≥ {TRIGGER_Z}; 'squeeze' when SPY falls with it (z ≥ 1)",
        evidence=b.evidence,
    )


def _yen(F, ctx) -> Event | None:
    j = F.get("USDJPY")
    if j is None:
        return None
    t_dn, h_dn = j.strongest(-1)
    t_up, h_up = j.strongest(+1)
    b = _Book(F)
    if t_dn is not None and t_dn >= TRIGGER_Z:
        b.add(_ev(j, "trigger", h_dn, f"USD/JPY {(j.change(h_dn) or 0):+.2f}% — เยนแข็งค่า"))
        b.check("SPY", -1, "หุ้นถูกขายพร้อมกัน", thr=1.0)
        b.check("VIX", +1, "ความผันผวนเพิ่ม", thr=1.0)
        sev = grade(t_dn, b.confirms)
        if not sev:
            return None
        carry = b.confirms > 0
        return Event(
            id="yen_carry_unwind" if carry else "yen_appreciation",
            name="Yen Carry-Trade Unwind" if carry else "Sharp Yen Appreciation",
            definition="Rapid yen appreciation forcing closure of positions funded in low-yield yen.",
            summary=("เยนแข็งค่าเร็วพร้อมสินทรัพย์เสี่ยงถูกขาย — สถานะที่กู้เยนดอกเบี้ยต่ำไปลงทุนถูกบังคับปิด"
                     if carry else "เยนแข็งค่าเร็วผิดปกติ แต่สินทรัพย์เสี่ยงยังไม่ถูกขายตาม"),
            channel="fx", direction="down", severity=sev, score=t_dn,
            rule=f"USD/JPY log-change z ≤ −{TRIGGER_Z}; 'carry unwind' when SPY or VIX confirm (z ≥ 1)",
            evidence=b.evidence,
        )
    if t_up is not None and t_up >= 2.5:
        b.add(_ev(j, "trigger", h_up, f"USD/JPY {j.value:.2f} ({(j.change(h_up) or 0):+.2f}%)"))
        sev = grade(t_up, 0)
        return Event(
            id="yen_depreciation", name="Yen Depreciation Pressure",
            definition="Rapid yen weakening that raises the risk of Japanese FX intervention.",
            summary="เยนอ่อนค่าเร็วผิดปกติ — เพิ่มความเสี่ยงที่ทางการญี่ปุ่นจะเข้าแทรกแซงค่าเงิน "
                    "ซึ่งมักทำให้เยนกลับทิศแรงและกระทบ carry trade",
            channel="fx", direction="up", severity=sev, score=t_up,
            rule="USD/JPY log-change z ≥ 2.5",
            evidence=b.evidence,
        ) if sev else None
    return None


def _oil(F, ctx) -> Event | None:
    c = F.get("CRUDE")
    ovx = F.get("OVX")
    t, h, sign = None, 1, 0
    if c is not None:
        t, h = c.strongest(0)
        sign = 1 if (c.change(h) or 0) > 0 else -1
    b = _Book(F)
    if t is not None and t >= TRIGGER_Z:
        b.add(_ev(c, "trigger", h, f"WTI {(c.change(h) or 0):+.2f}% ใน {h} วัน"))
        b.check("OVX", +1, "ความผันผวนน้ำมันพุ่ง")
    elif ovx is not None and (ovx.strongest(+1)[0] or 0) >= TRIGGER_Z:
        t, h = ovx.strongest(+1)
        b.add(_ev(ovx, "trigger", h, "ความผันผวนคาดการณ์ของน้ำมันพุ่ง"))
        if c is not None:
            b.add(_ev(c, "context", 1, "ราคา WTI"))
            sign = 1 if (c.chg1 or 0) > 0 else -1
    else:
        return None
    if sign < 0:
        b.check("SPY", -1, "หุ้นร่วงตาม — สัญญาณอุปสงค์อ่อน", thr=1.0)
    sev = grade(t, b.confirms)
    if not sev:
        return None
    up = sign >= 0
    return Event(
        id="oil_supply_shock" if up else "oil_demand_shock",
        name="Oil Supply Shock" if up else "Oil Demand Shock",
        definition=("Sharp rise in crude prices/volatility — an energy cost shock to inflation and margins."
                    if up else "Sharp fall in crude prices — typically a signal of weakening global demand."),
        summary=("ราคาน้ำมัน/ความผันผวนน้ำมันพุ่งผิดปกติ — ต้นทุนพลังงานกดดันเงินเฟ้อและกำไรบริษัท"
                 if up else "ราคาน้ำมันร่วงผิดปกติ — มักสะท้อนอุปสงค์โลกที่อ่อนลง"),
        channel="commodities", direction="up" if up else "down", severity=sev, score=t,
        rule=f"|WTI log-change| z ≥ {TRIGGER_Z} or OVX change z ≥ {TRIGGER_Z}",
        evidence=b.evidence,
    )


def _gold(F, ctx) -> Event | None:
    g, gvz = F.get("GLD"), F.get("GVZ")
    if g is None:
        return None
    t, h = g.strongest(0)
    tv = gvz.strongest(+1)[0] if gvz is not None else None
    if (t is None or t < 2.5) and (tv is None or tv < TRIGGER_Z):
        return None
    move = g.change(h) or 0.0
    b = _Book(F)
    if t is not None and t >= 2.5:
        b.add(_ev(g, "trigger", h, f"ทองคำ {move:+.2f}% ใน {h} วัน"))
        b.check("GVZ", +1, "ความผันผวนทองคำพุ่ง")
    else:
        t, h2 = gvz.strongest(+1)
        b.add(_ev(gvz, "trigger", h2, "ความผันผวนทองคำพุ่ง"))
        b.add(_ev(g, "context", 1, "ราคาทองคำ"))
        move = g.chg1 or 0.0
    sev = grade(t, b.confirms)
    if not sev:
        return None
    up = move >= 0
    return Event(
        id="haven_demand" if up else "haven_liquidation",
        name="Safe-Haven Demand Surge" if up else "Safe-Haven Liquidation",
        definition=("Abnormal bid for gold — hedging against monetary or geopolitical risk."
                    if up else "Abnormal selling of gold — often forced selling to raise cash or margin."),
        summary=("ทองคำถูกไล่ซื้อผิดปกติ — ป้องกันความเสี่ยงค่าเงิน/นโยบายการเงิน/ภูมิรัฐศาสตร์"
                 if up else "ทองคำถูกเทขายผิดปกติ — มักเป็นการขายเพื่อหาเงินสดหรือวางหลักประกัน"),
        channel="commodities", direction="up" if up else "down", severity=sev, score=t,
        rule="|GLD log-change| z ≥ 2.5 or GVZ change z ≥ 2",
        evidence=b.evidence,
    )


def _tech_unwind(F, ctx) -> Event | None:
    q, s = F.get("QQQ"), F.get("SPY")
    rel = ctx.get("qqq_spy_rel_z")
    if q is None or s is None or rel is None or rel > -TRIGGER_Z:
        return None
    b = _Book(F)
    b.add(_ev(q, "trigger", 1, f"QQQ {(q.chg1 or 0):+.2f}% vs SPY {(s.chg1 or 0):+.2f}% "
                               f"(ส่วนต่าง z {rel:+.2f})"))
    vz = ctx.get("vxn_vix_spread_z")
    if vz is not None and vz >= CONFIRM_Z:
        b.confirms += 1
        b.add(_ev_level("VXN", vz, "confirm", f"VXN−VIX spread z63 {vz:+.2f} — ความเสี่ยงกระจุกในเทค"))
    sev = grade(-rel, b.confirms)
    return Event(
        id="tech_unwind", name="Technology Concentration Unwind",
        definition="Mega-cap technology underperforms the broad market sharply — crowded "
                   "positioning being reduced.",
        summary="หุ้นเทคโนโลยีขนาดใหญ่แย่กว่าตลาดรวมผิดปกติ — สถานะที่กระจุกในเทคถูกลดลง",
        channel="equity", direction="down", severity=sev, score=-rel,
        rule=f"log(QQQ/SPY) change z ≤ −{TRIGGER_Z}; confirm: VXN−VIX spread z63 ≥ {CONFIRM_Z}",
        evidence=b.evidence,
    ) if sev else None


def _correlation(F, ctx) -> Event | None:
    v1, v3 = ctx.get("dcc_v1"), ctx.get("dcc_v3")
    rank = {"SPIKE": 2.0, "EXTREME": 3.0}
    t = max(rank.get(v1, 0.0), rank.get(v3, 0.0))
    if t < TRIGGER_Z:
        return None
    b = _Book(F)
    b.add(_ev_level("DCC", None, "trigger", f"DCC V1 {v1} · HMM {v3}"))
    if rank.get(v1, 0) and rank.get(v3, 0):
        b.confirms += 1
    sev = grade(t, b.confirms)
    return Event(
        id="correlation_spike", name="Cross-Asset Correlation Spike",
        definition="Correlations across equities, bonds, gold and credit converge toward one — "
                   "diversification failing.",
        summary="สินทรัพย์ต่างประเภทเริ่มเคลื่อนไหวไปทางเดียวกัน — การกระจายความเสี่ยงใช้ไม่ได้ผล",
        channel="cross_asset", direction=None, severity=sev, score=t,
        rule="EWMA-DCC ≥ SPIKE or HMM crisis state ≥ SPIKE (7-asset pool)",
        evidence=b.evidence,
    ) if sev else None


def _liquidation(F, ctx) -> Event | None:
    vol, s = F.get("SPY_VOL"), F.get("SPY")
    if vol is None or s is None or vol.lz63 is None or s.z1 is None:
        return None
    if vol.lz63 < TRIGGER_Z or s.z1 > -1.5:
        return None
    b = _Book(F)
    b.add(_ev_level("SPY_VOL", vol.lz63, "trigger", f"ปริมาณซื้อขาย SPY z63 {vol.lz63:+.2f}"))
    b.add(_ev(s, "confirm", 1, f"SPY {(s.chg1 or 0):+.2f}%"))
    rsi, fg = ctx.get("rsi"), ctx.get("fear_greed")
    if rsi is not None and rsi < 35:
        b.confirms += 1
        b.add(_ev_level("RSI", rsi, "confirm", f"SPY RSI {rsi:.1f} < 35"))
    if fg is not None and fg < 25:
        b.confirms += 1
        b.add(_ev_level("FG", fg, "confirm", f"Fear & Greed {fg:.0f} < 25"))
    sev = grade(vol.lz63, b.confirms)
    return Event(
        id="forced_liquidation", name="Forced Liquidation",
        definition="Heavy-volume selling consistent with deleveraging or margin-driven exits.",
        summary="การขายด้วยปริมาณสูงผิดปกติ — ลักษณะของการลดหนี้/ถูกบังคับขาย ไม่ใช่แค่ความกังวล",
        channel="equity", direction="down", severity=sev, score=vol.lz63,
        rule="SPY volume z63 ≥ 2 with SPY z1 ≤ −1.5; confirm: RSI < 35, Fear & Greed < 25",
        evidence=b.evidence,
    ) if sev else None


DECOMP_GROUPS = {
    "real_rates": ("UST5Y", "REAL5", "BE5", "UST10Y", "REAL10", "BE10"),
    "energy": ("CRUDE", "BRENT", "BRENT_WTI", "HO", "DIESEL_CRACK", "RB", "GAS_CRACK", "CRACK_321"),
}


def key_rolls(key: str) -> bool:
    return key in ROLL_LEGS


def _pctile_1y(s: pd.Series) -> float | None:
    s = s.tail(252)
    return None if len(s) < 60 else float((s <= s.iloc[-1]).mean() * 100)


def decomposition(p: Prepared, asof: pd.Timestamp, F: dict[str, Reading]) -> dict:
    """Level, change, z and 1-year percentile for the two decompositions the
    TAIL panel shows: nominal = real + breakeven, and crude → product margins."""
    out: dict[str, list[dict]] = {}
    for group, keys in DECOMP_GROUPS.items():
        rows = []
        for k in keys:
            r = F.get(k)
            if r is None:
                rows.append({"key": k, "label": LABEL.get(k, k), "value": None})
                continue
            pct = _pctile_1y(p.raw[k].loc[:asof])
            official = p.estimated_from.get(k)
            rows.append({
                "key": k, "label": LABEL.get(k, k), "short": SHORT.get(k, k), "unit": _unit(k),
                "level_unit": "%" if KIND.get(k) == "bp" else UNIT_OVERRIDE.get(k, ""),
                "value": None if r.value is None else round(r.value, 3),
                "change": None if r.chg1 is None else round(r.chg1, 2),
                "change5": None if r.chg5 is None else round(r.chg5, 2),
                "z1": None if r.z1 is None else round(r.z1, 2),
                "pctile_1y": None if pct is None else round(pct),
                "date": r.date,
                "estimated": bool(official and r.date and r.date > official),
                # Change blanked because a futures leg switched contract that session.
                "roll_day": key_rolls(k) and r.chg1 is None and r.value is not None,
            })
        out[group] = rows
    return out


RULES = (
    _rates_vol_shock, _treasury_repricing, _real_yield_shock, _policy_repricing,
    _equity_vol_shock, _tail_hedging, _equity_selloff, _tech_unwind, _liquidation,
    _flight_to_quality, _joint_drawdown, _correlation,
    _credit_widening, _financial_conditions,
    _dollar, _yen, _oil, _refining_margins, _brent_wti, _gold,
)


def classify(F: dict[str, Reading], ctx: dict | None = None) -> list[Event]:
    ctx = ctx or {}
    out: list[Event] = []
    for rule in RULES:
        try:
            ev = rule(F, ctx)
        except Exception as exc:  # one malformed input must not blank the panel
            print(f"[tail_events] {rule.__name__} failed: {exc}")
            ev = None
        if ev is None:
            continue
        if ctx.get("catalyst"):
            ev.catalyst = ctx["catalyst"]
        out.append(ev)
    out.sort(key=lambda e: (-SEV_RANK[e.severity], -e.score))
    return out


# ─── Composite floor ──────────────────────────────────────────────────────────

RISK_ORDER = ("NORMAL", "CAUTION", "ELEVATED", "HIGH")


def event_floor(events: list[Event]) -> tuple[str, str]:
    """Minimum composite level the events justify, and the rule that set it.

    Counted per channel, not per event: a rates-vol shock and a bear steepener
    on the same day are one observation about the rates channel.
    """
    by_ch: dict[str, int] = {}
    for e in events:
        by_ch[e.channel] = max(by_ch.get(e.channel, 0), SEV_RANK[e.severity])
    severe = sorted(c for c, r in by_ch.items() if r >= 3)
    active = sorted(c for c, r in by_ch.items() if r >= 2)
    names = lambda cs: ", ".join(CHANNEL_LABEL.get(c, c) for c in cs)  # noqa: E731
    if len(severe) >= 3:
        return "HIGH", f"SEVERE events in 3+ channels ({names(severe)})"
    if severe and len(active) >= 2:
        return "ELEVATED", f"SEVERE in {names(severe)} with ACTIVE+ in {len(active)} channels"
    if severe:
        return "CAUTION", f"SEVERE event in {names(severe)}"
    if len(active) >= 2:
        return "CAUTION", f"ACTIVE events in 2+ channels ({names(active)})"
    return "NORMAL", "no event at ACTIVE+ in 2 channels, none SEVERE"


def event_floor_from_dicts(events: list[dict]) -> tuple[str, str]:
    """`event_floor` over the serialised payload (what the router holds)."""
    shim = [Event(id=e["id"], name=e["name"], definition="", summary="", channel=e["channel"],
                  direction=None, severity=e["severity"], score=float(e.get("score") or 0),
                  rule="", evidence=[]) for e in events]
    return event_floor(shim)


def max_level(a: str, b: str) -> str:
    return a if RISK_ORDER.index(a) >= RISK_ORDER.index(b) else b


# ─── Catalysts ────────────────────────────────────────────────────────────────


def catalyst_for(d: date, catalysts: list[tuple[str, str]], bdays: int = 1) -> str | None:
    """Scheduled releases within ±`bdays` business days of `d` — a move into
    an FOMC decision is the market pricing that decision."""
    hits = []
    for ds, kind in catalysts:
        try:
            ed = date.fromisoformat(ds)
        except ValueError:
            continue
        lo, hi = sorted((d, ed))
        if int(np.busday_count(lo, hi)) <= bdays:
            hits.append(f"{kind} {ds[5:]}")
    return ", ".join(dict.fromkeys(hits)) or None


# ─── Runner ───────────────────────────────────────────────────────────────────


def run(panel: pd.DataFrame, *, anchor: str = "SPY", snapshot_ctx: dict | None = None,
        catalysts: list[tuple[str, str]] | None = None, log_sessions: int = 20) -> dict:
    """Classify the latest session and the `log_sessions` before it.

    The evaluation calendar is `anchor`'s own bars — the US cash session — so a
    Yahoo series that has already printed tomorrow's FX bar does not create an
    evaluation date on which half the inputs are missing.
    """
    catalysts = catalysts or []
    if panel is None or panel.empty or anchor not in panel.columns:
        return {"asof": None, "events": [], "log": [], "inputs": []}
    p = prepare(panel)
    dates = panel[anchor].dropna().index
    if len(dates) == 0:
        return {"asof": None, "events": [], "log": [], "inputs": []}

    # 63-session stock–bond correlation, for context on joint drawdowns.
    rc = None
    if "SPY" in panel and "TLT" in panel:
        r = np.log(panel[["SPY", "TLT"]].dropna()).diff().dropna()
        if len(r) >= 63:
            rc = r["SPY"].rolling(63).corr(r["TLT"])
    rel_z = None
    if "QQQ" in panel and "SPY" in panel:
        both = panel[["QQQ", "SPY"]].dropna()
        if len(both) > Z_MIN:
            rel = np.log(both["QQQ"] / both["SPY"]).diff() * 100
            rel_z = _z_of_change(rel)

    # 1-year percentile of the margin LEVELS — a crack at the 95th percentile
    # is information even on a day it did not move.
    pct_series = {
        k: p.raw[k].rolling(252, min_periods=120).apply(lambda w: (w <= w[-1]).mean() * 100, raw=True)
        for k in ("DIESEL_CRACK", "CRACK_321", "GAS_CRACK", "BRENT_WTI") if k in p.raw
    }

    log: list[dict] = []
    latest: list[Event] = []
    for i, d in enumerate(reversed(dates[-(log_sessions + 1):])):
        F = readings_at(p, d)
        ctx: dict = {"catalyst": catalyst_for(d.date(), catalysts), "date": d.strftime("%Y-%m-%d")}
        if rc is not None and d in rc.index:
            ctx["stock_bond_corr"] = _num(rc.get(d))
        if rel_z is not None and d in rel_z.index:
            ctx["qqq_spy_rel_z"] = _num(rel_z.get(d))
        ctx["pctile"] = {k: _num(ps.get(d)) for k, ps in pct_series.items() if d in ps.index}
        if i == 0:
            ctx.update(snapshot_ctx or {})
        evs = classify(F, ctx)
        if i == 0:
            latest = evs
        if evs:
            log.append({
                "date": d.strftime("%Y-%m-%d"),
                "catalyst": ctx.get("catalyst"),
                "events": [{"id": e.id, "name": e.name, "severity": e.severity,
                            "channel": e.channel} for e in evs],
            })

    asof = dates[-1]
    F_now = readings_at(p, asof)
    inputs = [
        {
            "key": k, "label": LABEL.get(k, k), "value": None if r.value is None else round(r.value, 4),
            "change": None if r.chg1 is None else round(r.chg1, 2), "unit": _unit(k),
            "z1": None if r.z1 is None else round(r.z1, 2),
            "z5": None if r.z5 is None else round(r.z5, 2), "date": r.date,
        }
        for k, r in sorted(F_now.items())
    ]
    missing = sorted(set(KIND) - set(F_now))
    return {
        "decomposition": decomposition(p, asof, F_now),
        "asof": asof.strftime("%Y-%m-%d"),
        "events": [e.as_dict() for e in latest],
        "log": log,
        "inputs": inputs,
        "inputs_missing": missing,
    }
