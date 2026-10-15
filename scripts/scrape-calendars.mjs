/**
 * Re-scrape official central-bank calendars and diff them against
 * data/meetings.json. A difference fails the job. This script never
 * rewrites the canonical file unless invoked with --write (bootstrap only).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fetchText, DATA } from "./common.mjs";

const FILE = path.join(DATA, "meetings.json");

const SOURCES = {
  fed: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
  ecbCalendar: "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html",
  ecbDecisions: "https://www.ecb.europa.eu/press/govcdec/mopo",
  boe: "https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates",
  boj: "https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm",
};

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, sept: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function iso(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function meeting(bank, decisionDate, extra = {}) {
  return {
    bank,
    decisionDate,
    startDate: extra.startDate || decisionDate,
    endDate: extra.endDate || decisionDate,
    source: extra.source,
    note: extra.note || null,
  };
}

function parseFed(html) {
  const text = textOf(html);
  const out = [];
  const yearRe = /(\d{4}) FOMC Meetings/g;
  const years = [];
  let m;
  while ((m = yearRe.exec(text))) years.push({ year: Number(m[1]), index: m.index });
  for (let i = 0; i < years.length; i++) {
    if (years[i].year !== 2026 && years[i].year !== 2027) continue;
    let end = years[i + 1] ? years[i + 1].index : text.length;
    const note = text.indexOf("Note:", years[i].index + 10);
    if (note !== -1 && note < end) end = note;
    const chunk = text.slice(years[i].index, end);
    const monthRe = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})-(\d{1,2})(?!\d)/g;
    let mm;
    while ((mm = monthRe.exec(chunk))) {
      const month = MONTHS[mm[1].toLowerCase()];
      const startDay = Number(mm[2]);
      const endDay = Number(mm[3]);
      const year = years[i].year;
      const endMonth = endDay >= startDay ? month : month + 1;
      const endYear = endMonth > 12 ? year + 1 : year;
      const endM = ((endMonth - 1) % 12) + 1;
      out.push(meeting("Fed", iso(endYear, endM, endDay), {
        startDate: iso(year, month, startDay),
        endDate: iso(endYear, endM, endDay),
        source: SOURCES.fed,
        note: "Decision date is day 2 of the FOMC meeting",
      }));
    }
  }
  return out;
}

function parseEcbCalendar(html) {
  const out = [];
  const re = /<dt>\s*(\d{2})\/(\d{2})\/(\d{4})\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/gi;
  let m;
  while ((m = re.exec(html))) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    const body = textOf(m[4]).toLowerCase();
    if (!body.includes("monetary policy meeting")) continue;
    if (body.includes("non-monetary")) continue;
    if (!body.includes("day 2") && !body.includes("press conference")) continue;
    const date = iso(year, month, day);
    out.push(meeting("ECB", date, {
      source: SOURCES.ecbCalendar,
      note: "Decision date is day 2 of the Governing Council monetary policy meeting",
    }));
  }
  return out;
}

function parseEcbDecisions(html, year) {
  const out = [];
  const seen = new Set();
  const re = /ecb\.mp(\d{2})(\d{2})(\d{2})/g;
  let m;
  while ((m = re.exec(html))) {
    const date = iso(2000 + Number(m[1]), Number(m[2]), Number(m[3]));
    if (seen.has(date)) continue;
    seen.add(date);
    out.push(meeting("ECB", date, {
      source: `${SOURCES.ecbDecisions}/${year}/html/index_include.en.html`,
      note: "Press release date of the monetary policy decision",
    }));
  }
  return out;
}

function parseBoe(html) {
  const text = textOf(html);
  const out = [];
  const blocks = [
    { year: 2026, re: /2026 confirmed dates([\s\S]*?)2027 confirmed dates/i },
    { year: 2027, re: /2027 confirmed dates([\s\S]*?)Monetary Policy Committee Reports/i },
  ];
  for (const block of blocks) {
    const found = text.match(block.re);
    if (!found) continue;
    const re = /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b/gi;
    let m;
    while ((m = re.exec(found[1]))) {
      const day = Number(m[1]);
      const month = MONTHS[m[2].toLowerCase()];
      out.push(meeting("BoE", iso(block.year, month, day), {
        source: SOURCES.boe,
        note: "MPC announcement / decision date",
      }));
    }
  }
  return out;
}

function parseBoj(html) {
  const text = textOf(html);
  const out = [];
  const sections = [
    { year: 2026, re: /Table : 2026([\s\S]*?)Table : 2027/ },
    { year: 2027, re: /Table : 2027([\s\S]*?)Note: The time of release/ },
  ];
  const monthRe = "(Jan|Feb|Mar|Apr|May|June|July|Aug|Sept|Oct|Nov|Dec)";
  const pair = new RegExp(
    `${monthRe}\\.?\\s+(\\d{1,2})\\s*\\([^)]*\\),\\s*(\\d{1,2})\\s*\\(`,
    "g",
  );
  for (const section of sections) {
    const found = text.match(section.re);
    if (!found) continue;
    let m;
    pair.lastIndex = 0;
    while ((m = pair.exec(found[1]))) {
      const month = MONTHS[m[1].toLowerCase()];
      const startDay = Number(m[2]);
      const endDay = Number(m[3]);
      const year = section.year;
      out.push(meeting("BoJ", iso(year, month, endDay), {
        startDate: iso(year, month, startDay),
        endDate: iso(year, month, endDay),
        source: SOURCES.boj,
        note: "Decision date is day 2 of the Monetary Policy Meeting",
      }));
    }
  }
  return out;
}

function dedupe(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.bank}|${row.decisionDate}`, row);
  }
  return [...map.values()].sort((a, b) =>
    a.bank === b.bank ? a.decisionDate.localeCompare(b.decisionDate) : a.bank.localeCompare(b.bank),
  );
}

export async function scrapeMeetings() {
  const [fedHtml, ecbCal, ecb2025, ecb2026, boeHtml, bojHtml] = await Promise.all([
    fetchText(SOURCES.fed),
    fetchText(SOURCES.ecbCalendar),
    fetchText(`${SOURCES.ecbDecisions}/2025/html/index_include.en.html`),
    fetchText(`${SOURCES.ecbDecisions}/2026/html/index_include.en.html`),
    fetchText(SOURCES.boe),
    fetchText(SOURCES.boj),
  ]);
  const rows = dedupe([
    ...parseFed(fedHtml),
    ...parseEcbCalendar(ecbCal),
    ...parseEcbDecisions(ecb2025, 2025),
    ...parseEcbDecisions(ecb2026, 2026),
    ...parseBoe(boeHtml),
    ...parseBoj(bojHtml),
  ]);
  if (rows.length < 40) {
    throw new Error(`Parsed only ${rows.length} meetings; refusing a short scrape`);
  }
  const counts = {};
  for (const row of rows) counts[row.bank] = (counts[row.bank] || 0) + 1;
  return {
    id: "meetings",
    description: "Hardcoded official central-bank decision dates. The monthly checker fails if a fresh scrape differs.",
    status: "ok",
    asOf: new Date().toISOString().slice(0, 10),
    source: SOURCES,
    counts,
    meetings: rows,
  };
}

function signature(doc) {
  return (doc.meetings || [])
    .map((m) => `${m.bank}|${m.decisionDate}|${m.startDate}|${m.endDate}`)
    .sort()
    .join("\n");
}

async function main() {
  const write = process.argv.includes("--write");
  const fresh = await scrapeMeetings();
  console.log("scraped", fresh.counts, "total", fresh.meetings.length);
  if (write) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(fresh, null, 2) + "\n");
    console.log("wrote", FILE);
    return;
  }
  if (!fs.existsSync(FILE)) {
    console.error("missing canonical meetings file", FILE);
    process.exit(1);
  }
  const current = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const a = signature(current);
  const b = signature(fresh);
  if (a !== b) {
    console.error("Central-bank calendar DIFFERS from data/meetings.json. Not updating the file.");
    const as = new Set(a.split("\n"));
    const bs = new Set(b.split("\n"));
    for (const line of bs) if (!as.has(line)) console.error(" +", line);
    for (const line of as) if (!bs.has(line)) console.error(" -", line);
    process.exit(1);
  }
  console.log("calendar check ok: scrape matches data/meetings.json");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
