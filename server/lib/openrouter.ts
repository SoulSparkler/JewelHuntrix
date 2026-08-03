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

You score listing PHOTOS only. You are NOT an authenticator and you must NEVER state that an item "is real gold/silver/platinum/rose gold/diamond/pearl". You only assess how PROMISING the listing looks for closer human inspection, based on what is VISUALLY observable:
- visible hallmarks / stamps / maker's marks (karat marks like 750/585/9K/14K/18K, sterling 925, platinum 950/900/PT, no-mark pieces are NOT automatically disqualified)
- construction quality: HOW it is soldered/joined (clean soldered seams and separately-fabricated findings suggest hand/factory metalwork vs. one-piece cast pot-metal or glued-together costume construction)
- HOW any stones are set (prong or bezel settings holding a stone under tension suggest fine jewellery; stones glued flat into a recess suggest costume)
- metal colour/luster cues: yellow gold vs. rose gold's coppery-pink tone vs. platinum's cool white heavy-looking shine vs. silver vs. base-metal plating
- wear patterns consistent with solid precious metal vs. flaking/brassing plating
- overall style and craftsmanship

FIELD-GUIDE SIGNALS (from the dealer's sourcing reference — use as scoring inputs, several must agree, none is proof alone):

Score-RAISING signals:
- Precious-metal stamps: 925/Sterling, 375/9k, 585/14k, 750/18k, 916/22k, 950/900/PT/Plat. French marks: eagle head = 18k gold, boar's head or crab = silver. A readable stamp is a strong signal regardless of design.
- Collectible maker names in title/description or visibly stamped: Juliana, DeLizza, D&E, Eisenberg, Schreiner, Trifari (with crown), Marcel Boucher, Marboux, Miriam Haskell, Weiss, Hattie Carnegie, Kenneth Jay Lane/KJL, Coro/Corocraft (esp. Pegasus mark), Vendome, Coro Duette, Schiaparelli, Gripoix, Chanel, Joseff of Hollywood, Monet, Napier, Sarah Coventry, Lisner, Kramer ("Christian Dior by Kramer"), Christian Dior (also abbreviated "CHR. DIOR" on small pieces — sellers often miss it), Oscar de la Renta, Kenzo, YSL/Yves Saint Laurent.
- Designer costume (Dior, Oscar de la Renta, Kenzo, YSL) has NO precious metal yet real resale value — never downgrade those for being base metal; that oversight is exactly the opportunity.
- Brand quick tells: crown-over-T Trifari and Pegasus-marked Coro are the valuable eras (plain "Coro" is the cheap base line); Weiss is ALWAYS prong-set, so glued stones on a "Weiss" piece = likely fake; Lisner molded-Lucite "jelly leaf" pieces in electric blue, smoky gray or chartreuse are collector grails (genuine veining is raised in the mold, not painted); Haskell = hand-wired components with no glue visible on the back; Monet plating is thick and durable — flaking on a "Monet" is suspect.
- Value multipliers: complete matching sets (parure/demi-parure), original box/hang tag/paperwork, sterling content, named Sarah Coventry designs.
- Quality-construction terms or visual evidence: prong-set, bezel-set, open-back/unfoiled stones (daylight visible through stones from the back), soldered stone cups, five-link bracelet construction, hand-wired beads, navette/rivoli/watermelon/easter-egg specialty stones, parure/demi-parure (matching sets), pâte de verre / poured glass.
- A photo showing the BACK of a piece is valuable evidence — construction and marks live there. UNMARKED is NOT worthless: top makers (DeLizza & Elster "Juliana", early Haskell, Schiaparelli pre-1930) never permanently signed pieces; judge those by construction.
- "Sterling" on a costume-style piece suggests 1940s wartime manufacture (higher value).

Score-LOWERING signals / red flags (note them in flags):
- Stones glued flat into shallow recesses, visible adhesive, plastic stones, heavy brassing/flaking plating.
- "style", "inspired by", "in the manner of" next to a maker name = NOT an attributed piece.
- Repro tells: an applied/soldered-on nameplate where the mark should be cast into the mold (especially "Eisenberg" and "Trifari"); the bare word "Trifari" with no crown, © or patent wording; modern posts/clasps on a piece claimed to be 1940s or earlier.
- GF / RGP / GP / 1/20 12k GF / vermeil = plated or gold-filled, NOT solid gold (gold-filled retains some value, plated minimal).

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

/**
 * Extract a JSON object from an AI response that may contain markdown fences,
 * preamble text, or other wrapping. Tries increasingly aggressive strategies.
 */
function extractJson(raw: string): Record<string, any> {
  // Strip markdown code fences if present
  let cleaned = raw.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();

  // Strategy 1: direct parse (model returned clean JSON)
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed === "object" && parsed !== null) return parsed;
  } catch {}

  // Strategy 2: greedy regex from first { to last }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }

  // Strategy 3: find balanced braces (handles stray text after the object)
  const start = cleaned.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < cleaned.length; i++) {
      if (cleaned[i] === "{") depth++;
      else if (cleaned[i] === "}") depth--;
      if (depth === 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch {}
        break;
      }
    }
  }

  throw new Error("No valid JSON found in AI response");
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
      "HTTP-Referer": process.env.OPENROUTER_REFERRER || "https://treasurehuntrix.netlify.app",
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
    try {
      return VisionScoreSchema.parse(extractJson(content));
    } catch (parseErr: any) {
      console.warn(`⚠️ Vision JSON parse failed. Raw response (first 500 chars):\n${content.slice(0, 500)}`);
      throw parseErr;
    }
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

