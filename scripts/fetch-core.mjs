/**
 * Fetch every non-Yahoo source independently. A failure keeps the last
 * good JSON for that series and records status/asOf. Yahoo is not called.
 */
import {
  addDays,
  assertDates,
  daysBetween,
  fetchFred,
  fetchText,
  fredHostError,
  inRange,
  isoToday,
  latestOnOrBefore,
  monthEnd,
  num,
  parseCsv,
  parseDMYMon,
  parseMDY,
  readJson,
  rebuildHealth,
  runSource,
  sortUnique,
} from "./common.mjs";

const TENOR_KEYS = ["3mo", "6mo", "1yr", "2yr", "5yr", "10yr", "30yr"];

function normHeader(h) {
  return String(h).toLowerCase().replace(/\s+/g, "");
}

function treasuryUrl(year, type) {
  return `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=${type}&field_tdr_date_value=${year}&page&_format=csv`;
}

async function fetchEurusd() {
  const text = await fetchText(
    "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?format=csvdata&startPeriod=1999-01-01",
    { timeout: 60000 },
  );
  const rows = parseCsv(text);
  const header = rows[0];
  const dateIdx = header.indexOf("TIME_PERIOD");
  const valueIdx = header.indexOf("OBS_VALUE");
  if (dateIdx < 0 || valueIdx < 0) throw new Error("ECB EUR/USD CSV missing columns");
  const points = [];
  for (const row of rows.slice(1)) {
    const date = row[dateIdx];
    const value = num(row[valueIdx]);
    if (!date || value == null) continue;
    points.push({ date, value });
  }
  const full = sortUnique(points);
  if (full.length < 5000) throw new Error(`EUR/USD history too short (${full.length})`);
  if (full[0].date > "1999-06-01") throw new Error(`EUR/USD history starts ${full[0].date}, expected 1999`);
  inRange(full.at(-1).value, 0.7, 1.8, "EUR/USD");
  const ma200 = [];
  let sum = 0;
  for (let i = 0; i < full.length; i++) {
    sum += full[i].value;
    if (i >= 200) sum -= full[i - 200].value;
    if (i >= 199) ma200.push({ date: full[i].date, value: Math.round((sum / 200) * 1e6) / 1e6 });
  }
  const keep = full.slice(-900);
  const maKeep = ma200.filter((p) => p.date >= keep[0].date);
  return {
    id: "eurusd",
    name: "EUR/USD",
    unit: "USD per EUR",
    source: "ECB EXR D.USD.EUR.SP00.A",
    sourceUrl: "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?format=csvdata&startPeriod=1999-01-01",
    historyStart: full[0].date,
    historyCount: full.length,
    maWindow: 200,
    maNote: "200-day average is the mean of 200 daily observations, computed on the full history from 1999 before the stored window is trimmed.",
    asOf: keep.at(-1).date,
    points: keep,
    ma200: maKeep,
  };
}

function validateEurusd(doc) {
  assertDates(doc.points, "eurusd");
  inRange(doc.points.at(-1).value, 0.7, 1.8, "EUR/USD");
  if (!doc.ma200?.length) throw new Error("missing 200-day average");
  if (doc.historyCount < 5000) throw new Error("full history was not used");
  const lastMa = doc.ma200.at(-1);
  if (lastMa.date !== doc.asOf) throw new Error("MA date does not match spot");
  inRange(lastMa.value, 0.7, 1.8, "EUR/USD MA");
}

async function fetchBroadUsd() {
  const points = await fetchFred("DTWEXBGS", "2024-01-01");
  if (points.length < 50) throw new Error("Broad dollar series too short");
  inRange(points.at(-1).value, 70, 160, "DTWEXBGS");
  return {
    id: "broad-usd",
    name: "Broad USD index (Fed)",
    unit: "index",
    source: "FRED DTWEXBGS",
    sourceUrl: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTWEXBGS",
    fallback: true,
    delayed: true,
    note: "Nominal Broad U.S. Dollar Index, daily. Used only when ICE DXY from Yahoo is unavailable. It is not the ICE Dollar Index.",
    asOf: points.at(-1).date,
    points: points.slice(-500),
  };
}

function validateBroad(doc) {
  if (doc.status === "error") return;
  assertDates(doc.points, "broad-usd");
  inRange(doc.points.at(-1).value, 70, 160, "DTWEXBGS");
}

function parseTreasuryCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("empty treasury csv");
  const header = rows[0].map(normHeader);
  const dateIdx = header.indexOf("date");
  if (dateIdx < 0) throw new Error("treasury csv missing Date");
  const col = {};
  for (const key of TENOR_KEYS) {
    const idx = header.indexOf(key);
    if (idx >= 0) col[key] = idx;
  }
  const points = [];
  for (const row of rows.slice(1)) {
    const date = parseMDY(row[dateIdx]);
    if (!date) continue;
    const point = { date };
    for (const key of TENOR_KEYS) {
      if (col[key] == null) continue;
      point[key] = num(row[col[key]]);
    }
    if (point["10yr"] == null && point["2yr"] == null) continue;
    points.push(point);
  }
  return points;
}

