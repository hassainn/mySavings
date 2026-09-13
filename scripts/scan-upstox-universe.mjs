import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
if (!token) {
  console.log("UPSTOX_ACCESS_TOKEN is not configured; keeping the existing scan.");
  process.exit(0);
}

const outputPath = path.resolve("docs/data/scanner-results.json");
const partitionCount = Math.max(1, Math.min(4, Number(process.env.PARTITION_COUNT || 2)));
const partitionIndex = Math.max(0, Math.min(partitionCount - 1, Number(process.env.PARTITION_INDEX || 0)));
const partitionPath = path.resolve(`docs/data/scanner-results-part-${partitionIndex}.json`);
const instrumentUrl =
  "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
const maxInstruments = Math.min(
  1850,
  Math.max(1, Number(process.env.MAX_INSTRUMENTS || 1850)),
);
const requestSpacingMs = Math.max(
  125,
  Number(process.env.UPSTOX_REQUEST_SPACING_MS || 135),
);
const minimumPrice = Math.max(1, Number(process.env.MINIMUM_PRICE || 20));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value, digits = 2) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const mean = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const highest = (values) => Math.max(...values);
const lowest = (values) => Math.min(...values);
const pct = (value, base) => (base ? ((value - base) / base) * 100 : 0);

function sma(values, period, index = values.length - 1) {
  if (index + 1 < period) return null;
  return mean(values.slice(index - period + 1, index + 1));
}

function emaSeries(values, period) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const output = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    output.push(values[index] * multiplier + output[index - 1] * (1 - multiplier));
  }
  return output;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  if (!losses) return 100;
  const relativeStrength = gains / losses;
  return 100 - 100 / (1 + relativeStrength);
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const ranges = [];
  for (let index = candles.length - period; index < candles.length; index += 1) {
    const current = candles[index];
    const previousClose = candles[index - 1].close;
    ranges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previousClose),
        Math.abs(current.low - previousClose),
      ),
    );
  }
  return mean(ranges);
}

function localLows(candles, start, end) {
  const lows = [];
  for (let index = Math.max(2, start); index <= Math.min(end, candles.length - 3); index += 1) {
    const value = candles[index].low;
    if (
      value <= candles[index - 1].low &&
      value <= candles[index - 2].low &&
      value <= candles[index + 1].low &&
      value <= candles[index + 2].low
    ) {
      lows.push(index);
    }
  }
  return lows;
}

function detectDoubleBottom(candles) {
  const end = candles.length - 1;
  const lows = localLows(candles, end - 90, end - 4);
  for (let right = lows.length - 1; right >= 1; right -= 1) {
    for (let left = right - 1; left >= 0; left -= 1) {
      const first = lows[left];
      const second = lows[right];
      const separation = second - first;
      if (separation < 10 || separation > 60) continue;
      const lowA = candles[first].low;
      const lowB = candles[second].low;
      if (Math.abs(lowA - lowB) / Math.min(lowA, lowB) > 0.035) continue;
      const neckline = highest(candles.slice(first, second + 1).map((candle) => candle.high));
      const close = candles[end].close;
      if (close >= neckline * 0.98) {
        return { active: true, neckline, floor: Math.min(lowA, lowB) };
      }
    }
  }
  return { active: false };
}

function detectVcp(candles) {
  if (candles.length < 80) return { active: false };
  const slice = candles.slice(-60);
  const ranges = [
    slice.slice(0, 20),
    slice.slice(20, 40),
    slice.slice(40, 60),
  ].map((group) => (highest(group.map((x) => x.high)) - lowest(group.map((x) => x.low))) / mean(group.map((x) => x.close)));
  const volumes = [mean(slice.slice(0, 20).map((x) => x.volume)), mean(slice.slice(40).map((x) => x.volume))];
  const pivot = highest(slice.slice(0, -1).map((x) => x.high));
  const close = slice.at(-1).close;
  return {
    active:
      ranges[1] < ranges[0] * 0.9 &&
      ranges[2] < ranges[1] * 0.9 &&
      volumes[1] < volumes[0] * 0.85 &&
      close >= pivot * 0.94,
    pivot,
  };
}

