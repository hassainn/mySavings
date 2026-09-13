import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// Market-intelligence generator with graceful fallback so the news feed
// ALWAYS fetches, free of charge, and upgrades automatically when a billed
// Gemini key is available:
//   1. Grounded Gemini (Google Search) — best quality, needs a paid project.
//   2. RSS headlines + Gemini classification — free AI ranking; sources come
//      from the RSS items by index, so URLs are never invented.
//   3. RSS headlines + deterministic ranking — no key needed, always works.

const apiKey = process.env.GEMINI_API_KEY?.trim();
const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const outputPath = path.resolve("docs/data/market-intelligence.json");

const WATCHLIST = {
  HAL: "Hindustan Aeronautics",
  BEL: "Bharat Electronics",
  TRENT: "Trent",
  CGPOWER: "CG Power",
  COCHINSHIP: "Cochin Shipyard",
};

const RSS_FEEDS = [
  { name: "LiveMint Markets", url: "https://www.livemint.com/rss/markets" },
  { name: "Economic Times Markets", url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms" },
  { name: "Economic Times Stocks", url: "https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms" },
  { name: "Hindu BusinessLine Markets", url: "https://www.thehindubusinessline.com/markets/feeder/default.rss" },
  { name: "Moneycontrol", url: "https://www.moneycontrol.com/rss/latestnews.xml" },
  { name: "Business Standard Markets", url: "https://www.business-standard.com/rss/markets-106.rss" },
];

const DISCLAIMER =
  "AI-generated research summary. Verify source articles and exchange filings before making investment decisions. Not investment advice.";

const CATEGORY_ENUM = ["market", "sector", "stock"];
const SENTIMENT_ENUM = ["Positive", "Neutral", "Negative", "Mixed"];
const IMPORTANCE_ENUM = ["High", "Medium", "Low"];
const CATALYST_ENUM = [
  "Earnings",
  "Guidance",
  "Order win",
  "Rating change",
  "Block deal",
  "Ownership",
  "Index change",
  "Regulatory",
  "Macro/flows",
  "Corporate action",
  "Other",
];
const HORIZON_ENUM = ["Today", "This week", "Watch"];
const IMPORTANCE_RANK = { High: 0, Medium: 1, Low: 2 };

// NOTE: the interactions API rejects JSON-Schema min/max constraints in schemas
// this size (verified: identical schema 400s with them, 200s without). Count
// expectations live in the prompt instead; the finalisers validate counts.
const sectorSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["name", "momentum", "score", "reason", "catalysts", "risks", "relatedStocks"],
    properties: {
      name: { type: "string" },
      momentum: { type: "string", enum: ["Leading", "Improving", "Mixed", "Weakening"] },
      score: { type: "integer" },
      reason: { type: "string" },
      catalysts: { type: "array", items: { type: "string" } },
      risks: { type: "array", items: { type: "string" } },
      relatedStocks: { type: "array", items: { type: "string" } },
    },
  },
};

// Schema for the grounded call (model researches and writes full news items).
const groundedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["marketMood", "marketSummary", "dailyFocus", "sectors", "news", "disclaimer"],
  properties: {
    marketMood: { type: "string" },
    marketSummary: { type: "string" },
    dailyFocus: { type: "string" },
    sectors: sectorSchema,
    news: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "category", "symbol", "headline", "summary", "sentiment",
          "importance", "catalystType", "timeHorizon", "impact",
          "sourceName", "sourceUrl", "publishedAt",
        ],
        properties: {
          category: { type: "string", enum: CATEGORY_ENUM },
          symbol: { type: "string" },
          headline: { type: "string" },
          summary: { type: "string" },
          sentiment: { type: "string", enum: SENTIMENT_ENUM },
          importance: { type: "string", enum: IMPORTANCE_ENUM },
          catalystType: { type: "string", enum: CATALYST_ENUM },
          timeHorizon: { type: "string", enum: HORIZON_ENUM },
          impact: { type: "string" },
          sourceName: { type: "string" },
          sourceUrl: { type: "string" },
          publishedAt: { type: "string" },
        },
      },
    },
    disclaimer: { type: "string" },
  },
};