async function fetchTreasury() {
  const year = new Date().getUTCFullYear();
  const years = [year - 1, year];
  const chunks = await Promise.all(years.map((y) => fetchText(treasuryUrl(y, "daily_treasury_yield_curve"))));
  let points = sortUnique(chunks.flatMap(parseTreasuryCsv));
  if (points.length < 200) throw new Error(`treasury rows ${points.length}`);
  const last = points.at(-1);
  inRange(last["10yr"], 0, 15, "US 10Y");
  inRange(last["2yr"], 0, 15, "US 2Y");
  const curve = last["10yr"] - last["2yr"];
  inRange(curve, -5, 5, "2s10s percent");
  let fredCheck = null;
  try {
    const dgs = await fetchFred("DGS10", addDays(last.date, -40));
    const t102 = await fetchFred("T10Y2Y", addDays(last.date, -40));
    const dgsLast = latestOnOrBefore(dgs, last.date);
    const gapLast = latestOnOrBefore(t102, last.date);
    const ours = latestOnOrBefore(points, dgsLast?.date || last.date);
    fredCheck = {
      dgs10: dgsLast,
      treasury10yOnThatDate: ours ? ours["10yr"] : null,
      diffBp: dgsLast && ours ? Math.round((ours["10yr"] - dgsLast.value) * 1000) / 10 : null,
      t10y2y: gapLast,
      treasury2s10sOnThatDate: gapLast ? (latestOnOrBefore(points, gapLast.date)["10yr"] - latestOnOrBefore(points, gapLast.date)["2yr"]) : null,
    };
    if (fredCheck.diffBp != null && Math.abs(fredCheck.diffBp) > 5) {
      fredCheck.flag = `US 10Y disagrees with FRED DGS10 by ${fredCheck.diffBp} bp`;
    }
  } catch (err) {
    fredCheck = { status: "unavailable", error: err.message };
  }
  return {
    id: "treasury",
    name: "US Treasury yield curve",
    unit: "percent",
    source: `US Treasury daily yield curve CSV ${years[0]}-${years[1]}`,
    sourceUrl: treasuryUrl(year, "daily_treasury_yield_curve"),
    fallback: false,
    asOf: last.date,
    tenors: {
      "3mo": "3M",
      "6mo": "6M",
      "1yr": "1Y",
      "2yr": "2Y",
      "5yr": "5Y",
      "10yr": "10Y",
      "30yr": "30Y",
    },
    fredCheck,
    points,
  };
}

function validateTreasury(doc) {
  assertDates(doc.points, "treasury");
  const last = doc.points.at(-1);
  for (const key of ["3mo", "2yr", "5yr", "10yr", "30yr"]) {
    inRange(last[key], 0, 15, key);
  }
}

