#!/usr/bin/env node
/**
 * Smoke test Kalshi RSA auth + API (no server required).
 * Usage: from repo root: npm run test:kalshi
 *        optional: node scripts/kalshi-smoke-test.mjs KXBTC15M-26MAR301400
 */
import 'dotenv/config';
import { kalshiFetch, hasKalshiAuth } from '../lib/kalshiAuth.mjs';
import { KALSHI_TRADE_API } from '../lib/kalshiPrice.mjs';

const tickerArg = process.argv[2]?.trim();

async function main() {
  console.log('KALSHI_TRADE_API', KALSHI_TRADE_API);
  console.log('RSA auth ready (API key + private key):', hasKalshiAuth());
  if (!hasKalshiAuth()) {
    console.error('\nFAIL: Set KALSHI_API_KEY and KALSHI_PRIVATE_KEY_PATH (or KALSHI_PRIVATE_KEY) in .env');
    process.exit(1);
  }

  const balanceUrl = `${KALSHI_TRADE_API}/portfolio/balance`;
  const r = await kalshiFetch(balanceUrl);
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    j = { raw: text.slice(0, 400) };
  }
  console.log('\nGET /portfolio/balance → HTTP', r.status);
  if (!r.ok) {
    console.error('Body:', j);
    process.exit(1);
  }
  console.log('Balance (cents):', j.balance, '| portfolio_value:', j.portfolio_value);

  const ev = await kalshiFetch(`${KALSHI_TRADE_API}/events?series_ticker=KXBTC15M&status=open&limit=2`);
  const evText = await ev.text();
  let evJ;
  try {
    evJ = JSON.parse(evText);
  } catch {
    evJ = {};
  }
  console.log('\nGET /events KXBTC15M open → HTTP', ev.status, ev.ok ? 'OK' : 'FAIL');
  if (ev.ok && evJ.events?.length) {
    console.log('Sample event_ticker:', evJ.events[0].event_ticker);
  }

  const t = tickerArg || evJ.events?.[0]?.event_ticker;
  if (t) {
    const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets?event_ticker=${encodeURIComponent(t)}&limit=1`);
    const md = await mr.json();
    const m = md.markets?.[0];
    console.log('\nMarket for', t, '→ HTTP', mr.status);
    if (m) console.log('  ticker:', m.ticker, '| status:', m.status, '| yes_ask:', m.yes_ask_dollars, '| no_ask:', m.no_ask_dollars);
  }

  console.log('\nOK — Kalshi API reachable with your credentials.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