// Schema for the RSS-classify call: the model only labels items it is given,
// referencing each by its list index so the real source URL/date are reused.
const classifySchema = {
  type: "object",
  additionalProperties: false,
  required: ["marketMood", "marketSummary", "dailyFocus", "sectors", "items", "disclaimer"],
  properties: {
    marketMood: { type: "string" },
    marketSummary: { type: "string" },
    dailyFocus: { type: "string" },
    sectors: sectorSchema,
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "category", "symbol", "summary", "sentiment", "importance", "catalystType", "timeHorizon", "impact"],
        properties: {
          index: { type: "integer" },
          category: { type: "string", enum: CATEGORY_ENUM },
          symbol: { type: "string" },
          summary: { type: "string" },
          sentiment: { type: "string", enum: SENTIMENT_ENUM },
          importance: { type: "string", enum: IMPORTANCE_ENUM },
          catalystType: { type: "string", enum: CATALYST_ENUM },
          timeHorizon: { type: "string", enum: HORIZON_ENUM },
          impact: { type: "string" },
        },
      },
    },
    disclaimer: { type: "string" },
  },
};

// ---------------------------------------------------------------- helpers
const isHttps = (value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};
const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const toTime = (value) => {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
};
function decodeEntities(text = "") {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}
const stripTags = (text = "") => text.replace(/<[^>]+>/g, " ");
const clean = (text = "") => decodeEntities(stripTags(text)).replace(/\s+/g, " ").trim();

function parseRss(xml, sourceName) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const raw of blocks) {
    const end = raw.search(/<\/item>/i);
    const body = end === -1 ? raw : raw.slice(0, end);
    const pick = (tag) => {
      const match = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return match ? decodeEntities(match[1]).trim() : "";
    };
    const title = clean(pick("title"));
    let link = clean(pick("link"));
    if (!isHttps(link)) {
      const guid = clean(pick("guid"));
      if (isHttps(guid)) link = guid;
    }
    const description = clean(pick("description")).slice(0, 320);
    const pubDate = pick("pubDate") || pick("dc:date") || pick("date");
    if (title && isHttps(link)) {
      items.push({ title, link, description, pubDate, sourceName });
    }
  }
  return items;
}

async function fetchFeed(feed) {
  try {
    const response = await fetch(feed.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AlphaSwingBot/1.0; +https://hassainn.github.io/mySavings/)",
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      console.log(`Feed "${feed.name}" -> HTTP ${response.status}`);
      return [];
    }
    const items = parseRss(await response.text(), feed.name);
    console.log(`Feed "${feed.name}" -> ${items.length} items`);
    return items;
  } catch (error) {
    console.log(`Feed "${feed.name}" failed: ${String(error.message).slice(0, 120)}`);
    return [];
  }
}

async function collectRssItems() {
  const all = (await Promise.all(RSS_FEEDS.map(fetchFeed))).flat();
  const seen = new Set();
  const unique = [];
  for (const item of all.sort((a, b) => toTime(b.pubDate) - toTime(a.pubDate))) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 60);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  const cutoff = Date.now() - 4 * 86400000;
  const recent = unique.filter((item) => {
    const time = toTime(item.pubDate);
    return time === 0 || time >= cutoff;
  });
  return (recent.length >= 8 ? recent : unique).slice(0, 40);
}

