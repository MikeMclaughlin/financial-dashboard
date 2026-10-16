/**
 * Recompute derived values from the committed JSON and record second-source
 * discrepancies. Exits non-zero only when stored math does not match a recompute.
 */
import { addDays, latestOnOrBefore, readJson, writeJson } from "./common.mjs";

const issues = [];
const checks = [];

function note(item, detail, level = "info") {
  checks.push({ item, level, detail });
  if (level !== "info") issues.push({ item, level, detail });
}

function near(a, b, tol, label) {
  if (a == null || b == null || Math.abs(a - b) > tol) {
    throw new Error(`${label}: stored ${a} vs recomputed ${b}`);
  }
}

function pct(series, back) {
  const last = series.at(-1);
  const then = back == null ? series[series.length - 2] : latestOnOrBefore(series, addDays(last.date, back));
  if (!then || then.date >= last.date) return null;
  return Math.round(((last.value / then.value - 1) * 100) * 100) / 100;
}

function requireSeries(name, doc, ok) {
  if (!ok) note(name, `${name} has no usable points (status ${doc?.status || "missing"}): ${doc?.error || ""}`, "issue");
  else note(name, `${name} status=${doc.status || "ok"} asOf=${doc.asOf || "-"} fallback=${Boolean(doc.fallback)} proxy=${Boolean(doc.proxy)}`);
}

