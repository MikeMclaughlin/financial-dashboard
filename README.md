# Global Macro: Dollar, Rates & G10

Is capital leaving the euro?

A static dark-theme dashboard. Real series are fetched by GitHub Actions (no API keys, no paid data) and committed as JSON under `data/`. The site only reads those files. Version **1.0**.

The three tiles that were in the original additional-indicators mock and are **not** built: EUR/USD cross-currency basis, EUR/USD implied volatility and risk reversal, and equity fund flows (US vs Europe).

## Run locally

```bash
npm ci
npm run fetch
python3 -m http.server 4173
```

Open `http://127.0.0.1:4173`. Health JSON is at `data/health.json`. On Vercel, `/api/health` and `/health.json` rewrite to that file.

`npm run fetch` runs the non-Yahoo sources, then the Yahoo step, then `scripts/verify.mjs`. Either step keeps the previous JSON for a series that fails its range check.

## Architecture

- `index.html`, `css/styles.css`, `js/app.js`, `js/charts.js` — no build step.
- `scripts/fetch-core.mjs` — every source except Yahoo. Each series is isolated: a failure records `status` and `error` and leaves the last good points in place.
- `scripts/fetch-yahoo.mjs` — DXY, fed-funds futures, gold, oil, and the G10 Yahoo cross-check. This step is allowed to fail alone (`continue-on-error` in Actions).
- `scripts/verify.mjs` — recomputes changes, spreads, the 200-day average, and the CFTC net identity. It writes `data/verification.json` and exits non-zero only when a required series has no points or the stored math does not match.
- `scripts/scrape-calendars.mjs` — re-reads the official central-bank pages and **fails if they differ** from `data/meetings.json`. It does not rewrite that file. `--write` is a local bootstrap only.
- `.github/workflows/refresh-data.yml` — commits updated JSON.
- `.github/workflows/check-calendars.yml` — monthly calendar diff.

The page never clears a card just because a refresh is in progress. Placeholders (`—` / “Unavailable”) appear only when a series has never been loaded. A stale file keeps its previous points and is labeled with `status: "stale"`.

## Refresh cadence

All times are UTC. Schedules run from the default branch after this PR is merged.

| Workflow | When | What |
|---|---|---|
| Refresh market data | Weekdays 22:30 | Full core fetch, then Yahoo |
| Refresh market data | Weekdays 13:30 | Same pipeline. Bundesbank yields are published the next European morning, so this pass picks up the Bunds. |
| Refresh market data | Friday 21:00 and Saturday 21:00 | Same pipeline, timed for the CFTC commitments release and a retry. |
| Refresh market data | `workflow_dispatch` | Manual run |
| Check calendars | 08:15 on the 1st of each month, plus `workflow_dispatch` | Scrape vs `data/meetings.json`. A diff fails the job. |

CFTC paging uses `$order=report_date_as_yyyy_mm_dd,cftc_contract_market_code`, a stable unique key, and dedupes on that key. Auction rows are deduped on CUSIP.

## Chart period

The header selector is 30 / 90 / 180 / 365 days and defaults to 90. It drives the EUR/USD chart, the 2s10s and price sparklines, CFTC bars, the US–Germany 2Y gap, the Bund–Treasury spread, real yields, gold and oil, and auction bars.

It does **not** move the G10 heatmap (fixed 1D / 1W / 1M / 90D), the Treasury curve snapshot (today / 45 days / 90 days), the Fed/ECB path (next 12 months), or the 90-day central-bank calendar.

## How a currency’s move is signed

ECB reference rates are quoted as foreign currency per 1 euro. The dollar price of 1 unit of currency X is `(USD per EUR) / (X per EUR)`. Percent changes use that dollar price. **Positive means X strengthened versus the dollar** (blue). Negative means it weakened (orange). EUR itself is the ECB USD-per-EUR series.

The written shorthand “USD/X = EURX / EURUSD” is the inverse of this (units of X per dollar). The dashboard follows the sign rule in the spec, not that shorthand.

## Sources, fallbacks, and lag

