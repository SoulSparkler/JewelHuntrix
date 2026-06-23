import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
const { Pool } = pkg;
import * as schema from '../shared/schema';

/**
 * Sanitize the DATABASE_URL coming from the environment.
 *
 * Production "Invalid URL" crashes are almost always caused by the value being
 * pasted into the host's env settings with surrounding quotes or a stray
 * trailing newline/space. We strip those defensively so a cosmetically-wrong
 * env var still connects.
 */
function cleanConnectionString(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim();
  // Strip a single pair of surrounding quotes if present.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s || undefined;
}

const connectionString = cleanConnectionString(process.env.DATABASE_URL);

if (!connectionString) {
  console.error('❌ DATABASE_URL is not set (or empty after sanitizing)!');
} else {
  // Fail loudly & early on an unparseable string instead of a vague runtime
  // "Invalid URL" deep inside the first query.
  try {
    // eslint-disable-next-line no-new
    new URL(connectionString);
  } catch (e: any) {
    console.error(`❌ DATABASE_URL is not a valid URL (len=${connectionString.length}, starts="${connectionString.slice(0, 12)}"): ${e.message}`);
  }
}

// Enable SSL for any non-local host (Supabase pooler / Neon require it). We
// don't verify the cert because managed providers use their own CA chain.
function needsSsl(conn: string | undefined): boolean {
  if (!conn) return false;
  if (conn.includes('sslmode=require')) return true;
  try {
    const host = new URL(conn).hostname;
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
  } catch {
    return false;
  }
}

// PostgreSQL connection pool
const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
});

// Handle pool errors
pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

export const db = drizzle(pool, { schema });

// Export pool for direct queries if needed
export { pool };

// Test database connection
export async function testConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('✅ PostgreSQL connection successful');
    return true;
  } catch (error) {
    console.error('❌ PostgreSQL connection failed:', error);
    return false;
  }
}