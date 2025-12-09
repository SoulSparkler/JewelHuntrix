import OpenAI from "openai";
import { z } from "zod";

let openai: OpenAI | null = null;

if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  console.log("OpenAI client initialized successfully.");
} else {
  console.warn(
    "OPENAI_API_KEY is not set. Image analysis will be disabled."
  );
}

// Zod validation schema for antique dealer responses
const AntiqueDealerResponseSchema = z.object({
  listingUrl: z.string(),
  isValuableLikely: z.boolean(),
  confidence: z.number().min(0).max(100),
  mainMaterialGuess: z.enum(['gold', 'silver', 'pearls', 'diamonds', 'gemstones', 'mixed', 'unknown']),
  reasons: z.array(z.string())
});

interface AntiqueDealerAnalysisResult {
  listingUrl: string;
  isValuableLikely: boolean;
  confidence: number;
  mainMaterialGuess: 'gold' | 'silver' | 'pearls' | 'diamonds' | 'gemstones' | 'mixed' | 'unknown';
  reasons: string[];
}

const ANTIQUE_DEALER_PROMPT = `You are a professional antique jewelry dealer and estate lot expert.

Your task is to detect HIDDEN VALUE in undervalued Vinted listings, especially:
- Vintage jewelry lots
- Estate lots
- "Old jewelry box" bundles
- Mixed costume + real metal pieces
- Sellers who do NOT recognize what they are selling

Analyze the listing TITLE, DESCRIPTION, PRICE, and IMAGES.

You are not looking only for obvious solid gold.
You are looking for:
- Real GOLD
- Real SILVER
- NATURAL PEARLS
- DIAMONDS
- PRECIOUS & SEMI-PRECIOUS GEMSTONES
- RELIGIOUS MEDALS
- ANTIQUE SIGNED JEWELRY
- ART NOUVEAU / ART DECO pieces

Think like a flea market treasure hunter.

--- VALUE BOOST SIGNALS ---
Increase confidence if ANY of the following are present:
- Hallmarks: 925, 800, 835, 585, 750, 18k, 14k
- Tarnish consistent with real silver
- Old cut diamonds
- Baroque or irregular pearls
- Heavy wear on clasps
- Religious medals with age patina
- One valuable item hidden among many cheap ones
- Seller language like: "old jewelry", "grandma", "estate", "found in drawer", "untested", "don't know"

--- VALUE RED FLAGS ---
Decrease confidence if:
- "plaqué", "doré", "fantaisie", "gold tone"
- Mass-produced modern fashion jewelry
- Obvious plastic beads
- Fully uniform shiny gold color
- No wear at all on supposedly old items

--- DECISION RULE ---
If even ONE item in a mixed lot is likely real:
→ The entire lot becomes a PROFIT OPPORTUNITY.

Your job is to detect potential resale arbitrage, not to authenticate perfectly.

OUTPUT ONLY valid JSON. NO markdown. NO explanations outside the JSON. NO extra text.

Schema:
{
  "listingUrl": "string",
  "isValuableLikely": boolean,
  "confidence": 0-100,
  "mainMaterialGuess": "gold | silver | pearls | diamonds | gemstones | mixed | unknown",
  "reasons": ["string", "string", "string"]
}

If uncertainty exists but upside is high → still raise confidence.
You are allowed to be aggressive in opportunity detection.`;

// Parse AI response with validation
function parseAntiqueDealerResponse(content: string, listingUrl: string): AntiqueDealerAnalysisResult {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    
    const parsed = JSON.parse(jsonMatch[0]);
    const validated = AntiqueDealerResponseSchema.parse(parsed);
    
    return {
      listingUrl: validated.listingUrl || listingUrl,
      isValuableLikely: validated.isValuableLikely,
      confidence: validated.confidence,
      mainMaterialGuess: validated.mainMaterialGuess,
      reasons: validated.reasons
    };
  } catch (error: any) {
    console.warn('AI response validation failed:', error.message);
    return {
      listingUrl,
      isValuableLikely: false,
      confidence: 0,
      mainMaterialGuess: 'unknown',
      reasons: ['Analysis failed: ' + error.message]
    };
  }
}

export async function analyzeJewelryImages(
  imageUrls: string[],
  listingTitle: string,
  listingDescription?: string,
  listingUrl?: string
): Promise<AntiqueDealerAnalysisResult> {
  if (!openai) {
    return {
      listingUrl: listingUrl || '',
      isValuableLikely: false,
      confidence: 0,
      mainMaterialGuess: 'unknown',
      reasons: ["Image analysis is disabled because OPENAI_API_KEY is not configured."]
    };
  }

  console.log(`Analyzing ${imageUrls.length} images with OpenAI Vision`);

  if (imageUrls.length === 0) {
    return {
      listingUrl: listingUrl || '',
      isValuableLikely: false,
      confidence: 0,
      mainMaterialGuess: 'unknown',
      reasons: ["No images available for analysis"]
    };
  }

  try {
    const messages: any[] = [
      {
        role: "user",
        content: [
          { type: "text", text: `${ANTIQUE_DEALER_PROMPT}\n\nListing title: "${listingTitle}"\n\nDescription: "${listingDescription || ''}"` },
          ...imageUrls.slice(0, 4).map(url => ({
            type: "image_url",
            image_url: { url, detail: "high" }
          })),
        ],
      },
    ];

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 1000,
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No response from OpenAI");
    }

    return parseAntiqueDealerResponse(content, listingUrl || '');
  } catch (error: any) {
    console.error("Error analyzing with OpenAI:", error.message);
    return {
      listingUrl: listingUrl || '',
      isValuableLikely: false,
      confidence: 0,
      mainMaterialGuess: 'unknown',
      reasons: [`Analysis failed: ${error.message}`]
    };
  }
}
