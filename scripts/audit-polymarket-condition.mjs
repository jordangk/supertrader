#!/usr/bin/env node
/**
 * Audit Polymarket resolution on Polygon via Alchemy (JSON-RPC).
 *
 * Reads Conditional Tokens payout numerators/denominator for a market condition.
 * Optionally resolves conditionId from Gamma API using the event slug.
 *
 * Usage:
 *   node scripts/audit-polymarket-condition.mjs sol-updown-5m-1774454400
 *   node scripts/audit-polymarket-condition.mjs --conditionId=0xa26b8b9a9c6b39181516c7acb3dc53a66a2cca38d62635fdf5056101866f3674
 *
 * Env (required):
 *   ALCHEMY_KEY — Polygon Alchemy API key (set in shell or project root `.env`)
 */

import 'dotenv/config';
import { Contract, JsonRpcProvider } from 'ethers';
import fs from 'fs';

const CONDITIONAL_TOKENS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

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

const key = alchemyKeyFromEnv();
if (!key) {
  console.error(
    'Missing Alchemy credentials. Set one of:\n' +
      '  ALCHEMY_KEY=<your key>\n' +
      '  or POLYGON_RPC / POLYGON_RPC_URL / ALCHEMY_HTTP with a full URL like https://polygon-mainnet.g.alchemy.com/v2/<key>\n' +
      'in your shell or project root .env',
  );
  process.exit(1);
}
const RPC = `https://polygon-mainnet.g.alchemy.com/v2/${key}`;

const abi = [
  'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
];

function parseArgs() {
  const argv = process.argv.slice(2);
  let slug = null;
  let conditionId = null;
  let outPath = null;
  for (const a of argv) {
    if (a.startsWith('--conditionId=')) conditionId = a.slice('--conditionId='.length);
    else if (a.startsWith('--out=')) outPath = a.slice('--out='.length);
    else if (!a.startsWith('-')) slug = a;
  }
  return { slug, conditionId, outPath };
}

async function gammaSlug(slug) {
  const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  const data = await res.json();
  const ev = Array.isArray(data) ? data[0] : data;
  if (!ev?.markets?.[0]) throw new Error(`Gamma: no market for slug ${slug}`);
  const m = ev.markets[0];
  const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
  return {
    slug: ev.slug,
    title: m.question || ev.title,
    conditionId: m.conditionId,
    outcomes: outcomes || ['?', '?'],
    outcomePricesGamma: m.outcomePrices,
    clobTokenIds: typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds,
  };
}

async function audit(conditionId, meta = {}) {
  const provider = new JsonRpcProvider(RPC);
  const c = new Contract(CONDITIONAL_TOKENS, abi, provider);
  const denom = await c.payoutDenominator(conditionId);
  const n = [];
  for (let i = 0; i < (meta.outcomes?.length || 2); i++) {
    n.push(await c.payoutNumerators(conditionId, i));
  }
  const report = {
    auditedAt: new Date().toISOString(),
    rpc: RPC.replace(/\/v2\/.*/, '/v2/<key>'),
    contract: CONDITIONAL_TOKENS,
    conditionId,
    gamma: meta.slug ? meta : undefined,
    payoutDenominator: denom.toString(),
    payoutNumerators: Object.fromEntries(
      (meta.outcomes || ['index0', 'index1']).map((name, i) => [name, n[i]?.toString() ?? 'n/a']),
    ),
    resolvedOnChain: denom > 0n,
    note: 'Numerators are CTF payout weights vs denominator (binary: winning side = denominator).',
  };
  return report;
}

const { slug, conditionId: cidArg, outPath } = parseArgs();

try {
  let conditionId = cidArg;
  let meta = {};
  if (!conditionId) {
    const s = slug || 'sol-updown-5m-1774454400';
    meta = await gammaSlug(s);
    conditionId = meta.conditionId;
  } else {
    meta = { slug: slug || null, outcomes: ['Up', 'Down'] };
  }

  const report = await audit(conditionId, meta);
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (outPath) {
    fs.writeFileSync(outPath, text, 'utf8');
    console.error(`Wrote ${outPath}`);
  }
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