async function fetchFx() {
  const text = await fetchText(
    "https://data-api.ecb.europa.eu/service/data/EXR/D.USD+JPY+GBP+CHF+CAD+AUD+NZD+SEK+NOK.EUR.SP00.A?format=csvdata&startPeriod=2024-01-01",
    { timeout: 60000 },
  );
  const rows = parseCsv(text);
  const header = rows[0];
  const ccyIdx = header.indexOf("CURRENCY");
  const dateIdx = header.indexOf("TIME_PERIOD");
  const valueIdx = header.indexOf("OBS_VALUE");
  const perEur = {};
  for (const row of rows.slice(1)) {
    const ccy = row[ccyIdx];
    const date = row[dateIdx];
    const value = num(row[valueIdx]);
    if (!ccy || !date || value == null) continue;
    (perEur[ccy] ||= []).push({ date, value });
  }
  for (const ccy of Object.keys(perEur)) perEur[ccy] = sortUnique(perEur[ccy]);
  const needed = ["USD", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK"];
  for (const ccy of needed) {
    if (!perEur[ccy]?.length) throw new Error(`missing ECB ${ccy}`);
  }
  const eurusd = perEur.USD;
  const levels = { EUR: eurusd.map((p) => ({ date: p.date, value: p.value })) };
  for (const ccy of needed.filter((c) => c !== "USD")) {
    const byDate = new Map(perEur[ccy].map((p) => [p.date, p.value]));
    const series = [];
    for (const spot of eurusd) {
      const foreignPerEur = byDate.get(spot.date);
      if (foreignPerEur == null || foreignPerEur === 0) continue;
      series.push({ date: spot.date, value: spot.value / foreignPerEur });
    }
    levels[ccy === "USD" ? "EUR" : ccy] = series;
  }
  const order = ["EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK"];
  const changes = {};
  let asOf = eurusd.at(-1).date;
  for (const ccy of order) {
    const series = levels[ccy];
    const last = series.at(-1);
    if (last.date < asOf) asOf = last.date;
    const windows = { "1D": null, "1W": -7, "1M": -30, "90D": -90 };
    const row = {};
    for (const [label, back] of Object.entries(windows)) {
      const then = label === "1D"
        ? series[series.length - 2]
        : latestOnOrBefore(series, addDays(last.date, back));
      if (!then || then.date >= last.date || then.value === 0) {
        row[label] = null;
        continue;
      }
      const pct = (last.value / then.value - 1) * 100;
      if (Math.abs(pct) > 40) throw new Error(`${ccy} ${label} move ${pct.toFixed(2)}% failed the range check`);
      row[label] = Math.round(pct * 100) / 100;
    }
    changes[ccy] = row;
    const bounds = {
      EUR: [0.7, 1.8], JPY: [0.003, 0.02], GBP: [0.8, 2.2], CHF: [0.7, 2],
      CAD: [0.5, 1.2], AUD: [0.4, 1.2], NZD: [0.3, 1.1], SEK: [0.05, 0.25], NOK: [0.05, 0.25],
    };
    inRange(last.value, bounds[ccy][0], bounds[ccy][1], `${ccy} USD price`);
  }
  const verification = await verifyFxFred(levels);
  return {
    id: "fx",
    name: "G10 vs USD",
    unit: "USD per 1 unit of currency",
    definition: "USD price of 1 unit = (USD per EUR) / (currency per EUR). Percent change of that price. Positive means the currency strengthened versus the dollar.",
    source: "ECB EXR daily, D.USD+JPY+GBP+CHF+CAD+AUD+NZD+SEK+NOK.EUR.SP00.A",
    sourceUrl: "https://data-api.ecb.europa.eu/service/data/EXR/D.USD+JPY+GBP+CHF+CAD+AUD+NZD+SEK+NOK.EUR.SP00.A?format=csvdata&startPeriod=2024-01-01",
    asOf,
    order,
    changes,
    levels: Object.fromEntries(order.map((ccy) => [ccy, levels[ccy].slice(-500)])),
    verification,
  };
}

async function verifyFxFred(levels) {
  const spec = [
    { ccy: "EUR", id: "DEXUSEU", invert: false },
    { ccy: "JPY", id: "DEXJPUS", invert: true },
    { ccy: "GBP", id: "DEXUSUK", invert: false },
    { ccy: "CHF", id: "DEXSZUS", invert: true },
    { ccy: "CAD", id: "DEXCAUS", invert: true },
    { ccy: "AUD", id: "DEXUSAL", invert: false },
    { ccy: "NZD", id: "DEXUSNZ", invert: false },
    { ccy: "SEK", id: "DEXSDUS", invert: true },
    { ccy: "NOK", id: "DEXNOUS", invert: true },
  ];
  const checks = [];
  for (const item of spec) {
    try {
      const fred = await fetchFred(item.id, "2025-01-01");
      const last = fred.at(-1);
      const usd = item.invert ? 1 / last.value : last.value;
      const ours = latestOnOrBefore(levels[item.ccy], last.date);
      const diffPct = ours ? ((ours.value / usd) - 1) * 100 : null;
      checks.push({
        currency: item.ccy,
        source: `FRED ${item.id}`,
        fredDate: last.date,
        fredUsdPerUnit: Math.round(usd * 1e6) / 1e6,
        ecbDate: ours?.date || null,
        ecbUsdPerUnit: ours ? Math.round(ours.value * 1e6) / 1e6 : null,
        diffPct: diffPct == null ? null : Math.round(diffPct * 100) / 100,
        flag: diffPct != null && Math.abs(diffPct) > 1,
        note: "FRED H.10 rates typically lag the ECB reference by several business days. Compared on the FRED date.",
      });
    } catch (err) {
      checks.push({ currency: item.ccy, source: `FRED ${item.id}`, status: "unavailable", error: err.message, flag: false });
    }
  }
  return checks;
}

function validateFx(doc) {
  const order = ["EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK"];
  for (const ccy of order) {
    if (!doc.levels[ccy]?.length) throw new Error(`missing ${ccy}`);
    assertDates(doc.levels[ccy], ccy);
    for (const label of ["1D", "1W", "1M", "90D"]) {
      const v = doc.changes[ccy][label];
      if (v == null || Math.abs(v) > 40) throw new Error(`${ccy} ${label} invalid`);
    }
  }
}

async function fetchCftc() {
  const points = [];
  const seen = new Set();
  const pageSize = 1000;
  for (let offset = 0; offset < 5000; offset += pageSize) {
    const params = new URLSearchParams({
      $where: "cftc_contract_market_code='099741'",
      $order: "report_date_as_yyyy_mm_dd,cftc_contract_market_code",
      $select: "report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all,open_interest_all,cftc_contract_market_code",
      $limit: String(pageSize),
      $offset: String(offset),
    });
    const text = await fetchText(`https://publicreporting.cftc.gov/resource/6dca-aqww.csv?${params}`);
    const rows = parseCsv(text);
    if (rows.length <= 1) break;
    const header = rows[0];
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));
    let added = 0;
    for (const row of rows.slice(1)) {
      const rawDate = row[idx.report_date_as_yyyy_mm_dd] || "";
      const date = rawDate.slice(0, 10);
      const key = `${date}|${row[idx.cftc_contract_market_code]}`;
      if (seen.has(key)) continue;
      const long = num(row[idx.noncomm_positions_long_all]);
      const short = num(row[idx.noncomm_positions_short_all]);
      const oi = num(row[idx.open_interest_all]);
      if (long == null || short == null || oi == null) continue;
      const net = long - short;
      if (!(oi > 0) || Math.abs(net) > oi) continue;
      seen.add(key);
      points.push({ date, long, short, openInterest: oi, net });
      added++;
    }
    if (rows.length - 1 < pageSize) break;
    if (added === 0) break;
  }
  const sorted = sortUnique(points).filter((p) => p.date >= "2023-01-01");
  if (sorted.length < 20) throw new Error(`CFTC rows ${sorted.length}`);
  const last = sorted.at(-1);
  if (last.net !== last.long - last.short) throw new Error("CFTC net identity failed");
  return {
    id: "cftc",
    name: "EUR net speculative positioning",
    unit: "contracts",
    definition: "CFTC legacy futures-only, EURO FX (099741). Net = noncommercial long minus noncommercial short. Positive is net long euro; negative is net short euro.",
    source: "CFTC Socrata 6dca-aqww",
    sourceUrl: "https://publicreporting.cftc.gov/resource/6dca-aqww.csv",
    asOf: last.date,
    points: sorted.slice(-120),
  };
}

