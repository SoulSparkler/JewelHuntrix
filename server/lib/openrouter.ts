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

const VISION_MODEL_ID = process.env.VISION_MODEL_ID || "google/gemini-2.5-flash-lite";
const MESSAGE_MODEL_ID = process.env.MESSAGE_MODEL_ID || "openai/gpt-4o-mini";
// Stronger model used ONLY for one-off manual deep-analysis (the dashboard's
// "Manual Scan"). The bulk scanner keeps the cheap VISION_MODEL_ID pre-filter.
const DETAIL_MODEL_ID = process.env.DETAIL_MODEL_ID || "google/gemini-2.5-flash";

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

/**
 * Download an image and return a base64 data URI.
 * Vinted CDN URLs are signed and often return 404 when fetched by external
 * services (like OpenRouter). By downloading server-side first we avoid that.
 */
async function imageToDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
        Referer: "https://www.vinted.nl/",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "image/jpeg";
    return `data:${contentType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

async function resolveImageContents(
  urls: string[],
): Promise<Array<{ type: "image_url"; image_url: { url: string } }>> {
  const results = await Promise.all(urls.map(imageToDataUri));
  return results
    .filter((uri): uri is string => uri !== null)
    .map((uri) => ({ type: "image_url" as const, image_url: { url: uri } }));
}

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
    const imageContents = await resolveImageContents(imageUrls.slice(0, 4));
    if (imageContents.length === 0) {
      return { score: 1, reasoning: "Could not download any listing images.", flags: ["image-download-failed"], confidence: "low" };
    }

    const messages = [
      { role: "system", content: VISION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: `Listing title: "${title}"\nDescription: "${description}"\nScore the photos.` },
          ...imageContents,
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

// ---------------------------------------------------------------------------
// Task A2 — DETAILED manual analysis (dashboard "Manual Scan").
//
// Unlike the bulk pre-filter above (which returns a terse 1-10 score), this
// produces an expert, apprentice-teaching write-up: a per-item breakdown that
// names the concrete visual tells (injection-molding marks, glued cabochons vs.
// prong/bezel set stones, sprayed-lacquer "pearl" finish vs. real nacre,
// hallmarks/stamps, solder seams, clasp/backplate construction) and ends with a
// certainty estimate. Used for the few one-off URLs the owner scans by hand, so
// it can afford a stronger (DETAIL_MODEL_ID) model.
// ---------------------------------------------------------------------------

export interface DetailedAnalysis {
  score: number; // 1-10 "worth a closer look"
  confidence: "low" | "medium" | "high";
  certaintyPreciousPct: number; // 0-100: certainty it contains REAL precious materials
  flags: string[]; // short tells, e.g. "injection-molding nub", "glued cabochons"
  analysis: string; // long-form markdown write-up (the Gemini-style breakdown)
}

const DetailedAnalysisSchema = z.object({
  score: z.number().min(1).max(10),
  confidence: z.enum(["low", "medium", "high"]),
  certaintyPreciousPct: z.number().min(0).max(100),
  flags: z.array(z.string()),
  analysis: z.string(),
});

const DETAIL_SYSTEM_PROMPT = `You are a seasoned antique jewellery dealer mentoring an apprentice. You are shown the photos of ONE Vinted listing (which may contain several pieces and may include front AND back views). You assess what is VISUALLY observable — you are NOT an authenticator and must never claim with 100% certainty that a metal/stone is genuine. But you DO teach the apprentice exactly what the photos suggest and why.

Write a clear, engaging breakdown. For EACH distinct piece you can see:
- Name it and where it is in the photos (e.g. "the gold-toned brooch, bottom right").
- Point out the concrete tells and what they mean. Look especially for:
  * injection-molding marks / mold nubs / seams on the BACK of "stones" or "pearls" (a giveaway for moulded plastic/acrylic/glass)
  * stones glued flat into openings vs. prong-set or bezel-set (set stones suggest better quality)
  * "pearls" with a uniform satiny sprayed-lacquer coating vs. real nacre lustre/dimpling
  * hallmarks / stamps / maker's marks (e.g. 925, 750, 18k) — and whether you can actually read one
  * construction: cast alloy framework, solder seams, solid backplate, clasp/pin type, plating wear
- Be specific about WHY each clue points to fine jewellery or to costume/fashion.

If a photo is too poor to judge a detail, say so honestly.

Finish with a short "Certainty estimate" section:
- certainty it contains solid precious metal / real pearls / precious gems (a percentage)
- certainty it is mass-produced costume jewellery / fashion accessory (a percentage)

Return a JSON object ONLY (no markdown fences), with exactly this shape:
{
  "score": <integer 1-10, how worth-a-closer-look this listing is for a dealer>,
  "confidence": "low" | "medium" | "high",
  "certaintyPreciousPct": <integer 0-100, your certainty it contains REAL precious materials>,
  "flags": ["<short tells, e.g. 'injection-molding nub on pearl back', 'glued cabochons', 'visible 925 stamp'>"],
  "analysis": "<the full apprentice-teaching write-up as MARKDOWN text; use headings and bullet points; this is the main output and should be detailed>"
}`;

export async function analyzeListingDetailed(
  imageUrls: string[],
  title: string,
  description = "",
): Promise<DetailedAnalysis> {
  if (imageUrls.length === 0) {
    return {
      score: 1,
      confidence: "low",
      certaintyPreciousPct: 0,
      flags: ["no-images"],
      analysis: "No photos were available for this listing, so nothing can be assessed visually.",
    };
  }
  try {
    const imageContents = await resolveImageContents(imageUrls.slice(0, 6));
    if (imageContents.length === 0) {
      return {
        score: 1,
        confidence: "low",
        certaintyPreciousPct: 0,
        flags: ["image-download-failed"],
        analysis: "Could not download any listing images from Vinted. The CDN may have blocked the request.",
      };
    }

    const messages = [
      { role: "system", content: DETAIL_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Listing title: "${title}"\nDescription: "${description}"\nHere are the listing photos (front and, where present, back views). Give your full apprentice-teaching breakdown and certainty estimate.`,
          },
          ...imageContents,
        ],
      },
    ];

    const data = await callOpenRouter(DETAIL_MODEL_ID, messages, 1800);
    const cost = estimateCost(data.usage, VISION_PRICE_IN, VISION_PRICE_OUT);
    logUsage("detail", { ...cost, model: DETAIL_MODEL_ID });

    const content: string = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in detailed analysis response");
    return DetailedAnalysisSchema.parse(JSON.parse(jsonMatch[0]));
  } catch (err: any) {
    console.warn(`⚠️ Detailed analysis failed: ${err.message}`);
    return {
      score: 1,
      confidence: "low",
      certaintyPreciousPct: 0,
      flags: ["error"],
      analysis: `The detailed analysis could not be completed: ${err.message}`,
    };
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