function detectDarvas(candles) {
  const prior = candles.slice(-31, -1);
  const ceiling = highest(prior.map((x) => x.high));
  const floor = lowest(prior.slice(-12).map((x) => x.low));
  const close = candles.at(-1).close;
  return {
    active: close >= ceiling * 0.985 && (ceiling - floor) / ceiling <= 0.18,
    ceiling,
    floor,
  };
}

function evaluateBreakoutHistory(candles) {
  const outcomes = [];
  for (let index = 55; index < candles.length - 12; index += 1) {
    const prior = candles.slice(index - 20, index);
    const volumeBase = mean(prior.map((x) => x.volume));
    if (
      candles[index].close <= highest(prior.map((x) => x.high)) ||
      candles[index].volume < volumeBase * 1.35
    ) continue;
    const entry = candles[index].close;
    const risk = Math.max(entry * 0.025, entry - lowest(candles.slice(index - 7, index + 1).map((x) => x.low)));
    const stop = entry - risk;
    const target = entry + risk * 2;
    let result = "open";
    for (const future of candles.slice(index + 1, index + 11)) {
      if (future.low <= stop) { result = "loss"; break; }
      if (future.high >= target) { result = "win"; break; }
    }
    if (result !== "open") outcomes.push(result);
  }
  const wins = outcomes.filter((value) => value === "win").length;
  return {
    sampleSize: outcomes.length,
    winRate: outcomes.length ? round((wins / outcomes.length) * 100, 0) : null,
    method: "2R before 1R stop within 10 sessions",
  };
}

function analyze(instrument, candles) {
  if (candles.length < 210) return null;
  const close = candles.at(-1).close;
  if (close < minimumPrice) return null;
  const closes = candles.map((x) => x.close);
  const volumes = candles.map((x) => x.volume);
  const ema21 = emaSeries(closes, 21).at(-1);
  const ema12Series = emaSeries(closes, 12);
  const ema26Series = emaSeries(closes, 26);
  const macdSeries = ema12Series.map((value, index) => value - ema26Series[index]);
  const macd = macdSeries.at(-1);
  const macdSignal = emaSeries(macdSeries.slice(25), 9).at(-1);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const priorHigh20 = highest(candles.slice(-21, -1).map((x) => x.high));
  const high52 = highest(candles.slice(-252, -1).map((x) => x.high));
  const avgVolume20 = mean(volumes.slice(-21, -1));
  const relativeVolume = avgVolume20 ? candles.at(-1).volume / avgVolume20 : 0;
  const rsi14 = rsi(closes);
  const atr14 = atr(candles);
  const doubleBottom = detectDoubleBottom(candles);
  const vcp = detectVcp(candles);
  const darvas = detectDarvas(candles);
  const tags = [];
  const evidence = [];
  let score = 28;

  const trendTemplate = close > ema21 && close > sma50 && sma50 > sma200;
  if (trendTemplate) { tags.push("Trend template"); evidence.push("Price above EMA21, SMA50 and SMA200"); score += 18; }
  if (close > priorHigh20) { tags.push("20-day breakout"); evidence.push("Close cleared the prior 20-session high"); score += 18; }
  else if (close >= priorHigh20 * 0.985) { tags.push("Near breakout"); evidence.push("Within 1.5% of the 20-session pivot"); score += 9; }
  if (close > high52) { tags.push("52-week high"); evidence.push("New trailing-year price high"); score += 12; }
  if (relativeVolume >= 1.5) { tags.push("Volume expansion"); evidence.push(`${round(relativeVolume)}× 20-day average volume`); score += 12; }
  else if (relativeVolume >= 1.15) { evidence.push(`${round(relativeVolume)}× 20-day average volume`); score += 5; }
  if (rsi14 >= 52 && rsi14 <= 72) { evidence.push(`RSI ${round(rsi14, 0)} supports momentum without extreme extension`); score += 7; }
  if (macd > macdSignal && macd > 0) { tags.push("MACD positive"); evidence.push("MACD is above signal and zero line"); score += 6; }
  if (doubleBottom.active) { tags.push("Double bottom"); evidence.push("Two aligned swing lows with neckline pressure"); score += 13; }
  if (vcp.active) { tags.push("VCP"); evidence.push("Contracting ranges with volume dry-up"); score += 13; }
  if (darvas.active) { tags.push("Darvas box"); evidence.push("Tight 30-session box near its ceiling"); score += 8; }
  if (close > sma50 && sma50 > sma200 && sma(closes, 50, closes.length - 11) < sma50) {
    tags.push("Golden trend");
    score += 5;
  }

  const actionablePatterns = ["20-day breakout", "52-week high", "Double bottom", "VCP", "Darvas box", "Near breakout"];
  const meaningful = tags.some((tag) => actionablePatterns.includes(tag));
  if (!meaningful) return null;
  const confidence = Math.max(1, Math.min(99, Math.round(score)));
  const pivotCandidates = [priorHigh20, doubleBottom.neckline, vcp.pivot, darvas.ceiling].filter(Number.isFinite);
  const entryTrigger = Math.max(...pivotCandidates) * 1.001;
  const structuralLow = lowest(candles.slice(-10).map((x) => x.low));
  const stop = Math.max(structuralLow, entryTrigger - atr14 * 2);
  const risk = entryTrigger - stop;
  const target = entryTrigger + risk * 2;
  const backtest = evaluateBreakoutHistory(candles);

  return {
    symbol: instrument.trading_symbol,
    name: instrument.short_name || instrument.name,
    instrumentKey: instrument.instrument_key,
    asOf: candles.at(-1).date,
    close: round(close),
    changePct: round(pct(close, candles.at(-2).close)),
    confidence,
    state: close >= entryTrigger ? "Triggered" : confidence >= 78 ? "Armed" : "Watch",
    primaryPattern: tags.find((tag) => actionablePatterns.includes(tag)) || tags[0] || "Confluence",
    patterns: tags.slice(0, 6),
    evidence: evidence.slice(0, 5),
    entryTrigger: round(entryTrigger),
    stop: round(stop),
    target2R: round(target),
    riskReward: risk > 0 ? 2 : null,
    indicators: {
      ema21: round(ema21), sma50: round(sma50), sma200: round(sma200),
      rsi14: round(rsi14, 1), macd: round(macd), atr14: round(atr14),
      relativeVolume: round(relativeVolume),
    },
    validation: backtest,
  };
}

