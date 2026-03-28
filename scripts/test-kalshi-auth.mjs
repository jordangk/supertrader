import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';

const apiKey = process.env.KALSHI_API_KEY_NEW || '6dcab987-73d4-42a6-896c-14221347634f';
const pk = fs.readFileSync(process.env.KALSHI_PRIVATE_KEY_PATH, 'utf8');

const timestamp = Date.now().toString();
const method = 'GET';
const path = '/trade-api/v2/portfolio/balance';
const msg = timestamp + method + path;

// PSS signing
const sig = crypto.sign('sha256', Buffer.from(msg), {
  key: pk,
  padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
  saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
});

const headers = {
  'KALSHI-ACCESS-KEY': apiKey,
  'KALSHI-ACCESS-SIGNATURE': sig.toString('base64'),
  'KALSHI-ACCESS-TIMESTAMP': timestamp,
  'Content-Type': 'application/json',
};

// Test elections API
console.log('=== elections API ===');
let r = await fetch('https://api.elections.kalshi.com/trade-api/v2/portfolio/balance', { headers });
console.log('Status:', r.status);
console.log('Body:', (await r.text()).slice(0, 300));

// Test trading API (newer endpoint)
console.log('\n=== trading-api.kalshi.com ===');
const ts2 = Date.now().toString();
const msg2 = ts2 + method + path;
const sig2 = crypto.sign('sha256', Buffer.from(msg2), {
  key: pk,
  padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
  saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
});
r = await fetch('https://trading-api.kalshi.com/trade-api/v2/portfolio/balance', {
  headers: {
    'KALSHI-ACCESS-KEY': apiKey,
    'KALSHI-ACCESS-SIGNATURE': sig2.toString('base64'),
    'KALSHI-ACCESS-TIMESTAMP': ts2,
    'Content-Type': 'application/json',
  },
});
console.log('Status:', r.status);
console.log('Body:', (await r.text()).slice(0, 300));

// Test with PKCS1 v1.5 padding (not PSS)
console.log('\n=== PKCS1 v1.5 padding ===');
const ts3 = Date.now().toString();
const msg3 = ts3 + method + path;
const sig3 = crypto.sign('sha256', Buffer.from(msg3), {
  key: pk,
  padding: crypto.constants.RSA_PKCS1_PADDING,
});
r = await fetch('https://trading-api.kalshi.com/trade-api/v2/portfolio/balance', {
  headers: {
    'KALSHI-ACCESS-KEY': apiKey,
    'KALSHI-ACCESS-SIGNATURE': sig3.toString('base64'),
    'KALSHI-ACCESS-TIMESTAMP': ts3,
    'Content-Type': 'application/json',
  },
});
console.log('Status:', r.status);
console.log('Body:', (await r.text()).slice(0, 300));