function main() {
  const eurusd = readJson("eurusd.json");
  const dxy = readJson("dxy.json");
  const treasury = readJson("treasury.json");
  const fx = readJson("fx.json");
  const cftc = readJson("cftc.json");
  const bunds = readJson("bunds.json");
  const bonds = readJson("bonds.json");
  const real = readJson("real-yield.json");
  const auctions = readJson("auctions.json");
  const ecb = readJson("ecb-path.json");
  const fed = readJson("fed-path.json");
  const commodities = readJson("commodities.json");
  const meetings = readJson("meetings.json");
  const fxYahoo = readJson("fx-yahoo.json");

  requireSeries("1 EUR/USD", eurusd, eurusd?.points?.length > 200 && eurusd?.ma200?.length);
  requireSeries("2 DXY", dxy, dxy?.points?.length > 30);
  requireSeries("3 Treasury", treasury, treasury?.points?.length > 100);
  requireSeries("6 FX", fx, fx?.changes && Object.keys(fx.changes).length === 9);
  requireSeries("7 CFTC", cftc, cftc?.points?.length > 8);
  requireSeries("8/9 Bunds", bunds, bunds?.de2y?.length && bunds?.de10y?.length);
  requireSeries("11 Bonds", bonds, bonds?.bars?.length === 7);
  requireSeries("12 ECB path", ecb, ecb?.points?.length >= 3);
  requireSeries("12 Fed path", fed, fed?.points?.length >= 3);
  requireSeries("13 Real yield", real, real?.points?.length > 30);
  requireSeries("14 Gold", commodities, commodities?.gold?.points?.length > 30);
  requireSeries("14 Oil", commodities, commodities?.oil?.points?.length > 30);
  requireSeries("15 Auctions", auctions, auctions?.auctions?.length > 4);
  requireSeries("16 Meetings", meetings, meetings?.meetings?.length > 40);

  if (eurusd?.points?.length && eurusd.ma200?.length) {
    const window = eurusd.points.slice(-200);
    if (window.length === 200) {
      const avg = window.reduce((s, p) => s + p.value, 0) / 200;
      const stored = eurusd.ma200.at(-1).value;
      near(stored, Math.round(avg * 1e6) / 1e6, 0.000002, "EUR/USD 200-day average");
      note(5, `200-day average ${stored} on ${eurusd.ma200.at(-1).date}; history ${eurusd.historyStart} count ${eurusd.historyCount}`);
    }
  }

  if (treasury?.points?.length) {
    const last = treasury.points.at(-1);
    const prev = treasury.points.at(-2);
    const gap = Math.round((last["10yr"] - last["2yr"]) * 100);
    const prevGap = Math.round((prev["10yr"] - prev["2yr"]) * 100);
    note(4, `2s10s ${gap} bp on ${last.date}; change ${gap - prevGap} bp`);
    for (const key of ["3mo", "2yr", "5yr", "10yr", "30yr"]) {
      if (last[key] == null) throw new Error(`curve tenor missing today: ${key}`);
    }
    const d45 = latestOnOrBefore(treasury.points, addDays(last.date, -45));
    const d90 = latestOnOrBefore(treasury.points, addDays(last.date, -90));
    note(10, `curve today ${last.date}, 45d ${d45?.date}, 90d ${d90?.date}`);
    for (const row of [d45, d90]) {
      for (const key of ["3mo", "2yr", "5yr", "10yr", "30yr"]) {
        if (row?.[key] == null) note(10, `tenor ${key} missing on ${row?.date}`, "issue");
      }
    }
    note(3, `US 10Y ${last["10yr"]}% on ${last.date} from the Treasury yield curve`);
  }

  if (fx?.levels) {
    for (const ccy of fx.order) {
      const series = fx.levels[ccy];
      const recomputed = {
        "1D": pct(series, null),
        "1W": pct(series, -7),
        "1M": pct(series, -30),
        "90D": pct(series, -90),
      };
      for (const label of Object.keys(recomputed)) {
        near(fx.changes[ccy][label], recomputed[label], 0.02, `${ccy} ${label}`);
      }
      note(6, `${ccy} 1D ${fx.changes[ccy]["1D"]} / 1W ${fx.changes[ccy]["1W"]} / 1M ${fx.changes[ccy]["1M"]} / 90D ${fx.changes[ccy]["90D"]}`);
    }
  }
  for (const check of fxYahoo?.checks || []) {
    if (check.flag) note(6, `${check.currency} ECB vs Yahoo differs ${check.diffPct}%`, "outlier");
    else if (check.status === "unavailable") note(6, `${check.currency} Yahoo unavailable: ${check.error}`, "issue");
    else note(6, `${check.currency} vs Yahoo diff ${check.diffPct}%`);
  }

  if (cftc?.points?.length) {
    for (const p of cftc.points) {
      if (p.net !== p.long - p.short) throw new Error(`CFTC net ${p.date}`);
    }
    const last = cftc.points.at(-1);
    note(7, `latest net ${last.net} = ${last.long} long − ${last.short} short, open interest ${last.openInterest} on ${last.date}`);
  }

  if (bunds && treasury?.points) {
    const paired = [];
    for (const g of bunds.de2y) {
      const us = latestOnOrBefore(treasury.points.filter((p) => p["2yr"] != null).map((p) => ({ date: p.date, value: p["2yr"] })), g.date);
      if (us && us.date === g.date) paired.push(g.date);
    }
    note(8, `US and German 2Y share ${paired.length} exact dates; German as of ${bunds.de2y.at(-1).date}`);
    note(9, `German 10Y ${bunds.de10y.at(-1).value} on ${bunds.de10y.at(-1).date}; US 10Y ${treasury.points.at(-1)["10yr"]} on ${treasury.points.at(-1).date}`);
  }

  if (bonds?.bars) {
    for (const bar of bonds.bars) {
      const spread = Math.round((bar.yield - bar.us10y) * 100);
      near(bar.spreadBp, spread, 0, `${bar.country} spread`);
      note(11, `${bar.country} ${bar.spreadBp} bp, yield ${bar.yield} as of ${bar.asOf} vs US ${bar.us10y} on ${bar.us10yDate} [${bar.badges.join(", ") || "daily"}]`);
    }
    for (const check of bonds.crosschecks || []) {
      if (check.flag) note(11, `${check.country} cross-check flag ${JSON.stringify(check)}`, "outlier");
      else note(11, `${check.country} cross-check diff ${check.diffBp} bp`);
    }
  }

  const swiss = bonds?.bars?.find((bar) => bar.country === "Switzerland");
  if (swiss) note(11, `Switzerland ${swiss.yield}% as of ${swiss.asOf} from ${swiss.source}${swiss.status === "stale" ? ` (stale: ${swiss.error})` : ""}`);
  if (dxy?.status === "stale") note(2, `Dollar index is the last good Yahoo print: ${dxy.error || ""}`, "fallback");
  if (real?.points?.length) note(13, `Real yield ${real.points.at(-1).value}% on ${real.asOf} from ${real.source}`);
  if (fed?.proxy) note(12, `Fed path proxy: ${fed.label}. ${fed.yahooError || ""}`, "proxy");
  else if (fed?.anchor) note(12, `Fed funds futures are live. Anchor: ${fed.anchor.source} ${fed.anchor.value}% on ${fed.anchor.date}`);
  if (ecb?.proxy) note(12, "ECB path is a proxy by design (AAA curve + €STR, not OIS)", "proxy");
  if (commodities?.gold?.fallback) note(14, `Gold fallback: ${commodities.gold.source}`, "fallback");
  if (commodities?.gold?.status === "stale") note(14, `Gold kept the last good print: ${commodities.gold.error}`, "fallback");
  if (commodities?.oil?.status === "stale") note(14, `Oil kept the last good print: ${commodities.oil.error}`, "fallback");

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = (meetings?.meetings || []).filter((m) => m.decisionDate >= today && m.decisionDate <= addDays(today, 90));
  note(16, `decision dates inside the next 90 days: ${upcoming.map((m) => `${m.bank} ${m.decisionDate}`).join(", ") || "none"}`);

  const report = {
    generatedAt: new Date().toISOString(),
    issueCount: issues.length,
    issues,
    checks,
  };
  writeJson("verification.json", report);
  console.log(`verification issues: ${issues.length}`);
  for (const issue of issues) console.log(` - [${issue.level}] item ${issue.item}: ${issue.detail}`);
  const hard = issues.filter((i) => i.level === "issue" && /no usable points/.test(i.detail));
  if (hard.length) {
    console.error(`${hard.length} required series are empty`);
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
