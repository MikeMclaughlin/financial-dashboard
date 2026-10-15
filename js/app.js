const APP_VERSION = "1.0";
const FILES = [
  "health", "eurusd", "dxy", "broad-usd", "treasury", "fx", "cftc", "bunds",
  "bonds", "ecb-path", "fed-path", "real-yield", "commodities", "auctions", "meetings",
];
const HEAT_ORDER = ["EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK"];
const HEAT_COLS = [
  ["1D", "One-day percent change in the currency's value versus the US dollar. Positive (blue) means stronger versus the dollar; negative (orange) means weaker."],
  ["1W", "One-week percent change versus the US dollar, from the fixing on or before seven days earlier. Positive means the currency strengthened versus the dollar."],
  ["1M", "Thirty-day percent change versus the US dollar. Positive means the currency strengthened versus the dollar."],
  ["90D", "Ninety-day percent change versus the US dollar. Positive means the currency strengthened versus the dollar."],
];

let period = Number(localStorage.getItem("macro-period") || 90);
if (![30, 90, 180, 365].includes(period)) period = 90;
let tab = localStorage.getItem("macro-tab") === "extra" ? "extra" : "main";
let heatSort = { key: "order", dir: 1 };
let data = {};

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
function pretty(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${months[m - 1]} ${y}`;
}
function stamp(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return pretty(iso);
  return date.toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) + " UTC";
}
function fmt(n, digits) {
  const value = Number(n);
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function signed(n, digits, suffix = "") {
  if (!Number.isFinite(n)) return "—";
  const body = fmt(Math.abs(n), digits);
  if (n > 0) return `+${body}${suffix}`;
  if (n < 0) return `−${body}${suffix}`;
  return `${body}${suffix}`;
}
function cls(n) { return n < 0 ? "down" : "up"; }
function onOrBefore(points, date) {
  let ans = null;
  for (const p of points) {
    if (p.date <= date) ans = p;
    else break;
  }
  return ans;
}
function windowOf(points, days) {
  if (!points?.length) return [];
  const end = points[points.length - 1].date;
  const start = addDays(end, -days);
  return points.filter((p) => p.date >= start);
}
function xs(n) {
  return Array.from({ length: n }, (_, i) => (n === 1 ? 1 : i / (n - 1)));
}
function xLabels(days) {
  return [1, 2 / 3, 1 / 3, 0].map((frac) => ({
    at: 1 - frac,
    text: frac === 0 ? "Now" : frac === 1 ? `${days}d ago` : `${Math.round(days * frac)}d`,
  }));
}
function asof(date, extra = "") {
  return `as of ${pretty(date)}${extra}`;
}
function empty(el, message) {
  el.innerHTML = `<div class="empty">${message}</div>`;
}

async function load() {
  const rows = await Promise.all(FILES.map(async (name) => {
    try {
      const res = await fetch(`data/${name}.json`, { cache: "no-cache" });
      if (!res.ok) throw new Error(String(res.status));
      return [name, await res.json()];
    } catch (err) {
      return [name, { status: "error", error: err.message, points: [] }];
    }
  }));
  const next = Object.fromEntries(rows);
  for (const [name, doc] of Object.entries(next)) {
    if (doc && (doc.points?.length || doc.levels || doc.bars || doc.meetings || doc.auctions || doc.gold || doc.de2y || doc.anchor)) {
      data[name] = doc;
    } else if (!data[name]) {
      data[name] = doc;
    }
  }
  render();
}

function setTab(next, redraw) {
  tab = next;
  localStorage.setItem("macro-tab", tab);
  document.getElementById("view-main").hidden = tab !== "main";
  document.getElementById("view-extra").hidden = tab !== "extra";
  document.getElementById("tab-main").setAttribute("aria-selected", String(tab === "main"));
  document.getElementById("tab-extra").setAttribute("aria-selected", String(tab === "extra"));
  if (redraw) render();
}

function lockDates(root) {
  root.querySelectorAll(".sub, .k-asof, #foot-fresh").forEach((el) => {
    const text = el.textContent;
    if (!/as of \d{1,2} [A-Za-z]{3} \d{4}/.test(text)) return;
    const frag = document.createDocumentFragment();
    const re = /as of \d{1,2} [A-Za-z]{3} \d{4}/g;
    let last = 0;
    let match;
    while ((match = re.exec(text))) {
      frag.append(text.slice(last, match.index));
      const span = document.createElement("span");
      span.className = "nowrap";
      span.textContent = match[0];
      frag.append(span);
      last = match.index + match[0].length;
    }
    frag.append(text.slice(last));
    el.replaceChildren(frag);
  });
}

function kpi(label, value, change, changeText, sparkValues, sparkColor, dateLine) {
  return `<article class="card">
    <div class="k-label">${label}</div>
    <div class="k-value">${value}</div>
    <div class="k-change ${cls(change)}">${changeText}</div>
    <div class="k-asof">${dateLine}</div>
    <div class="spark" data-spark="${sparkColor}">${sparkValues.join(",")}</div>
  </article>`;
}

function renderKpis() {
  const host = document.getElementById("kpis");
  const eur = data.eurusd?.points || [];
  const dxyDoc = data.dxy?.points?.length ? data.dxy : data["broad-usd"];
  const dxy = dxyDoc?.points || [];
  const ust = data.treasury?.points || [];
  const cards = [];
  if (eur.length > 1) {
    const w = windowOf(eur, period);
    const last = eur.at(-1);
    const prev = eur.at(-2);
    const pct = (last.value / prev.value - 1) * 100;
    cards.push(kpi("EUR/USD", fmt(last.value, 4), pct, `${signed(pct, 2, "%")} <span>today</span>`, w.map((p) => p.value), pct < 0 ? Chart.ORANGE : Chart.BLUE, asof(last.date)));
  } else cards.push(kpi("EUR/USD", "—", 0, "Unavailable", [], Chart.BLUE, data.eurusd?.error || "No print yet"));
  if (dxy.length > 1) {
    const last = dxy.at(-1);
    const prev = dxy.at(-2);
    const pct = (last.value / prev.value - 1) * 100;
    const name = dxyDoc.name || "Dollar Index (DXY)";
    const badge = dxyDoc.fallback ? `<span class="badge">Fed broad</span>` : "";
    cards.push(kpi(`${name}${badge}`, fmt(last.value, 1), pct, `${signed(pct, 2, "%")} <span>today</span>`, windowOf(dxy, period).map((p) => p.value), pct < 0 ? Chart.ORANGE : Chart.BLUE, asof(last.date, dxyDoc.fallback ? " · not ICE DXY" : "")));
  } else cards.push(kpi("Dollar Index (DXY)", "—", 0, "Unavailable", [], Chart.BLUE, data.dxy?.error || "No print yet"));
  if (ust.length > 1 && ust.at(-1)["10yr"] != null) {
    const last = ust.at(-1);
    const prev = ust.at(-2);
    const bp = (last["10yr"] - prev["10yr"]) * 100;
    cards.push(kpi("US 10Y Treasury", `${fmt(last["10yr"], 2)}%`, bp, `${signed(Math.round(bp), 0, " bp")} <span>today</span>`, windowOf(ust, period).map((p) => p["10yr"]).filter(Number.isFinite), bp < 0 ? Chart.ORANGE : Chart.BLUE, asof(last.date)));
  } else cards.push(kpi("US 10Y Treasury", "—", 0, "Unavailable", [], Chart.BLUE, data.treasury?.error || "No print yet"));
  host.innerHTML = cards.join("");
  host.querySelectorAll(".spark").forEach((el) => {
    const values = el.textContent.split(",").map(Number).filter(Number.isFinite);
    Chart.sparkline(el, values, el.dataset.spark);
  });

  const wide = document.getElementById("curve-card");
  if (ust.length > 1 && ust.at(-1)["10yr"] != null && ust.at(-1)["2yr"] != null) {
    const series = ust.filter((p) => p["10yr"] != null && p["2yr"] != null).map((p) => ({ date: p.date, value: (p["10yr"] - p["2yr"]) * 100 }));
    const last = series.at(-1);
    const prev = series.at(-2);
    const chg = last.value - prev.value;
    const w = windowOf(series, period);
    wide.innerHTML = `<div>
      <div class="k-label">2s10s curve</div>
      <div class="k-value">${signed(Math.round(last.value), 0, " bp")}</div>
      <div class="k-change ${cls(chg)}">${signed(Math.round(chg), 0, " bp")} <span>today</span></div>
      <div class="k-asof">${asof(last.date)} · 10Y minus 2Y</div>
    </div><div class="spark" id="curve-spark"></div>`;
    Chart.sparkline(document.getElementById("curve-spark"), w.map((p) => p.value), chg < 0 ? Chart.ORANGE : Chart.BLUE);
  } else {
    wide.innerHTML = `<div><div class="k-label">2s10s curve</div><div class="empty">${data.treasury?.error || "Unavailable"}</div></div>`;
  }
}

function renderEur() {
  const points = windowOf(data.eurusd?.points || [], period);
  const sub = document.getElementById("eur-sub");
  const el = document.getElementById("eur-chart");
  if (points.length < 2) return empty(el, data.eurusd?.error || "EUR/USD is not available yet");
  sub.textContent = `Last ${period} days · falling price = euro weakening vs dollar · ${asof(points.at(-1).date)}`;
  const maMap = new Map((data.eurusd.ma200 || []).map((p) => [p.date, p.value]));
  const ma = points.filter((p) => maMap.has(p.date));
  const decision = (data.meetings?.meetings || [])
    .filter((m) => m.bank === "ECB" && m.decisionDate >= points[0].date && m.decisionDate <= points.at(-1).date)
    .sort((a, b) => a.decisionDate.localeCompare(b.decisionDate))
    .at(-1);
  let marker = null;
  if (decision) {
    const idx = points.findIndex((p) => p.date >= decision.decisionDate);
    const at = idx < 0 ? 1 : idx / (points.length - 1);
    marker = { x: at, label: "ECB decision", color: Chart.BLUE };
  }
  Chart.lineChart(el, {
    xLabels: xLabels(period),
    marker,
    series: [
      {
        name: "EUR/USD",
        color: Chart.ORANGE,
        area: true,
        points: points.map((p, i) => ({ x: i / (points.length - 1), y: p.value, title: `${pretty(p.date)} · ${fmt(p.value, 4)}` })),
      },
      {
        name: "200-day average",
        color: "#c5ceda",
        dashed: true,
        width: 1.6,
        dot: false,
        points: ma.map((p) => ({ x: points.findIndex((row) => row.date === p.date) / (points.length - 1), y: maMap.get(p.date), title: `${pretty(p.date)} · 200d ${fmt(maMap.get(p.date), 4)}` })),
      },
    ],
  });
}

function heatColor(value) {
  const t = Math.min(1, Math.abs(value) / 6);
  const mix = (a, b) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.pow(t, 0.8)));
  const rgb = value < 0 ? mix([42, 34, 30], [255, 159, 74]) : mix([22, 40, 72], [61, 141, 255]);
  return `rgb(${rgb.join(",")})`;
}

function renderHeat() {
  const fx = data.fx;
  const host = document.getElementById("heat");
  if (!fx?.changes) return empty(host, fx?.error || "FX heatmap is not available yet");
  const rows = HEAT_ORDER.map((ccy, index) => ({ ccy, index, ...fx.changes[ccy] }));
  const key = heatSort.key;
  rows.sort((a, b) => {
    if (key === "order") return (a.index - b.index) * heatSort.dir;
    if (key === "ccy") return a.ccy.localeCompare(b.ccy) * heatSort.dir;
    return ((a[key] ?? 0) - (b[key] ?? 0)) * heatSort.dir;
  });
  const arrow = (col) => heatSort.key === col ? (heatSort.dir > 0 ? "▲" : "▼") : "";
  const head = `<th data-sort="ccy" title="G10 currency code. Click to sort the rows alphabetically.">Currency <span class="arrow">${arrow("ccy")}</span></th>`
    + HEAT_COLS.map(([col, title]) => `<th data-sort="${col}" title="${title}">${col} <span class="arrow">${arrow(col)}</span></th>`).join("");
  const body = rows.map((row) => `<tr><td class="name">${row.ccy}</td>${HEAT_COLS.map(([col]) => {
    const v = row[col];
    return `<td class="cell" style="background:${heatColor(v)}" title="${row.ccy} ${col}: ${signed(v, 2, "%")} versus the US dollar">${signed(v, 1)}</td>`;
  }).join("")}</tr>`).join("");
  host.innerHTML = `<table class="heat"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    <p class="sub">${asof(fx.asOf)} · USD value of each currency, percent change. ECB reference rates.</p>`;
  host.querySelectorAll("th").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      heatSort = { key: col, dir: heatSort.key === col ? -heatSort.dir : (col === "ccy" ? 1 : -1) };
    renderHeat();
  });
  lockDates(host);
});
}

function renderCftc() {
  const points = windowOf(data.cftc?.points || [], period);
  const el = document.getElementById("cftc-chart");
  document.getElementById("cftc-sub").textContent = `Last ${period} days, weekly · CFTC legacy futures-only EURO FX (099741). Net = noncommercial long − short. Below zero = net short euro. ${asof(data.cftc?.asOf)}`;
  if (points.length < 2) return empty(el, data.cftc?.error || "CFTC positioning is not available yet");
  Chart.columnBars(el, {
    bars: points.map((p) => ({
      value: p.net,
      color: p.net < 0 ? Chart.ORANGE : Chart.BLUE,
      title: `${pretty(p.date)} · net ${p.net.toLocaleString("en-US")} · long ${p.long.toLocaleString("en-US")} · short ${p.short.toLocaleString("en-US")} · open interest ${p.openInterest.toLocaleString("en-US")}`,
    })),
    xLabels: [{ at: 0, text: `${period}d ago` }, { at: 1, text: "Latest" }],
  });
}

function paired(german, field, sign) {
  const us = (data.treasury?.points || []).filter((p) => p[field] != null);
  const out = [];
  let j = 0;
  for (const g of german) {
    while (j < us.length && us[j].date < g.date) j += 1;
    if (j < us.length && us[j].date === g.date) {
      const gap = sign * (us[j][field] - g.value);
      out.push({ date: g.date, value: gap, us: us[j][field], de: g.value });
    }
  }
  return out;
}

function renderGap() {
  const all = paired(data.bunds?.de2y || [], "2yr", 1);
  const points = windowOf(all, period);
  const el = document.getElementById("gap-chart");
  document.getElementById("gap-sub").textContent = `Last ${period} days · wider gap = rates pull toward the dollar · US 2Y minus German 2Y, percentage points. ${asof(points.at(-1)?.date || data.bunds?.asOf)}`;
  if (points.length < 2) return empty(el, "No overlapping US and German 2Y dates in this period");
  Chart.lineChart(el, {
    xLabels: xLabels(period),
    series: [{
      name: "US−DE 2Y",
      color: Chart.BLUE,
      points: points.map((p, i) => ({ x: i / (points.length - 1), y: p.value, title: `${pretty(p.date)} · gap ${fmt(p.value, 2)} pp · US ${fmt(p.us, 2)} · DE ${fmt(p.de, 2)}` })),
    }],
  });
}

function renderBund() {
  const all = paired(data.bunds?.de10y || [], "10yr", -1);
  const points = windowOf(all, period);
  const el = document.getElementById("bund-chart");
  document.getElementById("bund-sub").textContent = `Last ${period} days · more negative = Europe offers less yield vs US · German 10Y minus US 10Y. ${asof(points.at(-1)?.date || data.bunds?.asOf)}`;
  if (points.length < 2) return empty(el, "No overlapping Bund and Treasury 10Y dates in this period");
  Chart.lineChart(el, {
    xLabels: xLabels(period),
    series: [{
      name: "Bund−UST",
      color: Chart.ORANGE,
      points: points.map((p, i) => ({ x: i / (points.length - 1), y: p.value, title: `${pretty(p.date)} · ${fmt(p.value, 2)} pp · Bund ${fmt(p.de, 2)} · UST ${fmt(p.us, 2)}` })),
    }],
  });
}

function renderCurve() {
  const ust = data.treasury?.points || [];
  const el = document.getElementById("ust-chart");
  const legend = document.getElementById("ust-legend");
  if (!ust.length) return empty(el, data.treasury?.error || "Yield curve is not available yet");
  const last = ust.at(-1);
  const tenors = [["3mo", "3M"], ["2yr", "2Y"], ["5yr", "5Y"], ["10yr", "10Y"], ["30yr", "30Y"]];
  const snaps = [
    { name: "Today", color: Chart.BLUE, dashed: false, row: last },
    { name: "45d ago", color: "#c5ceda", dashed: true, row: onOrBefore(ust, addDays(last.date, -45)) },
    { name: "90d ago", color: Chart.ORANGE, dashed: false, row: onOrBefore(ust, addDays(last.date, -90)) },
  ];
  document.getElementById("curve-sub").textContent = `Today (${pretty(last.date)}) vs 45d ago (${pretty(snaps[1].row?.date)}) vs 90d ago (${pretty(snaps[2].row?.date)})`;
  Chart.lineChart(el, {
    tickMode: "half",
    suffix: "%",
    xLabels: tenors.map(([, label], i) => ({ at: i / (tenors.length - 1), text: label })),
    series: snaps.filter((s) => s.row).map((s) => ({
      name: s.name,
      color: s.color,
      dashed: s.dashed,
      dot: false,
      points: tenors.map(([,], i) => ({
        x: i / (tenors.length - 1),
        y: s.row[tenors[i][0]],
        title: `${s.name} ${tenors[i][1]} · ${fmt(s.row[tenors[i][0]], 2)}% · ${pretty(s.row.date)}`,
      })).filter((p) => Number.isFinite(p.y)),
    })),
  });
  legend.innerHTML = snaps.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("");
}

function renderBonds() {
  const el = document.getElementById("bond-chart");
  const bars = data.bonds?.bars || [];
  if (bars.length !== 7) return empty(el, data.bonds?.error || "Bond spreads are not available yet");
  const rows = [...bars].sort((a, b) => a.spreadBp - b.spreadBp);
  Chart.horizontalBars(el, rows.map((bar) => ({
    label: bar.country,
    sub: `${bar.badges.length ? `${bar.badges.join(" · ")} · ` : ""}as of ${pretty(bar.asOf)}`,
    value: bar.spreadBp,
    color: bar.spreadBp < 0 ? Chart.ORANGE : Chart.BLUE,
    display: signed(bar.spreadBp, 0),
    title: `${bar.country} 10Y ${fmt(bar.yield, 2)}% on ${pretty(bar.asOf)} minus US 10Y ${fmt(bar.us10y, 2)}% on ${pretty(bar.us10yDate)} = ${bar.spreadBp} bp. ${bar.source}`,
  })));
}

function ecbKnots(ecb) {
  if (!ecb?.anchor) return [];
  const knots = [{ months: 0, tenor: "€STR", value: ecb.anchor.value }];
  for (const p of ecb.points || []) knots.push({ months: p.months, tenor: p.tenor, value: p.value });
  if (ecb.spot2Y) knots.push({ months: ecb.spot2Y.months, tenor: "SR_2Y", value: ecb.spot2Y.value });
  return knots.filter((p) => Number.isFinite(p.value) && Number.isFinite(p.months)).sort((a, b) => a.months - b.months);
}

function renderPath() {
  const el = document.getElementById("path-chart");
  const fed = data["fed-path"];
  const ecb = data["ecb-path"];
  const legend = document.getElementById("path-legend");
  if (!fed?.points?.length && !ecb?.points?.length) return empty(el, "Rate paths are not available yet");
  const horizon = 24;
  const fedPoints = [{ x: 0, y: fed?.anchor?.value, title: `Now · ${fed?.anchor?.source || "anchor"} ${fmt(fed?.anchor?.value, 2)}%` }];
  for (const p of fed?.points || []) {
    const months = p.tenor ? p.months : (p.months ?? 0) + 1;
    if (months > 12) continue;
    fedPoints.push({ x: months / horizon, y: p.value, title: `${p.label || p.tenor || p.symbol} · ${fmt(p.value, 3)}%` });
  }
  const knots = ecbKnots(ecb);
  const ecbLine = knots.map((p) => ({
    x: p.months / horizon,
    y: p.value,
    title: `${p.tenor} · ${fmt(p.value, 2)}% at ${p.months}m`,
  }));
  const forward = ecb?.forward1Y;
  const forwardPoint = forward && Number.isFinite(forward.value) ? [{
    x: (forward.months || 12) / horizon,
    y: forward.value,
    title: `IF_1Y instantaneous forward · ${fmt(forward.value, 2)}% at ${forward.months || 12}m`,
  }] : [];
  Chart.lineChart(el, {
    tickMode: "half",
    suffix: "%",
    ticks: 5,
    xLabels: [{ at: 0, text: "Now" }, { at: 12 / horizon, text: "+12M" }, { at: 1, text: "+24M" }],
    series: [
      { name: "Fed", color: Chart.BLUE, points: fedPoints.filter((p) => Number.isFinite(p.y)) },
      { name: "ECB spots", color: Chart.ORANGE, points: ecbLine },
      { name: "ECB 1Y forward", color: Chart.ORANGE, callout: forward ? `IF ${fmt(forward.value, 2)}%` : "", points: forwardPoint },
    ],
  });
  const fedNote = fed?.proxy ? "Fed proxy" : "Fed futures";
  const knotText = knots.map((p) => `${p.tenor} ${fmt(p.value, 2)}% at ${p.months}m`).join(", ");
  const fwdText = forward ? `Dot at ${forward.months || 12}m is the 1Y instantaneous forward IF_1Y ${fmt(forward.value, 2)}%.` : "";
  const anchorNote = fed?.anchor?.source ? `Fed anchor: ${fed.anchor.source}.` : "";
  document.getElementById("path-sub").textContent = `Does not follow the period. Fed line is the next 12 monthly futures (implied rate = 100 − price). ${anchorNote} ECB line is the linear interpolation of €STR and the AAA spot curve: ${knotText}. ${fwdText} Proxy, not an OIS curve. ${asof(ecb?.asOf || fed?.asOf)}`;
  legend.innerHTML = `<span><i style="background:${Chart.BLUE}"></i>${fedNote} to +12M</span><span><i style="background:${Chart.ORANGE}"></i>ECB spots to 2Y</span><span><i style="background:${Chart.ORANGE}"></i>ECB 1Y forward</span>`;
}

function renderReal() {
  const points = windowOf(data["real-yield"]?.points || [], period);
  const el = document.getElementById("real-chart");
  const doc = data["real-yield"] || {};
  const realTitle = el.closest("article")?.querySelector("h2");
  if (realTitle) realTitle.textContent = doc.fallback ? "US 10Y real yield (Treasury)" : "US 10Y real yield (TIPS)";
  document.getElementById("real-sub").textContent = `Last ${period} days · higher real yields tend to support the dollar${doc.fallback ? " · FRED DFII10 unavailable, Treasury real yield curve" : ""} · ${asof(doc.asOf)}`;
  if (points.length < 2) return empty(el, doc.error || "Real yield is not available yet");
  Chart.lineChart(el, {
    tickMode: "half",
    suffix: "%",
    xLabels: xLabels(period),
    series: [{
      name: "US 10Y real",
      color: Chart.BLUE,
      points: points.map((p, i) => ({ x: i / (points.length - 1), y: p.value, title: `${pretty(p.date)} · ${fmt(p.value, 2)}%` })),
    }],
  });
}

function renderCmd() {
  const doc = data.commodities || {};
  const el = document.getElementById("cmd-chart");
  const gold = windowOf(doc.gold?.points || [], period);
  const oil = windowOf(doc.oil?.points || [], period);
  const flags = [doc.gold?.fallback ? "gold delayed" : "", doc.oil?.fallback ? "oil delayed" : ""].filter(Boolean).join(" · ");
  document.getElementById("cmd-sub").textContent = `Last ${period} days, rebased to 100 · blue = gold · orange = oil${flags ? ` · ${flags}` : ""} · gold ${asof(doc.gold?.asOf)} · oil ${asof(doc.oil?.asOf)}`;
  if (gold.length < 2 && oil.length < 2) return empty(el, "Gold and oil are not available yet");
  const rebase = (points, name, color) => {
    const base = points[0]?.value;
    if (!base) return null;
    return {
      name, color,
      points: points.map((p, i) => ({ x: i / (points.length - 1), y: (p.value / base) * 100, title: `${name} ${pretty(p.date)} · ${fmt(p.value, 2)} · rebased ${fmt((p.value / base) * 100, 1)}` })),
    };
  };
  Chart.lineChart(el, {
    xLabels: xLabels(period),
    series: [rebase(gold, "Gold", Chart.BLUE), rebase(oil, "Oil", Chart.ORANGE)].filter(Boolean),
  });
}

function renderAuctions() {
  const rows = windowOf(data.auctions?.auctions || [], period);
  const el = document.getElementById("auc-chart");
  document.getElementById("auc-sub").textContent = `Last ${period} days · Notes and Bonds (bills excluded; TIPS included when classified as a note or bond). Dashed line = average bid-to-cover. Hover a bar for the security and yield. ${asof(data.auctions?.asOf)}`;
  if (!rows.length) return empty(el, data.auctions?.error || "No note or bond auctions in this period");
  const avg = rows.reduce((s, r) => s + r.bidToCover, 0) / rows.length;
  Chart.columnBars(el, {
    average: avg,
    tickMode: "half",
    ticks: 3,
    bars: rows.map((r) => ({
      value: r.bidToCover,
      color: Chart.BLUE,
      title: `${r.securityTerm || r.securityType} ${r.securityType}${r.tips ? " TIPS" : ""} · yield ${r.highYield == null ? "n/a" : fmt(r.highYield, 3) + "%"} · bid-to-cover ${fmt(r.bidToCover, 2)} · ${pretty(r.date)}`,
    })),
    xLabels: [{ at: 0, text: `${period}d ago` }, { at: 1, text: "Latest auction" }],
  });
}

function renderCalendar() {
  const el = document.getElementById("cal-chart");
  const meetings = data.meetings?.meetings || [];
  if (!meetings.length) return empty(el, "Calendar file is missing");
  const today = new Date();
  const todayIso = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString().slice(0, 10);
  const banks = [
    ["Fed", Chart.BLUE],
    ["ECB", Chart.ORANGE],
    ["BoJ", Chart.ORANGE],
    ["BoE", Chart.ORANGE],
  ];
  const rows = banks.map(([name, color]) => {
    const events = meetings
      .filter((m) => m.bank === name)
      .map((m) => ({ ...m, days: Math.round((Date.parse(`${m.decisionDate}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86400000) }))
      .filter((m) => m.days >= 0 && m.days <= 90)
      .sort((a, b) => a.days - b.days);
    events.forEach((ev, i) => {
      const prev = events[i - 1];
      ev.shift = prev && ev.days - prev.days < 8 ? 16 : 0;
      ev.label = `+${ev.days}d`;
    });
    return { name, color, events };
  });
  Chart.timeline(el, { rows, maxDays: 90 });
}

