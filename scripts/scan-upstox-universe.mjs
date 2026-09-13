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

function detectCupAndHandle(candles) {
  const n = candles.length;
  if (n < 80) return { active: false };
  const high = (i) => candles[i].high;
  const low = (i) => candles[i].low;
  const close = candles[n - 1].close;
  const argMaxHigh = (a, b) => {
    a = Math.max(0, a);
    b = Math.min(n - 1, b);
    let idx = a;
    for (let i = a + 1; i <= b; i += 1) if (high(i) > high(idx)) idx = i;
    return idx;
  };
  const argMinLow = (a, b) => {
    a = Math.max(0, a);
    b = Math.min(n - 1, b);
    let idx = a;
    for (let i = a + 1; i <= b; i += 1) if (low(i) < low(idx)) idx = i;
    return idx;
  };
  // Right rim: the dominant peak in the last ~40 sessions; the handle forms after it.
  const rr = argMaxHigh(n - 40, n - 4);
  const rightRim = high(rr);
  const handleLen = n - 1 - rr;
  if (handleLen < 3 || handleLen > 35) return { active: false };
  // Left rim: the prior high that opens the cup, 20-160 sessions before the right rim.
  const lr = argMaxHigh(rr - 160, rr - 20);
  const leftRim = high(lr);
  const cupLen = rr - lr;
  if (cupLen < 20 || cupLen > 160) return { active: false };
  if (rightRim < leftRim * 0.85 || rightRim > leftRim * 1.1) return { active: false };
  // Cup bottom strictly between the two rims.
  const cl = argMinLow(lr + 1, rr - 1);
  const cupLow = low(cl);
  const rimAvg = (leftRim + rightRim) / 2;
  const cupDepth = (rimAvg - cupLow) / rimAvg;
  if (cupDepth < 0.12 || cupDepth > 0.5) return { active: false };
  // Rounded U, not a sharp V: both legs took real time.
  if (cl - lr < cupLen * 0.25 || rr - cl < cupLen * 0.25) return { active: false };
  // A cup is a correction after an advance: price must have risen into the left rim.
  const preLow = low(argMinLow(lr - 40, lr));
  if (leftRim < preLow * 1.2) return { active: false };
  // Handle: a shallow pullback that holds the upper half of the cup.
  const handleLow = low(argMinLow(rr + 1, n - 1));
  const pivot = rightRim;
  const handleDepth = (pivot - handleLow) / pivot;
  if (handleDepth < 0.02 || handleDepth > 0.15 || handleDepth > cupDepth * 0.5) {
    return { active: false };
  }
  if (handleLow < cupLow + (pivot - cupLow) * 0.5) return { active: false };
  // Forming near, or just clearing, the pivot - not far below and not already extended.
  if (close < pivot * 0.9 || close > pivot * 1.05) return { active: false };
  const cupVol = mean(candles.slice(lr, rr + 1).map((candle) => candle.volume));
  const handleVol = mean(candles.slice(rr + 1, n).map((candle) => candle.volume));
  const volumeDryUp = cupVol > 0 && handleVol < cupVol * 0.85;
  return {
    active: true,
    pivot,
    cupLow,
    leftRim,
    rightRim,
    handleLow,
    cupDepthPct: round(cupDepth * 100, 1),
    handleDepthPct: round(handleDepth * 100, 1),
    cupSessions: cupLen,
    handleSessions: handleLen,
    volumeDryUp,
  };
}

function detectHighTightFlag(candles) {
  const n = candles.length;
  if (n < 60) return { active: false };
  const close = candles[n - 1].close;
  // A short, tight flag (5-25 sessions) resting on top of a near-vertical run.
  for (let flagLen = 5; flagLen <= 25; flagLen += 1) {
    const flag = candles.slice(n - flagLen, n);
    const flagHigh = highest(flag.map((candle) => candle.high));
    const flagLow = lowest(flag.map((candle) => candle.low));
    const flagDepth = (flagHigh - flagLow) / flagHigh;
    if (flagDepth > 0.25) continue;
    const poleStart = n - flagLen - 45;
    if (poleStart < 0) continue;
    const baseLow = lowest(
      candles.slice(poleStart, n - flagLen).map((candle) => candle.low),
    );
    const advance = (flagHigh - baseLow) / baseLow;
    if (advance < 0.9) continue; // ~90-100%+ move builds the flagpole
    if (close < flagHigh * 0.9) continue; // consolidating just under the pivot
    return {
      active: true,
      pivot: flagHigh,
      flagDepthPct: round(flagDepth * 100, 1),
      advancePct: round(advance * 100, 0),
      flagSessions: flagLen,
    };
  }
  return { active: false };
}