function validateCftc(doc) {
  assertDates(doc.points, "cftc");
  for (const p of doc.points) {
    if (p.net !== p.long - p.short) throw new Error(`net identity ${p.date}`);
    if (Math.abs(p.net) > p.openInterest) throw new Error(`net exceeds open interest ${p.date}`);
  }
}

function parseBundesbank(text) {
  const points = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2});([^;]*);/);
    if (!m) continue;
    const value = num(m[2]);
    if (value == null) continue;
    points.push({ date: m[1], value });
  }
  return sortUnique(points);
}

async function fetchBunds() {
  const start = "2024-01-01";
  const url2 = `https://api.statistiken.bundesbank.de/rest/data/BBSIS/D.I.ZST.ZI.EUR.S1311.B.A604.R02XX.R.A.A._Z._Z.A?format=csv&startPeriod=${start}`;
  const url10 = `https://api.statistiken.bundesbank.de/rest/data/BBSIS/D.I.ZST.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A?format=csv&startPeriod=${start}`;
  const [t2, t10] = await Promise.all([fetchText(url2), fetchText(url10)]);
  const de2y = parseBundesbank(t2);
  const de10y = parseBundesbank(t10);
  if (de2y.length < 100 || de10y.length < 100) throw new Error("Bundesbank series short");
  inRange(de2y.at(-1).value, -2, 12, "DE 2Y");
  inRange(de10y.at(-1).value, -2, 12, "DE 10Y");
  return {
    id: "bunds",
    name: "German sovereign yields",
    unit: "percent",
    source: "Bundesbank BBSIS Svensson daily, 2-year R02XX and 10-year R10XX",
    sourceUrl: url10,
    note: "Published the next business day. Comma decimals in the source CSV.",
    asOf: de10y.at(-1).date < de2y.at(-1).date ? de10y.at(-1).date : de2y.at(-1).date,
    de2y,
    de10y,
  };
}

function validateBunds(doc) {
  assertDates(doc.de2y, "de2y");
  assertDates(doc.de10y, "de10y");
  inRange(doc.de2y.at(-1).value, -2, 12, "DE 2Y");
  inRange(doc.de10y.at(-1).value, -2, 12, "DE 10Y");
}

function parseJgb(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const points = [];
  for (const line of lines) {
    const cells = line.split(",");
    let date = null;
    const western = cells[0].match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    const reiwa = cells[0].match(/^R(\d+)\.(\d+)\.(\d+)$/i);
    if (western) date = `${western[1]}-${western[2].padStart(2, "0")}-${western[3].padStart(2, "0")}`;
    if (reiwa) {
      const year = 2018 + Number(reiwa[1]);
      date = `${year}-${reiwa[2].padStart(2, "0")}-${reiwa[3].padStart(2, "0")}`;
    }
    if (!date) continue;
    const value = num(cells[10]);
    if (value == null) continue;
    points.push({ date, value });
  }
  return sortUnique(points);
}

