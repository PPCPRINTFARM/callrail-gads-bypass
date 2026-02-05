/**
 * CallRail → Google Sheets → Google Ads Conversion Sync
 * 
 * This function:
 * 1. Pulls calls from CallRail with GCLIDs
 * 2. Calculates tiered conversion values based on lead score
 * 3. Writes to Google Sheets (for Google Ads offline conversion import)
 * 4. Can be triggered hourly via cron or manually
 * 
 * Value Tiers (Glen's formula):
 * - Not good lead (Very Poor): $0
 * - OK lead (Poor): 25% of product price
 * - Good lead (Fair): 50% of product price
 * - Hot lead (Good): 75% of product price
 * - Converted (Very Good): 100% of product price
 */

const { google } = require('googleapis');

// Configuration
const CONFIG = {
  callrail: {
    apiKey: process.env.CALLRAIL_API_KEY,
    accountId: process.env.CALLRAIL_ACCOUNT_ID
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID // Sheet where conversions are logged
  },
  // Product prices for value calculation
  products: {
    '3': 895, '5': 1095, '7': 1395, '10': 1995,
    '15': 2495, '20': 2995, '25': 3495, '30': 3995,
    '40': 4995, '50': 5995, '60': 6995, '75': 8495, '100': 10995,
    'default': 3500 // Average if product not detected
  },
  // Lead score to value multiplier mapping
  tiers: {
    'very_poor': 0,
    'poor': 0.25,
    'fair': 0.50,
    'good': 0.75,
    'very_good': 1.0
  }
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  try {
    // Parse parameters
    const params = event.queryStringParameters || {};
    const hoursBack = parseInt(params.hours) || 24;
    const dryRun = params.dry_run === 'true';

    console.log(`Syncing conversions from last ${hoursBack} hours. Dry run: ${dryRun}`);

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date(endDate - hoursBack * 60 * 60 * 1000);

    // Fetch calls from CallRail
    const calls = await fetchCallRailCalls(startDate, endDate);
    console.log(`Fetched ${calls.length} calls from CallRail`);

    // Process and calculate values
    const conversions = [];
    const stats = {
      totalCalls: calls.length,
      withGclid: 0,
      withValue: 0,
      zeroValue: 0,
      totalValue: 0
    };

    for (const call of calls) {
      const gclid = extractGclid(call);
      if (!gclid) continue;
      stats.withGclid++;

      // Calculate value based on lead score and detected product
      const valueData = calculateValue(call);
      
      if (valueData.value <= 0) {
        stats.zeroValue++;
        continue;
      }

      stats.withValue++;
      stats.totalValue += valueData.value;

      conversions.push({
        gclid,
        callId: call.id,
        conversionTime: formatGoogleAdsTime(call.start_time),
        conversionValue: valueData.value,
        currency: 'USD',
        // Metadata for tracking
        phone: call.customer_phone_number || '',
        leadScore: valueData.leadScore,
        tier: valueData.tier,
        detectedProduct: valueData.product,
        productPrice: valueData.productPrice,
        campaign: call.campaign || '',
        source: call.source || '',
        duration: call.duration || 0,
        rawCallData: JSON.stringify({
          lead_score: call.lead_score,
          tags: call.tags,
          note: call.note
        })
      });
    }

    console.log(`Processed: ${stats.withGclid} with GCLID, ${stats.withValue} with value, $${stats.totalValue.toFixed(2)} total`);

    // Write to Google Sheets (unless dry run)
    let sheetResult = { rowsWritten: 0 };
    if (!dryRun && conversions.length > 0) {
      sheetResult = await writeToGoogleSheets(conversions);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        dryRun,
        stats: {
          ...stats,
          totalValue: stats.totalValue.toFixed(2),
          rowsWritten: sheetResult.rowsWritten
        },
        conversions: conversions.map(c => ({
          gclid: c.gclid.substring(0, 20) + '...',
          value: c.conversionValue,
          tier: c.tier,
          product: c.detectedProduct,
          leadScore: c.leadScore
        })),
        message: dryRun 
          ? 'Dry run - no data written to Sheets' 
          : `Wrote ${sheetResult.rowsWritten} conversions to Google Sheets`
      })
    };

  } catch (error) {
    console.error('Sync error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  }
};

// Fetch calls from CallRail API
async function fetchCallRailCalls(startDate, endDate) {
  const url = new URL(`https://api.callrail.com/v3/a/${CONFIG.callrail.accountId}/calls.json`);
  url.searchParams.set('per_page', '250');
  url.searchParams.set('start_date', startDate.toISOString().split('T')[0]);
  url.searchParams.set('end_date', endDate.toISOString().split('T')[0]);
  url.searchParams.set('fields', 'id,start_time,duration,customer_phone_number,tracking_phone_number,source,campaign,landing_page_url,gclid,lead_score,tags,note,transcription');

  const response = await fetch(url.toString(), {
    headers: {
      'Authorization': `Token token=${CONFIG.callrail.apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`CallRail API error: ${response.status}`);
  }

  const data = await response.json();
  return data.calls || [];
}

// Extract GCLID from call data
function extractGclid(call) {
  // Direct gclid field
  if (call.gclid) return call.gclid;

  // Check landing page URL
  if (call.landing_page_url) {
    const match = call.landing_page_url.match(/[?&]gclid=([^&]+)/);
    if (match) return match[1];
  }

  return null;
}

// Calculate conversion value based on lead score and product
function calculateValue(call) {
  // Get lead score tier
  const leadScore = call.lead_score || {};
  const scoreValue = leadScore.value || 'unknown';
  const scorePercent = leadScore.percent || 0;
  
  // Map CallRail score to tier
  let tier = 'poor';
  if (scoreValue === 'very_poor' || scorePercent < 20) tier = 'very_poor';
  else if (scoreValue === 'poor' || scorePercent < 40) tier = 'poor';
  else if (scoreValue === 'fair' || scorePercent < 60) tier = 'fair';
  else if (scoreValue === 'good' || scorePercent < 80) tier = 'good';
  else if (scoreValue === 'very_good' || scorePercent >= 80) tier = 'very_good';

  // Detect product from transcript, tags, or notes
  const product = detectProduct(call);
  const productPrice = CONFIG.products[product] || CONFIG.products.default;

  // Calculate value
  const multiplier = CONFIG.tiers[tier] || 0;
  const value = Math.round(productPrice * multiplier * 100) / 100;

  return {
    value,
    tier,
    leadScore: `${scoreValue} (${scorePercent}%)`,
    product,
    productPrice,
    multiplier
  };
}

// Detect product HP from call data
function detectProduct(call) {
  const searchText = [
    call.transcription?.text || '',
    call.note || '',
    (call.tags || []).map(t => t.name || t).join(' ')
  ].join(' ').toLowerCase();

  // Look for HP mentions
  const hpPatterns = [
    /(\d+)\s*hp/i,
    /(\d+)\s*horse\s*power/i,
    /(\d+)\s*horsepower/i
  ];

  for (const pattern of hpPatterns) {
    const match = searchText.match(pattern);
    if (match) {
      const hp = match[1];
      if (CONFIG.products[hp]) return hp;
    }
  }

  return 'default';
}

// Format time for Google Ads offline conversion
function formatGoogleAdsTime(isoString) {
  // Google Ads wants: yyyy-MM-dd HH:mm:ss+TZ
  const date = new Date(isoString);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  
  // Arizona time (no DST)
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}-07:00`;
}

// Write conversions to Google Sheets
async function writeToGoogleSheets(conversions) {
  const auth = new google.auth.OAuth2(
    CONFIG.google.clientId,
    CONFIG.google.clientSecret
  );
  auth.setCredentials({ refresh_token: CONFIG.google.refreshToken });

  const sheets = google.sheets({ version: 'v4', auth });
  
  // Prepare rows for the sheet
  // Format: GCLID, Conversion Time, Value, Currency, Call ID, Phone, Lead Score, Tier, Product, Campaign
  const rows = conversions.map(c => [
    c.gclid,
    c.conversionTime,
    c.conversionValue,
    c.currency,
    c.callId,
    c.phone,
    c.leadScore,
    c.tier,
    c.detectedProduct,
    c.campaign,
    new Date().toISOString() // Timestamp when synced
  ]);

  // Append to the sheet
  const response = await sheets.spreadsheets.values.append({
    spreadsheetId: CONFIG.google.spreadsheetId,
    range: 'Conversions!A:K', // Main sheet
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: rows
    }
  });

  return {
    rowsWritten: rows.length,
    updatedRange: response.data.updates?.updatedRange
  };
}
