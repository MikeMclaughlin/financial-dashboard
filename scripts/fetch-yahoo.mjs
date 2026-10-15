/**
 * Yahoo-dependent series only. This step is allowed to fail on its own.
 * On a Yahoo failure it keeps the last good series or switches to the
 * documented non-Yahoo fallback.
 */
import {
  addDays,
  assertDates,
  fetchText,
  inRange,
  latestOnOrBefore,
  readJson,
  rebuildHealth,
  runSource,
  sortUnique,
} from "./common.mjs";

async function yahooChart(symbol, range = "2y") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const text = await fetchText(url, { headers: { Accept: "application/json" }, timeout: 25000 });
  const data = JSON.parse(text);
  const result = data.chart?.result?.[0];
  if (!result) {
    const desc = data.chart?.error?.description || "empty chart";
    throw new Error(`Yahoo ${symbol}: ${desc}`);
  }
  const stamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < stamps.length; i++) {
    const value = closes[i];
    if (value == null || !Number.isFinite(value)) continue;
    points.push({ date: new Date(stamps[i] * 1000).toISOString().slice(0, 10), value });
  }
  return { points: sortUnique(points), price: result.meta?.regularMarketPrice ?? null };
}

async function fetchDxy() {
  try {
    const { points } = await yahooChart("DX-Y.NYB", "2y");
    if (points.length < 100) throw new Error(`DXY rows ${points.length}`);
    inRange(points.at(-1).value, 70, 140, "DXY");
    return {
      id: "dxy",
      name: "Dollar Index (DXY)",
      unit: "index",
      source: "Yahoo DX-Y.NYB (ICE Dollar Index, unofficial)",
      sourceUrl: "https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?range=2y&interval=1d",
      fallback: false,
      delayed: false,
      asOf: points.at(-1).date,
      points,
    };
  } catch (err) {
    const broad = readJson("broad-usd.json");
    if (broad?.points?.length) {
      return {
        ...broad,
        id: "dxy",
        name: "Broad USD index (Fed)",
        fallback: true,
        delayed: true,
        status: "ok",
        error: null,
        yahooError: err.message,
        note: "ICE DXY from Yahoo was unavailable. Showing FRED DTWEXBGS, the Fed broad dollar index, which is a different basket.",
      };
    }
    throw err;
  }
}

function validateDxy(doc) {
  assertDates(doc.points, "dxy");
  inRange(doc.points.at(-1).value, 70, 160, "dollar index");
}

