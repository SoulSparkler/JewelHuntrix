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

// Zod validation schema for AI responses
const AnalysisResponseSchema = z.object({
  isValuable: z.boolean(),
  confidence: z.number().min(0).max(100),
  detectedMaterials: z.array(z.string()),
  reasons: z.array(z.string()),
  lotType: z.enum(['single', 'vintage_lot', 'estate', 'mixed']).default('single')
});

interface AnalysisResult {
  isValuable: boolean;
  confidence: number;
  detectedMaterials: string[];
  reasons: string[];
  lotType: 'single' | 'vintage_lot' | 'estate' | 'mixed';
}

const ANALYSIS_PROMPT = `You are an expert jewelry appraiser analyzing Vinted listings for hidden valuable items.

ANALYZE the images and text for ALL types of valuable materials:

=== GOLD DETECTION ===
Hallmarks: 10K, 14K, 18K, 22K, 24K, 417, 585, 750, 916, 999
Keywords: solid gold, real gold, genuine gold, oro
Visual: Rich yellow/rose color, weight appearance, quality wear patterns

=== SILVER DETECTION ===
Hallmarks: 925, Sterling, 900, 800, 835
Keywords: solid silver, sterling silver, argent
Visual: Bright metallic luster, natural tarnish patterns

=== PEARL DETECTION ===
Types: Natural, Akoya, South Sea, Tahitian, Freshwater
Visual: Natural luster/orient, irregular surface texture, drill hole quality
Keywords: real pearls, cultured pearls, genuine pearls

=== DIAMOND & GEMSTONE DETECTION ===
Visual: Clarity, cut quality, color depth, light refraction
Settings: Quality prong work, bezel settings, pave
Keywords: diamond, ruby, sapphire, emerald, amethyst

=== ANTIQUE RELIGIOUS MEDALS ===
Materials: Gold, silver, bronze
Indicators: Age patina, detailed craftsmanship, religious iconography
Keywords: antique medal, religious medal, saint medal, miraculous medal

=== SIGNED VINTAGE DESIGNER ===
Brands: Trifari, Monet, Napier, Coro, Sarah Coventry, Miriam Haskell
Indicators: Signature stamps, quality construction, original boxes
Keywords: signed, designer, vintage, marked

=== VINTAGE LOT DETECTION ===
CRITICAL: Look for hidden gems in mixed lots!
Keywords: estate lot, vintage jewelry lot, old jewelry box, grandma jewelry, bulk jewelry, unsorted
Strategy: Even ONE valuable piece among costume jewelry = valuable lot
Look for: Individual hallmarked pieces, real pearls, quality stones hidden in pile
Visual: Mixed quality items, some with hallmarks, real gems among costume pieces

=== RED FLAGS - Lower Confidence ===
Keywords: doré, gold tone, gold plated, plaqué, vermeil, fantaisie, costume
Visual: Green discoloration, peeling, lightweight, mass-produced appearance

OUTPUT ONLY valid JSON:
{
  "isValuable": boolean,
  "confidence": number 0-100,
  "detectedMaterials": string[],
  "reasons": string[],
  "lotType": "single" | "vintage_lot" | "estate" | "mixed"
}

NO extra text. NO markdown. NO comments.`;

// Parse AI response with validation
function parseAIResponse(content: string): AnalysisResult {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    
    const parsed = JSON.parse(jsonMatch[0]);
    const validated = AnalysisResponseSchema.parse(parsed);
    
    return {
      isValuable: validated.isValuable,
      confidence: validated.confidence,
      detectedMaterials: validated.detectedMaterials,
      reasons: validated.reasons,
      lotType: validated.lotType
    };
  } catch (error: any) {
    console.warn('AI response validation failed:', error.message);
    return {
      isValuable: false,
      confidence: 0,
      detectedMaterials: [],
      reasons: ['Analysis failed: ' + error.message],
      lotType: 'single'
    };
  }
}

export async function analyzeJewelryImages(
  imageUrls: string[],
  listingTitle: string,
  listingDescription?: string
): Promise<AnalysisResult> {
  if (!openai) {
    return {
      isValuable: false,
      confidence: 0,
      detectedMaterials: [],
      reasons: ["Image analysis is disabled because OPENAI_API_KEY is not configured."],
      lotType: 'single'
    };
  }

  console.log(`Analyzing ${imageUrls.length} images with OpenAI Vision`);

  if (imageUrls.length === 0) {
    return {
      isValuable: false,
      confidence: 0,
      detectedMaterials: [],
      reasons: ["No images available for analysis"],
      lotType: 'single'
    };
  }

  try {
    const messages: any[] = [
      {
        role: "user",
        content: [
          { type: "text", text: `${ANALYSIS_PROMPT}\n\nListing title: "${listingTitle}"\n\nDescription: "${listingDescription || ''}"` },
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

    return parseAIResponse(content);
  } catch (error: any) {
    console.error("Error analyzing with OpenAI:", error.message);
    return {
      isValuable: false,
      confidence: 0,
      detectedMaterials: [],
      reasons: [`Analysis failed: ${error.message}`],
      lotType: 'single'
    };
  }
}
