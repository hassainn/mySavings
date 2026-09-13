// TEMPORARY diagnostic: bisect which part of the real classifySchema causes
// HTTP 400 on the non-grounded structured-output call. Free tier is ~5 req/min,
// so calls are spaced out. Remove this script and its workflow when done.

const apiKey = process.env.GEMINI_API_KEY?.trim();
const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
if (!apiKey) {
  console.log("No GEMINI_API_KEY; nothing to probe.");
  process.exit(0);
}
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(label, schema) {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        model,
        input: 'Classify: [0] "HAL wins order" [1] "Nifty falls 1%". Return the JSON.',
        response_format: { type: "text", mime_type: "application/json", schema },
      }),
    });
    const text = await res.text();
    console.log(`\n=== ${label} -> HTTP ${res.status} ===`);
    if (res.status !== 200) console.log(text.slice(0, 1200));
    else console.log("OK");
  } catch (error) {
    console.log(`\n=== ${label} -> THREW: ${String(error.message).slice(0, 200)} ===`);
  }
}

const sectorSchema = {
  type: "array",
  minItems: 3,
  maxItems: 6,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["name", "momentum", "score", "reason", "catalysts", "risks", "relatedStocks"],
    properties: {
      name: { type: "string" },
      momentum: { type: "string", enum: ["Leading", "Improving", "Mixed", "Weakening"] },
      score: { type: "integer", minimum: 0, maximum: 100 },
      reason: { type: "string" },
      catalysts: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
      risks: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
      relatedStocks: { type: "array", maxItems: 6, items: { type: "string" } },
    },
  },
};
const itemsSchema = {
  type: "array",
  minItems: 6,
  maxItems: 14,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["index", "category", "symbol", "summary", "sentiment", "importance", "catalystType", "timeHorizon", "impact"],
    properties: {
      index: { type: "integer", minimum: 0 },
      category: { type: "string", enum: ["market", "sector", "stock"] },
      symbol: { type: "string" },
      summary: { type: "string" },
      sentiment: { type: "string", enum: ["Positive", "Neutral", "Negative", "Mixed"] },
      importance: { type: "string", enum: ["High", "Medium", "Low"] },
      catalystType: { type: "string", enum: ["Earnings", "Guidance", "Order win", "Rating change", "Block deal", "Ownership", "Index change", "Regulatory", "Macro/flows", "Corporate action", "Other"] },
      timeHorizon: { type: "string", enum: ["Today", "This week", "Watch"] },
      impact: { type: "string" },
    },
  },
};

// B1: exact full classifySchema (reproduce the 400).
const B1 = {
  type: "object",
  additionalProperties: false,
  required: ["marketMood", "marketSummary", "dailyFocus", "sectors", "items", "disclaimer"],
  properties: {
    marketMood: { type: "string" },
    marketSummary: { type: "string" },
    dailyFocus: { type: "string" },
    sectors: sectorSchema,
    items: itemsSchema,
    disclaimer: { type: "string" },
  },
};
// B2: drop sectors entirely.
const B2 = {
  type: "object",
  additionalProperties: false,
  required: ["marketMood", "items", "disclaimer"],
  properties: { marketMood: { type: "string" }, items: itemsSchema, disclaimer: { type: "string" } },
};
// B3: keep sectors but flatten its nested arrays to plain strings.
const flatSector = {
  type: "array",
  minItems: 3,
  maxItems: 6,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["name", "momentum", "score", "reason"],
    properties: {
      name: { type: "string" },
      momentum: { type: "string", enum: ["Leading", "Improving", "Mixed", "Weakening"] },
      score: { type: "integer", minimum: 0, maximum: 100 },
      reason: { type: "string" },
    },
  },
};
const B3 = {
  type: "object",
  additionalProperties: false,
  required: ["marketMood", "sectors", "items", "disclaimer"],
  properties: {
    marketMood: { type: "string" },
    sectors: flatSector,
    items: itemsSchema,
    disclaimer: { type: "string" },
  },
};
// B4: full schema with ALL min/max/minimum/maximum stripped.
const strip = (obj) => {
  if (Array.isArray(obj)) return obj.map(strip);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (["minItems", "maxItems", "minimum", "maximum"].includes(k)) continue;
      out[k] = strip(v);
    }
    return out;
  }
  return obj;
};
const B4 = strip(B1);

await probe("B1 full classifySchema", B1);
await sleep(20000);
await probe("B2 no sectors", B2);
await sleep(20000);
await probe("B3 flattened sectors (no nested arrays)", B3);
await sleep(20000);
await probe("B4 full, min/max stripped", B4);
console.log("\nDone.");