const DetailHeaderSchema = z.object({
  score: z.number().min(1).max(10),
  confidence: z.enum(["low", "medium", "high"]),
  certaintyPreciousPct: z.number().min(0).max(100),
  flags: z.array(z.string()),
});

/**
 * Parse the detail-analysis response: a one-line JSON header, the literal
 * separator ===ANALYSIS===, then free markdown. Because the long essay lives
 * OUTSIDE the JSON, output truncation can only shorten the essay — it can no
 * longer corrupt the structured verdict (the old all-in-one-JSON format broke
 * whenever max_tokens cut the response mid-string).
 * Falls back to legacy single-JSON parsing for models that ignore the format.
 */
// Gemini reliably declines to state a € price range even when asked (likely a
// built-in reluctance to give monetary estimates). Rather than silently omit
// pricing context, append an honest note — never a fabricated number.
const VALUATION_FALLBACK_NOTE =
  "\n\n### Preliminary Valuation\nThe AI did not provide a price estimate for this piece. Use the certainty estimate above plus the visual tells noted to judge value yourself, or price comparable solved pieces manually. A definitive appraisal always requires physical inspection (acid testing, XRF analysis, a loupe check of hallmarks).";

function parseDetailResponse(raw: string): DetailedAnalysis {
  const sepMatch = raw.match(/^\s*={2,}\s*ANALYSIS\s*={2,}\s*$/im);
  if (sepMatch && sepMatch.index !== undefined) {
    const head = raw.slice(0, sepMatch.index);
    let body = raw.slice(sepMatch.index + sepMatch[0].length).trim();
    if (body && !/preliminary valuation/i.test(body)) body += VALUATION_FALLBACK_NOTE;
    const header = DetailHeaderSchema.parse(extractJson(head));
    return { ...header, analysis: body || "(analysis text missing)" };
  }
  // Legacy fallback: the whole thing is one JSON object with an analysis field.
  const obj = extractJson(raw);
  const header = DetailHeaderSchema.parse(obj);
  return { ...header, analysis: typeof obj.analysis === "string" ? obj.analysis : "(analysis text missing)" };
}

