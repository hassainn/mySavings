import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Scrapes screener.in (server-side; it is CORS-blocked in the browser) for the
// top breakout stocks in the latest scan and publishes docs/data/fundamentals.json
// with last-few-quarter EPS / sales / net-profit YoY growth + ROE / P/E, so the
// app can show real fundamentals on a stock. Screener has no API — we parse the
// public company page's Quarterly Results table.

const MAX_STOCKS = Math.max(1, Math.min(60, Number(process.env.FUND_MAX || 45)));
const SPACING_MS = Math.max(400, Number(process.env.FUND_SPACING_MS || 1200));
const outputPath = path.resolve("docs/data/fundamentals.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim();
const num = (s) => { const n = Number(String(s).replace(/,/g, "").replace(/[^\-0-9.]/g, "")); return Number.isFinite(n) ? n : null; };
const yoy = (arr, i) => (arr && arr[i] != null && arr[i - 4] != null && arr[i - 4] !== 0 ? round(((arr[i] - arr[i - 4]) / Math.abs(arr[i - 4])) * 100) : null);
const round = (n) => (Number.isFinite(n) ? Number(n.toFixed(1)) : null);

function tableAfter(html, title) {
  const i = html.indexOf(title);
  if (i < 0) return "";
  const s = html.indexOf("<table", i);
  const e = html.indexOf("</table>", s);
  return s >= 0 && e >= 0 ? html.slice(s, e) : "";
}
function quarterHeads(tableHtml) {
  return [...tableHtml.matchAll(/<th[^>]*>\s*([A-Z][a-z]{2} \d{4})\s*<\/th>/g)].map((m) => m[1]);
}
function rowNums(tableHtml, label) {
  const rows = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]));
    if (cells.length && cells[0].replace(/[\s+%]/g, "").toLowerCase().startsWith(label.replace(/\s/g, "").toLowerCase())) {
      return cells.slice(1).map(num).filter((n) => n != null);
    }
  }
  return null;
}
function topRatio(html, label) {
  // screener top ratios: <li ...><span class="name">Stock P/E</span> ... <span class="number">24.1</span> ...
  const re = new RegExp(`name[^>]*>\\s*${label}[\\s\\S]{0,220}?number[^>]*>\\s*([\\-0-9,.]+)`, "i");
  const m = html.match(re);
  return m ? num(m[1]) : null;
}

async function fetchCompany(sym) {
  const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Accept: "text/html" };
  for (const url of [`https://www.screener.in/company/${sym}/consolidated/`, `https://www.screener.in/company/${sym}/`]) {
    try {
      const r = await fetch(url, { headers });
      if (r.status !== 200) continue;
      const html = await r.text();
      const qt = tableAfter(html, "Quarterly Results");
      if (!qt) continue;
      const heads = quarterHeads(qt);
      const eps = rowNums(qt, "EPS");
      const sales = rowNums(qt, "Sales") || rowNums(qt, "Revenue");
      const np = rowNums(qt, "Net Profit") || rowNums(qt, "Profit");
      if (!eps && !sales) continue;
      const last = (a) => (a && a.length ? a[a.length - 1] : null);
      const li = eps ? eps.length - 1 : sales.length - 1;
      const epsGrowth = [];
      // last 3 quarters of EPS YoY; a near-zero base makes the % meaningless — drop |>500%|.
      if (eps) for (let k = 0; k < 3; k++) { const idx = eps.length - 1 - k; const g = yoy(eps, idx); if (g != null && Math.abs(g) <= 500) epsGrowth.unshift({ q: heads[idx] || "", yoy: g }); }
      const salesG = sales ? yoy(sales, sales.length - 1) : null;
      const npG = np ? yoy(np, np.length - 1) : null;
      const ttmEps = eps && eps.length >= 4 ? round(eps.slice(-4).reduce((a, b) => a + b, 0)) : null;
      const twoQtrStrong = epsGrowth.length >= 2 && epsGrowth.slice(-2).every((e) => e.yoy != null && e.yoy >= 25);
      const growthQualified = twoQtrStrong && salesG != null && salesG >= 15 ? "Yes" : epsGrowth.some((e) => e.yoy >= 25) ? "Partial" : "No";
      const at = (a, back) => (a && a.length > back ? a[a.length - 1 - back] : null);
      return {
        basis: url.includes("consolidated") ? "Consolidated" : "Standalone",
        latestQuarter: heads.length ? heads[heads.length - 1] : null,
        priorYearQuarter: heads.length >= 5 ? heads[heads.length - 5] : null,
        eps: last(eps),
        epsNow: at(eps, 0),
        epsPrior: at(eps, 4),
        revNow: at(sales, 0),
        revPrior: at(sales, 4),
        ttmEps,
        epsGrowth,
        salesGrowthYoY: salesG,
        profitGrowthYoY: npG,
        roe: topRatio(html, "ROE"),
        roce: topRatio(html, "ROCE"),
        pe: topRatio(html, "Stock P/E") || topRatio(html, "P/E"),
        growthQualified,
        source: url,
      };
    } catch {
      /* try next url */
    }
  }
  return null;
}

// Pick the top breakout stocks from the latest scan.
let symbols = [];
try {
  const scan = JSON.parse(await readFile(path.resolve("docs/data/scanner-results.json"), "utf8"));
  symbols = (scan.signals || []).map((s) => s.symbol).filter(Boolean).slice(0, MAX_STOCKS);
} catch {
  console.log("No scanner-results.json; nothing to enrich.");
}
if (process.argv[2]) symbols = process.argv.slice(2); // manual: node generate-fundamentals.mjs RELIANCE TCS

const out = { generatedAt: new Date().toISOString(), source: "screener.in", count: 0, symbols: {} };
let ok = 0;
for (const sym of symbols) {
  const data = await fetchCompany(sym);
  if (data) { out.symbols[sym] = data; ok += 1; }
  console.log(`${sym}: ${data ? `EPS ${data.eps ?? "?"}, EPS YoY ${data.epsGrowth.map((e) => e.yoy + "%").join("/") || "?"}, growth ${data.growthQualified}` : "no data"}`);
  await sleep(SPACING_MS);
}
out.count = ok;
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(out), "utf8");
console.log(`\nWrote ${path.relative(process.cwd(), outputPath)} with fundamentals for ${ok}/${symbols.length} stocks.`);