// ---------------------------------------------------- deterministic labels
const CATALYST_RULES = [
  [/\b(q[1-4]\b|quarter|results?|profit|net profit|earnings|\bpat\b|revenue|topline|bottom ?line)\b/i, "Earnings"],
  [/\b(order|contract|wins?\b|bags?\b|awarded|deal worth|project win|l1 bidder|tender)\b/i, "Order win"],
  [/\b(upgrade|downgrade|rating|target price|price target|initiat|brokerage|buy call|sell call|outperform|underperform|overweight)\b/i, "Rating change"],
  [/\b(block deal|bulk deal|stake sale|offer for sale|\bofs\b|promoter (buy|sell|stake)|pledg)\b/i, "Block deal"],
  [/\b(buyback|dividend|bonus issue|stock split|rights issue|record date|ex-date)\b/i, "Corporate action"],
  [/\b(\brbi\b|\bsebi\b|policy|repo rate|tariff|regulation|\bban\b|probe|penalty|\bgst\b|budget|approval)\b/i, "Regulatory"],
  [/\b(\bfii\b|\bdii\b|\bfpi\b|inflow|outflow|fund flow|foreign investors|net buyers|net sellers)\b/i, "Macro/flows"],
  [/\b(guidance|outlook|forecast|expansion|capex|capacity|new plant|new facility)\b/i, "Guidance"],
  [/\b(index inclusion|index reshuffle|added to nifty|removed from nifty|f&o inclusion)\b/i, "Index change"],
  [/\b(acquisition|merger|amalgamation|takeover|stake buy|acquires)\b/i, "Ownership"],
];
const POSITIVE = /\b(surge|surges|jump|jumps|gain|gains|rally|rallies|soar|soars|record high|all-?time high|wins?|bags?|beats?|upgrade|multibagger|rise|rises|climbs?|hits? high|outperform|rally|strong)\b/i;
const NEGATIVE = /\b(fall|falls|drop|drops|plunge|plunges|slump|slumps|loss|losses|miss|misses|downgrade|\bcut\b|cuts|probe|penalty|fraud|\bban\b|decline|declines|tumble|tumbles|weak|hits? low|underperform|slides?)\b/i;
// Clickbait/opinion and off-market noise that a swing trader should not treat as essential.
const OPINION = /\b(top stocks?|stocks? to buy|stocks? to watch|buy under|price target|prediction|smart talk|what to|guide for|should you (buy|sell)|do you own|multibagger|best (stocks|shares|picks)|stock picks?|hot stocks?|to bet on|market outlook|weekly (market|wrap)|these \d+ stocks|\d+ stocks? (to|that))\b/i;
const FOREIGN = /\b(oracle|nvidia|apple inc|microsoft|tesla|amazon|meta platforms|alphabet|larry ellison|elon musk)\b/i;
const GLOBAL_MACRO = /\b(\bfed\b|\bg7\b|\becb\b|powell|warsh|treasury yields|wall street|dow jones|nasdaq|s&p 500|us stocks)\b/i;
const STRONG_CATALYSTS = ["Earnings", "Order win", "Rating change", "Regulatory", "Block deal", "Guidance", "Index change"];
const IMPACT_BY_CATALYST = {
  Earnings: "Earnings-driven move — expect a volatility expansion; confirm with volume before acting on the base.",
  Guidance: "Guidance/capex news reframes the trend; confirm it with price structure, not the headline.",
  "Order win": "Order-book catalyst — watch for a volume-backed breakout at the pivot.",
  "Rating change": "Analyst re-rating shifts sentiment; treat it as context, not a trigger.",
  "Block deal": "Ownership/supply change — watch the price reaction near support and resistance.",
  Ownership: "M&A/stake change can reprice the name; wait for the structure to settle.",
  "Index change": "Index flows can drive short-term demand; note the effective date.",
  Regulatory: "Policy/regulatory catalyst — can reprice the whole group; check breadth first.",
  "Macro/flows": "Flows set the risk backdrop; not a standalone setup trigger.",
  "Corporate action": "Corporate action — check ex-dates and adjust your levels.",
  Other: "Review the source and the price/volume reaction before acting.",
};

function inferSymbol(text) {
  for (const [ticker, name] of Object.entries(WATCHLIST)) {
    if (new RegExp(`\\b${ticker}\\b`, "i").test(text) || new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) {
      return { symbol: ticker, watch: true };
    }
  }
  if (/\bnifty\b/i.test(text)) return { symbol: "NIFTY", watch: false };
  if (/\bsensex\b/i.test(text)) return { symbol: "SENSEX", watch: false };
  return { symbol: "NSE", watch: false };
}

