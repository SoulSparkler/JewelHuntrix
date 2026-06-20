# Database Setup Guide for JewelHuntrix

## 🎯 Overview

This guide helps you set up the PostgreSQL database for JewelHuntrix to fix the persistent data loss issue.

## 🚀 Quick Setup Options

### Option 1: Supabase (Recommended)

1. **Create Supabase Project**
   - Go to [supabase.com](https://supabase.com)
   - Create a new project
   - Note your project reference ID and password

2. **Get Connection String**
   ```
   postgresql://postgres:<YOUR_PASSWORD>@<YOUR_PROJECT_REF>.pooler.supabase.com:6543/postgres?sslmode=require
   ```

3. **Update .env file**
   ```bash
   DATABASE_URL=postgresql://postgres:your_password@your_project_ref.pooler.supabase.com:6543/postgres?sslmode=require
   ```

4. **Run Migration**
   ```bash
   npm run db:push
   ```

### Option 2: Railway

1. **Create Railway Project**
   - Go to [railway.app](https://railway.app)
   - Create new PostgreSQL service
   - Copy connection string

2. **Update .env file**
   ```bash
   DATABASE_URL=postgresql://username:password@host:port/database
   ```

### Option 3: Local PostgreSQL

1. **Install PostgreSQL locally**
   ```bash
   # macOS
   brew install postgresql
   brew services start postgresql
   
   # Ubuntu/Debian
   sudo apt install postgresql postgresql-contrib
   sudo systemctl start postgresql
   ```

2. **Create database**
   ```bash
   createdb jewelhuntrix
   ```

3. **Update .env file**
   ```bash
   DATABASE_URL=postgresql://postgres:password@localhost:5432/jewelhuntrix
   ```

### Option 4: Neon (Free PostgreSQL)

1. **Create Neon Account**
   - Go to [neon.tech](https://neon.tech)
   - Create new project
   - Copy connection string

2. **Update .env file**
   ```bash
   DATABASE_URL=postgresql://username:password@ep-example.us-east-1.aws.neon.tech/neondb?sslmode=require
   ```

## 🔧 Testing Database Connection

After setting up your DATABASE_URL, test the connection:

### 1. Start the server
```bash
npm run dev
```

### 2. Check database health
Visit: `http://localhost:5000/api/db-health`

You should see:
```json
{
  "status": "ok",
  "connection": true,
  "tables": {
    "searchQueries": 0,
    "manualScans": 0,
    "findings": 0
  },
  "operations": {
    "insertSelectDelete": "success"
  }
}
```

### 3. Test data persistence

**Create a search:**
- Go to Search Queries page
- Add a new search
- Refresh the page
- The search should still be there ✅

**Create a manual scan:**
- Go to Manual Scan page
- Analyze a Vinted listing
- Go to Manual Scans page
- The scan should be there ✅

## 🐛 Troubleshooting

### "Connection refused" or "ENOTFOUND"
- Check your DATABASE_URL format
- Ensure database is running
- Verify network connectivity

### "relation does not exist"
- Run migrations: `npm run db:push`
- Check that tables were created

### "password authentication failed"
- Check username/password in DATABASE_URL
- Ensure database allows password authentication

### No data persists after restart
- Verify DATABASE_URL is set in .env
- Check server logs for database connection errors
- Test /api/db-health endpoint

## 📊 Database Schema

The system creates 4 main tables:

1. **search_queries** - Saved Vinted search configurations
2. **manual_scans** - Individual listing analysis results
3. **findings** - High-confidence valuable items found
4. **analyzed_listings** - Cache of all analyzed listings

## 🔄 Migration Process

If you need to regenerate migrations:

```bash
# Generate new migrations from schema
npx drizzle-kit generate

# Push migrations to database
npm run db:push
```

## 🛡️ Security Notes

- Never commit .env file to version control
- Use environment variables in production
- Enable SSL for remote databases
- Rotate passwords regularly

## ✅ Success Checklist

- [ ] DATABASE_URL set in .env file
- [ ] Database connection successful
- [ ] Tables created (4 tables)
- [ ] Server starts without database errors
- [ ] /api/db-health returns success
- [ ] Searches persist after page refresh
- [ ] Manual scans persist after page refresh

Once all items are checked, your data persistence issue should be resolved! 🎉