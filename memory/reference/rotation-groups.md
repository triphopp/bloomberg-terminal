# ROT groups — what each group is, and where its members come from

**Audited:** 2026-10-23 (membership as of 2026-10-21) · **Code:** `backend/sector_membership.py`, `backend/routers/rotation.py`,
`backend/reference_data/set_sectors.tsv` · **Tests:** `backend/tests/test_sector_membership.py` pins every finding below
**UI:** MKT → STRUCTURE → ROT → click a row → every member (name, weight, cap, last, 1D/1W/1M/3M, 1M vs bench, quadrant) →
click = stock page, shift+click = chart window (`views/rotation-members.tsx`)

The rule: a group is its **published** definition, never a guess. Three authorities:

| Group kind | Authority | Members come from | Weight |
|---|---|---|---|
| US sector (11) | **GICS** (MSCI / S&P DJI), via the Select Sector SPDR that tracks each S&P Select Sector index = the S&P 500 members of that GICS sector | State Street's daily holdings file of the fund — every holding | % of fund (capped market-cap) |
| US theme (24) | none exists — a theme **is** its ETF | State Street's file for KBE / XHB / XRT; Yahoo `funds_data.top_holdings` (top 10, labelled TOP 10) for the rest | % of fund |
| TH industry group (8) / sector (27) | **The Stock Exchange of Thailand**'s own classification | `reference_data/set_sectors.tsv` = the SET's sector composition, all 700 SET-board members | % of the group's market cap (SET figure) |

**Never fill a group from Yahoo's `sector` field.** Yahoo uses Morningstar's sectors ("Consumer Cyclical",
"Financial Services", "Basic Materials") — neither GICS nor SET. The heatmap (`routers/market_heatmap.py`) groups by
Yahoo's screener sectors and is therefore NOT reusable for ROT membership.

## Sources (each checked 2026-10-23)

| Source | URL | What | Access |
|---|---|---|---|
| State Street holdings, per fund | `https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-<ticker>.xlsx` | Name, ticker, CUSIP, SEDOL, weight, shares; "As of" date in row 3 | ✅ plain GET, free, no key (one 301 from `/us/en/intermediary/...`) |
| SET sector composition | page `https://www.set.or.th/en/market/index/set/<industry>/<sector>` → its XHR `/api/set/index/<sector>/composition?lang=en` | symbol, name, industry, sector, market cap, `statisticsAsOf` | ⚠️ browser only — scripts get HTTP 403 (Incapsula). Do not try to get round it; refresh by hand (below) |
| SET listed-company list | `https://www.set.or.th/dat/eod/listedcompany/static/listedCompanies_en_US.xls` | — | ❌ same bot wall |
| Yahoo fund holdings | `yf.Ticker(etf).funds_data.top_holdings` | top 10 + `Holding Percent` | ✅ top 10 only — labelled as such |
| Fund names / objectives | `yf.Ticker(etf).info.longName` + `funds_data.description` (secondary); issuer pages (primary) | used for the theme audit | ✅ |

## US sectors — GICS

All 11 GICS sectors are present, each mapped to the right SPDR. The labels were abbreviations and one was wrong in
name ("Technology"); they are now GICS's own names.

| GICS | Sector | ETF | Before | Verdict |
|---|---|---|---|---|
| 45 | Information Technology | XLK | "Technology (XLK)" | relabelled — GICS name is Information Technology |
| 40 | Financials | XLF | same | ✅ |
| 35 | Health Care | XLV | same | ✅ |
| 10 | Energy | XLE | same | ✅ |
| 20 | Industrials | XLI | same | ✅ |
| 25 | Consumer Discretionary | XLY | "Cons Discret (XLY)" | relabelled |
| 30 | Consumer Staples | XLP | "Cons Staples (XLP)" | relabelled |
| 60 | Real Estate | XLRE | same | ✅ |
| 55 | Utilities | XLU | same | ✅ |
| 15 | Materials | XLB | same | ✅ |
| 50 | Communication Services | XLC | "Comm Svcs (XLC)" | relabelled |

Caveat that stays: a Select Sector index caps single-name weights (e.g. XLK: NVDA 15.6 %, AAPL 14.6 % on
2026-10-21), so the ETF's weights are not the sector's raw market-cap shares. Membership is exact; weight is the fund's.

## US themes — the fund is the definition