function contractSymbols(count = 12) {
  const codes = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"];
  const now = new Date();
  let month = now.getUTCMonth();
  let year = now.getUTCFullYear();
  const out = [];
  for (let i = 0; i < count; i++) {
    const yy = String(year).slice(-2);
    out.push({
      symbol: `ZQ${codes[month]}${yy}.CBT`,
      monthsAhead: i,
      year,
      month: month + 1,
      label: new Date(Date.UTC(year, month, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
    });
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return out;
}

async function anchorRate() {
  try {
    const text = await fetchText("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF&cosd=2026-01-01", { timeout: 15000 });
    const rows = text.trim().split(/\r?\n/).slice(1).map((line) => line.split(",")).filter((r) => r[1] && r[1] !== ".");
    const last = rows.at(-1);
    const value = Number(last[1]);
    if (!Number.isFinite(value)) throw new Error("DFF missing");
    return { date: last[0], value, source: "FRED DFF" };
  } catch (err) {
    const text = await fetchText("https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json");
    const row = JSON.parse(text).refRates?.[0];
    if (!row) throw new Error(`DFF and EFFR unavailable (${err.message})`);
    return {
      date: row.effectiveDate,
      value: row.percentRate,
      source: "NY Fed EFFR (FRED DFF unavailable)",
      fallback: true,
      fredError: err.message,
    };
  }
}

function treasuryProxy(anchor) {
  const treasury = readJson("treasury.json");
  const last = treasury?.points?.at(-1);
  if (!last) throw new Error("Treasury proxy unavailable");
  const points = [
    { tenor: "3M", months: 3, value: last["3mo"] },
    { tenor: "6M", months: 6, value: last["6mo"] },
    { tenor: "1Y", months: 12, value: last["1yr"] },
    { tenor: "2Y", months: 24, value: last["2yr"] },
  ].filter((p) => p.value != null);
  if (points.length < 4) throw new Error("Treasury proxy missing a tenor");
  return {
    id: "fed-path",
    name: "Fed rate-path proxy",
    proxy: true,
    fallback: true,
    label: "Proxy: Treasury bill and note yields (fed funds futures unavailable)",
    source: "US Treasury 3M, 6M, 1Y and 2Y yields",
    asOf: last.date,
    anchor: anchor || { date: last.date, value: last["3mo"], source: "Treasury 3M" },
    points,
  };
}

async function fetchFedPath() {
  const anchor = await anchorRate().catch((err) => ({ error: err.message }));
  const contracts = contractSymbols(12);
  const points = [];
  const errors = [];
  for (const contract of contracts) {
    try {
      const { points: series, price } = await yahooChart(contract.symbol, "5d");
      const last = series.at(-1);
      const raw = price ?? last?.value;
      if (raw == null) throw new Error("no price");
      const implied = 100 - raw;
      inRange(implied, -1, 15, contract.symbol);
      points.push({
        symbol: contract.symbol,
        months: contract.monthsAhead,
        label: contract.label,
        year: contract.year,
        month: contract.month,
        price: raw,
        value: Math.round(implied * 1000) / 1000,
        asOf: last?.date || null,
      });
    } catch (err) {
      errors.push(`${contract.symbol}: ${err.message}`);
    }
  }
  if (points.length < 8) {
    const proxy = treasuryProxy(anchor.error ? null : anchor);
    proxy.yahooError = errors.join("; ") || "too few futures contracts";
    return proxy;
  }
  if (anchor.error) {
    const proxy = treasuryProxy(null);
    proxy.yahooError = anchor.error;
    proxy.futures = points;
    return proxy;
  }
  inRange(anchor.value, -1, 15, "fed anchor");
  return {
    id: "fed-path",
    name: "Fed rate-path expectations",
    proxy: false,
    fallback: Boolean(anchor.fallback),
    label: "Fed funds futures, implied rate = 100 − price",
    source: "Yahoo ZQ monthly futures, anchored to the effective fed funds rate",
    asOf: points.at(-1).asOf || anchor.date,
    anchor,
    points,
    errors,
  };
}

function validateFed(doc) {
  inRange(doc.anchor.value, -1, 15, "fed anchor");
  if (!doc.points.length) throw new Error("fed path empty");
  for (const p of doc.points) inRange(p.value, -1, 15, "fed path point");
}

async function fetchCommodities() {
  const out = {
    id: "commodities",
    name: "Gold and oil in USD",
    unit: "USD price, rebased to 100 in the browser",
    gold: null,
    oil: null,
  };
  try {
    const { points } = await yahooChart("GC=F", "2y");
    inRange(points.at(-1).value, 500, 10000, "gold");
    out.gold = {
      name: "Gold",
      source: "Yahoo GC=F",
      fallback: false,
      delayed: false,
      asOf: points.at(-1).date,
      points,
    };
  } catch (err) {
    try {
      const { points } = await yahooChart("GLD", "2y");
      inRange(points.at(-1).value, 50, 1000, "GLD");
      out.gold = {
        name: "Gold (GLD ETF proxy)",
        source: "Yahoo GLD (GC=F unavailable)",
        fallback: true,
        delayed: true,
        yahooError: err.message,
        asOf: points.at(-1).date,
        points,
      };
    } catch (err2) {
      out.gold = { status: "error", error: `${err.message}; ${err2.message}`, points: [] };
    }
  }
  try {
    const { points } = await yahooChart("CL=F", "2y");
    inRange(points.at(-1).value, 20, 250, "oil");
    out.oil = {
      name: "Oil",
      source: "Yahoo CL=F",
      fallback: false,
      delayed: false,
      asOf: points.at(-1).date,
      points,
    };
  } catch (err) {
    try {
      const text = await fetchText("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILWTICO&cosd=2024-01-01", { timeout: 18000 });
      const points = sortUnique(text.trim().split(/\r?\n/).slice(1).map((line) => {
        const [date, value] = line.split(",");
        return { date, value: Number(value) };
      }).filter((p) => Number.isFinite(p.value)));
      if (!points.length) throw new Error("DCOILWTICO empty");
      inRange(points.at(-1).value, 20, 250, "WTI");
      out.oil = {
        name: "Oil (WTI, delayed)",
        source: "FRED DCOILWTICO (Yahoo CL=F unavailable)",
        fallback: true,
        delayed: true,
        yahooError: err.message,
        asOf: points.at(-1).date,
        points,
      };
    } catch (err2) {
      out.oil = { status: "error", error: `${err.message}; ${err2.message}`, points: [] };
    }
  }
  if (!out.gold?.points?.length && !out.oil?.points?.length) {
    throw new Error(`commodities failed: ${out.gold?.error || ""} ${out.oil?.error || ""}`);
  }
  out.asOf = out.gold?.asOf || out.oil?.asOf;
  out.fallback = Boolean(out.gold?.fallback || out.oil?.fallback);
  out.delayed = Boolean(out.gold?.delayed || out.oil?.delayed);
  out.status = out.gold?.points?.length && out.oil?.points?.length ? "ok" : "partial";
  return out;
}

function validateCommodities(doc) {
  for (const leg of [doc.gold, doc.oil]) {
    if (!leg?.points?.length) continue;
    assertDates(leg.points, leg.name || "commodity");
  }
  if (!doc.gold?.points?.length && !doc.oil?.points?.length) throw new Error("no commodity points");
}

async function fetchFxYahoo() {
  const fx = readJson("fx.json");
  const pairs = [
    { ccy: "EUR", symbol: "EURUSD=X", invert: false },
    { ccy: "JPY", symbol: "JPY=X", invert: true },
    { ccy: "GBP", symbol: "GBPUSD=X", invert: false },
    { ccy: "CHF", symbol: "CHF=X", invert: true },
    { ccy: "CAD", symbol: "CAD=X", invert: true },
    { ccy: "AUD", symbol: "AUDUSD=X", invert: false },
    { ccy: "NZD", symbol: "NZDUSD=X", invert: false },
    { ccy: "SEK", symbol: "SEK=X", invert: true },
    { ccy: "NOK", symbol: "NOK=X", invert: true },
  ];
  const checks = [];
  for (const pair of pairs) {
    try {
      const { points } = await yahooChart(pair.symbol, "5d");
      const last = points.at(-1);
      const usd = pair.invert ? 1 / last.value : last.value;
      const ours = fx?.levels?.[pair.ccy] ? latestOnOrBefore(fx.levels[pair.ccy], last.date) : null;
      const diffPct = ours ? ((ours.value / usd) - 1) * 100 : null;
      checks.push({
        currency: pair.ccy,
        source: `Yahoo ${pair.symbol}`,
        yahooDate: last.date,
        yahooUsdPerUnit: Math.round(usd * 1e6) / 1e6,
        ecbDate: ours?.date || null,
        ecbUsdPerUnit: ours ? Math.round(ours.value * 1e6) / 1e6 : null,
        diffPct: diffPct == null ? null : Math.round(diffPct * 100) / 100,
        flag: diffPct != null && Math.abs(diffPct) > 1,
        note: "Yahoo is a market quote, not the ECB fixing. A gap under 1% is treated as normal.",
      });
    } catch (err) {
      checks.push({ currency: pair.ccy, source: `Yahoo ${pair.symbol}`, status: "unavailable", error: err.message, flag: false });
    }
  }
  const flagged = checks.filter((c) => c.flag).length;
  return {
    id: "fx-yahoo",
    name: "G10 Yahoo cross-check",
    status: checks.some((c) => c.diffPct != null) ? "ok" : "error",
    asOf: checks.find((c) => c.yahooDate)?.yahooDate || null,
    source: "Yahoo FX spot quotes",
    flagged,
    checks,
  };
}

function validateFxYahoo(doc) {
  if (!Array.isArray(doc.checks) || doc.checks.length !== 9) throw new Error("expected 9 FX cross-checks");
}

async function main() {
  await runSource("dxy", "dxy.json", fetchDxy, validateDxy);
  await runSource("fed-path", "fed-path.json", fetchFedPath, validateFed);
  await runSource("commodities", "commodities.json", fetchCommodities, validateCommodities);
  await runSource("fx-yahoo", "fx-yahoo.json", fetchFxYahoo, validateFxYahoo);
  rebuildHealth();
  console.log("yahoo fetch complete");
}

main().catch((err) => {
  console.error(err);
  try { rebuildHealth({ yahooCrashed: err.message }); } catch { /* ignore */ }
  process.exit(1);
});
