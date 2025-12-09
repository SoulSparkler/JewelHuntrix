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

// Enhanced Zod validation schema for comprehensive material detection
const AntiqueDealerResponseSchema = z.object({
  listingUrl: z.string(),
  isValuableLikely: z.boolean(),
  confidence: z.number().min(0).max(100),
  mainMaterialGuess: z.enum([
    'gold', 'silver', 'pearls', 'diamonds', 'precious_gemstones',
    'semi_precious_stones', 'religious_medals', 'signed_vintage',
    'art_deco', 'art_nouveau', 'mixed', 'unknown'
  ]),
  reasons: z.array(z.string())
});

interface AntiqueDealerAnalysisResult {
  listingUrl: string;
  isValuableLikely: boolean;
  confidence: number;
  mainMaterialGuess: 'gold' | 'silver' | 'pearls' | 'diamonds' | 'precious_gemstones' |
                    'semi_precious_stones' | 'religious_medals' | 'signed_vintage' |
                    'art_deco' | 'art_nouveau' | 'mixed' | 'unknown';
  reasons: string[];
}

const ENHANCED_ANTIQUe_DEALER_PROMPT = `You are a MASTER antique jewelry dealer and estate liquidator with 30+ years experience.

Your mission: Detect HIDDEN VALUE in undervalued Vinted listings across ALL valuable materials and periods.

🎯 TARGET CATEGORIES:
1. GOLD - All karats (9k, 14k, 18k, 22k, 24k)
2. SILVER - Sterling (925), Coin silver (900), Continental silver (800, 835)
3. PEARLS - Natural, High-value cultured, Baroque, Antique seed pearls
4. DIAMONDS - Old mine cuts, European cuts, Rose cuts, Modern brilliant cuts
5. PRECIOUS GEMSTONES - Ruby, Sapphire, Emerald, Diamond (natural)
6. SEMI-PRECIOUS STONES - Amber, Coral, Turquoise, Jade, Opal, Garnet
7. RELIGIOUS MEDALS - Saint medals, Rosary beads, Crucifixes, Papal items
8. SIGNED VINTAGE - Trifari, Monet, Napier, Coro, Eisenberg, Weiss, Sarah Coventry
9. ART DECO (1920s-1930s) - Geometric patterns, Egyptian revival, Machine age aesthetics
10. ART NOUVEAU (1890s-1910s) - Flowing lines, natural motifs, enamel work

🏺 EXPERT DETECTION SIGNALS:

GOLD INDICATORS:
• Hallmarks: 375 (9k), 585 (14k), 750 (18k), 916 (22k), 999 (24k)
• "750", "18k", "14k", "585", "375" markings
• Weight and density (heavy for size)
• Specific color variations (rose gold, white gold tint)
• Vintage construction techniques

SILVER INDICATORS:
• Hallmarks: "925", "sterling", "800", "835", "coin"
• Patina patterns (rainbow tarnish, black silver sulfide)
• Weight (heavier than aluminum/steel)
• Cold touch test indicators in description
• Victorian/Georgian construction methods

PEARL INDICATORS:
• Natural luster vs. fake shine
• Baroque/irregular shapes (often more valuable)
• Nacre thickness visible in drill holes
• "Mother of pearl" components
• Antique stringing techniques

DIAMOND INDICATORS:
• Old mine cut (chunky, irregular facets)
• European cut (square, less brilliant)
• Rose cut (dome-shaped, flat bottom)
• Setting styles (bezel, claw, illusion settings)
• Diamond test results mentioned

PRECIOUS GEMSTONES:
• Ruby: Deep red, natural inclusions, heat treatment signs
• Sapphire: Cornflower blue, color zoning, asterism
• Emerald: Garden inclusions, oil treatment signs
• Natural vs. synthetic indicators

SEMI-PRECIOUS HIGHLIGHTS:
• Amber: Insect inclusions, electrostatic properties
• Coral: Mediterranean red, carved details
• Turquoise: Matrix patterns, American Southwest style
• Jade: Nephrite vs. jadeite, carved motifs

RELIGIOUS ITEMS:
• "Saint [name]" medal identification
• Latin inscriptions, papal imagery
• "Made in Vatican" or "Rome" markings
• Rosary bead materials and construction

SIGNED VINTAGE:
• Trifari: "Trifari" with crown logo
• Monet: "Monet" with block letters
• Napier: "Napier" with metal content marks
• Coro: "Coro" with registration numbers
• Eisenberg: "Eisenberg Original"
• Weiss: "Weiss" with signature style

ART PERIODS:
• Art Deco: Geometric patterns, stepped outlines, sunbursts
• Art Nouveau: Flowing lines, natural forms, enamel details
• Construction: Hand-fabricated vs. mass-produced methods

💰 LOT INTELLIGENCE:
If ONE valuable item exists in a mixed lot → ENTIRE LOT becomes profitable
Focus on finding the "needle in the haystack"

SELLER LANGUAGE CUES (boost confidence):
• "Don't know what this is"
• "Found in grandma's drawer"
• "Estate sale", "attic clearout"
• "Old jewelry box", "vintage lot"
• "Untested", "as is", "for parts"
• "Mixed lot", "bundle", "collection"

RED FLAGS (reduce confidence):
• "Plaqué", "doré", "gold tone", "gold filled"
• Modern mass-produced brands
• Perfect condition "old" items
• Obviously plastic components
• Recent manufacture indicators

📊 CONFIDENCE SCORING:
- 90-100%: Multiple clear indicators, professional expertise
- 80-89%: Strong evidence, minor uncertainties
- 70-79%: Good indicators, some risk factors
- 60-69%: Possible value, mixed signals
- Below 60%: Unlikely valuable, high risk

OUTPUT JSON ONLY - NO MARKDOWN:
{
  "listingUrl": "string",
  "isValuableLikely": boolean,
  "confidence": 0-100,
  "mainMaterialGuess": "gold|silver|pearls|diamonds|precious_gemstones|semi_precious_stones|religious_medals|signed_vintage|art_deco|art_nouveau|mixed|unknown",
  "reasons": ["string", "string", "string"]
}

Be aggressive in opportunity detection - you're looking for arbitrage, not perfect authentication.`;

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
          { type: "text", text: `${ENHANCED_ANTIQUe_DEALER_PROMPT}\n\nListing title: "${listingTitle}"\n\nDescription: "${listingDescription || ''}"` },
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
