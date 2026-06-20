/**
 * Central OpenRouter client.
 *
 * Two distinct AI tasks, each with its OWN model configured via env var so the
 * owner can swap models without touching code:
 *
 *   - Task A: scoreListingImages()   -> vision scoring of listing photos
 *             model = VISION_MODEL_ID   (e.g. openai/gpt-4o, anthropic/claude-sonnet-4)
 *   - Task B: generateAlertMessage() -> cheap text-only Telegram copy
 *             model = MESSAGE_MODEL_ID  (e.g. openai/gpt-4o-mini)
 *
 * Both calls log which model was used and an estimated cost so the owner can see
 * spend per scan.
 */

import { z } from "zod";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const VISION_MODEL_ID = process.env.VISION_MODEL_ID || "openai/gpt-4o";
const MESSAGE_MODEL_ID = process.env.MESSAGE_MODEL_ID || "openai/gpt-4o-mini";

// Optional per-1M-token price overrides for cost logging (USD). These are only
// for the log line — they don't affect billing, which OpenRouter does for real.
const VISION_PRICE_IN = parseFloat(process.env.VISION_PRICE_IN_PER_M || "2.5");
const VISION_PRICE_OUT = parseFloat(process.env.VISION_PRICE_OUT_PER_M || "10");
const MESSAGE_PRICE_IN = parseFloat(process.env.MESSAGE_PRICE_IN_PER_M || "0.15");
const MESSAGE_PRICE_OUT = parseFloat(process.env.MESSAGE_PRICE_OUT_PER_M || "0.6");

export interface VisionScore {
  score: number; // 1-10
  reasoning: string;
  flags: string[];
  confidence: "low" | "medium" | "high";
}

const VisionScoreSchema = z.object({
  score: z.number().min(1).max(10),
  reasoning: z.string(),
  flags: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
});

// The system prompt MUST keep the model in "pre-filter" mode — never a verdict.
const VISION_SYSTEM_PROMPT = `You are a pre-filter assistant for an antique jewellery dealer who hunts for undervalued Vinted lots.

You score listing PHOTOS only. You are NOT an authenticator and you must NEVER state that an item "is real gold/silver/diamond/pearl". You only assess how PROMISING the listing looks for closer human inspection, based on what is VISUALLY observable:
- visible hallmarks / stamps / maker's marks
- construction quality (solder seams, casting vs. stamped sheet)
- stone setting (prong/bezel settings vs. glued stones)
- wear patterns consistent with solid precious metal vs. flaking plating
- overall style and craftsmanship

Output a JSON object ONLY, no markdown, with exactly this shape:
{
  "score": <integer 1-10, how worth-a-closer-look this listing is>,
  "reasoning": "<one or two sentences, strictly about visual evidence>",
  "flags": ["<short observations, e.g. 'visible 925 stamp', 'glued rhinestones', 'flaking plating'>"],
  "confidence": "low" | "medium" | "high"
}

Be honest about uncertainty. If photos are too poor to judge, say so and use low confidence. You are a filter that surfaces candidates, never the final word.`;

interface UsageLog {
  model: string;
  promptTokens: number;
  completionTokens: number;
  estCostUsd: number;
}

function logUsage(task: string, log: UsageLog): void {
  console.log(
    `💸 [AI ${task}] model=${log.model} tokens_in=${log.promptTokens} tokens_out=${log.completionTokens} est_cost=$${log.estCostUsd.toFixed(4)}`,
  );
}

function estimateCost(usage: any, priceIn: number, priceOut: number): UsageLog & { promptTokens: number } {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const estCostUsd = (promptTokens / 1_000_000) * priceIn + (completionTokens / 1_000_000) * priceOut;
  return { model: "", promptTokens, completionTokens, estCostUsd };
}

async function callOpenRouter(model: string, messages: any[], maxTokens: number): Promise<any> {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  const res = await fetch(OPENROUTER_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_REFERRER || "https://jewelhuntrix.netlify.app",
      "X-Title": "JewelHuntrix",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${model} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Task A — vision scoring. Returns a structured pre-filter score (1-10).
 * On any failure returns a safe low-score result so the pipeline never crashes.
 */
export async function scoreListingImages(
  imageUrls: string[],
  title: string,
  description = "",
): Promise<VisionScore> {
  if (imageUrls.length === 0) {
    return { score: 1, reasoning: "No images available to assess.", flags: ["no-images"], confidence: "low" };
  }
  try {
    const messages = [
      { role: "system", content: VISION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: `Listing title: "${title}"\nDescription: "${description}"\nScore the photos.` },
          ...imageUrls.slice(0, 4).map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      },
    ];

    const data = await callOpenRouter(VISION_MODEL_ID, messages, 600);
    const cost = estimateCost(data.usage, VISION_PRICE_IN, VISION_PRICE_OUT);
    logUsage("vision", { ...cost, model: VISION_MODEL_ID });

    const content: string = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in vision response");
    return VisionScoreSchema.parse(JSON.parse(jsonMatch[0]));
  } catch (err: any) {
    console.warn(`⚠️ Vision scoring failed: ${err.message}`);
    return { score: 1, reasoning: `Scoring failed: ${err.message}`, flags: ["error"], confidence: "low" };
  }
}

/**
 * Task B — cheap text model that turns the score + metadata into a short,
 * human-readable Telegram message (Dutch). Falls back to a plain template if the
 * model call fails, so an alert is always delivered.
 */
export async function generateAlertMessage(input: {
  title: string;
  price: string;
  url: string;
  sellerCountry: string | null;
  score: VisionScore;
}): Promise<string> {
  const { title, price, url, sellerCountry, score } = input;
  const fallback = buildFallbackMessage(input);
  try {
    const messages = [
      {
        role: "system",
        content:
          "Je schrijft korte, zakelijke Telegram-meldingen (in het Nederlands) voor een antiekhandelaar die kansrijke Vinted-sieraden zoekt. Max 6 regels. Wees nuchter: dit is een pre-filter-signaal, geen garantie. Gebruik de gegeven score en observaties. Sluit af met de link. Geen overdreven marketingtaal.",
      },
      {
        role: "user",
        content: `Titel: ${title}\nPrijs: ${price}\nLand verkoper: ${sellerCountry || "onbekend"}\nScore: ${score.score}/10 (zekerheid: ${score.confidence})\nObservaties: ${score.flags.join(", ") || "geen"}\nReden: ${score.reasoning}\nLink: ${url}`,
      },
    ];
    const data = await callOpenRouter(MESSAGE_MODEL_ID, messages, 300);
    const cost = estimateCost(data.usage, MESSAGE_PRICE_IN, MESSAGE_PRICE_OUT);
    logUsage("message", { ...cost, model: MESSAGE_MODEL_ID });

    const text: string = data.choices?.[0]?.message?.content?.trim() ?? "";
    return text || fallback;
  } catch (err: any) {
    console.warn(`⚠️ Message generation failed, using fallback: ${err.message}`);
    return fallback;
  }
}

function buildFallbackMessage(input: {
  title: string;
  price: string;
  url: string;
  sellerCountry: string | null;
  score: VisionScore;
}): string {
  const { title, price, url, sellerCountry, score } = input;
  return [
    `💎 Mogelijk kansrijke vondst (score ${score.score}/10, ${score.confidence})`,
    `*${title}*`,
    `💰 ${price}  |  📍 ${sellerCountry || "onbekend"}`,
    score.flags.length ? `🔎 ${score.flags.join(", ")}` : "",
    score.reasoning,
    url,
  ]
    .filter(Boolean)
    .join("\n");
}
