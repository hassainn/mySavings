// TEMPORARY diagnostic: probe why the non-grounded structured-output call
// returns HTTP 400. Runs several request variants in one CI run and prints
// the FULL response body so we can see Google's field-level error detail.
// Remove this script and its workflow once the cause is confirmed.

const apiKey = process.env.GEMINI_API_KEY?.trim();
const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
if (!apiKey) {
  console.log("No GEMINI_API_KEY; nothing to probe.");
  process.exit(0);
}

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

async function probe(label, body) {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`\n=== ${label} -> HTTP ${res.status} ===`);
    console.log(text.slice(0, 1600));
  } catch (error) {
    console.log(`\n=== ${label} -> THREW ===`);
    console.log(String(error.message).slice(0, 400));
  }
}

const prompt = 'Classify these headlines as JSON. [0] "HAL wins order" [1] "Nifty falls 1%".';

// A schema WITH numeric/array constraints (like the current classifySchema).
const constrainedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "importance"],
        properties: {
          index: { type: "integer", minimum: 0 },
          importance: { type: "string", enum: ["High", "Medium", "Low"] },
        },
      },
    },
  },
};

// The SAME schema with all min/max constraints removed.
const leanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "importance"],
        properties: {
          index: { type: "integer" },
          importance: { type: "string", enum: ["High", "Medium", "Low"] },
        },
      },
    },
  },
};

const tinySchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: { summary: { type: "string" } },
};

const rf = (schema) => ({ type: "text", mime_type: "application/json", schema });

await probe("V1 constrained schema, no tools", { model, input: prompt, response_format: rf(constrainedSchema) });
await probe("V2 lean schema (no min/max), no tools", { model, input: prompt, response_format: rf(leanSchema) });
await probe("V3 tiny schema, no tools", { model, input: prompt, response_format: rf(tinySchema) });
await probe("V4 no response_format, no tools", { model, input: prompt });
await probe("V5 tiny schema + empty tools array", { model, input: prompt, tools: [], response_format: rf(tinySchema) });
await probe("V6 lean schema + google_search tool", { model, input: prompt, tools: [{ type: "google_search" }], response_format: rf(leanSchema) });

console.log("\nDone.");
