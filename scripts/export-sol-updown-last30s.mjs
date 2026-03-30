#!/usr/bin/env node
/**
 * Export one CSV row per second for the last 30s of the *current* SOL 5m market.
 *
 * - This is **CLOB** midpoint history (forward-filled per second), not on-chain trade prices.
 *   For **actual USDC paid per share**, use `scripts/export-onchain-fills-last30s.mjs` (CTF `OrderFilled` via Alchemy).
 * - **Alchemy** (ALCHEMY_KEY in .env): Polygon RPC for chain id / latest block metadata in the CSV header.
 *
 *   node scripts/export-sol-updown-last30s.mjs
 *   node scripts/export-sol-updown-last30s.mjs --out=csv_exports/sol_updown_last30s.csv
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { JsonRpcProvider } from 'ethers';

function alchemyKeyFromEnv() {
  const direct = process.env.ALCHEMY_KEY?.trim();
  if (direct) return direct;
  for (const name of ['POLYGON_RPC', 'POLYGON_RPC_URL', 'ALCHEMY_HTTP', 'ALCHEMY_POLYGON_URL']) {
    const url = process.env[name]?.trim();
    if (!url) continue;
    const m = url.match(/alchemy\.com\/v2\/([^/?#]+)/i);
    if (m) return m[1];
  }
  return null;
}

async function clobHistory(tokenId, startTs, endTs) {
  const url =
    `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(tokenId)}` +
    `&startTs=${startTs}&endTs=${endTs}&interval=max`;
  const j = await fetch(url).then(r => r.json());
  const h = j.history || [];
  return h.map(({ t, p }) => ({ t, p })).sort((a, b) => a.t - b.t);
}

/** Last trade price at or before second `s` (unix). */
function priceAtOrBefore(points, s) {
  let last = null;
  for (const { t, p } of points) {
    if (t <= s) last = p;
    else break;
  }
  return last;
}

const outArg = process.argv.find(a => a.startsWith('--out='));
const outFile = outArg ? outArg.slice(6) : path.join('csv_exports', 'sol_updown_last30s.csv');

const NOW = Math.floor(Date.now() / 1000);
const START = NOW - 30;
const LOOKBACK = START - 6 * 3600; // 6h of history so we have a price before START
const slot = Math.floor(NOW / 300) * 300;
const slug = `sol-updown-5m-${slot}`;

const key = alchemyKeyFromEnv();
let polyMeta = {};
if (key) {
  try {
    const provider = new JsonRpcProvider(`https://polygon-mainnet.g.alchemy.com/v2/${key}`);
    const [net, bn] = await Promise.all([provider.getNetwork(), provider.getBlockNumber()]);
    const block = await provider.getBlock(bn);
    polyMeta = {
      alchemy_polygon_chainId: Number(net.chainId),
      alchemy_latest_block: bn,
      alchemy_latest_block_ts: block?.timestamp ?? null,
    };
  } catch (e) {
    polyMeta = { alchemy_error: e.message || String(e) };
  }
} else {
  polyMeta = { alchemy: 'skipped (set ALCHEMY_KEY in .env for Polygon metadata)' };
}

const ev = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`).then(r => r.json());
const m = ev[0]?.markets?.[0];
if (!m) throw new Error(`No market for ${slug}`);

const tokens = JSON.parse(m.clobTokenIds);
const outcomes = JSON.parse(m.outcomes || '["Up","Down"]');

const upHist = await clobHistory(tokens[0], LOOKBACK, NOW);
const downHist = await clobHistory(tokens[1], LOOKBACK, NOW);

const lines = [];
lines.push(
  '# Polymarket CLOB forward-filled to 1 row/sec; odds are not stored on-chain per second.',
);
lines.push(`# slug=${m.slug} title=${JSON.stringify(m.question)}`);
lines.push(`# window_unix=${START}..${NOW - 1} (${30} rows) generated=${new Date().toISOString()}`);
lines.push(`# polygon_meta=${JSON.stringify(polyMeta)}`);
lines.push('second_index,unix_seconds,iso_utc,up_decimal,down_decimal,up_cents,down_cents');

for (let i = 0; i < 30; i++) {
  const s = START + i;
  const up = priceAtOrBefore(upHist, s);
  const dn = priceAtOrBefore(downHist, s);
  const iso = new Date(s * 1000).toISOString();
  lines.push(
    [
      i,
      s,
      iso,
      up != null ? String(up) : '',
      dn != null ? String(dn) : '',
      up != null ? (up * 100).toFixed(2) : '',
      dn != null ? (dn * 100).toFixed(2) : '',
    ].join(','),
  );
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
console.error(`Wrote ${outFile} (30 rows + header comments)`);