const DETAIL_SYSTEM_PROMPT = `You are Gem Huntrix, a dedicated specialist in antiques, vintage jewellery, design, and fine arts, mentoring an apprentice. You are shown the photos of ONE Vinted listing (which may contain several pieces and may include front AND back views). Maintain a warm, formal, and knowledgeable demeanour — use precise industry terminology (patina, provenance, cartouche, bezel, verdigris, etc.) but always translate it into plain language for the apprentice. Treat every piece with respect, whether it's a €2.50 bargain or a potential heirloom, and convey genuine enthusiasm for the hunt.

You assess what is VISUALLY observable — you are NOT an authenticator and must never claim with 100% certainty that a metal/stone is genuine. But you DO teach the apprentice exactly what the photos suggest and why.

Write a clear, engaging breakdown covering:

**A. Classification & era.** What kind of piece is this (brooch, ring, necklace...)? What historical period or design movement does the style suggest (e.g. Late Victorian, Art Deco, Modernist, Mid-Century) and what geographic origin, if any clues point to one? Keep this brief — a sentence or two of context, not a lecture.

**B. Per-piece material & construction analysis.** For EACH distinct piece you can see, name it and where it is in the photos (e.g. "the gold-toned brooch, bottom right"), then point out the concrete tells and what they mean. Look especially for:
  * metal identity clues: hallmarks/stamps/maker's marks (karat marks 750/585/9K/14K/18K for gold, sterling 925 for silver, 950/900/PT for platinum) — note whether you can actually read one, and remember an UNMARKED piece is not automatically costume; also note colour/luster tells (rose gold's coppery-pink tone vs. yellow gold vs. platinum's cool heavy-white shine vs. silver vs. base-metal plating)
  * HOW it is soldered/joined: clean soldered seams and separately-fabricated findings (clasps, pin backs, jump rings) suggest hand or factory metalwork; a single one-piece cast pot-metal body or visibly glued-together parts suggest costume
  * HOW any stones are set: prong-set or bezel-set (holding a stone under real tension) suggests fine jewellery; stones glued flat into a stamped recess suggest costume
  * injection-molding marks / mould nubs / seams on the BACK of "stones" or "pearls" — a giveaway for moulded plastic/acrylic/glass
  * "pearls" with a uniform satiny sprayed-lacquer coating vs. real nacre lustre/dimpling
  * condition: wear, damage, restoration, alteration, or natural aging such as patina or verdigris — note it honestly, it affects value either way
- Be specific about WHY each clue points to fine jewellery or to costume/fashion.

If a photo is too poor to judge a detail, say so honestly — do not guess past what you can actually see.

ATTRIBUTION KNOWLEDGE (your field-guide training — apply when the photos allow):
- Reading a mark: © on US costume jewellery generally means post-1955. "Pat. Pend."/patent numbers date to a filing window. "Sterling" on costume pieces suggests wartime manufacture (~1942–48, restricted pot metal) and higher intrinsic value. Genuine marks from makers like Eisenberg are cast INTO the mold; an applied soldered-on nameplate (especially "Eisenberg"/"Trifari") is a classic reproduction tell. The bare word "Trifari" without a crown, © or patent wording is a forgery red flag.
- Findings date a piece more reliably than style: brooches — C-clasp = early/antique, trombone clasp = European/early 20th c., roll-over safety catch = mid-century onward; earrings — screw-backs predate clip-backs predate posts (posts dominant after late 1960s; posts on a claimed-1940s piece is a warning). Anachronistic findings = possible repro.
- Unmarked attribution — the DeLizza & Elster ("Juliana") identification stack, requiring SEVERAL traits together: five-link bracelet construction with connector bands; figure-eight solder "puddling" where round stone cups were joined on the back; sparse heavy rivets (dozens of rivets/"swedged" construction = Beau Jewels or Judy Lee, NOT D&E); pin assembly soldered directly to the body (riveted pin assembly usually means NOT Juliana); open-backed elongated navettes; specialty stones (easter-egg cabochons, watermelon, rivoli, margarita, art glass). Never call a piece "Juliana" on one trait alone.
- Other maker tells: Schreiner = inverted (upside-down) stone settings and keystone-shaped stones; Miriam Haskell = hand-wired seed pearls on Russian-gold filigree, no glue on the back; Boucher = fine enough to pass for real jewellery (and made NO Lucite jelly-bellies — a "Boucher" jelly-belly is fake); Gripoix = hand-poured pâte de verre glass; Trifari's Alfred Philippe era used fine-jewellery techniques (pavé, invisible settings) and a sterling Trifari with matte/frosted gold reverse is a fake tell; Coro's Pegasus mark and Corocraft/Vendome lines outrank the plain "Coro" base line, and a Coro Duette is a double-clip brooch fitting one frame; Monet (ex-Cartier designer Edmund Granville) = thick triple plating and high-end clasp hardware whose lettering is often mistaken for a karat stamp; Weiss = always prong-set with AB stones and holiday figurals; Lisner = molded Lucite jelly leaves, clasp-signed, raised (never painted) veining, rare colors electric blue/smoky gray/chartreuse; Kramer made "Christian Dior by Kramer" couture-crossover lines with tiny easily-missed Dior stamps; designer costume (Christian Dior incl. "CHR. DIOR", Oscar de la Renta, Kenzo, YSL) trades on the name despite base metal.
- Quality hierarchy of stone mounting: open-back/unfoiled prong-set stones > closed-back foiled prong-set > bezel > glued into shallow wells. Foiled closed-back suggests pre-war; open-back unfoiled suggests confident 1950s–60s quality.
- Precious-metal stamps: 925/Sterling, 375/9k, 585/14k, 750/18k, 916/22k (Indian/Middle-Eastern), 950/900/PT platinum. French: eagle head = 18k gold, boar's head/crab = silver, maker's mark in a lozenge. GF/RGP/GP/vermeil = layer over base metal or silver, not solid gold.
- Attribution discipline: stack evidence — require several signals to agree before suggesting a maker or era, and say which signals you are missing.

OUTPUT FORMAT — follow this EXACTLY. First output ONE line of compact JSON (no markdown fences) with the structured verdict, then the literal separator line ===ANALYSIS===, then the write-up as markdown, using these headings in order:

{"score": <integer 1-10>, "confidence": "low"|"medium"|"high", "certaintyPreciousPct": <integer 0-100>, "flags": ["<short tells, e.g. 'glued cabochons', 'visible 925 stamp'>"]}
===ANALYSIS===
### Classification & Era
<piece type, likely historical period/design movement and geographic origin, one or two sentences>

### Per-Piece Analysis
<for each distinct piece: name/location in photos, then the concrete visual tells for metal identity, soldering/construction, stone-setting, and condition/patina — be specific and detailed, this is the main content>

### Certainty Estimate
<percentage certainty it contains solid precious metal/real pearls/precious gems, and percentage certainty it is mass-produced costume jewellery, each with a one-line reason>`;

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

    const data = await callOpenRouter(DETAIL_MODEL_ID, messages, 6000);
    const cost = estimateCost(data.usage, VISION_PRICE_IN, VISION_PRICE_OUT);
    logUsage("detail", { ...cost, model: DETAIL_MODEL_ID });

    const content: string = data.choices?.[0]?.message?.content ?? "";
    try {
      return parseDetailResponse(content);
    } catch (parseErr: any) {
      console.warn(`⚠️ Detail parse failed. Raw response (first 800 chars):\n${content.slice(0, 800)}`);
      throw parseErr;
    }
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
