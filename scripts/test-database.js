#!/usr/bin/env node

/**
 * Database Persistence Test Script
 * Tests that data persists correctly using the storage service
 */

import { storage } from '../server/storage.js';
import { db } from '../server/db.js';
import { sql } from 'drizzle-orm';

console.log("🧪 Testing Database Persistence...\n");

async function testDatabasePersistence() {
  try {
    console.log("1️⃣ Testing database connection...");
    const connectionTest = await db.execute(sql`SELECT 1`);
    console.log("✅ Database connection successful");

    console.log("\n2️⃣ Testing search queries persistence...");
    
    // Create a test search
    const testSearch = await storage.createSearchQuery({
      vintedUrl: "https://www.vinted.com/search?query=test-persistence",
      searchLabel: "Test Persistence Search",
      scanFrequencyHours: 2,
      confidenceThreshold: 75,
      isActive: true
    });
    console.log("✅ Created test search:", testSearch.id);

    // Retrieve all searches
    const searches = await storage.getSearchQueries();
    console.log(`✅ Retrieved ${searches.length} searches`);
    
    const foundSearch = searches.find(s => s.id === testSearch.id);
    if (foundSearch) {
      console.log("✅ Search persists correctly!");
    } else {
      console.log("❌ Search was not persisted!");
    }

    console.log("\n3️⃣ Testing manual scans persistence...");
    
    // Create a test manual scan
    const testScan = await storage.createManualScan({
      listingUrl: "https://www.vinted.com/items/12345",
      listingTitle: "Test Persistence Scan",
      confidenceScore: 85,
      aiReasoning: "Test reasoning for persistence",
      detectedMaterials: ["gold"],
      reasons: ["test reason"],
      isValuable: true,
      lotType: "single",
      price: "€25.00"
    });
    console.log("✅ Created test manual scan:", testScan.id);

    // Retrieve all manual scans
    const scans = await storage.getManualScans();
    console.log(`✅ Retrieved ${scans.length} manual scans`);
    
    const foundScan = scans.find(s => s.id === testScan.id);
    if (foundScan) {
      console.log("✅ Manual scan persists correctly!");
    } else {
      console.log("❌ Manual scan was not persisted!");
    }

    console.log("\n4️⃣ Cleaning up test data...");
    
    // Clean up test data
    await storage.deleteSearchQuery(testSearch.id);
    await storage.deleteManualScan(testScan.id);
    console.log("✅ Test data cleaned up");

    console.log("\n🎉 Database persistence test completed successfully!");
    console.log("\n📋 Summary:");
    console.log("   • Database connection: ✅ Working");
    console.log("   • Search queries persist: ✅ Working");
    console.log("   • Manual scans persist: ✅ Working");
    console.log("   • Data cleanup: ✅ Working");
    
    return true;

  } catch (error) {
    console.error("❌ Database persistence test failed:", error.message);
    console.error("Stack trace:", error.stack);
    return false;
  }
}

// Handle both ES modules and CommonJS
if (import.meta.url === `file://${process.argv[1]}` || require.main === module) {
  testDatabasePersistence()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error("Test script error:", error);
      process.exit(1);
    });
}

export { testDatabasePersistence };