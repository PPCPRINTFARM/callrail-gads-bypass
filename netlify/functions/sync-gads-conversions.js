/**
 * CallRail → Google Ads CSV Export
 * 
 * Pulls calls from CallRail, calculates tiered conversion values,
 * and outputs a CSV ready for manual upload to Google Ads.
 * 
 * NO Google credentials needed - just CallRail API key.
 * 
 * Usage:
 *   /sync-gads-conversions?hours=168          → JSON summary
 *   /sync-gads-conversions?hours=168&format=csv → Download CSV
 *   /sync-gads-conversions?days=7&format=csv   → Same thing, 7 days
 * 
 * Value Tiers (Glen's formula):
 *   Very Good (80%+):  100% of product price (Converted)
 *   Good (60-79%):     75% of product price  (Hot Lead)
 *   Fair (40-59%):     50% of product price  (Good Lead)
 *   Poor (20-39%):     25% of product price  (OK Lead)
 *   Very Poor (<20%):  $0                    (Not Good)
 */

const CONFIG = {
  callrail: {
    apiKey: process.env.CALLRAIL_API_KEY,
    accountId: process.env.CALLRAIL_ACCOUNT_ID
  },
  products: {
    '3': 895, '5': 1095, '7': 1395, '10': 1995,
    '15': 2495, '20': 2995, '25': 3495, '30': 3995,
    '40': 4995, '50': 5995, '60': 6995, '75': 8495, '100': 10995,
    'default': 3500
  },
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
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  try {
    const params = event.queryStringParameters || {};
    const hoursBack = parseInt(params.hours) || (parseInt(params.days) || 7) * 24;
    const format = params.format || 'json';

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date(endDate - hoursBack * 60 * 60 * 1000);

    console.log(`Fetching calls from ${startDate.toISOString()} to ${endDate.toISOString()}`);

    // Fetch all calls (paginated)
    const calls = await fetchAllCalls(startDate, endDate);
    console.log(`Fetched ${calls.length} total calls`);

    // Process calls
    const conversions = [];
    const stats = {
      totalCalls: calls.length,
      withGclid: 0,
      withValue: 0,
      zeroValue: 0,
      totalValue: 0
    };

    // Group by phone number to handle repeat callers
    const callerGroups = {};

    for (const call of calls) {
      const gclid = extractGclid(call);
      if (!gclid) continue;
      stats.withGclid++;

      const phone = normalizePhone(call.customer_phone_number);
      if (!callerGroups[phone]) {
        callerGroups[phone] = [];
      }
      callerGroups[phone].push({ call, gclid });
    }

    // Process each caller group - spread value across calls
    for (const phone in callerGroups) {
      const group = callerGroups[phone];
      
      // Find best lead score in the group
      let bestScore = 0;
      let bestProduct = 'default';
      
      for (const { call } of group) {
        const score = getScorePercent(call);
        if (score > bestScore) {
          bestScore = score;
        }
        const product = detectProduct(call);
        if (product !== 'default') {
          bestProduct = product;
        }
      }

      // Calculate total value based on best score
      const tier = getTier(bestScore);
      const multiplier = CONFIG.tiers[tier] || 0;
      const productPrice = CONFIG.products[bestProduct] || CONFIG.products.default;
      const totalValue = Math.round(productPrice * multiplier * 100) / 100;

      if (totalValue <= 0) {
        stats.zeroValue += group.length;
        continue;
      }

      // Spread value across all calls from this caller
      const perCallValue = Math.round((totalValue / group.length) * 100) / 100;

      for (const { call, gclid } of group) {
        stats.withValue++;
        stats.totalValue += perCallValue;

        conversions.push({
          gclid,
          conversionName: 'Phone Call',
          conversionTime: formatGoogleAdsTime(call.start_time),
          conversionValue: perCallValue,
          currency: 'USD',
          // Extra info for JSON view
          callId: call.id,
          phone: call.customer_phone_number || '',
          tier,
          product: bestProduct,
          productPrice,
          campaign: call.campaign || '',
          source: call.source || '',
          duration: call.duration || 0,
          leadScore: bestScore
        });
      }
    }

    console.log(`Processed: ${stats.withGclid} with GCLID, ${stats.withValue} with value, $${stats.totalValue.toFixed(2)} total`);

    // Return CSV format for Google Ads upload
    if (format === 'csv') {
      const csvHeader = 'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency';
      const csvRows = conversions.map(c =>
        `${c.gclid},${c.conversionName},${c.conversionTime},${c.conversionValue},${c.currency}`
      );

      return {
        statusCode: 200,
        headers: {
          ...headers,
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="callrail_gads_conversions.csv"'
        },
        body: [csvHeader, ...csvRows].join('\n')
      };
    }

    // Return JSON with full details
    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        dateRange: {
          from: startDate.toISOString(),
          to: endDate.toISOString(),
          hours: hoursBack
        },
        stats: {
          ...stats,
          totalValue: '$' + stats.totalValue.toFixed(2),
          uniqueCallers: Object.keys(callerGroups).length
        },
        conversions: conversions.map(c => ({
          gclid: c.gclid.substring(0, 20) + '...',
          value: '$' + c.conversionValue.toFixed(2),
          tier: c.tier,
          product: c.product === 'default' ? 'Unknown (avg $3,500)' : c.product + ' HP',
          phone: c.phone,
          campaign: c.campaign,
          duration: c.duration + 's',
          leadScore: c.leadScore + '%'
        })),
        csvUrl: `/.netlify/functions/sync-gads-conversions?hours=${hoursBack}&format=csv`
      }, null, 2)
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  }
};