function parseRba(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let col = 4;
  const points = [];
  for (const line of lines) {
    if (line.startsWith("Title,")) {
      const header = parseCsv(line)[0];
      const idx = header.findIndex((h) => h.trim() === "Australian Government 10 year bond");
      if (idx < 0) throw new Error("RBA 10-year column missing");
      col = idx;
      continue;
    }
    const date = parseDMYMon(line.split(",")[0]);
    if (!date) continue;
    const cells = parseCsv(line)[0];
    const value = num(cells[col]);
    if (value == null) continue;
    points.push({ date, value });
  }
  return sortUnique(points);
}

function parseBoc(text) {
  const rows = parseCsv(text);
  const start = rows.findIndex((r) => r[0] === "date" && String(r[1]).includes("10YR"));
  if (start < 0) throw new Error("BoC observations header missing");
  const points = [];
  for (const row of rows.slice(start + 1)) {
    const date = row[0];
    const value = num(row[1]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || value == null) continue;
    points.push({ date, value });
  }
  return sortUnique(points);
}

async function fetchOecdOne(area) {
  const key = `${area}.M.IRLT.PA._Z._Z._Z._Z.N`;
  const url = `https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_FINMARK,4.0/${key}?startPeriod=2024-01`;
  let text = "";
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      text = await fetchText(url, { headers: { Accept: "application/vnd.sdmx.data+csv;charset=utf-8" } });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  const rows = parseCsv(text);
  const header = rows[0];
  const dateIdx = header.indexOf("TIME_PERIOD");
  const valueIdx = header.indexOf("OBS_VALUE");
  const points = [];
  for (const row of rows.slice(1)) {
    const value = num(row[valueIdx]);
    if (value == null || !/^\d{4}-\d{2}$/.test(row[dateIdx])) continue;
    points.push({ date: monthEnd(row[dateIdx]), value, month: row[dateIdx] });
  }
  return sortUnique(points);
}

async function fetchOecdMonthly(areas) {
  const out = {};
  for (const area of areas) {
    try {
      out[area] = await fetchOecdOne(area);
    } catch (err) {
      console.error(`OECD ${area} failed: ${err.message}`);
      out[area] = null;
    }
  }
  return out;
}

