# JewelHuntrix - Implementation Plan (Updated)

## Overview

This document outlines the implementation plan for JewelHuntrix, a Vinted scanning bot that detects **undervalued valuable jewelry** including:

- **Gold** (10k, 14k, 18k, 22k, 24k)
- **Silver** (925, sterling, 900, 800)
- **Pearls** (natural, cultured)
- **Diamonds & Gemstones**
- **Antique Religious Medals**
- **Signed Vintage Designer Jewelry**
- **Hidden Gems in Vintage/Estate Lots**

## Architecture

```mermaid
flowchart TB
    subgraph Frontend
        UI[React Dashboard]
        MS[Manual Scan Page]
        FP[Findings Page]
    end
    
    subgraph Backend
        API[Express API]
        SCH[Scheduler 1-3h + Random]
        SCAN[Scanner Service]
    end
    
    subgraph Services
        SCRAPE[Puppeteer + Auth]
        AI[OpenAI Analyzer]
        TG[Telegram Alerts]
    end
    
    subgraph Database
        PG[(PostgreSQL)]
    end
    
    UI --> API
    MS --> API
    FP --> API
    
    SCH --> SCAN
    API --> SCAN
    
    SCAN --> SCRAPE
    SCAN --> AI
    SCAN --> TG
    
    API --> PG
    SCAN --> PG
```

## Tech Stack Decisions

| Component | Choice | Reason |
|-----------|--------|--------|
| Database | PostgreSQL + Drizzle ORM | Persistent storage, existing schema |
| Scraping | Puppeteer + Auth Session | Handles JS-rendered content, authenticated access |
| Confidence | 0-100% integer | More intuitive for decision-making |
| AI | OpenAI GPT-4o-mini | Vision + text analysis |
| Scheduler | 1-3h + Random Delay | Avoid Vinted blocking, human-like behavior |

---

## Phase 1: Database - PostgreSQL Integration

### 1.1 Schema Updates

Update [`shared/schema.ts`](../shared/schema.ts) to add:

```typescript
// Update findings table - broader scope
isValuable: boolean("is_valuable").notNull().default(false),
reasons: jsonb("reasons").notNull().$type<string[]>(),
lotType: text("lot_type").notNull().default("single"), // single, vintage_lot, estate, mixed

// Update manual_scans table  
isValuable: boolean("is_valuable").notNull().default(false),
reasons: jsonb("reasons").notNull().$type<string[]>(),
lotType: text("lot_type").notNull().default("single"),
```

### 1.2 PostgreSQL Storage Implementation

Create [`server/db.ts`](../server/db.ts):

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@shared/schema';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });
```

### 1.3 Replace MemStorage with PostgreSQL

Update [`server/storage.ts`](../server/storage.ts) to use Drizzle queries instead of in-memory Maps.

---

## Phase 2: Puppeteer Scraper with Auth Support

### 2.1 New Scraper Implementation

Replace axios/cheerio with Puppeteer in [`server/services/vinted-scraper.ts`](../server/services/vinted-scraper.ts):

```typescript
import puppeteer from 'puppeteer';

// Environment variables for auth
const VINTED_SESSION_COOKIE = process.env.VINTED_SESSION_COOKIE;
const VINTED_AUTH_TOKEN = process.env.VINTED_AUTH_TOKEN;

export async function scrapeVintedListing(url: string): Promise<VintedListing | null> {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    
    // Set auth cookies if available
    if (VINTED_SESSION_COOKIE) {
      await page.setCookie({
        name: '_vinted_fr_session',
        value: VINTED_SESSION_COOKIE,
        domain: '.vinted.nl'
      });
    }
    
    // Block unnecessary resources
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });
    
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    
    // Extract data including description
    const data = await page.evaluate(() => {
      return {
        title: document.querySelector('h1')?.textContent?.trim() || '',
        price: document.querySelector('.price')?.textContent?.trim() || '',
        description: document.querySelector('.item-description')?.textContent?.trim() || '',
        imageUrls: Array.from(document.querySelectorAll('img[src*="vinted"]'))
          .map(img => img.getAttribute('src'))
          .filter(Boolean)
      };
    });
    
    return data;
  } finally {
    await browser.close();
  }
}
```

### 2.2 Retry Logic with Exponential Backoff

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Max retries exceeded');
}
```