// ===== CALLRAIL API =====

async function fetchAllCalls(startDate, endDate) {
  let allCalls = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const url = new URL(`https://api.callrail.com/v3/a/${CONFIG.callrail.accountId}/calls.json`);
    url.searchParams.set('per_page', '250');
    url.searchParams.set('page', page.toString());
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
      throw new Error(`CallRail API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const calls = data.calls || [];
    allCalls = allCalls.concat(calls);

    // Check if there are more pages
    if (calls.length < 250 || page >= 10) {
      hasMore = false;
    } else {
      page++;
    }
  }

  return allCalls;
}

// ===== GCLID EXTRACTION =====

function extractGclid(call) {
  if (call.gclid) return call.gclid;

  if (call.landing_page_url) {
    const match = call.landing_page_url.match(/[?&]gclid=([^&]+)/);
    if (match) return match[1];
  }

  return null;
}

// ===== VALUE CALCULATION =====

function getScorePercent(call) {
  const leadScore = call.lead_score;
  if (!leadScore) return 30; // Default to "poor" if no score

  if (typeof leadScore === 'object') {
    return leadScore.percent || leadScore.score || 30;
  }
  if (typeof leadScore === 'number') {
    return leadScore;
  }
  if (typeof leadScore === 'string') {
    const map = { 'very_poor': 10, 'poor': 30, 'fair': 50, 'good': 70, 'very_good': 90 };
    return map[leadScore.toLowerCase()] || 30;
  }

  return 30;
}

function getTier(scorePercent) {
  if (scorePercent >= 80) return 'very_good';
  if (scorePercent >= 60) return 'good';
  if (scorePercent >= 40) return 'fair';
  if (scorePercent >= 20) return 'poor';
  return 'very_poor';
}

function detectProduct(call) {
  const searchText = [
    call.transcription?.text || call.transcription || '',
    call.note || '',
    (call.tags || []).map(t => t.name || t).join(' ')
  ].join(' ').toLowerCase();

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

function normalizePhone(phone) {
  if (!phone) return 'unknown';
  return phone.replace(/\D/g, '').slice(-10);
}

// ===== FORMATTING =====

function formatGoogleAdsTime(isoString) {
  const date = new Date(isoString);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  // Arizona time (no DST, always MST = UTC-7)
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}-0700`;
}
