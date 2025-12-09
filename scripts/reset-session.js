#!/usr/bin/env node

/**
 * Vinted Session Reset Script
 * 
 * This script deletes the saved session file to allow for a fresh login.
 * Useful when session becomes corrupted or expired.
 * 
 * Usage:
 *   npm run vinted:reset
 *   node scripts/reset-session.js
 */

import { cookieManager } from '../server/utils/cookie-manager.js';
import fs from 'fs/promises';
import path from 'path';

const SESSION_FILE = process.env.VINTED_SESSION_FILE || './data/vinted-session.json';

async function resetSession() {
  console.log('🗑️  Vinted Session Reset\n');

  try {
    // Check if session file exists
    try {
      await fs.access(SESSION_FILE);
    } catch {
      console.log('ℹ️  No session file found - nothing to reset');
      return true;
    }

    // Get current session info before deletion
    const sessionInfo = await cookieManager.getSessionInfo();
    
    if (sessionInfo.hasSession) {
      console.log(`📁 Found session file: ${SESSION_FILE}`);
      console.log(`🍪 Cookies: ${sessionInfo.cookies}`);
      if (sessionInfo.age !== undefined) {
        console.log(`📅 Age: ${sessionInfo.age} days old`);
      }
      console.log('');
    }

    // Delete the session file
    await cookieManager.deleteSession();
    
    console.log('✅ Session successfully reset!');
    console.log('');
    console.log('📋 Next Steps:');
    console.log('  1. Run manual login: npm run vinted:login');
    console.log('  2. Log into your Vinted account in the browser');
    console.log('  3. Wait for cookies to be saved automatically');
    console.log('  4. Run the scraper with the new session');
    console.log('');
    console.log('💡 The scraper will work without authentication, but with limited access');

    return true;

  } catch (error) {
    console.error('💥 Error resetting session:', error.message);
    console.log('');
    console.log('💡 Manual cleanup:');
    console.log(`  Delete this file manually: ${SESSION_FILE}`);
    return false;
  }
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Session reset interrupted');
  process.exit(0);
});

resetSession().then(success => {
  process.exit(success ? 0 : 1);
}).catch(console.error);