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
const prompt = `You are the research editor for Alpha Swing AI, an Indian swing-trading decision workspace.

Current time: ${today.toISOString()}.
Use Google Search to research only reputable, recent sources about Indian equities, NSE/BSE market conditions, sector momentum and company-specific developments. Prefer exchange filings, company announcements, SEBI/RBI/government releases, Reuters, Bloomberg, Business Standard, The Economic Times, Moneycontrol and similarly established publications. Focus on information published in the last 48 hours; use an older item only when it remains an active catalyst and state the date.

Cover the broad market plus the user's watchlist: HAL, BEL, TRENT, CGPOWER and COCHINSHIP. Rank the sectors showing the strongest evidence-backed momentum, but call them Leading only when price participation and credible catalysts agree. Separate facts from inference. Each news item must explain why it matters to a swing trader, name the source, include its real HTTPS article URL and use an ISO-8601 publishedAt value when available.

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

intelligence.news = (intelligence.news || []).map((item, index) => {
  const fallback = uniqueSources[index % Math.max(uniqueSources.length, 1)];
  return {
    ...item,
    sourceName: item.sourceName || fallback?.title || "Source",
    sourceUrl: isHttps(item.sourceUrl) ? item.sourceUrl : fallback?.url || "",
  };
});

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