async function fetchJson(url, authenticated = false) {
  const response = await fetch(url, {
    headers: authenticated
      ? { Accept: "application/json", Authorization: `Bearer ${token}` }
      : { Accept: "application/json" },
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const isGzip =
    response.headers.get("content-type")?.includes("gzip") ||
    (bytes[0] === 0x1f && bytes[1] === 0x8b);
  const decoded = isGzip ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  return JSON.parse(decoded);
}

const instrumentPayload = await fetchJson(instrumentUrl);
const eligible = instrumentPayload
  .filter(
    (item) =>
      item.segment === "NSE_EQ" &&
      item.instrument_type === "EQ" &&
      (!item.security_type || item.security_type === "NORMAL") &&
      item.instrument_key &&
      item.trading_symbol,
  )
  .sort((a, b) => a.trading_symbol.localeCompare(b.trading_symbol));
const partitionUniverse = eligible.filter((_, index) => index % partitionCount === partitionIndex);
const universe = partitionUniverse.slice(0, maxInstruments);
const toDate = new Date();
const fromDate = new Date(toDate);
fromDate.setUTCDate(fromDate.getUTCDate() - 430);
const isoDate = (date) => date.toISOString().slice(0, 10);
const signals = [];
const failures = [];
let attempted = 0;

for (let index = 0; index < universe.length; index += 1) {
  const instrument = universe[index];
  attempted += 1;
  const key = encodeURIComponent(instrument.instrument_key);
  const url = `https://api.upstox.com/v3/historical-candle/${key}/days/1/${isoDate(toDate)}/${isoDate(fromDate)}`;
  try {
    const payload = await fetchJson(url, true);
    const candles = (payload.data?.candles || [])
      .map(([date, open, high, low, close, volume]) => ({ date, open, high, low, close, volume }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const signal = analyze(instrument, candles);
    if (signal) signals.push(signal);
  } catch (error) {
    failures.push({ symbol: instrument.trading_symbol, reason: String(error.message).slice(0, 160) });
    if (String(error.message).startsWith("429")) {
      console.error("Upstox rate limit reached; ending scan without retrying.");
      break;
    }
  }
  if ((index + 1) % 100 === 0) console.log(`Scanned ${index + 1}/${universe.length}`);
  await sleep(requestSpacingMs);
}

signals.sort((a, b) => b.confidence - a.confidence || b.changePct - a.changePct);
const now = new Date().toISOString();
const partitionResult = {
  schemaVersion: 1,
  status: "partition_complete",
  provider: "Upstox",
  generatedAt: now,
  methodologyUpdatedAt: now,
  partition: { index: partitionIndex, count: partitionCount },
  universe: {
    name: "NSE normal cash equities",
    eligible: eligible.length,
    requested: universe.length,
    scanned: attempted - failures.length,
    failed: failures.length,
    truncated: partitionUniverse.length > universe.length,
  },
  summary: {
    qualified: signals.length,
    armed: signals.filter((signal) => signal.state === "Armed").length,
    triggered: signals.filter((signal) => signal.state === "Triggered").length,
    highConfidence: signals.filter((signal) => signal.confidence >= 80).length,
  },
  strategyLibrary: [
    "20-day breakout", "52-week high", "Double bottom", "VCP",
    "Darvas box", "Trend template", "MACD momentum",
  ],
  signals: signals.slice(0, 250),
  failures: failures.slice(0, 25),
  disclaimer:
    "Confidence is a deterministic confluence score, not a win-rate promise. Backtest samples are symbol-specific, exclude costs and slippage, and do not predict future returns. Confirm price, liquidity and risk before acting.",
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(partitionPath, `${JSON.stringify(partitionResult, null, 2)}\n`, "utf8");

const partitions = [];
for (let index = 0; index < partitionCount; index += 1) {
  try {
    const saved = JSON.parse(
      await readFile(path.resolve(`docs/data/scanner-results-part-${index}.json`), "utf8"),
    );
    if (saved.partition?.count === partitionCount) partitions.push(saved);
  } catch {
    // The first scheduled slice is intentionally published as partial coverage.
  }
}
const mergedSignals = partitions
  .flatMap((part) => part.signals || [])
  .sort((a, b) => b.confidence - a.confidence || b.changePct - a.changePct)
  .slice(0, 250);
const mergedFailures = partitions.flatMap((part) => part.failures || []).slice(0, 25);
const result = {
  ...partitionResult,
  status: partitions.length === partitionCount ? "live" : "partial",
  generatedAt: partitions.map((part) => part.generatedAt).sort().at(-1) || now,
  partition: undefined,
  universe: {
    name: "NSE normal cash equities",
    eligible: eligible.length,
    requested: partitions.reduce((sum, part) => sum + Number(part.universe?.requested || 0), 0),
    scanned: partitions.reduce((sum, part) => sum + Number(part.universe?.scanned || 0), 0),
    failed: partitions.reduce((sum, part) => sum + Number(part.universe?.failed || 0), 0),
    truncated: partitions.some((part) => part.universe?.truncated),
    partitionsComplete: partitions.length,
    partitionsRequired: partitionCount,
  },
  summary: {
    qualified: partitions.reduce((sum, part) => sum + Number(part.summary?.qualified || 0), 0),
    armed: partitions.reduce((sum, part) => sum + Number(part.summary?.armed || 0), 0),
    triggered: partitions.reduce((sum, part) => sum + Number(part.summary?.triggered || 0), 0),
    highConfidence: partitions.reduce((sum, part) => sum + Number(part.summary?.highConfidence || 0), 0),
  },
  signals: mergedSignals,
  failures: mergedFailures,
};
delete result.partition;
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`Saved partition ${partitionIndex + 1}/${partitionCount}: ${partitionResult.universe.scanned} equities. Combined coverage: ${result.universe.scanned}/${eligible.length}.`);
