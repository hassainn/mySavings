import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

// Builds docs/data/nse-symbols.json — a compact { trading_symbol: {k: instrument_key, n: name} }
// map of NSE cash equities, so the app can resolve any symbol to a price key and
// fetch real closes from Upstox's public historical-candle endpoint (no token needed).

const url = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
const res = await fetch(url);
if (!res.ok) {
  console.error(`Failed to fetch NSE instruments: HTTP ${res.status}`);
  process.exit(1);
}
const buffer = Buffer.from(await res.arrayBuffer());
const instruments = JSON.parse(gunzipSync(buffer).toString("utf8"));

const symbols = {};
for (const row of instruments) {
  if (
    row.segment === "NSE_EQ" &&
    row.instrument_type === "EQ" &&
    row.security_type === "NORMAL" &&
    row.trading_symbol &&
    row.instrument_key
  ) {
    symbols[row.trading_symbol] = { k: row.instrument_key, n: String(row.name || row.trading_symbol).trim() };
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  count: Object.keys(symbols).length,
  symbols,
};
const outPath = path.resolve("docs/data/nse-symbols.json");
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(out), "utf8");
console.log(`Wrote ${path.relative(process.cwd(), outPath)} with ${out.count} NSE equities.`);