function classifyDeterministic(item) {
  const text = `${item.title} ${item.description}`;
  const { symbol, watch } = inferSymbol(text);
  let category = "market";
  if (watch || (symbol !== "NSE" && symbol !== "NIFTY" && symbol !== "SENSEX")) category = "stock";
  else if (/\b(nifty|sensex|market|index|indices|dalal street)\b/i.test(item.title)) category = "market";
  else if (/\b(sector|bank|banks|\bit\b|pharma|auto|metal|fmcg|realty|energy|power|defence|psu)\b/i.test(item.title)) category = "sector";
  else category = "stock";
  let catalystType = "Other";
  for (const [rule, type] of CATALYST_RULES) {
    if (rule.test(text)) {
      catalystType = type;
      break;
    }
  }
  const pos = POSITIVE.test(text);
  const neg = NEGATIVE.test(text);
  const sentiment = pos && neg ? "Mixed" : pos ? "Positive" : neg ? "Negative" : "Neutral";
  const time = toTime(item.pubDate);
  const ageDays = time ? (Date.now() - time) / 86400000 : 99;
  const timeHorizon = ageDays < 1 ? "Today" : ageDays < 3 ? "This week" : "Watch";
  const strong = STRONG_CATALYSTS.includes(catalystType);
  const opinion = OPINION.test(text);
  const foreign = FOREIGN.test(text) && !watch;
  const globalMacro = GLOBAL_MACRO.test(text);
  // High is reserved for genuinely essential, actionable catalysts. Opinion and
  // off-market noise never rank essential; global macro is context, not a trigger.
  let importance;
  if (opinion || foreign) importance = "Low";
  else if (watch && strong) importance = "High";
  else if (category === "stock" && ["Order win", "Earnings", "Block deal"].includes(catalystType) && sentiment !== "Negative") importance = "High";
  else if (globalMacro) importance = "Medium";
  else if (strong || watch || catalystType !== "Other") importance = "Medium";
  else importance = "Low";
  return {
    category,
    symbol,
    headline: item.title.slice(0, 180),
    summary: (item.description || item.title).slice(0, 300),
    sentiment,
    importance,
    catalystType,
    timeHorizon,
    impact: IMPACT_BY_CATALYST[catalystType] || IMPACT_BY_CATALYST.Other,
    sourceName: item.sourceName,
    sourceUrl: item.link,
    publishedAt: time ? new Date(time).toISOString() : null,
    _noise: opinion || foreign,
  };
}

const SECTOR_RULES = [
  ["Defence & aerospace", /\b(defence|defense|aerospace|\bhal\b|hindustan aeronautics|\bbel\b|bharat electronics|\bbdl\b|cochin shipyard|mazagon|ordnance|shipyard|missile)\b/i, ["HAL", "BEL", "COCHINSHIP"]],
  ["Banking & financials", /\b(bank|banks|nbfc|financ|\bhdfc\b|\bicici\b|\bsbi\b|kotak|axis|insurance|lending)\b/i, []],
  ["IT services", /\b(\bit\b|infosys|\btcs\b|wipro|\bhcl\b|tech mahindra|software|technolog)\b/i, []],
  ["Capital goods & power", /\b(capital goods|\bpower\b|cg power|\bl&t\b|larsen|\bbhel\b|grid|transformer|capex|infrastructure|engineering)\b/i, ["CGPOWER"]],
  ["Auto", /\b(auto|maruti|tata motors|mahindra|bajaj|hero|two-?wheeler|\bev\b|vehicle)\b/i, []],
  ["Pharma & healthcare", /\b(pharma|drug|cipla|sun pharma|dr\.? reddy|healthcare|hospital|\bapi\b)\b/i, []],
  ["Consumer & retail", /\b(fmcg|consumer|retail|trent|dmart|titan|nestle|hindustan unilever|\bhul\b)\b/i, ["TRENT"]],
  ["Metals & mining", /\b(metal|steel|tata steel|\bjsw\b|hindalco|vedanta|\bcoal\b|mining|zinc)\b/i, []],
  ["Energy & oil", /\b(oil|gas|reliance|\bongc\b|energy|refin|petro|\bcng\b)\b/i, []],
];

function buildSectors(news) {
  const scored = SECTOR_RULES.map(([name, rule, base]) => {
    const hits = news.filter((n) => rule.test(`${n.headline} ${n.summary}`));
    const pos = hits.filter((h) => h.sentiment === "Positive").length;
    const neg = hits.filter((h) => h.sentiment === "Negative").length;
    const score = Math.max(0, Math.min(100, 50 + (pos - neg) * 12 + Math.min(hits.length, 4) * 3));
    const momentum = hits.length === 0 ? "Mixed" : pos > neg ? (pos >= 2 ? "Leading" : "Improving") : neg > pos ? "Weakening" : "Mixed";
    const relatedStocks = Array.from(
      new Set([...base, ...hits.map((h) => h.symbol).filter((s) => s && !["NSE", "NIFTY", "SENSEX"].includes(s))]),
    ).slice(0, 6);
    return {
      name,
      momentum,
      score,
      reason: hits.length
        ? `${hits.length} recent headline${hits.length > 1 ? "s" : ""} in the feed window (${pos} positive, ${neg} negative).`
        : "No fresh headlines in the current feed window.",
      catalysts: [hits.length ? "Recent news flow" : "Awaiting fresh catalysts"],
      risks: ["Headline risk", "Confirm with price and volume"].slice(0, hits.length ? 2 : 1),
      relatedStocks,
      _count: hits.length,
    };
  });
  const withNews = scored.filter((s) => s._count > 0).sort((a, b) => b._count - a._count || b.score - a.score);
  const without = scored.filter((s) => s._count === 0);
  const chosen = [...withNews, ...without].slice(0, 6);
  const final = chosen.length >= 3 ? chosen : [...chosen, ...without].slice(0, 3);
  return final.map(({ _count, ...rest }) => rest);
}

