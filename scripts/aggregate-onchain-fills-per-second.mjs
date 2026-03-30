#!/usr/bin/env node
/**
 * From an on-chain fills CSV (export-onchain-fills-last30s.mjs output), build one row per
 * calendar second with **volume-weighted** average price (sum USDC / sum shares) per outcome
 * for BUY fills. Sells are listed separately as VWAP sell (optional columns).
 *
 * Usage:
 *   node scripts/aggregate-onchain-fills-per-second.mjs csv_exports/foo.csv
 *   node scripts/aggregate-onchain-fills-per-second.mjs --in=a.csv --out=b.csv
 */

import fs from 'fs';
import path from 'path';

function parseArgs() {
  const argv = process.argv.slice(2);
  let inFile = null;
  let outFile = null;
  for (const a of argv) {
    if (a.startsWith('--in=')) inFile = a.slice(5);
    else if (a.startsWith('--out=')) outFile = a.slice(6);
    else if (!a.startsWith('-')) inFile = a;
  }
  return { inFile, outFile };
}

const { inFile, outFile: outArg } = parseArgs();
if (!inFile) {
  console.error('Usage: node scripts/aggregate-onchain-fills-per-second.mjs <fills.csv> [--out=out.csv]');
  process.exit(1);
}

const raw = fs.readFileSync(inFile, 'utf8');
const lines = raw.split(/\n/).filter((l) => l.trim() && !l.startsWith('#'));

let tsLo = Infinity;
let tsHi = -Infinity;
const rows = [];
for (const l of lines) {
  const p = l.split(',');
  if (p[0] === 'unix_seconds') continue;
  const unix = +p[0];
  if (Number.isNaN(unix)) continue;
  tsLo = Math.min(tsLo, unix);
  tsHi = Math.max(tsHi, unix);
  rows.push({
    unix,
    outcome: p[5],
    side: p[6],
    shares: +p[7],
    usdc: +p[8],
  });
}

// Full 30s window from comment if present, else span of data
let windowLo = tsLo;
let windowHi = tsHi;
const m = raw.match(/window_unix=(\d+)\.\.(\d+)/);
if (m) {
  windowLo = +m[1];
  windowHi = +m[2];
}

const bySec = new Map();
for (let t = windowLo; t <= windowHi; t++) {
  bySec.set(t, {
    upBuyU: 0,
    upBuyS: 0,
    dnBuyU: 0,
    dnBuyS: 0,
    upSellU: 0,
    upSellS: 0,
    dnSellU: 0,
    dnSellS: 0,
    n: 0,
  });
}

for (const r of rows) {
  const b = bySec.get(r.unix);
  if (!b) continue;
  b.n++;
  if (r.outcome === 'Up' && r.side === 'buy') {
    b.upBuyU += r.usdc;
    b.upBuyS += r.shares;
  }
  if (r.outcome === 'Down' && r.side === 'buy') {
    b.dnBuyU += r.usdc;
    b.dnBuyS += r.shares;
  }
  if (r.outcome === 'Up' && r.side === 'sell') {
    b.upSellU += r.usdc;
    b.upSellS += r.shares;
  }
  if (r.outcome === 'Down' && r.side === 'sell') {
    b.dnSellU += r.usdc;
    b.dnSellS += r.shares;
  }
}

const outLines = [];
outLines.push(
  '# Per-second volume-weighted avg: up_buy_vwap = sum(usdc)/sum(shares) for Up buys in that second.',
);
outLines.push(`# source=${path.basename(inFile)}`);
outLines.push(
  [
    'second_index',
    'unix_seconds',
    'iso_utc',
    'up_buy_vwap',
    'down_buy_vwap',
    'up_sell_vwap',
    'down_sell_vwap',
    'fills_in_second',
  ].join(','),
);

let idx = 0;
for (let t = windowLo; t <= windowHi; t++) {
  const b = bySec.get(t);
  const upBuy = b.upBuyS > 0 ? b.upBuyU / b.upBuyS : '';
  const dnBuy = b.dnBuyS > 0 ? b.dnBuyU / b.dnBuyS : '';
  const upSell = b.upSellS > 0 ? b.upSellU / b.upSellS : '';
  const dnSell = b.dnSellS > 0 ? b.dnSellU / b.dnSellS : '';
  outLines.push(
    [
      idx,
      t,
      new Date(t * 1000).toISOString(),
      upBuy === '' ? '' : upBuy.toFixed(8),
      dnBuy === '' ? '' : dnBuy.toFixed(8),
      upSell === '' ? '' : upSell.toFixed(8),
      dnSell === '' ? '' : dnSell.toFixed(8),
      b.n,
    ].join(','),
  );
  idx++;
}

const outFile = outArg || inFile.replace(/\.csv$/i, '_per_second.csv');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, outLines.join('\n') + '\n', 'utf8');
console.error(`Wrote ${outFile} (${idx} rows)`);
