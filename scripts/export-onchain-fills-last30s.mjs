#!/usr/bin/env node
/**
 * Last N seconds of a Polymarket 5m market: **on-chain** fills from CTF Exchange via Alchemy.
 *
 * Each row is one `OrderFilled` log where USDC (asset id 0) is swapped for the market's
 * Up or Down outcome token — **price_per_share = USDC / shares** for that fill.
 *
 * This is what people actually paid on-chain; it is **not** CLOB midpoint history.
 *
 * Usage:
 *   node scripts/export-onchain-fills-last30s.mjs
 *   node scripts/export-onchain-fills-last30s.mjs sol-updown-5m-1774458000
 *   node scripts/export-onchain-fills-last30s.mjs --slug=sol-updown-5m-1774458000 --seconds=30
 *
 * Env: ALCHEMY_KEY (or POLYGON_RPC URL containing alchemy key), same as audit-polymarket-condition.mjs
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { JsonRpcProvider } from 'ethers';

const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const ORDER_FILLED = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';

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

function parseArgs() {
  const argv = process.argv.slice(2);
  let slug = null;
  let seconds = 30;
  let outFile = path.join('csv_exports', 'onchain_fills_last30s.csv');
  for (const a of argv) {
    if (a.startsWith('--slug=')) slug = a.slice('--slug='.length);
    else if (a.startsWith('--seconds=')) seconds = Math.max(1, parseInt(a.slice('--seconds='.length), 10) || 30);
    else if (a.startsWith('--out=')) outFile = a.slice('--out='.length);
    else if (!a.startsWith('-')) slug = a;
  }
  return { slug, seconds, outFile };
}

/** Maker gives makerAsset (amount makerAmount), receives takerAsset (amount takerAmount). USDC id = 0. */
function decodeFillForMarket(log, tokenUp, tokenDn) {
  const topics = log.topics || [];
  if (topics.length < 4) return null;
  const data = (log.data || '0x').slice(2);
  if (data.length < 256) return null;
  const chunks = [];
  for (let i = 0; i < data.length; i += 64) chunks.push(data.slice(i, i + 64));
  const makerAsset = BigInt('0x' + chunks[0]);
  const takerAsset = BigInt('0x' + chunks[1]);
  const makerAmount = BigInt('0x' + chunks[2]);
  const takerAmount = BigInt('0x' + chunks[3]);

  const u = BigInt(tokenUp);
  const d = BigInt(tokenDn);

  let tokenId;
  let usdcSize;
  let shares;
  let side;

  if (makerAsset === 0n && takerAsset !== 0n) {
    tokenId = takerAsset;
    usdcSize = Number(makerAmount) / 1e6;
    shares = Number(takerAmount) / 1e6;
    side = 'buy';
  } else if (takerAsset === 0n && makerAsset !== 0n) {
    tokenId = makerAsset;
    usdcSize = Number(takerAmount) / 1e6;
    shares = Number(makerAmount) / 1e6;
    side = 'sell';
  } else {
    return null;
  }

  if (tokenId !== u && tokenId !== d) return null;
  const outcome = tokenId === u ? 'Up' : 'Down';
  const price = shares > 0 ? Math.round((usdcSize / shares) * 1e8) / 1e8 : 0;
  const blockNum =
    typeof log.blockNumber === 'bigint'
      ? Number(log.blockNumber)
      : typeof log.blockNumber === 'string'
        ? parseInt(log.blockNumber, 16)
        : Number(log.blockNumber);
  const rawIdx = log.index !== undefined && log.index !== null ? log.index : log.logIndex;
  const li =
    typeof rawIdx === 'bigint'
      ? Number(rawIdx)
      : typeof rawIdx === 'string'
        ? parseInt(rawIdx, 16)
        : Number(rawIdx);
  return {
    outcome,
    side,
    usdcSize,
    shares,
    price,
    txHash: log.transactionHash,
    logIndex: li,
    blockNumber: blockNum,
  };
}

