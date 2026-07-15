// One-off: verify Telegram credentials by sending a test alert through the
// app's own send path. Run: npx tsx scripts/tg-test.mts
import "dotenv/config";
import { sendTelegramMessage } from "../server/services/telegram";

const ok = await sendTelegramMessage(
  "✅ JewelHuntrix testbericht — de alerts werken! Vanaf nu krijg je hier meldingen zodra de scanner een kansrijke Vinted-vondst spot (score ≥ 7/10).",
  "https://treasurehuntrix.netlify.app",
);
console.log("telegram send:", ok ? "SUCCESS" : "FAILED");
process.exit(ok ? 0 : 1);
