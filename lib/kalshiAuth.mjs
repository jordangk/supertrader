/**
 * Kalshi RSA-signed authentication for API v2.
 * Each request is signed: SHA-256(timestamp_ms + method + path) with RSA-PKCS1v15.
 * Headers: KALSHI-ACCESS-KEY, KALSHI-ACCESS-SIGNATURE, KALSHI-ACCESS-TIMESTAMP
 *
 * Env: KALSHI_API_KEY, KALSHI_PRIVATE_KEY_PATH (or KALSHI_PRIVATE_KEY inline)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const API_KEY = process.env.KALSHI_API_KEY || '';
const KEY_PATH = process.env.KALSHI_PRIVATE_KEY_PATH || '';
const KEY_INLINE = process.env.KALSHI_PRIVATE_KEY || '';

let _privateKey = null;

function getPrivateKey() {
  if (_privateKey) return _privateKey;
  if (KEY_INLINE) {
    _privateKey = KEY_INLINE;
    return _privateKey;
  }
  if (KEY_PATH) {
    try {
      _privateKey = fs.readFileSync(KEY_PATH, 'utf8');
      console.log('[kalshi-auth] Loaded RSA private key from', KEY_PATH);
      return _privateKey;
    } catch (e) {
      console.error('[kalshi-auth] Cannot read private key from', KEY_PATH, e.message);
      return null;
    }
  }
  return null;
}

/**
 * Generate Kalshi auth headers for a request.
 * @param {string} method - HTTP method (GET, POST, DELETE)
 * @param {string} path - API path (e.g., /trade-api/v2/portfolio/orders)
 * @returns {object} Headers object to spread into fetch headers, or {} if no key configured.
 */
export function kalshiAuthHeaders(method, path) {
  if (!API_KEY) return {};
  const pk = getPrivateKey();
  if (!pk) {
    // Fall back to bearer token (works for public endpoints only)
    return { Authorization: `Bearer ${API_KEY}` };
  }

  const timestamp = Date.now().toString();
  const message = timestamp + method.toUpperCase() + path;

  try {
    const signature = crypto.sign(
      'sha256',
      Buffer.from(message),
      {
        key: pk,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      },
    );

    return {
      'KALSHI-ACCESS-KEY': API_KEY,
      'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
    };
  } catch (e) {
    console.error('[kalshi-auth] Signing failed:', e.message);
    return { Authorization: `Bearer ${API_KEY}` };
  }
}

/**
 * Whether RSA signing is available (key + private key both present).
 */
export function hasKalshiAuth() {
  return Boolean(API_KEY && getPrivateKey());
}

/**
 * Signed fetch wrapper for Kalshi API.
 */
export async function kalshiFetch(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  // Extract path from URL for signing
  const parsed = new URL(url);
  const path = parsed.pathname;

  const authHeaders = kalshiAuthHeaders(method, path);

  return fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; SuperTrader-Arb/1.0)',
      ...authHeaders,
      ...(options.headers || {}),
    },
  });
}
