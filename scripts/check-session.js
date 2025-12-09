#!/usr/bin/env node

/**
 * Vinted Session Status Checker
 * 
 * This script checks the status of the Vinted session and provides information
 * about cookie validity, age, and authentication state.
 * 
 * Usage:
 *   npm run vinted:status
 *   node scripts/check-session.js
 */

import { cookieManager } from '../server/utils/cookie-manager.js';

async function checkSessionStatus() {
  console.log('🔍 Checking Vinted Session Status...\n');

  try {
    const sessionInfo = await cookieManager.getSessionInfo();
    
    if (!sessionInfo.hasSession) {
      console.log('❌ No valid session found');
      console.log('');
      console.log('💡 Solutions:');
      console.log('  1. Run manual login: npm run vinted:login');
      console.log('  2. Set VINTED_SESSION_COOKIE environment variable');
      console.log('  3. Check if session file exists and is valid');
      return false;
    }

    console.log('✅ Session Status: ACTIVE');
    console.log(`📁 Source: ${sessionInfo.source}`);
    console.log(`🍪 Cookies: ${sessionInfo.cookies} loaded`);
    
    if (sessionInfo.age !== undefined) {
      console.log(`📅 Age: ${sessionInfo.age} days old`);
      
      if (sessionInfo.age > 30) {
        console.log('⚠️  Warning: Session is older than 30 days, may need refresh');
      } else if (sessionInfo.age > 7) {
        console.log('🟡 Notice: Session is older than 7 days');
      } else {
        console.log('🟢 Fresh session (less than 7 days old)');
      }
    }

    // Test session validity by checking if cookies can be loaded
    const hasValidSession = await cookieManager.hasValidSession();
    if (hasValidSession) {
      console.log('🔐 Authentication: VALID');
      console.log('🎉 Ready for authenticated scraping!');
    } else {
      console.log('❌ Authentication: INVALID');
      console.log('💡 Session may be expired or corrupted');
    }

    console.log('');
    console.log('📋 Next Steps:');
    if (hasValidSession) {
      console.log('  ✅ You can now run the scraper with full authentication');
      console.log('  🔄 The saved session will be automatically used');
    } else {
      console.log('  🔐 Run manual login: npm run vinted:login');
      console.log('  🗑️  Or reset session: npm run vinted:reset');
    }

    return hasValidSession;

  } catch (error) {
    console.error('💥 Error checking session:', error.message);
    console.log('');
    console.log('💡 Troubleshooting:');
    console.log('  - Check if VINTED_SESSION_FILE path is correct');
    console.log('  - Ensure the session file is valid JSON');
    console.log('  - Try running manual login again');
    return false;
  }
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Session check interrupted');
  process.exit(0);
});

checkSessionStatus().then(success => {
  process.exit(success ? 0 : 1);
}).catch(console.error);