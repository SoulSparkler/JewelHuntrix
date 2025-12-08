import * as cron from "node-cron";
import { storage } from "./storage";
import { scanSearchQuery } from "./services/scanner";

let isRunning = false;

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
  if (isRunning) {
    console.log("⏸ Scan already running, skipping new cycle.");
    return;
  }

  isRunning = true;
  console.log("\n🔍 Running scheduled scans...");

  try {
    const searches = await storage.getSearchQueries();
    const activeSearches = searches.filter((s) => s.isActive);

    for (const search of activeSearches) {
      const now = new Date();
      const hoursSinceLastScan = search.lastScannedAt
        ? (now.getTime() - search.lastScannedAt.getTime()) / (1000 * 60 * 60)
        : Infinity;

      if (hoursSinceLastScan >= search.scanFrequencyHours) {
        console.log(`Scanning: ${search.searchLabel}`);
        await scanSearchQuery(search);

        console.log("Memory usage (MB):", Math.round(process.memoryUsage().heapUsed / 1024 / 1024));
        
        // Random delay 30-90 seconds between scans for human-like behavior
        const betweenDelay = 30000 + Math.random() * 60000;
        await new Promise((res) => setTimeout(res, betweenDelay));
        
        if (global.gc) global.gc();
      } else {
        console.log(`Skipping ${search.searchLabel} - scanned ${Math.floor(hoursSinceLastScan)}h ago`);
      }
    }

    await storage.deleteExpiredFindings();
    console.log("✅ Scheduled scans complete\n");
  } catch (error: any) {
    console.error("Error in scheduled scans:", error);
  } finally {
    isRunning = false;
  }
}

export function startScheduler() {
  // Run every hour, but with randomized actual execution
  cron.schedule("0 * * * *", () => {
    const randomDelay = Math.random() * 30 * 60 * 1000; // 0-30 min random offset
    setTimeout(() => {
      runScheduledScans().catch((err) => {
        console.error("Scheduler error:", err);
      });
    }, randomDelay);
  });

  console.log(`📅 Scheduler started - randomized ${MIN_INTERVAL_HOURS}-${MAX_INTERVAL_HOURS}h intervals`);
}