---

## Phase 3: AI Analyzer - Expanded Detection

### 3.1 Comprehensive Detection Prompt

Update [`server/services/openai-analyzer.ts`](../server/services/openai-analyzer.ts):

```typescript
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
```

### 3.2 JSON Validation with Zod

```typescript
import { z } from 'zod';

const AnalysisResponseSchema = z.object({
  isValuable: z.boolean(),
  confidence: z.number().min(0).max(100),
  detectedMaterials: z.array(z.string()),
  reasons: z.array(z.string()),
  lotType: z.enum(['single', 'vintage_lot', 'estate', 'mixed']).default('single')
});

function parseAIResponse(content: string): AnalysisResult {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    
    const parsed = JSON.parse(jsonMatch[0]);
    return AnalysisResponseSchema.parse(parsed);
  } catch (error) {
    return {
      isValuable: false,
      confidence: 0,
      detectedMaterials: [],
      reasons: ['Analysis failed: ' + error.message],
      lotType: 'single'
    };
  }
}
```

---

## Phase 4: API Response Standardization

### 4.1 Manual Scan Response

Update [`server/routes.ts`](../server/routes.ts) `/api/analyze-listing`:

```typescript
app.post("/api/analyze-listing", async (req, res) => {
  // Add cache-busting headers
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  
  try {
    const { url } = req.body;
    
    // Validate URL
    if (!url || !url.includes('vinted')) {
      return res.status(400).json({ 
        error: 'Invalid Vinted URL',
        isValuable: false,
        confidence: 0,
        detectedMaterials: [],
        reasons: ['Invalid URL provided'],
        lotType: 'single'
      });
    }
    
    const listing = await scrapeVintedListing(url);
    const analysis = await analyzeJewelryImages(
      listing.imageUrls, 
      listing.title,
      listing.description
    );
    
    // Always return complete response
    res.json({
      listingUrl: url,
      listingTitle: listing.title,
      price: listing.price,
      isValuable: analysis.isValuable,
      confidence: analysis.confidence,
      detectedMaterials: analysis.detectedMaterials || [],
      reasons: analysis.reasons || [],
      lotType: analysis.lotType || 'single'
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      isValuable: false,
      confidence: 0,
      detectedMaterials: [],
      reasons: ['Analysis failed: ' + error.message],
      lotType: 'single'
    });
  }
});
```

---

## Phase 5: Scheduler - Randomized Intervals

### 5.1 Human-Like Scheduling

Update [`server/scheduler.ts`](../server/scheduler.ts):

```typescript
import * as cron from "node-cron";

// Configurable interval (1-3 hours)
const MIN_INTERVAL_HOURS = parseInt(process.env.SCAN_MIN_INTERVAL_HOURS || '1');
const MAX_INTERVAL_HOURS = parseInt(process.env.SCAN_MAX_INTERVAL_HOURS || '3');

function getRandomDelay(): number {
  // Random delay between min and max hours (in milliseconds)
  const minMs = MIN_INTERVAL_HOURS * 60 * 60 * 1000;
  const maxMs = MAX_INTERVAL_HOURS * 60 * 60 * 1000;
  return Math.floor(Math.random() * (maxMs - minMs)) + minMs;
}

async function runScheduledScans() {
  // ... existing scan logic
  
  // Add random delay between individual scans
  for (const search of activeSearches) {
    await scanSearchQuery(search);
    
    // Random delay 30-90 seconds between scans
    const betweenDelay = 30000 + Math.random() * 60000;
    await new Promise(r => setTimeout(r, betweenDelay));
  }
}

// Run every hour, but with randomized actual execution
cron.schedule("0 * * * *", () => {
  const randomDelay = Math.random() * 30 * 60 * 1000; // 0-30 min random offset
  setTimeout(() => runScheduledScans(), randomDelay);
});
```

### 5.2 Confidence Threshold

Only create findings when `confidence >= 70`:

```typescript
if (analysis.confidence >= searchQuery.confidenceThreshold) {
  await storage.createFinding({
    // ...
    isValuable: analysis.isValuable,
    detectedMaterials: analysis.detectedMaterials,
    reasons: analysis.reasons,
    lotType: analysis.lotType
  });
}
```