async function fetchBonds() {
  const year = new Date().getUTCFullYear();
  const [de, jgbEn, jgbCur, boc, rba, oecd] = await Promise.all([
    fetchText("https://api.statistiken.bundesbank.de/rest/data/BBSIS/D.I.ZST.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A?format=csv&startPeriod=2024-01-01"),
    fetchText("https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/historical/jgbcme_all.csv"),
    fetchText("https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv", { encoding: "shift_jis" }),
    fetchText("https://www.bankofcanada.ca/valet/observations/BD.CDN.10YR.DQ.YLD/csv?recent=500"),
    fetchText("https://www.rba.gov.au/statistics/tables/csv/f2-data.csv"),
    fetchOecdMonthly(["FRA", "ITA", "CHE", "DEU", "JPN", "CAN", "AUS", "USA"]),
  ]);
  const germany = parseBundesbank(de);
  const japan = sortUnique([...parseJgb(jgbEn), ...parseJgb(jgbCur)]).filter((p) => p.date >= "2024-01-01");
  const canada = parseBoc(boc);
  const australia = parseRba(rba).filter((p) => p.date >= "2024-01-01");
  const treasury = readJson("treasury.json");
  if (!treasury?.points?.length) throw new Error("US Treasury file missing; cannot price spreads");
  const ust = treasury.points.filter((p) => p["10yr"] != null).map((p) => ({ date: p.date, value: p["10yr"] }));
  const ustAsOf = ust.at(-1).date;

  let irs = {};
  try {
    const [fr, it] = await Promise.all([
      fetchText("https://data-api.ecb.europa.eu/service/data/IRS/M.FR.L.L40.CI.0000.EUR.N.Z?format=csvdata&lastNObservations=6"),
      fetchText("https://data-api.ecb.europa.eu/service/data/IRS/M.IT.L.L40.CI.0000.EUR.N.Z?format=csvdata&lastNObservations=6"),
    ]);
    irs = { FR: lastEcbObs(fr), IT: lastEcbObs(it) };
  } catch (err) {
    irs = { error: err.message };
  }

  const series = [
    {
      country: "Switzerland",
      points: oecd.CHE,
      frequency: "monthly",
      source: "OECD DF_FINMARK IRLT monthly (same dataset as FRED IRLTLT01CHM156N)",
      fredId: "IRLTLT01CHM156N",
    },
    {
      country: "Japan",
      points: japan,
      frequency: "daily",
      source: "Japan MOF JGB yield curve, 10Y (English history + current-month Shift-JIS file)",
      fredId: null,
    },
    {
      country: "Germany",
      points: germany,
      frequency: "daily",
      source: "Bundesbank BBSIS 10-year",
      fredId: null,
    },
    {
      country: "France",
      points: oecd.FRA,
      frequency: "monthly",
      source: "OECD DF_FINMARK IRLT monthly (same dataset as FRED IRLTLT01FRM156N)",
      fredId: "IRLTLT01FRM156N",
    },
    {
      country: "Italy",
      points: oecd.ITA,
      frequency: "monthly",
      source: "OECD DF_FINMARK IRLT monthly (same dataset as FRED IRLTLT01ITM156N)",
      fredId: "IRLTLT01ITM156N",
    },
    {
      country: "Canada",
      points: canada,
      frequency: "daily",
      source: "Bank of Canada Valet BD.CDN.10YR.DQ.YLD",
      fredId: null,
    },
    {
      country: "Australia",
      points: australia,
      frequency: "daily",
      source: "RBA statistical table F2, Australian Government 10 year bond",
      fredId: null,
    },
  ];

  const bars = [];
  const cross = [];
  for (const item of series) {
    if (!item.points?.length) throw new Error(`no yield for ${item.country}`);
    const last = item.points.at(-1);
    inRange(last.value, -2, 20, item.country);
    const us = latestOnOrBefore(ust, last.date);
    if (!us) throw new Error(`no US 10Y on or before ${last.date} for ${item.country}`);
    const spreadBp = Math.round((last.value - us.value) * 100);
    inRange(spreadBp, -800, 400, `${item.country} spread`);
    const badges = [];
    if (item.frequency === "monthly") badges.push("monthly");
    if (daysBetween(last.date, ustAsOf) > 4) badges.push("delayed");
    bars.push({
      country: item.country,
      yield: last.value,
      asOf: last.date,
      frequency: item.frequency,
      badges,
      source: item.source,
      fredId: item.fredId,
      us10y: us.value,
      us10yDate: us.date,
      spreadBp,
      status: "ok",
    });
  }

  const monthAvg = (points, month) => {
    const rows = points.filter((p) => p.date.startsWith(month));
    if (!rows.length) return null;
    return rows.reduce((s, p) => s + p.value, 0) / rows.length;
  };
  const compareMonthly = (country, area, points) => {
    const obs = oecd[area];
    if (!obs?.length) return;
    const last = obs.at(-1);
    const avg = monthAvg(points, last.month);
    if (avg == null) return;
    const diffBp = Math.round((avg - last.value) * 100);
    cross.push({
      country,
      oecdMonth: last.month,
      oecd: last.value,
      localMonthlyAverage: Math.round(avg * 1000) / 1000,
      diffBp,
      flag: Math.abs(diffBp) > 25,
    });
  };
  compareMonthly("Germany", "DEU", germany);
  compareMonthly("Japan", "JPN", japan);
  compareMonthly("Canada", "CAN", canada);
  compareMonthly("Australia", "AUS", australia);
  compareMonthly("United States", "USA", ust);
  if (irs.FR && oecd.FRA) cross.push(compareIrs("France", oecd.FRA, irs.FR));
  if (irs.IT && oecd.ITA) cross.push(compareIrs("Italy", oecd.ITA, irs.IT));
  if (irs.error) cross.push({ country: "France/Italy ECB IRS", status: "unavailable", error: irs.error });

  return {
    id: "bonds",
    name: "10Y government bond spread vs US Treasuries",
    unit: "basis points (country yield minus US 10Y)",
    asOf: ustAsOf,
    us10ySource: "US Treasury daily yield curve, 10 Yr",
    note: "Each spread uses the US 10Y on the closest Treasury date on or before that country's own date.",
    oecdDirect: true,
    fredGraph: fredBlocked || "not used for these monthly series; OECD SDMX is the dataset behind the FRED IDs",
    bars,
    crosschecks: cross.filter(Boolean),
  };
}

function lastEcbObs(text) {
  const rows = parseCsv(text);
  const header = rows[0];
  const dateIdx = header.indexOf("TIME_PERIOD");
  const valueIdx = header.indexOf("OBS_VALUE");
  const points = rows.slice(1).map((r) => ({ month: r[dateIdx], value: num(r[valueIdx]) })).filter((p) => p.value != null && /^\d{4}-\d{2}$/.test(p.month));
  return points.at(-1) || null;
}

function compareIrs(country, oecdPoints, irs) {
  const match = oecdPoints.find((p) => p.month === irs.month);
  const latest = oecdPoints.at(-1);
  if (!match) {
    return {
      country,
      source: "ECB IRS long-term rate vs OECD IRLT",
      month: irs.month,
      ecb: irs.value,
      oecdLatestMonth: latest?.month || null,
      oecdLatest: latest?.value ?? null,
      diffBp: null,
      flag: true,
      note: "OECD has no observation for the ECB month, so the months were not compared.",
    };
  }
  return {
    country,
    source: "ECB IRS long-term rate vs OECD IRLT",
    month: irs.month,
    ecb: irs.value,
    oecd: match.value,
    diffBp: Math.round((match.value - irs.value) * 100),
    flag: Math.abs(match.value - irs.value) > 0.25,
  };
}

