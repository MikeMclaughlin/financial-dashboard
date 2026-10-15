import fs from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";

export const APP_VERSION = "1.1";
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const DATA = path.join(ROOT, "data");

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function dataPath(name) {
  return path.join(DATA, name);
}

export function readJson(name, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(dataPath(name), "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(name, value) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(dataPath(name), JSON.stringify(value, null, 2) + "\n");
}

export async function fetchBuffer(url, { timeout = 45000, headers = {} } = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
    headers: {
      "User-Agent": UA,
      Accept: "*/*",
      ...headers,
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchText(url, opts = {}) {
  const buf = await fetchBuffer(url, opts);
  const encoding = opts.encoding || "utf-8";
  if (encoding.toLowerCase() === "utf-8" || encoding.toLowerCase() === "utf8") {
    return buf.toString("utf8").replace(/^\uFEFF/, "");
  }
  return iconv.decode(buf, encoding).replace(/^\uFEFF/, "");
}

const FRED_TIMEOUT_MS = 60000;
const FRED_ATTEMPTS = 3;
let fredHostDown = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransportError(err) {
  const message = err?.message || String(err);
  return /timeout|aborted|network|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|UND_ERR/i.test(message);
}

function fredUrls(id, start) {
  const series = encodeURIComponent(id);
  const cosd = encodeURIComponent(start);
  return [
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}&cosd=${cosd}`,
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}`,
  ];
}

function parseFredCsv(text, id) {
  const trimmed = String(text).trim();
  if (!trimmed || /<!DOCTYPE html>|<html/i.test(trimmed.slice(0, 400))) {
    throw new Error(`FRED ${id} returned a non-CSV page`);
  }
  const rows = parseCsv(trimmed);
  const points = [];
  for (const row of rows.slice(1)) {
    const date = row[0];
    const value = num(row[1]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || value == null) continue;
    points.push({ date, value });
  }
  return sortUnique(points);
}

/**
 * Download one FRED graph CSV. Each URL is tried 3 times with a 60s
 * timeout and exponential backoff. The dated URL is tried first; the
 * undated graph URL is the alternate form and is filtered to `start`.
 * After every form fails on the network, later calls in this process
 * skip straight to the caller's fallback.
 */
export async function fetchFred(id, start = "2024-01-01") {
  if (fredHostDown) throw new Error(fredHostDown);
  const errors = [];
  let transportOnly = true;
  for (const url of fredUrls(id, start)) {
    for (let attempt = 1; attempt <= FRED_ATTEMPTS; attempt++) {
      try {
        const text = await fetchText(url, { timeout: FRED_TIMEOUT_MS });
        const points = parseFredCsv(text, id).filter((point) => point.date >= start);
        if (!points.length) throw new Error(`FRED ${id} returned no observations from ${start}`);
        fredHostDown = null;
        return points;
      } catch (err) {
        const message = err?.message || String(err);
        errors.push(`${url} attempt ${attempt}: ${message}`);
        if (!isTransportError(err)) transportOnly = false;
        if (attempt < FRED_ATTEMPTS) await sleep(5000 * 2 ** (attempt - 1));
      }
    }
  }
  const detail = errors.join(" | ");
  if (transportOnly) {
    fredHostDown = `FRED unreachable (${detail})`;
    throw new Error(fredHostDown);
  }
  throw new Error(`FRED ${id}: ${detail}`);
}

export function fredHostError() {
  return fredHostDown;
}

export function parseCsv(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let cur = "";
  let quoted = false;
  const s = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(cur);
      cur = "";
    } else if (c === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else if (c !== "\r") {
      cur += c;
    }
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ""));
}

