import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const outputPath = path.resolve("docs/data/market-intelligence.json");

if (!apiKey) {
  throw new Error(
    "GEMINI_API_KEY is not configured. Add it as a GitHub Actions repository secret.",
  );
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "marketMood",
    "marketSummary",
    "dailyFocus",
    "sectors",
    "news",
    "disclaimer",
  ],
  properties: {
    marketMood: { type: "string" },
    marketSummary: { type: "string" },
    dailyFocus: { type: "string" },
    sectors: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "name",
          "momentum",
          "score",
          "reason",
          "catalysts",
          "risks",
          "relatedStocks",
        ],
        properties: {
          name: { type: "string" },
          momentum: {
            type: "string",
            enum: ["Leading", "Improving", "Mixed", "Weakening"],
          },
          score: { type: "integer", minimum: 0, maximum: 100 },
          reason: { type: "string" },
          catalysts: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: { type: "string" },
          },
          risks: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: { type: "string" },
          },
          relatedStocks: {
            type: "array",
            maxItems: 6,
            items: { type: "string" },
          },
        },
      },
    },
    news: {
      type: "array",
      minItems: 8,
      maxItems: 14,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "category",
          "symbol",
          "headline",
          "summary",
          "sentiment",
          "importance",
          "catalystType",
          "timeHorizon",
          "impact",
          "sourceName",
          "sourceUrl",
          "publishedAt",
        ],
        properties: {
          category: {
            type: "string",
            enum: ["market", "sector", "stock"],
          },
          symbol: { type: "string" },
          headline: { type: "string" },
          summary: { type: "string" },
          sentiment: {
            type: "string",
            enum: ["Positive", "Neutral", "Negative", "Mixed"],
          },
          importance: {
            type: "string",
            enum: ["High", "Medium", "Low"],
          },
          catalystType: {
            type: "string",
            enum: [
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
            ],
          },
          timeHorizon: {
            type: "string",
            enum: ["Today", "This week", "Watch"],
          },
          impact: { type: "string" },
          sourceName: { type: "string" },
          sourceUrl: { type: "string" },
          publishedAt: { type: ["string", "null"] },
        },
      },
    },
    disclaimer: { type: "string" },
  },
};

const today = new Date();
const prompt = `You are the research editor for Alpha Swing AI, an Indian (NSE) swing-trading workspace whose users trade breakouts, cup-and-handle and other base breakouts on a multi-day to multi-week horizon.

Current time: ${today.toISOString()}.
Use Google Search to research only reputable, recent sources. Prefer exchange filings (NSE/BSE), company announcements, SEBI/RBI/government releases, Reuters, Bloomberg, Business Standard, The Economic Times, Mint, Moneycontrol and similarly established desks. Focus on items published in the last 48 hours; use an older item only if it is still an active, unresolved catalyst, and state its date.

ESSENTIALITY BAR — a swing trader only cares about news that can move price or change a setup's odds over the next few sessions. INCLUDE, in priority order: quarterly results and management guidance; large order wins, capex and capacity news; credible analyst rating/target changes; block/bulk deals and promoter/insider/FII-DII ownership shifts; index inclusion/exclusion; regulatory or policy actions; scheduled catalysts in the next 1-2 weeks (e.g. results dates, board meetings) — for a scheduled event set timeHorizon to "This week" or "Watch" and note the event date in the summary. EXCLUDE low-signal noise: routine open/close/"market ends higher" recaps with no catalyst, pure opinion/prediction pieces, target-price hype, and rumours without a named source.

For every item: set "importance" to High only if it can plausibly move the stock or the setup this week (Medium = notable context, Low = background); set "catalystType" to the best-fitting category; set "timeHorizon" (Today / This week / Watch); and make "impact" a concrete, one-line swing-trade read (what it means for the trend, base or breakout — never a buy/sell/target call). Order the news array most-essential first (all High before Medium before Low).

Cover the broad market plus the user's watchlist: HAL, BEL, TRENT, CGPOWER and COCHINSHIP; add other clearly market-moving NSE names when warranted. Rank sectors by breakout leadership, marking one Leading only when price participation and credible catalysts agree. Separate facts from inference. Name the source, include its real HTTPS article URL, and use an ISO-8601 publishedAt when available.

Do not invent prices, filings, dates, quotes or URLs. Do not give buy, sell, target-price or guaranteed-return advice. If credible recent information is unavailable, say so rather than filling the gap. Keep summaries concise and professional.`;

const response = await fetch(
  "https://generativelanguage.googleapis.com/v1beta/interactions",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      model,
      input: prompt,
      tools: [{ type: "google_search" }],
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema,
      },
    }),
  },
);

if (!response.ok) {
  const details = await response.text();
  throw new Error(`Gemini API ${response.status}: ${details.slice(0, 800)}`);
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

let intelligence;
try {
  intelligence = JSON.parse(outputText);
} catch {
  throw new Error("Gemini returned output that was not valid JSON.");
}

const citations = [];
for (const step of payload.steps || []) {
  for (const part of step.content || []) {
    for (const annotation of part.annotations || []) {
      if (annotation.type === "url_citation" && annotation.url) {
        citations.push({
          title: annotation.title || new URL(annotation.url).hostname,
          url: annotation.url,
        });
      }
    }
  }
}

const isHttps = (value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const uniqueSources = Array.from(
  new Map(
    citations
      .filter((source) => isHttps(source.url))
      .map((source) => [source.url, source]),
  ).values(),
);

const IMPORTANCE_RANK = { High: 0, Medium: 1, Low: 2 };
const oneOf = (value, allowed, fallback) =>
  allowed.includes(value) ? value : fallback;
const publishedTime = (value) => {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
};

intelligence.news = (intelligence.news || [])
  .map((item, index) => {
    const fallback = uniqueSources[index % Math.max(uniqueSources.length, 1)];
    return {
      ...item,
      importance: oneOf(item.importance, ["High", "Medium", "Low"], "Medium"),
      catalystType: oneOf(
        item.catalystType,
        [
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
        ],
        "Other",
      ),
      timeHorizon: oneOf(item.timeHorizon, ["Today", "This week", "Watch"], "Watch"),
      sourceName: item.sourceName || fallback?.title || "Source",
      sourceUrl: isHttps(item.sourceUrl) ? item.sourceUrl : fallback?.url || "",
    };
  })
  .sort(
    (a, b) =>
      IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance] ||
      publishedTime(b.publishedAt) - publishedTime(a.publishedAt),
  );

const result = {
  status: "live",
  generatedAt: today.toISOString(),
  model,
  ...intelligence,
  sources: uniqueSources,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(
  `Updated ${path.relative(process.cwd(), outputPath)} with ${result.news.length} news items and ${result.sources.length} grounded sources.`,
);