function validateBonds(doc) {
  const expected = ["Switzerland", "Japan", "Germany", "France", "Italy", "Canada", "Australia"];
  if (doc.bars.length !== 7) throw new Error(`expected 7 bond bars, got ${doc.bars.length}`);
  for (const country of expected) {
    if (!doc.bars.some((b) => b.country === country)) throw new Error(`missing ${country}`);
  }
  const byDate = new Map();
  for (const bar of doc.bars) {
    inRange(bar.spreadBp, -800, 400, bar.country);
    if (bar.frequency === "monthly" && !bar.badges.includes("monthly")) throw new Error(`${bar.country} missing monthly badge`);
    if (byDate.has(bar.us10yDate) && byDate.get(bar.us10yDate) !== bar.us10y) {
      throw new Error(`US 10Y inconsistent on ${bar.us10yDate}`);
    }
    byDate.set(bar.us10yDate, bar.us10y);
  }
}

async function fetchEcbPath() {
  const keys = ["SR_3M", "SR_6M", "SR_1Y", "SR_2Y", "IF_1Y"];
  const texts = await Promise.all(keys.map((key) => fetchText(
    `https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.${key}?format=csvdata&lastNObservations=5`,
  )));
  const estrText = await fetchText(
    "https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2X2A25.WT?format=csvdata&lastNObservations=5",
  );
  const read = (text) => {
    const rows = parseCsv(text);
    const header = rows[0];
    const dateIdx = header.indexOf("TIME_PERIOD");
    const valueIdx = header.indexOf("OBS_VALUE");
    const points = rows.slice(1).map((r) => ({ date: r[dateIdx], value: num(r[valueIdx]) })).filter((p) => p.value != null);
    return points.at(-1);
  };
  const anchor = read(estrText);
  const byKey = Object.fromEntries(keys.map((key, i) => [key, read(texts[i])]));
  for (const key of keys) {
    if (!byKey[key]) throw new Error(`missing ECB ${key}`);
    inRange(byKey[key].value, -2, 12, key);
  }
  inRange(anchor.value, -2, 12, "€STR");
  return {
    id: "ecb-path",
    name: "ECB rate-path proxy",
    proxy: true,
    label: "ECB proxy (euro-area AAA curve, not an OIS path)",
    source: "€STR plus ECB yield curve SV_C_YM spot rates SR_3M, SR_6M, SR_1Y, SR_2Y and instantaneous forward IF_1Y",
    asOf: anchor.date,
    anchor: { date: anchor.date, value: anchor.value, source: "ECB euro short-term rate (€STR)" },
    points: [
      { tenor: "SR_3M", months: 3, value: byKey.SR_3M.value, asOf: byKey.SR_3M.date },
      { tenor: "SR_6M", months: 6, value: byKey.SR_6M.value, asOf: byKey.SR_6M.date },
      { tenor: "SR_1Y", months: 12, value: byKey.SR_1Y.value, asOf: byKey.SR_1Y.date },
    ],
    spot2Y: { tenor: "SR_2Y", months: 24, value: byKey.SR_2Y.value, asOf: byKey.SR_2Y.date },
    forward1Y: { tenor: "IF_1Y", months: 12, value: byKey.IF_1Y.value, asOf: byKey.IF_1Y.date },
  };
}

function validateEcbPath(doc) {
  inRange(doc.anchor.value, -2, 12, "€STR");
  if (doc.points.length < 3) throw new Error("ECB path incomplete");
  for (const p of doc.points) inRange(p.value, -2, 12, p.tenor);
  inRange(doc.spot2Y.value, -2, 12, "SR_2Y");
  inRange(doc.forward1Y.value, -2, 12, "IF_1Y");
}

async function fetchRealYield() {
  let treasuryReal = [];
  try {
    const year = new Date().getUTCFullYear();
    const chunks = await Promise.all([year - 1, year].map((y) => fetchText(treasuryUrl(y, "daily_treasury_real_yield_curve"))));
    treasuryReal = sortUnique(chunks.flatMap((text) => {
      const rows = parseCsv(text);
      const header = rows[0].map(normHeader);
      const dateIdx = header.indexOf("date");
      const col = header.indexOf("10yr");
      const points = [];
      for (const row of rows.slice(1)) {
        const date = parseMDY(row[dateIdx]);
        const value = num(row[col]);
        if (date && value != null) points.push({ date, value });
      }
      return points;
    }));
  } catch (err) {
    treasuryReal = [];
    console.error("real-yield treasury curve failed", err.message);
  }
  let points = null;
  let fallback = false;
  let source = "FRED DFII10";
  let sourceUrl = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10";
  let fredError = null;
  try {
    points = await fetchFred("DFII10", "2024-01-01");
  } catch (err) {
    fredError = err.message;
  }
  let cross = null;
  if (points?.length && treasuryReal.length) {
    const t = treasuryReal.at(-1);
    const f = latestOnOrBefore(points, t.date);
    cross = {
      treasuryDate: t.date,
      treasury10yReal: t.value,
      fredDate: f?.date || null,
      fred: f?.value ?? null,
      diffBp: f ? Math.round((f.value - t.value) * 100) : null,
      flag: f ? Math.abs(f.value - t.value) > 0.15 : false,
    };
  }
  if (!points?.length) {
    if (!treasuryReal.length) throw new Error(fredError || "no real yield source");
    points = treasuryReal;
    fallback = true;
    source = "US Treasury daily real yield curve, 10 YR (FRED DFII10 unavailable)";
    sourceUrl = treasuryUrl(new Date().getUTCFullYear(), "daily_treasury_real_yield_curve");
  }
  inRange(points.at(-1).value, -3, 8, "US 10Y real");
  return {
    id: "real-yield",
    name: fallback ? "US 10Y real yield (Treasury)" : "US 10Y real yield (TIPS)",
    unit: "percent",
    source,
    sourceUrl,
    fallback,
    delayed: false,
    fredError,
    crosscheck: cross,
    asOf: points.at(-1).date,
    points: points.slice(-500),
  };
}

