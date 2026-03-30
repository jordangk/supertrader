/**
 * Pre-market snipe strategy:
 * 1. Place Poly limit order BEFORE the 15m event starts (cheap fills from pre-market)
 * 2. 1 second before Kalshi opens → cancel the Poly order
 * 3. If Poly filled → buy opposite on Kalshi at market
 *
 * Usage: node scripts/pre-market-snipe.mjs [asset] [side] [price] [shares]
 * Example: node scripts/pre-market-snipe.mjs btc up 0.45 10
 */
import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { kalshiFetch } from '../lib/kalshiAuth.mjs';

const KALSHI_API = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';

const asset = process.argv[2] || 'btc';
const side = process.argv[3] || 'up';   // which side to buy on Poly
const price = parseFloat(process.argv[4] || '0.45');
const shares = parseInt(process.argv[5] || '10');

console.log(`[pre-snipe] ${asset.toUpperCase()} — Buy Poly ${side.toUpperCase()} ${shares}sh @ ${(price*100).toFixed(0)}¢, then hedge KS opposite`);

// Init Poly client
const wallet = new Wallet(process.env.PRIVATE_KEY);
const tempClient = new ClobClient('https://clob.polymarket.com', 137, wallet);
const creds = await tempClient.deriveApiKey();
const client = new ClobClient('https://clob.polymarket.com', 137, wallet, creds, 2, process.env.FUNDER_ADDRESS);

// Find next Poly slot
const now = Math.floor(Date.now() / 1000);
const nextSlot = (Math.floor(now / 900) + 1) * 900;
const slug = `${asset}-updown-15m-${nextSlot}`;

console.log(`[pre-snipe] Next slot: ${slug} (opens in ${nextSlot - now}s)`);

// Get Poly market tokens
const pr = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
const pa = await pr.json();
const ev = pa?.[0];
if (!ev?.markets?.[0]) {
  console.log('[pre-snipe] No Poly market found for', slug);
  process.exit(1);
}
const mkt = ev.markets[0];
const tids = typeof mkt.clobTokenIds === 'string' ? JSON.parse(mkt.clobTokenIds) : mkt.clobTokenIds;
const outcomes = typeof mkt.outcomes === 'string' ? JSON.parse(mkt.outcomes) : mkt.outcomes;
const tokenIdx = side === 'up' ? 0 : 1;
const tokenId = tids[tokenIdx];
console.log(`[pre-snipe] Poly: ${mkt.question} | ${side.toUpperCase()} token: ${tokenId.slice(0,12)}...`);

// Find matching Kalshi event
const seriesMap = { btc: 'KXBTC15M', eth: 'KXETH15M', sol: 'KXSOL15M', xrp: 'KXXRP15M', hype: 'KXHYPE15M' };
const series = seriesMap[asset];
if (!series) { console.log('[pre-snipe] Unknown asset:', asset); process.exit(1); }

// Place Poly limit order NOW (pre-market)
console.log(`[pre-snipe] Placing Poly ${side.toUpperCase()} limit: ${shares}sh @ ${(price*100).toFixed(0)}¢`);

const negRisk = false;
const tickSize = '0.01';
const signed = await client.createOrder({
  tokenID: tokenId,
  price: price,
  size: shares,
  side: 'BUY',
}, { tickSize, negRisk });
const polyResult = await client.postOrder(signed, 'GTC');
const polyOrderId = polyResult?.orderID || polyResult?.id;
console.log(`[pre-snipe] Poly order placed: ${polyOrderId?.slice(0,12)} status: ${polyResult?.status}`);