export function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(iso, days) {
  const t = Date.parse(`${iso}T00:00:00Z`) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function parseMDY(s) {
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

export function parseDMYMon(s) {
  const months = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const m = String(s).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const mm = months[m[2].toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
}

export function monthEnd(yearMonth) {
  const [y, m] = yearMonth.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

export function num(value) {
  if (value == null) return null;
  let s = String(value).trim();
  if (!s || s === "." || s === "-" || s === "NA" || s === "N/A" || s === "null") return null;
  s = s.replace(/\s/g, "");
  if (s.includes(",") && !s.includes(".")) s = s.replace(",", ".");
  s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function sortUnique(points, key = "date") {
  const map = new Map();
  for (const p of points) {
    if (!p || !p[key]) continue;
    map.set(p[key], p);
  }
  return [...map.values()].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
}

export function latestOnOrBefore(points, date, key = "date") {
  let ans = null;
  for (const p of points) {
    if (p[key] <= date) ans = p;
    else break;
  }
  return ans;
}

export function inRange(n, lo, hi, label) {
  if (n == null || !Number.isFinite(n) || n < lo || n > hi) {
    throw new Error(`${label} ${n} outside ${lo}..${hi}`);
  }
}

export function assertDates(points, label) {
  let prev = "";
  const today = addDays(isoToday(), 3);
  for (const p of points) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new Error(`${label} bad date ${p.date}`);
    if (p.date < prev) throw new Error(`${label} unsorted at ${p.date}`);
    if (p.date > today) throw new Error(`${label} future date ${p.date}`);
    prev = p.date;
  }
}

export async function runSource(name, file, producer, validate) {
  const prev = readJson(file);
  try {
    const next = await producer(prev);
    next.id = next.id || name;
    next.fetchedAt = new Date().toISOString();
    if (!next.status) next.status = "ok";
    validate(next);
    writeJson(file, next);
    console.log(`OK   ${name} status=${next.status} asOf=${next.asOf || "-"}`);
    return next;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error(`FAIL ${name}: ${message}`);
    if (prev && hasPayload(prev)) {
      prev.status = "stale";
      prev.error = message;
      prev.fetchedAt = new Date().toISOString();
      writeJson(file, prev);
      console.log(`KEEP ${name} last good asOf=${prev.asOf || "-"}`);
      return prev;
    }
    const empty = {
      id: name,
      status: "error",
      error: message,
      fetchedAt: new Date().toISOString(),
      points: [],
    };
    writeJson(file, empty);
    return empty;
  }
}

function hasPayload(doc) {
  if (!doc || typeof doc !== "object") return false;
  if (Array.isArray(doc.points) && doc.points.length) return true;
  if (Array.isArray(doc.bars) && doc.bars.length) return true;
  if (Array.isArray(doc.auctions) && doc.auctions.length) return true;
  if (doc.levels && Object.keys(doc.levels).length) return true;
  if (doc.fed?.points?.length || doc.ecb?.points?.length) return true;
  if (doc.gold?.points?.length || doc.oil?.points?.length) return true;
  if (doc.de2y?.length || doc.de10y?.length) return true;
  return false;
}

export function seriesSummary(doc) {
  if (!doc) return { status: "missing", asOf: null };
  return {
    status: doc.status || "unknown",
    asOf: doc.asOf || null,
    fallback: Boolean(doc.fallback),
    proxy: Boolean(doc.proxy),
    delayed: Boolean(doc.delayed),
    source: doc.source || null,
    error: doc.error || null,
    fetchedAt: doc.fetchedAt || null,
  };
}

export function rebuildHealth(extra = {}) {
  const files = [
    "eurusd",
    "dxy",
    "broad-usd",
    "treasury",
    "fx",
    "cftc",
    "bunds",
    "bonds",
    "ecb-path",
    "fed-path",
    "real-yield",
    "commodities",
    "auctions",
    "fx-yahoo",
    "meetings",
  ];
  const series = {};
  for (const name of files) {
    series[name] = seriesSummary(readJson(`${name}.json`));
  }
  const health = {
    version: APP_VERSION,
    service: "financial-dashboard",
    generatedAt: new Date().toISOString(),
    status: Object.values(series).some((s) => s.status === "error" || s.status === "missing")
      ? "degraded"
      : "ok",
    series,
    ...extra,
  };
  writeJson("health.json", health);
  fs.writeFileSync(path.join(ROOT, "health.json"), JSON.stringify(health, null, 2) + "\n");
  return health;
}