| Label now | ETF | Fund (what it holds) | Change |
|---|---|---|---|
| Banks | KBE | SPDR S&P Bank ETF — S&P Banks Select Industry. State Street file 2026-10-21: regional/diversified banks, custody banks (BK, NTRS) — **no brokers** (no SCHW, GS, MS) | was "Banks & Brokers" |
| Airlines | JETS | U.S. Global Jets ETF — airline-focused index | was "Travel & Airlines" (no hotels, cruise, booking) |
| Aerospace & Defense | ITA | iShares U.S. Aerospace & Defense — DJ US Select Aerospace & Defense | was "Defense" |
| China Internet | KWEB | KraneShares CSI China Internet ETF | was "China Tech" |
| Space & Defense | ARKX | ARK **Space & Defense** Innovation ETF (renamed by ARK) | was "Space" |
| Homebuilders | XHB | SPDR S&P Homebuilders — S&P Homebuilders Select Industry; also holds building products, furnishings, home-improvement retail (ITB is the pure builder fund) | label = the index's own name; note added |
| Genomics · Biotech · Pharma · Fintech & Payments · Cybersecurity · Semiconductors · Software · AI & Robotics · Cloud · Quantum · Solar · Gold Miners · Nuclear & Uranium · Crypto-linked · Mag 7 · Oil Services · Retail · Innovation (ARKK) | ARKG · IBB · PPH · FINX · CIBR · SMH · IGV · BOTZ · SKYY · QTUM · TAN · GDX · URA · BITQ · MAGS · OIH · XRT · ARKK | as named by each fund (`sector_membership.THEMES` keeps the fund's name beside the label) | ✅ unchanged |

## Thailand — the SET's 8 industry groups and 28 sectors

**Before:** 13 hand-picked "liquid representative" baskets (3–5 names each, equal-weight) with home-made names.
Checked against the SET's composition, four of the 50 names were in the wrong group or gone:

| Symbol | Was in | SET says | |
|---|---|---|---|
| SCGP | "Petrochem" | **PKG** Packaging (INDUS) | mis-mapped |
| MINT | "Food & Bev" | **TOURISM** Tourism & Leisure (SERVICE) | mis-mapped |
| AWC | "Tourism" | **PROP** Property Development (PROPCON) | mis-mapped |
| INTUCH | "ICT" | not listed — merged into GULF (Gulf Development, ENERG) 2025 | stale |

The baskets also left out large members of their own groups (e.g. CPN in property, GPSC / OR in energy, DIF / 3BBIF
in ICT, CCET in electronics), and 14 of the SET's 27 populated sectors had no row at all.

**Now:** every SET industry group and every sector with a listed member (MINE has none today) — 35 rows, named and
coded as the SET names them. Industry groups: AGRO Agro & Food Industry · CONSUMP Consumer Products · FINCIAL
Financials · INDUS Industrials · PROPCON Property & Construction · RESOURC Resources · SERVICE Services · TECH Technology.
Sectors: AGRI, FOOD | FASHION, HOME, PERSON | BANK, FIN, INSUR | AUTO, IMM, PAPER, PETRO, PKG, STEEL | CONMAT, CONS,
PF&REIT, PROP | ENERG, (MINE) | COMM, HELTH, MEDIA, PROF, TOURISM, TRANS | ETRON, ICT.

What is still an approximation, and says so on screen: the SET's own sector indices are not on Yahoo, so a group's
ROT line is a **market-cap-weighted basket of its largest members** — enough of them to reach ≥ 80 % of the group's
market cap, at most 10, at least 3 (`index_basket`), held at constant shares and chain-linked so a late listing
does not jump the level (`cap_weighted_index`). Each row's tooltip and the drill-down state N names = X % of cap;
the drill-down marks basket members with •. Membership itself is exact (all members listed). The MAP plots the 8
industry groups (27 sector trails are unreadable). Benchmark unchanged: ^SET.BK, fallback TDEX.BK.

## Refreshing `reference_data/set_sectors.tsv`

The SET refuses scripts, so the file is a dated snapshot. Refresh when a listing / delisting / reclassification
matters (the drill-down's SRC line shows the as-of date):

1. Open `https://www.set.or.th/en/market/index/set/fincial/bank` in a normal browser.
2. In that tab's DevTools console run:
   ```js
   const secs = ['AGRI','FOOD','FASHION','HOME','PERSON','BANK','FIN','INSUR','AUTO','IMM','PAPER','PETRO','PKG','STEEL',
     'CONMAT','CONS','PF&REIT','PROP','ENERG','MINE','COMM','HELTH','MEDIA','PROF','TOURISM','TRANS','ETRON','ICT'];
   const rows = []; let asOf = '';
   for (const s of secs) {
     const j = await (await fetch('/api/set/index/' + encodeURIComponent(s.toLowerCase()) + '/composition?lang=en')).json();
     for (const x of (j.composition?.stockInfos || [])) {
       asOf = asOf || (x.statisticsAsOf || '').slice(0, 10);
       rows.push([x.sectorName, x.industryName, x.symbol, Math.round((x.marketCap || 0) / 1e6),
                  (x.nameEN || '').replace(/PUBLIC COMPANY LIMITED/i, 'PCL').replace(/\|/g, '/')].join('|'));
     }
   }
   copy('# as_of: ' + asOf + '\n' + rows.join('\n'));
   ```
3. Replace the data lines of the file with the clipboard (keep the comment header, update `# as_of:`), then
   `cd backend && python -m pytest tests/test_sector_membership.py` — a sector the code does not know fails loudly;
   update the count / audited-symbol assertions if the market really changed.