/** Last block number whose timestamp is <= targetTs. */
async function findBlockAtOrBefore(provider, targetTs) {
  let lo = 0;
  let hi = await provider.getBlockNumber();
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = await provider.getBlock(mid);
    if (b.timestamp <= targetTs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** First block number whose timestamp is >= targetTs. */
async function findBlockAtOrAfter(provider, targetTs) {
  let lo = 0;
  let hi = await provider.getBlockNumber();
  let ans = hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = await provider.getBlock(mid);
    if (b.timestamp >= targetTs) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

async function getBlockRangeForWindow(provider, tsStart, tsEnd) {
  const fromBlock = await findBlockAtOrAfter(provider, tsStart);
  const toBlock = await findBlockAtOrBefore(provider, tsEnd);
  return { fromBlock, toBlock };
}

async function getLogsChunked(provider, fromBlock, toBlock) {
  const CHUNK = 2000;
  const fixed = [];
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, toBlock);
    const logs = await provider.getLogs({
      address: CTF_EXCHANGE,
      topics: [ORDER_FILLED],
      fromBlock: start,
      toBlock: end,
    });
    fixed.push(...logs);
  }
  return fixed;
}

const { slug: slugArg, seconds: SECONDS, outFile } = parseArgs();

const key = alchemyKeyFromEnv();
if (!key) {
  console.error(
    'Missing Alchemy key. Set ALCHEMY_KEY or POLYGON_RPC with alchemy URL in .env',
  );
  process.exit(1);
}

const provider = new JsonRpcProvider(`https://polygon-mainnet.g.alchemy.com/v2/${key}`);

const NOW = Math.floor(Date.now() / 1000);
const slot = Math.floor(NOW / 300) * 300;
const slug = slugArg || `sol-updown-5m-${slot}`;

const ev = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`).then((r) =>
  r.json(),
);
const m = ev[0]?.markets?.[0];
if (!m) {
  console.error(`No market for slug ${slug}`);
  process.exit(1);
}

const tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
const tokenUp = tokenIds[0];
const tokenDn = tokenIds[1];

const epoch = parseInt(slug.split('-').pop(), 10);
if (Number.isNaN(epoch)) {
  console.error('Could not parse epoch from slug');
  process.exit(1);
}

const windowEnd = epoch + 300;
const tsStart = windowEnd - SECONDS;
const tsEnd = windowEnd - 1;

const { fromBlock, toBlock } = await getBlockRangeForWindow(provider, tsStart, tsEnd);

const logs = await getLogsChunked(provider, fromBlock, toBlock);

const tsCache = new Map();
async function blockTs(bn) {
  if (tsCache.has(bn)) return tsCache.get(bn);
  const b = await provider.getBlock(bn);
  const t = b.timestamp;
  tsCache.set(bn, t);
  return t;
}

const fills = [];
for (const log of logs) {
  const row = decodeFillForMarket(log, tokenUp, tokenDn);
  if (!row) continue;
  const ts = await blockTs(row.blockNumber);
  if (ts < tsStart || ts > tsEnd) continue;
  fills.push({ ...row, unixSeconds: ts });
}

fills.sort((a, b) => {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
  return a.logIndex - b.logIndex;
});

const net = await provider.getNetwork();
const head = await provider.getBlockNumber();
const headBlock = await provider.getBlock(head);

const lines = [];
lines.push('# On-chain CTF Exchange OrderFilled (Polygon via Alchemy). price_per_share = usdc / shares for that fill.');
lines.push(`# slug=${slug} title=${JSON.stringify(m.question)}`);
lines.push(`# window_unix=${tsStart}..${tsEnd} (${SECONDS}s before 5m end) blocks=${fromBlock}..${toBlock}`);
lines.push(`# polygon_meta=${JSON.stringify({ chainId: Number(net.chainId), headBlock: head, headBlockTs: headBlock?.timestamp })}`);
lines.push(
  'unix_seconds,iso_utc,block_number,tx_hash,log_index,outcome,side,shares,usdc,price_per_share',
);

for (const f of fills) {
  lines.push(
    [
      f.unixSeconds,
      new Date(f.unixSeconds * 1000).toISOString(),
      f.blockNumber,
      f.txHash,
      f.logIndex,
      f.outcome,
      f.side,
      f.shares.toFixed(6),
      f.usdcSize.toFixed(6),
      f.price.toFixed(8),
    ].join(','),
  );
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
console.error(`Wrote ${outFile} (${fills.length} fills in last ${SECONDS}s of window)`);
if (fills.length === 0) {
  console.error(
    'No fills in that window (market may be illiquid or window already passed with no trades). Try a slug for an active/busy period.',
  );
}
