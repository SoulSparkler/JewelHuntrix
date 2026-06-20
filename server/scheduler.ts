import * as cron from "node-cron";
import { runScan } from "./services/run-scan";

/**
 * In-process scheduler — ONLY for local development or a self-hosted always-on
 * deployment. In production (Netlify) scanning is driven by the Scheduled
 * Function in netlify/functions/scan.mts, so this stays OFF by default to avoid
 * double-scanning. Enable with ENABLE_INPROCESS_SCHEDULER=true.
 */
export function startScheduler() {
  if (process.env.ENABLE_INPROCESS_SCHEDULER !== "true") {
    console.log("⏸ In-process scheduler disabled (scanning handled by Netlify cron).");
    return;
  }

  const expr = process.env.SCAN_CRON || "0 */2 * * *";
  cron.schedule(expr, () => {
    // Light jitter so we don't fire on the exact tick.
    const jitter = Math.random() * 90_000;
    setTimeout(() => {
      runScan().catch((err) => console.error("🚨 Scheduler error:", err));
    }, jitter);
  });

  console.log(`📅 In-process scheduler started (cron: ${expr}).`);
}
