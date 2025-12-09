#!/usr/bin/env node

/**
 * Database Migration Script
 * Generates and pushes Drizzle migrations to create all required tables
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

console.log("🚀 Starting database migration process...");

// Check if DATABASE_URL is set
if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL environment variable is not set!");
  console.error("Please set it in your .env file or environment");
  process.exit(1);
}

console.log("✅ DATABASE_URL found");

try {
  // Generate migrations from schema
  console.log("📋 Generating migrations from schema...");
  execSync('npx drizzle-kit generate', { 
    stdio: 'inherit',
    env: { ...process.env }
  });
  
  console.log("✅ Migrations generated successfully");

  // Check if migrations folder exists and has files
  const migrationsDir = './migrations';
  if (!fs.existsSync(migrationsDir)) {
    console.error("❌ Migrations directory not found!");
    process.exit(1);
  }
  
  const migrationFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));
  console.log(`📁 Found ${migrationFiles.length} migration files`);
  
  if (migrationFiles.length === 0) {
    console.warn("⚠️ No migration files found. Tables may already exist or schema hasn't changed.");
  } else {
    console.log("📝 Migration files:");
    migrationFiles.forEach(file => console.log(`   - ${file}`));
  }

  // Push migrations to database
  console.log("🚀 Pushing migrations to database...");
  execSync('npx drizzle-kit push', { 
    stdio: 'inherit',
    env: { ...process.env }
  });
  
  console.log("✅ Migrations pushed to database successfully!");

  // Test connection and show table info
  console.log("\n🔍 Testing database connection and table creation...");
  
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });
  
  try {
    const client = await pool.connect();
    
    // Check if tables exist
    const tables = ['search_queries', 'manual_scans', 'findings', 'analyzed_listings'];
    
    for (const table of tables) {
      const result = await client.query(`SELECT COUNT(*) FROM ${table}`);
      console.log(`✅ Table '${table}': ${result.rows[0].count} records`);
    }
    
    client.release();
    console.log("\n🎉 Database setup complete! All tables created and accessible.");
    
  } catch (dbError) {
    console.error("❌ Database test failed:", dbError.message);
    console.error("Please check your DATABASE_URL and ensure the database is accessible");
  } finally {
    await pool.end();
  }

} catch (error) {
  console.error("❌ Migration failed:", error.message);
  console.error("Stack trace:", error.stack);
  process.exit(1);
}

console.log("\n✨ Migration process completed!");