| Series | Primary | Fallback | Typical lag |
|---|---|---|---|
| EUR/USD | [ECB EXR D.USD.EUR.SP00.A](https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?format=csvdata&startPeriod=1999-01-01) from 1999 | Keep last good | ECB fixing, same day after 14:15 CET. The 200-day average is computed on the full history, then the JSON keeps the latest 900 sessions plus `historyCount`. |
| Dollar index | Yahoo `DX-Y.NYB` (ICE DXY is not free) | FRED `DTWEXBGS`. The card title becomes **Broad USD index (Fed)** and shows that series’ own as-of. It is a different basket. | Yahoo is same day. The Fed broad index lags and is a business-day series. |
| US yields | Treasury [daily yield curve CSV](https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/2026/all?type=daily_treasury_yield_curve&field_tdr_date_value=2026&page&_format=csv), current and prior year | FRED `DGS10` for the 10-year | Treasury updates after the New York close. |
| 2s10s | Treasury 10-year minus 2-year, in basis points | Cross-check FRED `T10Y2Y` when FRED answers | Same as Treasury. |
| G10 vs USD | One ECB EXR call for USD, JPY, GBP, CHF, CAD, AUD, NZD, SEK, NOK per EUR, from 2024 | Keep last good. Second look: FRED H.10 (`DEXUSEU`, `DEXJPUS`, `DEXUSUK`, `DEXSZUS`, `DEXCAUS`, `DEXUSAL`, `DEXUSNZ`, `DEXSDUS`, `DEXNOUS`) and Yahoo spot. | FRED H.10 usually lags about a week. Yahoo is a market quote, not the ECB fixing; gaps under 1% are not flagged. |
| EUR positioning | CFTC legacy futures-only EURO FX `099741` via Socrata `6dca-aqww`. Net = noncommercial long − short. | Keep last good | Weekly. Tuesday positions, released Friday. |
| German 2Y and 10Y | Bundesbank BBSIS daily, `R02XX` and `R10XX`. Semicolon CSV, comma decimals. | Keep last good | Next business day. |
| US–Germany 2Y gap | US 2Y minus German 2Y on dates present in **both** series | — | Limited by the slower of the two. |
| Bund–Treasury 10Y | German 10Y minus US 10Y (negative when Europe yields less) | — | Same. |
| Treasury curve | 3M, 2Y, 5Y, 10Y, 30Y from the Treasury CSV: latest, on-or-before 45 days, on-or-before 90 days | — | Same as Treasury. |
| 10Y spreads | See the country table below. Each spread uses the **same** US 10-year series, on the closest Treasury date on or before that country’s own date. | Keep last good | Mixed. Badges say `monthly` and `delayed`. |
| Fed path | Yahoo `ZQ<month><yy>.CBT` next 12 contracts. Implied rate = `100 − price`, anchored to FRED `DFF`. | Anchor: NY Fed EFFR. Whole path, if fewer than 8 contracts print: Treasury 3M / 6M / 1Y / 2Y, labeled as a proxy. | Futures are same day. EFFR is the previous business day. |
| ECB path | Always a **proxy**. €STR plus the ECB AAA yield curve `SV_C_YM` spot rates `SR_3M`, `SR_6M`, `SR_1Y`. `SR_2Y` and instantaneous forward `IF_1Y` are shown in the caption. There is no free OIS curve. | Keep last good | €STR is the previous business day. |
| US 10Y real yield | FRED `DFII10` | Treasury daily real yield curve, 10-year. The card is retitled when the fallback is showing. | Treasury real curve is same day as the nominal curve. FRED can lag a day. |
| Gold | Yahoo `GC=F` | Yahoo `GLD`, labeled delayed (it is an ETF, not the futures price) | Same day, or delayed on the ETF fallback. |
| Oil | Yahoo `CL=F` | FRED `DCOILWTICO` (about a week lag), labeled delayed | Same day, or the FRED lag. Stooq is not used. |
| Auction demand | TreasuryDirect `TA_WS/securities/auctioned`. **Notes and Bonds only.** Bills are excluded. TIPS are included when TreasuryDirect types them as a note or bond. | Keep last good | Auction day. |
| Central-bank dates | Hardcoded `data/meetings.json` from the Fed, ECB (decision = day 2), BoE, and BoJ pages listed in that file. The same ECB list, including 2025–2026 press-release dates, places the “ECB decision” marker. | The monthly job fails rather than editing the file | Official calendars. |

### 10-year government yields

| Country | Source | Frequency |
|---|---|---|
| Germany | Bundesbank BBSIS 10-year | Daily |
| Japan | MOF English history `jgbcme_all.csv` plus the current-month file `https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv` (Shift-JIS, not the `/english/` path) | Daily |
| Canada | Bank of Canada Valet `BD.CDN.10YR.DQ.YLD` | Daily |
| Australia | RBA F2, column “Australian Government 10 year bond” (metadata rows skipped) | Daily, often a few days behind the publication date |
| France, Italy, Switzerland | OECD SDMX `DSD_STES@DF_FINMARK` `IRLT` monthly. That is the dataset behind FRED `IRLTLT01FRM156N`, `IRLTLT01ITM156N`, and `IRLTLT01CHM156N`. FRED’s own graph CSV is attempted and, when it does not answer, OECD is read directly. | Monthly, often several weeks stale. Always badged `monthly`. |

