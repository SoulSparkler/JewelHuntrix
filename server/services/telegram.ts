import TelegramBot from "node-telegram-bot-api";
import { telegramRateLimiter } from "../utils/rate-limiter";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let bot: TelegramBot | null = null;

if (TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
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

  if (!bot || !TELEGRAM_CHAT_ID) {
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

*💡 Action:* [VIEW LISTING](${listingUrl}

---
*JewelHuntrix* | Powered by AI Treasure Detection
    `.trim();

    await bot.sendMessage(TELEGRAM_CHAT_ID, message, {
      parse_mode: "Markdown",
      disable_web_page_preview: false,
    });

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
 * Get current rate limiting status for monitoring
 */
export function getRateLimitStatus() {
  return {
    currentAlertsInLastHour: telegramRateLimiter.getCurrentAlertCount(),
    maxAlertsPerHour: 10,
    canSendAlert: (listingUrl: string) => telegramRateLimiter.canSendAlert(listingUrl)
  };
}