function validateReal(doc) {
  assertDates(doc.points, "real-yield");
  inRange(doc.points.at(-1).value, -3, 8, "real yield");
}

async function fetchAuctions() {
  const text = await fetchText("https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json&days=420", { timeout: 60000 });
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error("TreasuryDirect payload is not a list");
  const seen = new Set();
  const auctions = [];
  for (const row of rows) {
    const type = row.securityType;
    if (type !== "Note" && type !== "Bond") continue;
    const cusip = row.cusip;
    if (!cusip || seen.has(cusip)) continue;
    const date = String(row.auctionDate || "").slice(0, 10);
    const cover = num(row.bidToCoverRatio);
    const yieldPct = num(row.highYield);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || cover == null) continue;
    if (cover < 0.8 || cover > 8) continue;
    seen.add(cusip);
    auctions.push({
      cusip,
      date,
      securityType: type,
      securityTerm: row.securityTerm || "",
      tips: String(row.tips || "").toLowerCase() === "yes",
      bidToCover: cover,
      highYield: yieldPct,
    });
  }
  const sorted = auctions.sort((a, b) => a.date.localeCompare(b.date) || a.cusip.localeCompare(b.cusip));
  if (sorted.length < 5) throw new Error(`only ${sorted.length} note/bond auctions`);
  const avg = sorted.reduce((s, a) => s + a.bidToCover, 0) / sorted.length;
  inRange(avg, 1.5, 4.5, "average bid-to-cover");
  return {
    id: "auctions",
    name: "Treasury auction demand",
    unit: "bid-to-cover ratio",
    definition: "TreasuryDirect auctioned securities. Includes Notes and Bonds only (bills excluded). TIPS are included when TreasuryDirect classifies them as a Note or Bond.",
    source: "TreasuryDirect TA_WS securities/auctioned",
    sourceUrl: "https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json&days=420",
    asOf: sorted.at(-1).date,
    average: Math.round(avg * 1000) / 1000,
    auctions: sorted,
  };
}

function validateAuctions(doc) {
  assertDates(doc.auctions, "auctions");
  const cusips = new Set();
  for (const a of doc.auctions) {
    if (cusips.has(a.cusip)) throw new Error(`duplicate cusip ${a.cusip}`);
    cusips.add(a.cusip);
    if (a.securityType !== "Note" && a.securityType !== "Bond") throw new Error(a.securityType);
    inRange(a.bidToCover, 0.8, 8, "bid-to-cover");
  }
}

async function main() {
  const only = new Set((process.argv.find((arg) => arg.startsWith("--only=")) || "").replace("--only=", "").split(",").filter(Boolean));
  const jobs = [
    ["eurusd", "eurusd.json", fetchEurusd, validateEurusd],
    ["broad-usd", "broad-usd.json", fetchBroadUsd, validateBroad],
    ["treasury", "treasury.json", fetchTreasury, validateTreasury],
    ["fx", "fx.json", fetchFx, validateFx],
    ["cftc", "cftc.json", fetchCftc, validateCftc],
    ["bunds", "bunds.json", fetchBunds, validateBunds],
    ["real-yield", "real-yield.json", fetchRealYield, validateReal],
    ["ecb-path", "ecb-path.json", fetchEcbPath, validateEcbPath],
    ["auctions", "auctions.json", fetchAuctions, validateAuctions],
  ];
  const selected = jobs.filter(([name]) => !only.size || only.has(name));
  await Promise.all(selected.map(([name, file, prod, val]) => runSource(name, file, prod, val)));
  if (!only.size || only.has("bonds")) await runSource("bonds", "bonds.json", fetchBonds, validateBonds);
  const meetings = readJson("meetings.json");
  if (meetings) {
    meetings.fetchedAt = meetings.fetchedAt || new Date().toISOString();
    meetings.status = meetings.status || "ok";
  }
  rebuildHealth({ fredHost: fredHostError() });
  console.log("core fetch complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
