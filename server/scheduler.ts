import * as cron from "node-cron";
import { storage } from "./storage";
import { scanSearchQuery } from "./services/scanner";

let isRunning = false;

// Smart anti-blocking configuration
const MIN_INTERVAL_MINUTES = parseInt(process.env.SCAN_MIN_INTERVAL_MINUTES || '70'); // 70 minutes
const MAX_INTERVAL_MINUTES = parseInt(process.env.SCAN_MAX_INTERVAL_MINUTES || '150'); // 150 minutes
const BASE_INTERVAL_HOURS = parseInt(process.env.SCAN_FREQUENCY_HOURS || '2'); // 2 hours base

function getRandomInterval(): number {
  // Return random interval between min and max minutes
  return Math.floor(Math.random() * (MAX_INTERVAL_MINUTES - MIN_INTERVAL_MINUTES)) + MIN_INTERVAL_MINUTES;
}

function getHumanLikeDelay(): number {
  // Add human-like behavior patterns
  const patterns = [
    2 * 60 * 1000,    // 2 minutes (brief pause)
    5 * 60 * 1000,    // 5 minutes (coffee break)
    15 * 60 * 1000,   // 15 minutes (lunch)
    45 * 60 * 1000,   // 45 minutes (extended break)
  ];
  
  // Weight shorter delays more heavily for realistic behavior
  const weightedPatterns = [...patterns, ...patterns.slice(0, 2)]; // Duplicate shorter delays
  return weightedPatterns[Math.floor(Math.random() * weightedPatterns.length)];
}

async function checkSessionHealth(): Promise<boolean> {
  try {
    // Check if we can still access Vinted (basic health check)
    const testUrl = "https://www.vinted.com";
    const response = await fetch(testUrl, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    const isHealthy = response.ok || response.status === 403; // 403 is expected for authenticated areas
    console.log(`🔍 Session health check: ${isHealthy ? 'Healthy' : 'Issues detected'}`);
    return isHealthy;
  } catch (error) {
    console.warn("⚠️ Session health check failed:", error.message);
    return false;
  }
}

async function runScheduledScans() {
  if (isRunning) {
    console.log("⏸ Scan already running, skipping new cycle.");
    return;
  }

  isRunning = true;
  console.log("\n🔍 Running scheduled scans...");

  try {
    // Pre-scan session health check
    const sessionHealthy = await checkSessionHealth();
    if (!sessionHealthy) {
      console.log("⚠️ Session health check failed, delaying scans by 30 minutes");
      await new Promise(resolve => setTimeout(resolve, 30 * 60 * 1000));
      return;
    }

    const searches = await storage.getSearchQueries();
    const activeSearches = searches.filter((s) => s.isActive);
    let processedSearches = 0;

    for (const search of activeSearches) {
      const now = new Date();
      const minutesSinceLastScan = search.lastScannedAt
        ? (now.getTime() - search.lastScannedAt.getTime()) / (1000 * 60)
        : Infinity;

      const requiredInterval = getRandomInterval(); // 70-150 minutes
      
      if (minutesSinceLastScan >= requiredInterval) {
        console.log(`🔎 Scanning: ${search.searchLabel} (last scanned ${Math.floor(minutesSinceLastScan)}m ago, interval: ${requiredInterval}m)`);
        
        try {
          await scanSearchQuery(search);
          processedSearches++;
          
          console.log(`✅ Completed: ${search.searchLabel}`);
          
          // Human-like delay between searches
          const humanDelay = getHumanLikeDelay();
          console.log(`⏳ Taking ${Math.floor(humanDelay / 60000)}m ${(humanDelay % 60000) / 1000}s break...`);
          await new Promise(resolve => setTimeout(resolve, humanDelay));
          
          // Memory management
          if (global.gc && processedSearches % 3 === 0) {
            global.gc();
            console.log("🧹 Memory cleanup performed");
          }
          
        } catch (scanError: any) {
          console.error(`❌ Error scanning ${search.searchLabel}:`, scanError.message);
          
          // If we hit a rate limit, extend the delay
          if (scanError.message.includes('429') || scanError.message.includes('Too Many Requests')) {
            console.log("🚫 Rate limit detected, extending delay by 30 minutes");
            await new Promise(resolve => setTimeout(resolve, 30 * 60 * 1000));
          }
        }
      } else {
        console.log(`⏭️ Skipping ${search.searchLabel} - scanned ${Math.floor(minutesSinceLastScan)}m ago (need ${requiredInterval}m interval)`);
      }
    }

    await storage.deleteExpiredFindings();
    
    const summary = processedSearches > 0 ? `Processed ${processedSearches} searches` : 'No searches processed';
    console.log(`✅ Scheduled scans complete - ${summary}\n`);
    
  } catch (error: any) {
    console.error("❌ Error in scheduled scans:", error.message);
  } finally {
    isRunning = false;
  }
}

export function startScheduler() {
  // Use a more sophisticated cron pattern that varies the execution time
  // This creates a random execution window that mimics human browsing patterns
  cron.schedule("*/20 * * * *", () => { // Every 20 minutes
    const jitter = Math.random() * 15 * 60 * 1000; // 0-15 minute random offset
    setTimeout(() => {
      runScheduledScans().catch((err) => {
        console.error("🚨 Scheduler error:", err);
      });
    }, jitter);
  });

  console.log(`📅 Enhanced Scheduler Started:`);
  console.log(`   • Random intervals: ${MIN_INTERVAL_MINUTES}-${MAX_INTERVAL_MINUTES} minutes`);
  console.log(`   • Human-like delays between searches`);
  console.log(`   • Session health monitoring`);
  console.log(`   • Anti-blocking strategies active`);
}