function buildDeterministic(items) {
  const classified = items.map(classifyDeterministic);
  const filtered = classified.filter((n) => !n._noise);
  const pool = filtered.length >= 6 ? filtered : classified;
  const news = pool
    .map(({ _noise, ...rest }) => rest)
    .sort(
      (a, b) =>
        IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance] ||
        (toTime(b.publishedAt) || 0) - (toTime(a.publishedAt) || 0),
    )
    .slice(0, 14);
  const pos = news.filter((n) => n.sentiment === "Positive").length;
  const neg = news.filter((n) => n.sentiment === "Negative").length;
  const essential = news.filter((n) => n.importance === "High").length;
  const marketMood = pos > neg * 1.3 ? "Constructive headline tone" : neg > pos * 1.3 ? "Cautious headline tone" : "Mixed headline tone";
  const marketSummary = `${news.length} market and stock updates from Indian financial media in the last few sessions; ${essential} flagged essential for swing traders (${pos} positive, ${neg} negative). Headline sentiment is a first read — confirm with price and volume.`;
  const dailyFocus =
    "Trade the reaction, not the headline: wait for price to clear the pivot on above-average volume, and size every entry with a defined stop.";
  const sources = Array.from(
    new Map(news.filter((n) => isHttps(n.sourceUrl)).map((n) => [n.sourceUrl, { title: n.sourceName, url: n.sourceUrl }])).values(),
  ).slice(0, 20);
  return { marketMood, marketSummary, dailyFocus, sectors: buildSectors(news), news, sources, disclaimer: DISCLAIMER };
}

// -------------------------------------------------------------- Gemini API
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGemini({ prompt, tools, retries = 2, retryOn = [500, 503] }) {
  const body = JSON.stringify({
    model,
    input: prompt,
    ...(tools?.length ? { tools } : {}),
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: tools?.length ? groundedSchema : classifySchema,
    },
  });
  let response;
  for (let attempt = 0; ; attempt += 1) {
    response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body,
    });
    if (response.ok) break;
    const details = (await response.text()).slice(0, 300);
    if (retryOn.includes(response.status) && attempt < retries) {
      // 429 on the free tier clears within a minute; 500/503 are transient spikes.
      const waitMs = response.status === 429 ? 15000 : 5000;
      console.log(`Gemini ${response.status}; retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/${retries}).`);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`Gemini API ${response.status}: ${details}`);
  }
  const payload = await response.json();
  if (payload.status && payload.status !== "completed") {
    throw new Error(`Gemini interaction ended with status: ${payload.status}`);
  }
  const outputText =
    payload.output_text ||
    payload.outputs?.map((item) => item.text || "").join("") ||
    payload.steps
      ?.flatMap((step) => step.content || [])
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("") ||
    "";
  if (!outputText) throw new Error("Gemini returned no structured text output.");
  const citations = [];
  for (const step of payload.steps || []) {
    for (const part of step.content || []) {
      for (const annotation of part.annotations || []) {
        if (annotation.type === "url_citation" && annotation.url && isHttps(annotation.url)) {
          citations.push({ title: annotation.title || new URL(annotation.url).hostname, url: annotation.url });
        }
      }
    }
  }
  return { data: JSON.parse(outputText), citations };
}

