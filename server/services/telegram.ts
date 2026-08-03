import { telegramRateLimiter } from "../utils/rate-limiter";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Whether alerts can be sent at all (both env vars present).
const botConfigured = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

/**
 * Minimal Telegram Bot API client. The app only ever calls sendMessage, so a
 * single fetch to the HTTP API replaces the node-telegram-bot-api dependency
 * (which pulled in the deprecated `request` stack and its critical CVEs).
 */
async function tgSendMessage(text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}

function formatMaterialDisplay(material: string): string {
  const materialMap: { [key: string]: string } = {
    'gold': '🥇 Gold',
    'silver': '🥈 Silver',
    'pearls': '🤍 Pearls',
    'diamonds': '💎 Diamonds',
    'precious_gemstones': '💠 Precious Gemstones',
    'semi_precious_stones': '🔮 Semi-Precious Stones',
    'religious_medals': '✝️ Religious Items',
    'signed_vintage': '🏷️ Signed Vintage',
    'art_deco': '🟫 Art Deco',
    'art_nouveau': '🌸 Art Nouveau',
    'mixed': '📦 Mixed Lot',
    'unknown': '❓ Unknown'
  };
  
  return materialMap[material] || material;
}

function getConfidenceEmoji(score: number): string {
  if (score >= 90) return '🔥';
  if (score >= 85) return '⭐';
  if (score >= 80) return '💫';
  return '🎯';
}

/**
 * Send a Telegram alert for high-confidence jewelry findings
 * Only sends alerts for confidence >= 75% and isValuableLikely === true
 * Includes rate limiting and deduplication
 */
export async function sendTelegramAlert(
  listingTitle: string,
  listingUrl: string,
  price: string,
  confidenceScore: number,
  mainMaterialGuess: string,
  reasons: string[],
  isValuableLikely: boolean
): Promise<boolean> {
  // Check core requirements before proceeding
  if (confidenceScore < 75 || !isValuableLikely) {
    console.log(`Skipping Telegram alert: confidence ${confidenceScore}%, isValuableLikely: ${isValuableLikely}`);
    return false;
  }

  if (!botConfigured) {
    console.warn("Telegram bot not configured - skipping alert");
    return false;
  }

  // Check rate limiting and deduplication
  if (!telegramRateLimiter.canSendAlert(listingUrl)) {
    return false;
  }

  try {
    // Enhanced message formatting with emojis and better structure
    const materialEmoji = formatMaterialDisplay(mainMaterialGuess);
    const confidenceEmoji = getConfidenceEmoji(confidenceScore);
    
    const message = `
${confidenceEmoji} *HIGH-VALUE FIND ALERT* ${confidenceEmoji}

*${listingTitle}*

💰 *Price:* ${price}
${materialEmoji} *Material:* ${mainMaterialGuess}
🎯 *Confidence:* ${confidenceScore}%

*🔍 Analysis Reasons:*
${reasons.map(reason => `   • ${reason}`).join('\n')}

*💡 Action:* [VIEW LISTING](${listingUrl})

---
*JewelHuntrix* | Powered by AI Treasure Detection
    `.trim();

    await tgSendMessage(message);

    // Record the alert for rate limiting
    telegramRateLimiter.recordAlert(listingUrl);
    
    console.log(`✅ Telegram alert sent for: ${listingTitle} (${confidenceScore}% confidence)`);
    console.log(`📊 Current hourly alert count: ${telegramRateLimiter.getCurrentAlertCount()}/10`);
    
    return true;
  } catch (error: any) {
    console.error("❌ Error sending Telegram alert:", error.message);
    return false;
  }
}

/**
 * Send a pre-formatted message (used by the new OpenRouter-driven pipeline).
 * Keeps the per-listing rate limiter / dedupe behaviour.
 */
export async function sendTelegramMessage(text: string, dedupeKey?: string): Promise<boolean> {
  if (!botConfigured) {
    console.warn("Telegram bot not configured - skipping message");
    return false;
  }
  if (dedupeKey && !telegramRateLimiter.canSendAlert(dedupeKey)) {
    return false;
  }
  try {
    await tgSendMessage(text);
    if (dedupeKey) telegramRateLimiter.recordAlert(dedupeKey);
    return true;
  } catch (error: any) {
    console.error("❌ Error sending Telegram message:", error.message);
    return false;
  }
}

/**
 * Operational alert: a scan failed. Bypasses the listing rate-limiter because
 * the owner must know when the system is broken (Problem 3 requirement).
 */
export async function sendScanFailureAlert(reason: string): Promise<void> {
  if (!botConfigured) return;
  try {
    await tgSendMessage(
      `⚠️ *JewelHuntrix scan mislukt*\n\nReden: ${reason}\nTijd: ${new Date().toLocaleString("nl-NL")}`,
    );
  } catch (error: any) {
    console.error("❌ Could not send failure alert:", error.message);
  }
}

/**
 * Daily heartbeat: confirms the scanner is alive.
 */
export async function sendHealthPing(lastSuccessAt: Date | null, listingsChecked: number): Promise<void> {
  if (!botConfigured) return;
  const last = lastSuccessAt ? lastSuccessAt.toLocaleString("nl-NL") : "nog geen";
  try {
    await tgSendMessage(
      `✅ *JewelHuntrix draait*\n\nLaatste succesvolle run: ${last}\nListings gecheckt (laatste run): ${listingsChecked}`,
    );
  } catch (error: any) {
    console.error("❌ Could not send health ping:", error.message);
  }
}

/**
 * Get current rate limiting status for monitoring
 */
export function getRateLimitStatus() {
  return {
    currentAlertsInLastHour: telegramRateLimiter.getCurrentAlertCount(),
    maxAlertsPerHour: 10,
    canSendAlert: (listingUrl: string) => telegramRateLimiter.canSendAlert(listingUrl)
  };
}
