// =============================================================================
// electron/sheets-sync.js
// -----------------------------------------------------------------------------
// Minimal Google Sheets v4 client for the cue-list Push/Pull sync.
//
// No `googleapis` dependency: a service-account JWT is one RS256 signature
// (Node's built-in crypto does that natively) exchanged for a bearer token at
// Google's OAuth endpoint, then plain REST against the Sheets API. Pulling in
// the full `googleapis` SDK for two endpoints isn't worth the install weight
// on a show machine that may be offline most of the year.
// =============================================================================
const https = require('https');
const crypto = require('crypto');

const TOKEN_URL = 'oauth2.googleapis.com';
const SHEETS_HOST = 'sheets.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function httpsRequest({ host, path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request(
      {
        host,
        path,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { /* non-JSON error body */ }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const msg = parsed?.error?.message || data || `HTTP ${res.statusCode}`;
            reject(new Error(`${res.statusCode}: ${msg}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request to Google timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

// Access tokens are cached per service-account key (by client_email) for
// their lifetime, so repeated Push/Pull calls in one session don't re-mint a
// token every time. Keyed rather than a single slot because switching the
// configured key mid-session (rare, but possible from Settings) must not
// hand back a stale token for the old account.
const tokenCache = new Map(); // client_email -> { token, expiresAt }

async function getAccessToken(serviceAccount) {
  const cached = tokenCache.get(serviceAccount.client_email);
  if (cached && cached.expiresAt > Date.now() + 30000) return cached.token;

  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: SCOPE,
    aud: `https://${TOKEN_URL}/token`,
    iat: nowSec,
    exp: nowSec + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), serviceAccount.private_key);
  const jwt = `${unsigned}.${base64url(signature).replace(/\+/g, '-').replace(/\//g, '_')}`;
  // base64url() already strips padding and swaps the unsafe chars for the
  // header/claims halves; the signature is binary, not already base64url, so
  // it goes through the same pass explicitly above.

  const body = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`;
  const res = await new Promise((resolve, reject) => {
    const payload = Buffer.from(body);
    const req = https.request(
      {
        host: TOKEN_URL,
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': payload.length,
        },
        timeout: 15000,
      },
      (r) => {
        let data = '';
        r.on('data', (c) => { data += c; });
        r.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* ignore */ }
          if (r.statusCode === 200 && parsed?.access_token) resolve(parsed);
          else reject(new Error(parsed?.error_description || parsed?.error || `Token request failed (${r.statusCode})`));
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Token request to Google timed out')));
    req.write(payload);
    req.end();
  });

  const token = res.access_token;
  tokenCache.set(serviceAccount.client_email, {
    token,
    expiresAt: Date.now() + (res.expires_in || 3600) * 1000,
  });
  return token;
}

function a1Range(sheetName, startCol, startRow, endCol, endRow) {
  const sheet = `'${String(sheetName).replace(/'/g, "''")}'`;
  return `${sheet}!${startCol}${startRow}:${endCol}${endRow}`;
}

/**
 * Read every row of `sheetName` (including the header row at row 1).
 * Returns `{ header: string[], rows: string[][] }`. `rows` excludes the
 * header. Cells past the last non-empty one in a row are NOT padded —
 * callers index by header position and treat a short row as blanks past its
 * length, since Sheets drops trailing empty cells from its response.
 */
async function readSheet({ serviceAccount, spreadsheetId, sheetName }) {
  const token = await getAccessToken(serviceAccount);
  const range = a1Range(sheetName, 'A', 1, 'Z', 10000);
  const res = await httpsRequest({
    host: SHEETS_HOST,
    path: `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
    headers: { Authorization: `Bearer ${token}` },
  });
  const values = res?.values || [];
  const header = values[0] || [];
  const rows = values.slice(1);
  return { header, rows };
}

/**
 * Overwrite `sheetName` entirely with `header` + `rows`. Clears the old
 * extent first (values:update alone would leave stale cells behind a
 * shorter sheet than before — e.g. after deleting cues in the app and
 * pushing), then writes the new content starting at A1.
 */
async function writeSheet({ serviceAccount, spreadsheetId, sheetName, header, rows }) {
  const token = await getAccessToken(serviceAccount);
  const clearRange = a1Range(sheetName, 'A', 1, 'Z', 10000);
  await httpsRequest({
    host: SHEETS_HOST,
    path: `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(clearRange)}:clear`,
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: {},
  });
  const writeRange = a1Range(sheetName, 'A', 1, 'Z', 1 + rows.length);
  await httpsRequest({
    host: SHEETS_HOST,
    path: `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(writeRange)}?valueInputOption=RAW`,
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: { range: writeRange, majorDimension: 'ROWS', values: [header, ...rows] },
  });
}

module.exports = { readSheet, writeSheet, getAccessToken };