---

## Phase 6: Frontend Updates

### 6.1 ScanResultCard Updates

Update [`client/src/components/ScanResultCard.tsx`](../client/src/components/ScanResultCard.tsx):

```tsx
// Display isValuable (broader than just gold)
<div className="flex items-center gap-2">
  <span>Likely Valuable:</span>
  <span className={finding.isValuable ? "text-green-500 font-bold" : "text-red-500"}>
    {finding.isValuable ? "Yes" : "No"}
  </span>
</div>

// Display detected materials as badges
<div className="flex gap-2 flex-wrap mt-2">
  {finding.detectedMaterials?.map((material, i) => (
    <span key={i} className="bg-amber-600 px-2 py-1 rounded text-xs">
      {material}
    </span>
  ))}
</div>

// Display reasons as list
<div className="mt-2">
  <p className="font-medium text-sm">AI Reasoning:</p>
  <ul className="list-disc list-inside text-sm text-gray-300">
    {finding.reasons?.map((reason, i) => (
      <li key={i}>{reason}</li>
    )) || <li>No reasons provided</li>}
  </ul>
</div>

// Display lot type badge for vintage/estate
{finding.lotType && finding.lotType !== 'single' && (
  <span className="bg-purple-600 px-2 py-1 rounded text-xs uppercase">
    {finding.lotType.replace('_', ' ')}
  </span>
)}
```

---

## Phase 7: Testing Checklist

### Manual Scan Tests
- [ ] Single gold item URL
- [ ] Single silver item URL
- [ ] Pearl necklace URL
- [ ] Vintage lot URL
- [ ] Estate sale URL
- [ ] Mixed costume + real jewelry lot
- [ ] Invalid URL handling
- [ ] Network error handling

### Scheduler Tests
- [ ] Multiple active searches
- [ ] Frequency tracking (1-3 hours)
- [ ] Random delay verification
- [ ] Threshold filtering
- [ ] Memory management

### Frontend Tests
- [ ] All fields display correctly
- [ ] Null/undefined handling
- [ ] Error states
- [ ] Loading states
- [ ] Lot type badges

---

## Environment Variables

Add to `.env`:

```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/jewelhuntrix

# OpenAI
OPENAI_API_KEY=sk-...

# Vinted Auth (optional - for authenticated scraping)
VINTED_SESSION_COOKIE=your_session_cookie
VINTED_AUTH_TOKEN=your_auth_token

# Scheduler
SCAN_MIN_INTERVAL_HOURS=1
SCAN_MAX_INTERVAL_HOURS=3

# Telegram (optional)
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

---

## Current Issues to Fix

| Issue | Root Cause | Solution |
|-------|------------|----------|
| Manual scan inconsistent | Axios fails on JS-rendered pages | Switch to Puppeteer |
| 304 cached responses | No cache headers | Add Cache-Control headers |
| Frontend crashes | Missing fields in response | Always return complete JSON |
| Wrong JSON shape | AI returns markdown | Strict prompt + validation |
| Only gold detection | Limited scope | Expand to all valuables |
| Vinted blocking | Too frequent scans | Randomized 1-3h intervals |

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `shared/schema.ts` | Modify | Add isValuable, reasons, lotType fields |
| `server/db.ts` | Create | PostgreSQL connection |
| `server/storage.ts` | Modify | Use Drizzle instead of MemStorage |
| `server/services/vinted-scraper.ts` | Rewrite | Puppeteer + auth support |
| `server/services/openai-analyzer.ts` | Modify | Expanded detection prompt |
| `server/routes.ts` | Modify | Cache headers + response format |
| `server/scheduler.ts` | Modify | Randomized 1-3h intervals |
| `client/src/components/ScanResultCard.tsx` | Modify | Display new fields |
| `package.json` | Modify | Add puppeteer dependency |
| `.env.example` | Create | Document env variables |

---

## Next Steps

1. ✅ Plan reviewed and approved
2. Switch to **Code mode** to implement the changes
3. Test each phase before moving to the next
4. Deploy and monitor for issues
