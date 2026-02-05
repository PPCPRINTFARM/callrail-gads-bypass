/**
 * One-time script to get Google OAuth refresh token
 * 
 * Run this locally:
 * 1. npm install googleapis open
 * 2. node scripts/get-google-token.js
 * 3. Follow the browser prompt to authorize
 * 4. Copy the refresh token to your .env
 */

const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CLIENT_ID = '571399293814-ojpsivppu953sg53qrk73h701es91020.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REDIRECT_URI = 'http://localhost:3333/callback';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file'
];

async function main() {
  const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  console.log('\n🔐 Google OAuth Setup\n');
  console.log('1. Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\n2. Authorize the app and wait...\n');

  // Start local server to catch the callback
  const server = http.createServer(async (req, res) => {
    const query = url.parse(req.url, true).query;
    
    if (query.code) {
      try {
        const { tokens } = await oauth2Client.getToken(query.code);
        
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <h1>✅ Success!</h1>
          <p>You can close this window.</p>
          <p>Check your terminal for the refresh token.</p>
        `);

        console.log('\n✅ Got tokens!\n');
        console.log('Add this to your .env file:\n');
        console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
        
        server.close();
        process.exit(0);
        
      } catch (error) {
        res.writeHead(500);
        res.end('Error: ' + error.message);
        console.error('Error:', error.message);
      }
    }
  });

  server.listen(3333, () => {
    console.log('Waiting for authorization...');
    // Try to open browser automatically
    const open = require('open');
    open(authUrl).catch(() => {});
  });
}

main().catch(console.error);