const today = new Date();
const groundedPrompt = `You are the research editor for Alpha Swing AI, an Indian (NSE) swing-trading workspace whose users trade breakouts, cup-and-handle and other base breakouts on a multi-day to multi-week horizon.

Current time: ${today.toISOString()}.
Use Google Search to research only reputable, recent sources. Prefer exchange filings (NSE/BSE), company announcements, SEBI/RBI/government releases, Reuters, Bloomberg, Business Standard, The Economic Times, Mint, Moneycontrol and similarly established desks. Focus on items published in the last 48 hours; use an older item only if it is still an active, unresolved catalyst, and state its date.

ESSENTIALITY BAR — a swing trader only cares about news that can move price or change a setup's odds over the next few sessions. INCLUDE, in priority order: quarterly results and management guidance; large order wins, capex and capacity news; credible analyst rating/target changes; block/bulk deals and promoter/insider/FII-DII ownership shifts; index inclusion/exclusion; regulatory or policy actions; scheduled catalysts in the next 1-2 weeks (results dates, board meetings) — for a scheduled event set timeHorizon to "This week" or "Watch" and note the event date in the summary. EXCLUDE low-signal noise: routine open/close recaps with no catalyst, opinion pieces, target-price hype, and rumours without a named source.

For every item: set "importance" to High only if it can plausibly move the stock or the setup this week; set "catalystType" to the best-fitting category; set "timeHorizon" (Today / This week / Watch); and make "impact" a concrete one-line swing-trade read (never a buy/sell/target call). Order the news array most-essential first (all High before Medium before Low).

Cover the broad market plus the watchlist: HAL, BEL, TRENT, CGPOWER and COCHINSHIP; add other clearly market-moving NSE names when warranted. Return 8-14 news items and 3-6 sectors ranked by breakout leadership. Name the source, include its real HTTPS article URL, and set publishedAt to an ISO-8601 string (empty string if unknown). Do not invent prices, filings, dates, quotes or URLs. Do not give buy/sell/target advice. Keep summaries concise and professional.`;

function classifyPrompt(items) {
  const list = items
    .map((item, index) => `[${index}] (${item.sourceName}) ${item.title}${item.description ? ` — ${item.description}` : ""}`)
    .join("\n");
  return `You are the research editor for Alpha Swing AI, an Indian (NSE) swing-trading workspace (breakouts, cup-and-handle and base breakouts, multi-day to multi-week horizon).

Below are recent Indian market headlines, each with a numbered index. Select the ones most essential to a swing trader and classify ONLY those. Reference each by its "index" from the list — never invent headlines, sources or URLs, and do not use any information beyond what each headline provides.

Prioritise: results/guidance, order wins/capex, rating changes, block/bulk deals and ownership/FII-DII shifts, index changes, regulatory actions. Drop routine index recaps, opinion and hype. Select the 6-14 most essential items. For each set importance (High only if it can move price or a setup this week), catalystType, sentiment, timeHorizon (Today/This week/Watch), a short factual summary, and a one-line swing-trade "impact" read (never a buy/sell/target call). Order most-essential first. Also give a short marketMood, marketSummary, dailyFocus and 3-6 ranked sectors inferred only from these headlines.

Current time: ${today.toISOString()}.

HEADLINES:
${list}`;
}

function normaliseSectors(sectors) {
  if (!Array.isArray(sectors) || sectors.length < 3) return null;
  return sectors.slice(0, 6).map((sector) => ({
    name: String(sector.name || "Sector"),
    momentum: oneOf(sector.momentum, ["Leading", "Improving", "Mixed", "Weakening"], "Mixed"),
    score: Math.max(0, Math.min(100, Number(sector.score) || 0)),
    reason: String(sector.reason || "Evidence-weighted sector read."),
    catalysts: Array.isArray(sector.catalysts) && sector.catalysts.length ? sector.catalysts.slice(0, 3) : ["News flow"],
    risks: Array.isArray(sector.risks) && sector.risks.length ? sector.risks.slice(0, 3) : ["Headline risk"],
    relatedStocks: Array.isArray(sector.relatedStocks) ? sector.relatedStocks.slice(0, 6) : [],
  }));
}

