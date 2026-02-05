# CallRail → Google Ads Conversion Sync

**Bypasses CallRail's broken native integration** by syncing call conversions through Google Sheets.

## How It Works

```
CallRail API → Netlify Function → Google Sheets → Google Ads
                                      ↓
                              Phoenix Command UI
                             (view/edit values)
```

1. **Netlify function** pulls calls with GCLIDs from CallRail
2. **Calculates tiered values** based on lead score:
   - Very Good (Converted): 100% of product price
   - Good (Hot Lead): 75%
   - Fair (Good Lead): 50%
   - Poor (OK Lead): 25%
   - Very Poor (Not Good): $0
3. **Writes to Google Sheets** in Google Ads import format
4. **Google Ads Script** (runs hourly) imports from the Sheet

## Quick Setup

### 1. Create Google Sheet

Create a new Google Sheet with these headers in Row 1:
```
GCLID | Conversion Time | Value | Currency | Call ID | Phone | Lead Score | Tier | Product | Campaign | Synced At | Imported
```

Copy the Sheet ID from the URL (between `/d/` and `/edit`).

### 2. Get Google Refresh Token

```bash
cd callrail-gads-bypass
npm install
npm install open
node scripts/get-google-token.js
```

Follow the browser prompt. Copy the refresh token.

### 3. Deploy to Netlify

1. Push to GitHub or drag folder to Netlify
2. Add environment variables in Netlify:
   - `CALLRAIL_API_KEY`: 7de6f836a1feee75ce41493f8e9b64af
   - `CALLRAIL_ACCOUNT_ID`: 906309465
   - `GOOGLE_CLIENT_ID`: 571399293814-ojpsivppu953sg53qrk73h701es91020.apps.googleusercontent.com
   - `GOOGLE_CLIENT_SECRET`: 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
   - `GOOGLE_SPREADSHEET_ID`: (your sheet ID)
   - `GOOGLE_REFRESH_TOKEN`: (from step 2)

### 4. Set Up Google Ads Import

**Option A: Manual Upload (Easy)**
1. Go to your Google Sheet
2. Download as CSV
3. Google Ads → Tools → Conversions → Upload

**Option B: Google Ads Script (Automated)**
1. Google Ads → Tools → Bulk Actions → Scripts
2. Create new script
3. Paste contents of `google-ads-script.js`
4. Update `CONFIG.spreadsheetId` with your Sheet ID
5. Authorize and schedule hourly

### 5. Create Conversion Action in Google Ads

1. Tools → Measurement → Conversions
2. New conversion action → Import → Other data sources
3. Name: "CallRail Phone Lead"
4. Value: Use values from import
5. Save

## Usage

### Phoenix Command UI

Visit your Netlify URL to see the dashboard:
- View all pending conversions
- Edit values before sync
- Filter by tier/status
- Manually trigger sync

### API Endpoints

**Test sync (dry run):**
```
GET /.netlify/functions/sync-gads-conversions?hours=24&dry_run=true
```

**Run actual sync:**
```
GET /.netlify/functions/sync-gads-conversions?hours=24
```

### Scheduled Sync

Add a Netlify scheduled function or use an external cron service to hit:
```
POST https://your-site.netlify.app/.netlify/functions/sync-gads-conversions?hours=2
```

Every hour.

## Value Calculation

The script detects product HP from:
- Call transcript
- CallRail tags
- Call notes

Then applies the tier multiplier:

| CallRail Lead Score | Multiplier | Example (10HP = $1,995) |
|---------------------|------------|-------------------------|
| Very Good (80%+)    | 100%       | $1,995                  |
| Good (60-79%)       | 75%        | $1,496                  |
| Fair (40-59%)       | 50%        | $998                    |
| Poor (20-39%)       | 25%        | $499                    |
| Very Poor (<20%)    | 0%         | $0                      |

If product can't be detected, uses $3,500 average.

## Files

```
callrail-gads-bypass/
├── netlify/functions/
│   └── sync-gads-conversions.js    # Main sync function
├── public/
│   └── gads-sync.html              # Phoenix Command UI
├── scripts/
│   └── get-google-token.js         # OAuth setup helper
├── google-ads-script.js            # Paste into Google Ads
├── netlify.toml                    # Netlify config
├── package.json
└── .env.example
```

## Troubleshooting

**"No GCLID found"**
- Ensure CallRail tracking script is on your landing pages
- Check that Google Ads auto-tagging is enabled

**"Sheet not found"**
- Verify GOOGLE_SPREADSHEET_ID is correct
- Make sure the Google account has edit access

**"Token expired"**
- Re-run `node scripts/get-google-token.js`
- Update GOOGLE_REFRESH_TOKEN in Netlify

## Integration with Phoenix Command

To add this to your main Phoenix Command dashboard, include the iframe or link:

```html
<a href="/gads-sync.html">Google Ads Sync</a>
```

Or embed the conversions API data directly into Phoenix Command's dashboard.