if (polyResult?.status === 'matched') {
  console.log(`[pre-snipe] Poly FILLED IMMEDIATELY! Hedging on Kalshi...`);
  // Skip to hedge
} else {
  // Wait until 1 second before Kalshi opens
  // Kalshi opens at the slot time. We need to find the exact open time.
  const er = await kalshiFetch(`${KALSHI_API}/events?series_ticker=${series}&limit=3&status=open`);
  const ed = await er.json();
  // Find the event that opens at nextSlot
  let kalshiOpenTime = nextSlot * 1000; // default: slot start
  for (const e of (ed.events || [])) {
    const mr = await kalshiFetch(`${KALSHI_API}/markets?event_ticker=${e.event_ticker}&limit=1`);
    const md = await mr.json();
    const m = md.markets?.[0];
    if (m?.open_time) {
      const ot = new Date(m.open_time).getTime();
      if (ot > Date.now()) {
        kalshiOpenTime = ot;
        console.log(`[pre-snipe] Kalshi opens: ${m.open_time} (${((ot - Date.now())/1000).toFixed(0)}s)`);
        break;
      }
    }
  }

  // Wait until 1s before Kalshi opens
  const waitUntil = kalshiOpenTime - 1000;
  console.log(`[pre-snipe] Waiting ${((waitUntil - Date.now())/1000).toFixed(0)}s before cancelling Poly...`);

  await new Promise(resolve => {
    const iv = setInterval(() => {
      if (Date.now() >= waitUntil) {
        clearInterval(iv);
        resolve();
      }
    }, 200);
  });

  // Cancel the Poly order
  console.log(`[pre-snipe] Cancelling Poly order...`);
  try {
    await client.cancelOrder(polyOrderId);
    console.log(`[pre-snipe] Cancelled`);
  } catch (e) {
    console.log(`[pre-snipe] Cancel failed (might be filled):`, e.message?.slice(0, 50));
  }
}

// Check if Poly filled
await new Promise(r => setTimeout(r, 500));
let polyFilled = false;
let filledShares = 0;
try {
  const order = await client.getOrder(polyOrderId);
  if (order) {
    filledShares = parseFloat(order.size_matched || '0');
    polyFilled = filledShares > 0;
    console.log(`[pre-snipe] Poly order: status=${order.status} filled=${filledShares}/${shares}`);
  }
} catch {
  // If order not found, it might have fully filled
  if (polyResult?.status === 'matched') {
    polyFilled = true;
    filledShares = shares;
  }
}

if (!polyFilled || filledShares === 0) {
  console.log(`[pre-snipe] Poly NOT filled. No hedge needed. Done.`);
  process.exit(0);
}

console.log(`[pre-snipe] Poly FILLED ${filledShares} shares! Hedging on Kalshi...`);

// Wait for Kalshi to open
console.log(`[pre-snipe] Waiting for Kalshi to open...`);
let kalshiTicker = null;
for (let attempt = 0; attempt < 60; attempt++) {
  await new Promise(r => setTimeout(r, 500));
  const er2 = await kalshiFetch(`${KALSHI_API}/events?series_ticker=${series}&limit=3&status=open`);
  const events = (await er2.json()).events || [];
  for (const e of events) {
    const mr = await kalshiFetch(`${KALSHI_API}/markets?event_ticker=${e.event_ticker}&limit=1`);
    const m = (await mr.json()).markets?.[0];
    if (m?.status === 'active') {
      kalshiTicker = m.ticker;
      break;
    }
  }
  if (kalshiTicker) break;
}

if (!kalshiTicker) {
  console.log(`[pre-snipe] ERROR: Kalshi never opened. Poly filled but unhedged!`);
  process.exit(1);
}

// Buy opposite on Kalshi at market
const oppositeSide = side === 'up' ? 'no' : 'yes';
console.log(`[pre-snipe] Kalshi: buying ${oppositeSide.toUpperCase()} ${Math.round(filledShares)}sh at 99¢ on ${kalshiTicker}`);

const body = {
  ticker: kalshiTicker,
  action: 'buy',
  side: oppositeSide,
  type: 'limit',
  count: Math.round(filledShares),
};
if (oppositeSide === 'yes') body.yes_price_dollars = '0.99';
else body.no_price_dollars = '0.99';

const kr = await kalshiFetch(`${KALSHI_API}/portfolio/orders`, {
  method: 'POST',
  body: JSON.stringify(body),
});
const kd = await kr.json();
if (kr.ok) {
  const cost = parseFloat(kd.order?.taker_fill_cost_dollars || 0) + parseFloat(kd.order?.maker_fill_cost_dollars || 0);
  console.log(`[pre-snipe] Kalshi DONE: filled ${kd.order?.fill_count_fp}/${Math.round(filledShares)} cost $${cost.toFixed(2)} status: ${kd.order?.status}`);
  console.log(`[pre-snipe] HEDGE COMPLETE: Poly ${side.toUpperCase()} ${filledShares}sh @ ${(price*100).toFixed(0)}¢ + Kalshi ${oppositeSide.toUpperCase()} @ market`);
} else {
  console.log(`[pre-snipe] Kalshi FAILED:`, kd.error?.message);
}