function displayedNotes() {
  const notes = [];
  const stale = (doc, label) => {
    if (!doc) return;
    if (doc.status === "stale") notes.push(`${label}: showing the last good print`);
    else if (doc.status === "error" && !(doc.points?.length || doc.bars?.length || doc.auctions?.length)) notes.push(`${label}: unavailable`);
  };
  stale(data.eurusd, "EUR/USD");
  if (data.dxy?.points?.length) {
    if (data.dxy.fallback) notes.push("Dollar index: showing Broad USD index (Fed)");
    else if (data.dxy.status === "stale") notes.push("Dollar index: showing the last good print");
  } else if (data["broad-usd"]?.points?.length) {
    notes.push("Dollar index: showing Broad USD index (Fed) because ICE DXY did not load");
  } else {
    stale(data.dxy, "Dollar index");
  }
  stale(data.treasury, "US Treasury");
  stale(data.fx, "G10 heatmap");
  stale(data.cftc, "EUR positioning");
  stale(data.bunds, "German yields");
  stale(data.bonds, "10Y spreads");
  const real = data["real-yield"];
  if (real?.fallback) notes.push("US 10Y real yield: using Treasury source");
  else stale(real, "US 10Y real yield");
  const fed = data["fed-path"];
  if (fed?.proxy) notes.push("Fed path: using the Treasury yield proxy");
  else if (fed?.fallback) notes.push(`Fed path: anchored to ${fed.anchor?.source || "a fallback rate"}`);
  else stale(fed, "Fed path");
  stale(data["ecb-path"], "ECB path");
  const cmd = data.commodities || {};
  if (cmd.gold?.fallback) notes.push("Gold: using the GLD fallback");
  if (cmd.oil?.fallback) notes.push("Oil: using the delayed WTI series");
  if (cmd.status === "stale") notes.push("Gold and oil: showing the last good print");
  stale(data.auctions, "Treasury auctions");
  stale(data.meetings, "Central bank calendar");
  return notes;
}

function renderChrome() {
  const health = data.health || {};
  document.getElementById("version").textContent = health.version || APP_VERSION;
  document.getElementById("updated").textContent = `Updated ${stamp(health.generatedAt)}`;
  const notes = displayedNotes();
  document.getElementById("foot-fresh").textContent = notes.join(" · ");
  document.getElementById("period").value = String(period);
}

function render() {
  renderChrome();
  renderKpis();
  renderEur();
  renderHeat();
  renderCftc();
  renderGap();
  renderBund();
  renderCurve();
  renderBonds();
  renderPath();
  renderReal();
  renderCmd();
  renderAuctions();
  renderCalendar();
  lockDates(document);
}

document.getElementById("period").addEventListener("change", (event) => {
  period = Number(event.target.value);
  localStorage.setItem("macro-period", String(period));
  render();
});
document.getElementById("tab-main").addEventListener("click", () => setTab("main", true));
document.getElementById("tab-extra").addEventListener("click", () => setTab("extra", true));
setTab(tab, false);
let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 60);
});
load();