function finaliseGrounded(result) {
  const data = result.data || {};
  const sources = Array.from(new Map(result.citations.map((source) => [source.url, source])).values());
  const news = (data.news || []).map((item, index) => {
    const fallback = sources[index % Math.max(sources.length, 1)];
    return {
      ...item,
      importance: oneOf(item.importance, IMPORTANCE_ENUM, "Medium"),
      catalystType: oneOf(item.catalystType, CATALYST_ENUM, "Other"),
      timeHorizon: oneOf(item.timeHorizon, HORIZON_ENUM, "Watch"),
      sentiment: oneOf(item.sentiment, SENTIMENT_ENUM, "Neutral"),
      sourceName: item.sourceName || fallback?.title || "Source",
      sourceUrl: isHttps(item.sourceUrl) ? item.sourceUrl : fallback?.url || "",
    };
  });
  const sectors = normaliseSectors(data.sectors);
  if (!news.length || !sectors) throw new Error("Grounded response missing news or sectors.");
  news.sort(
    (a, b) =>
      IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance] ||
      (toTime(b.publishedAt) || 0) - (toTime(a.publishedAt) || 0),
  );
  return { ...data, sectors, news, sources, disclaimer: data.disclaimer || DISCLAIMER };
}

function finaliseClassified(result, items) {
  const data = result.data || {};
  const news = (data.items || [])
    .map((entry) => {
      const source = items[entry.index];
      if (!source) return null;
      const time = toTime(source.pubDate);
      return {
        category: oneOf(entry.category, CATEGORY_ENUM, "market"),
        symbol: String(entry.symbol || inferSymbol(source.title).symbol),
        headline: source.title.slice(0, 180),
        summary: String(entry.summary || source.description || source.title).slice(0, 300),
        sentiment: oneOf(entry.sentiment, SENTIMENT_ENUM, "Neutral"),
        importance: oneOf(entry.importance, IMPORTANCE_ENUM, "Medium"),
        catalystType: oneOf(entry.catalystType, CATALYST_ENUM, "Other"),
        timeHorizon: oneOf(entry.timeHorizon, HORIZON_ENUM, "Watch"),
        impact: String(entry.impact || IMPACT_BY_CATALYST.Other),
        sourceName: source.sourceName,
        sourceUrl: source.link,
        publishedAt: time ? new Date(time).toISOString() : null,
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance] ||
        (toTime(b.publishedAt) || 0) - (toTime(a.publishedAt) || 0),
    );
  const sectors = normaliseSectors(data.sectors) || buildSectors(news);
  if (news.length < 4) throw new Error("Classified response had too few usable items.");
  const sources = Array.from(
    new Map(news.filter((n) => isHttps(n.sourceUrl)).map((n) => [n.sourceUrl, { title: n.sourceName, url: n.sourceUrl }])).values(),
  ).slice(0, 20);
  return {
    marketMood: String(data.marketMood || "Mixed headline tone"),
    marketSummary: String(data.marketSummary || `${news.length} classified market updates.`),
    dailyFocus: String(data.dailyFocus || "Confirm every headline with price and volume before acting."),
    sectors,
    news,
    sources,
    disclaimer: data.disclaimer || DISCLAIMER,
  };
}

// ------------------------------------------------------------------- main
let payload = null;
let method = null;

if (apiKey) {
  try {
    payload = finaliseGrounded(await callGemini({ prompt: groundedPrompt, tools: [{ type: "google_search" }] }));
    method = "gemini-grounded";
    console.log("Using grounded Gemini intelligence.");
  } catch (error) {
    console.log(`Grounded Gemini unavailable (${String(error.message).slice(0, 160)}). Falling back to RSS.`);
  }
}

if (!payload) {
  const items = await collectRssItems();
  console.log(`Collected ${items.length} RSS items.`);
  if (!items.length) {
    console.log("No RSS items could be fetched; keeping the existing feed.");
    process.exit(0);
  }
  if (apiKey) {
    try {
      payload = finaliseClassified(
        await callGemini({ prompt: classifyPrompt(items), tools: [], retryOn: [429, 500, 503] }),
        items,
      );
      method = "rss-gemini";
      console.log("Using RSS headlines classified by Gemini.");
    } catch (error) {
      console.log(`Gemini classification unavailable (${String(error.message).slice(0, 160)}). Using deterministic ranking.`);
    }
  }
  if (!payload) {
    payload = buildDeterministic(items);
    method = "rss-deterministic";
    console.log("Using deterministic RSS ranking.");
  }
}

const result = {
  status: "live",
  method,
  generatedAt: today.toISOString(),
  model: method === "rss-deterministic" ? null : model,
  ...payload,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(
  `Updated ${path.relative(process.cwd(), outputPath)} via ${method} with ${result.news.length} news items and ${result.sources.length} sources.`,
);