function detectCandlestickPatterns(candles) {
  if (candles.length < 3) return [];
  const current = candles.at(-1);
  const previous = candles.at(-2);
  const first = candles.at(-3);
  const parts = (candle) => {
    const range = Math.max(candle.high - candle.low, Number.EPSILON);
    const body = Math.abs(candle.close - candle.open);
    return {
      body,
      range,
      upper: candle.high - Math.max(candle.open, candle.close),
      lower: Math.min(candle.open, candle.close) - candle.low,
      bullish: candle.close > candle.open,
      bearish: candle.close < candle.open,
      midpoint: (candle.open + candle.close) / 2,
    };
  };
  const now = parts(current);
  const prior = parts(previous);
  const oldest = parts(first);
  const averageBody = mean(candles.slice(-23, -3).map((candle) => Math.abs(candle.close - candle.open)));
  const patterns = [];
  const add = (name, bias, strength, note) => patterns.push({ name, bias, strength, note });

  if (
    prior.bearish && now.bullish &&
    current.open <= previous.close && current.close >= previous.open &&
    now.body >= prior.body * 0.9
  ) add("Bullish engulfing", "bullish", 4, "Bullish real body fully covered the prior bearish body");
  if (
    prior.bullish && now.bearish &&
    current.open >= previous.close && current.close <= previous.open &&
    now.body >= prior.body * 0.9
  ) add("Bearish engulfing", "bearish", 4, "Bearish real body fully covered the prior bullish body");
  if (
    oldest.bearish && oldest.body > averageBody &&
    prior.body < averageBody * 0.65 && now.bullish &&
    current.close > oldest.midpoint
  ) add("Morning star", "bullish", 5, "Three-candle reversal closed above the first candle midpoint");
  if (
    oldest.bullish && oldest.body > averageBody &&
    prior.body < averageBody * 0.65 && now.bearish &&
    current.close < oldest.midpoint
  ) add("Evening star", "bearish", 5, "Three-candle reversal closed below the first candle midpoint");
  if (
    now.lower >= Math.max(now.body * 2, now.range * 0.45) &&
    now.upper <= Math.max(now.body, now.range * 0.12) &&
    current.close >= current.low + now.range * 0.6
  ) add("Hammer", "bullish", 3, "Long lower wick shows rejection from the session low");
  if (
    now.upper >= Math.max(now.body * 2, now.range * 0.45) &&
    now.lower <= Math.max(now.body, now.range * 0.12) &&
    current.close <= current.low + now.range * 0.4
  ) add("Shooting star", "bearish", 3, "Long upper wick shows rejection from the session high");
  if (
    prior.bearish && now.bullish && current.open < previous.close &&
    current.close > prior.midpoint && current.close < previous.open
  ) add("Piercing line", "bullish", 3, "Bullish close recovered more than half of the prior bearish body");
  if (
    prior.bullish && now.bearish && current.open > previous.close &&
    current.close < prior.midpoint && current.close > previous.open
  ) add("Dark cloud cover", "bearish", 3, "Bearish close retraced more than half of the prior bullish body");
  if (now.body / now.range <= 0.1) {
    add("Doji", "neutral", 1, "Open and close are nearly equal, signalling indecision");
  }
  if (current.high < previous.high && current.low > previous.low) {
    add("Inside bar", "neutral", 2, "The full session range contracted inside the prior candle");
  }
  if (
    prior.body > averageBody && now.body < prior.body * 0.45 &&
    Math.max(current.open, current.close) < Math.max(previous.open, previous.close) &&
    Math.min(current.open, current.close) > Math.min(previous.open, previous.close)
  ) {
    add(now.bullish ? "Bullish harami" : "Bearish harami", now.bullish ? "bullish" : "bearish", 3, "Small real body formed inside the prior real body");
  }
  return patterns.sort((a, b) => b.strength - a.strength).slice(0, 3);
}