France and Italy are also compared with the ECB IRS long-term rate. Germany, Japan, Canada, Australia, and the US are compared with the OECD monthly average of the daily series. A same-month gap above 25 bp is flagged.

## Range checks before a file is replaced

A failed check keeps the previous file and sets `status: "stale"`.

- EUR/USD last print 0.70–1.80, history starts in 1999 and has at least 5,000 observations. 200-day average must land on the same date as the spot.
- Dollar index 70–140 (broad index 70–160).
- Treasury tenors on the latest row 0–15%. 2s10s between −500 and +500 bp.
- G10 90-day moves inside ±40%. Dollar prices inside per-currency bands (yen about 0.003–0.02 USD, euro 0.70–1.80, and so on).
- CFTC: `net = long − short` and the absolute net does not exceed open interest.
- Bond yields −2–20%. Spreads −800–+400 bp. Monthly bars must carry a `monthly` badge. The same US 10-year date must carry the same US yield.
- Bid-to-cover 0.8–8, and the sample average 1.5–4.5.
- Real yield −3–8%. Policy-rate points −1–15%.
- Gold futures 500–10,000. Oil 20–250.

## `/data` schema

Every series file has `id`, `status` (`ok`, `stale`, `error`, `partial`), `asOf` (`YYYY-MM-DD` of the last observation), `fetchedAt`, `source`, and `error` (null when healthy). `fallback: true` means a backup source is what the file contains. `proxy: true` means the series is not the market instrument named in the title.

`data/health.json` (also served as `/api/health`):

```json
{
  "version": "1.0",
  "generatedAt": "ISO-8601",
  "status": "ok",
  "series": {
    "eurusd": { "status": "ok", "asOf": "YYYY-MM-DD", "fallback": false, "proxy": false, "source": "...", "error": null }
  }
}
```

Points are `{ "date", "value" }` unless noted.

| File | Extra fields |
|---|---|
| `eurusd.json` | `historyStart`, `historyCount`, `ma200` |
| `dxy.json` | `fallback`. Name is `Broad USD index (Fed)` when the Fed index is showing. |
| `broad-usd.json` | FRED `DTWEXBGS`, kept even when DXY is primary |
| `treasury.json` | Tenor keys `3mo`, `6mo`, `1yr`, `2yr`, `5yr`, `10yr`, `30yr` in percent. `fredCheck` holds the DGS10 / T10Y2Y comparison. |
| `fx.json` | `levels[CCY]`, `changes[CCY]` for `1D`, `1W`, `1M`, `90D`, and `verification` (FRED) |
| `fx-yahoo.json` | Nine Yahoo spot checks with `diffPct` and `flag` |
| `cftc.json` | `long`, `short`, `openInterest`, `net` |
| `bunds.json` | `de2y`, `de10y` in percent |
| `bonds.json` | `bars[]` with `yield`, `asOf`, `us10y`, `us10yDate`, `spreadBp`, `badges`, `frequency` |
| `ecb-path.json` | `anchor`, `points` (`SR_3M/6M/1Y`), `spot2Y`, `forward1Y`. `proxy: true` |
| `fed-path.json` | `anchor`, `points` (futures `value` is the implied rate). `proxy: true` on the Treasury fallback. |
| `real-yield.json` | `fallback` when the Treasury real curve replaced DFII10 |
| `commodities.json` | `gold` and `oil`, each with `points`, `fallback`, `delayed` |
| `auctions.json` | `auctions[]`: `cusip`, `date`, `securityType`, `securityTerm`, `tips`, `bidToCover`, `highYield` |
| `meetings.json` | `meetings[]`: `bank`, `decisionDate`, `startDate`, `endDate`, `source` |
| `verification.json` | Recompute log and second-source flags |

Dates are ISO `YYYY-MM-DD`. Yields are percent, not decimals. Spreads and the 2s10s card are basis points. FX changes are percent. CFTC is contracts. Auction demand is the bid-to-cover ratio.

## Deploy

Vercel serves this directory as a static site. `vercel.json` rewrites `/api/health` and `/health.json` to `data/health.json`. Connect the GitHub repository so the default branch and pull requests get a deployment when data JSON changes. No environment variables and no API keys.

The Actions cron does not run until the workflow files are on the default branch.