function marketObservation(candles) {
  if (candles.length < 200) return null;
  const closes = candles.map((candle) => candle.close);
  const close = closes.at(-1);
  const previous = closes.at(-2);
  if (!Number.isFinite(close) || !Number.isFinite(previous)) return null;
  return {
    changePct: pct(close, previous),
    advancing: close > previous,
    aboveSma50: close > sma(closes, 50),
    aboveSma200: close > sma(closes, 200),
  };
}

function summarizeBreadth(counts) {
  const evaluated = Number(counts.evaluated || 0);
  if (!evaluated) {
    return {
      evaluated: 0,
      advancersPct: null,
      aboveSma50Pct: null,
      aboveSma200Pct: null,
      averageChangePct: null,
      score: null,
      label: "Awaiting market data",
      tone: "neutral",
      guidance: "Connect Upstox to calculate market mood from NSE breadth.",
    };
  }
  const advancersPct = (Number(counts.advancers || 0) / evaluated) * 100;
  const aboveSma50Pct = (Number(counts.aboveSma50 || 0) / evaluated) * 100;
  const aboveSma200Pct = (Number(counts.aboveSma200 || 0) / evaluated) * 100;
  const averageChangePct = Number(counts.totalChange || 0) / evaluated;
  const score = Math.max(0, Math.min(100, advancersPct * 0.35 + aboveSma50Pct * 0.4 + aboveSma200Pct * 0.25));
  let label = "Defensive";
  let tone = "bearish";
  let guidance = "Breadth is weak. Protect capital and require exceptional confirmation.";
  if (score >= 65) {
    label = "Risk-on";
    tone = "bullish";
    guidance = "Broad participation supports confirmed breakouts and constructive pullbacks.";
  } else if (score >= 55) {
    label = "Constructive";
    tone = "bullish";
    guidance = "Participation is healthy, but keep normal entry and risk discipline.";
  } else if (score >= 45) {
    label = "Mixed";
    tone = "neutral";
    guidance = "Leadership is selective. Prefer strong relative strength and volume confirmation.";
  } else if (score >= 35) {
    label = "Cautious";
    tone = "cautious";
    guidance = "Participation is narrowing. Reduce size and wait for cleaner confirmation.";
  }
  return {
    evaluated,
    advancers: Number(counts.advancers || 0),
    aboveSma50: Number(counts.aboveSma50 || 0),
    aboveSma200: Number(counts.aboveSma200 || 0),
    totalChange: Number(counts.totalChange || 0),
    advancersPct: round(advancersPct, 1),
    aboveSma50Pct: round(aboveSma50Pct, 1),
    aboveSma200Pct: round(aboveSma200Pct, 1),
    averageChangePct: round(averageChangePct, 2),
    score: round(score, 0),
    label,
    tone,
    guidance,
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
  const cupHandle = detectCupAndHandle(candles);
  const highTightFlag = detectHighTightFlag(candles);
  const candlestickPatterns = detectCandlestickPatterns(candles);
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
  if (cupHandle.active) {
    tags.push("Cup & handle");
    evidence.push(`Rounded cup ${cupHandle.cupDepthPct}% deep with a ${cupHandle.handleDepthPct}% handle in the upper half of the base`);
    if (cupHandle.volumeDryUp) evidence.push("Volume dried up through the handle");
    score += 17;
  }
  if (highTightFlag.active) {
    tags.push("High tight flag");
    evidence.push(`Flagpole advanced ${highTightFlag.advancePct}% then paused in a tight ${highTightFlag.flagDepthPct}% flag`);
    score += 12;
  }
  for (const pattern of candlestickPatterns) {
    tags.push(`Candle · ${pattern.name}`);
    evidence.push(pattern.note);
    if (pattern.bias === "bullish") score += pattern.strength * 3;
    if (pattern.bias === "bearish") score -= pattern.strength * 2;
    if (pattern.bias === "neutral") score += pattern.strength;
  }
  if (close > sma50 && sma50 > sma200 && sma(closes, 50, closes.length - 11) < sma50) {
    tags.push("Golden trend");
    score += 5;
  }

  const actionablePatterns = ["20-day breakout", "52-week high", "Double bottom", "VCP", "Darvas box", "Cup & handle", "High tight flag", "Near breakout"];
  const candlePatternNames = candlestickPatterns.map((pattern) => `Candle · ${pattern.name}`);
  const meaningful = tags.some((tag) => actionablePatterns.includes(tag)) || candlestickPatterns.length > 0;
  if (!meaningful) return null;
  const dominantCandle = candlestickPatterns[0] || null;
  const hasLongStructure = tags.some((tag) => actionablePatterns.includes(tag));
  if (!hasLongStructure && dominantCandle) score = Math.max(score, 50 + dominantCandle.strength * 6);
  const bearishCaution = dominantCandle?.bias === "bearish" && dominantCandle.strength >= 3;
  const confidence = Math.max(1, Math.min(99, Math.round(score)));
  const pivotCandidates = [priorHigh20, doubleBottom.neckline, vcp.pivot, darvas.ceiling, cupHandle.pivot, highTightFlag.pivot].filter(Number.isFinite);
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
    state: bearishCaution ? "Caution" : close >= entryTrigger ? "Triggered" : confidence >= 78 ? "Armed" : "Watch",
    bias: bearishCaution ? "bearish" : dominantCandle?.bias || "bullish",
    primaryPattern: (!hasLongStructure && candlePatternNames[0]) || tags.find((tag) => actionablePatterns.includes(tag)) || candlePatternNames[0] || tags[0] || "Confluence",
    patterns: tags.slice(0, 8),
    candlestickPatterns,
    evidence: evidence.slice(0, 7),
    entryTrigger: bearishCaution && !hasLongStructure ? null : round(entryTrigger),
    stop: bearishCaution && !hasLongStructure ? null : round(stop),
    target2R: bearishCaution && !hasLongStructure ? null : round(target),
    riskReward: bearishCaution && !hasLongStructure ? null : risk > 0 ? 2 : null,
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
const breadthCounts = {
  evaluated: 0,
  advancers: 0,
  aboveSma50: 0,
  aboveSma200: 0,
  totalChange: 0,
};
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
    const observation = marketObservation(candles);
    if (observation) {
      breadthCounts.evaluated += 1;
      breadthCounts.advancers += observation.advancing ? 1 : 0;
      breadthCounts.aboveSma50 += observation.aboveSma50 ? 1 : 0;
      breadthCounts.aboveSma200 += observation.aboveSma200 ? 1 : 0;
      breadthCounts.totalChange += observation.changePct;
    }
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
  schemaVersion: 2,
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
    cautions: signals.filter((signal) => signal.state === "Caution").length,
    highConfidence: signals.filter((signal) => signal.confidence >= 80).length,
    candlestickSignals: signals.filter((signal) => signal.candlestickPatterns?.length).length,
  },
  marketMood: summarizeBreadth(breadthCounts),
  strategyLibrary: [
    "20-day breakout", "52-week high", "Cup & handle", "High tight flag",
    "Double bottom", "VCP", "Darvas box", "Trend template", "MACD momentum",
    "Candle · Bullish engulfing", "Candle · Bearish engulfing",
    "Candle · Morning star", "Candle · Evening star", "Candle · Hammer",
    "Candle · Shooting star", "Candle · Piercing line", "Candle · Dark cloud cover",
    "Candle · Doji", "Candle · Inside bar", "Candle · Bullish harami", "Candle · Bearish harami",
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
const mergedBreadthCounts = partitions.reduce(
  (counts, part) => {
    const mood = part.marketMood || {};
    counts.evaluated += Number(mood.evaluated || 0);
    counts.advancers += Number(mood.advancers || 0);
    counts.aboveSma50 += Number(mood.aboveSma50 || 0);
    counts.aboveSma200 += Number(mood.aboveSma200 || 0);
    counts.totalChange += Number(mood.totalChange || 0);
    return counts;
  },
  { evaluated: 0, advancers: 0, aboveSma50: 0, aboveSma200: 0, totalChange: 0 },
);
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
    cautions: partitions.reduce((sum, part) => sum + Number(part.summary?.cautions || 0), 0),
    highConfidence: partitions.reduce((sum, part) => sum + Number(part.summary?.highConfidence || 0), 0),
    candlestickSignals: partitions.reduce((sum, part) => sum + Number(part.summary?.candlestickSignals || 0), 0),
  },
  marketMood: summarizeBreadth(mergedBreadthCounts),
  signals: mergedSignals,
  failures: mergedFailures,
};
delete result.partition;
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`Saved partition ${partitionIndex + 1}/${partitionCount}: ${partitionResult.universe.scanned} equities. Combined coverage: ${result.universe.scanned}/${eligible.length}.`);
