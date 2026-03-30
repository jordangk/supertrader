import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';

const env = {};
readFileSync('/Users/jordangk/Desktop/supert/supertrader/.env', 'utf8').split('\n').forEach(line => {
  const eq = line.indexOf('=');
  if (eq > 0) {
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k && !k.startsWith('#')) env[k] = v;
  }
});

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

// Fetch all hourly k9 trades
let all = [];
let offset = 0;
while (true) {
  const { data } = await supabase.from('k9_observed_trades')
    .select('slug, outcome, shares, usdc_size, price, trade_timestamp')
    .like('slug', 'bitcoin-up-or-down%')
    .order('trade_timestamp', { ascending: false })
    .range(offset, offset + 999);
  if (!data || !data.length) break;
  all = all.concat(data);
  if (data.length < 1000) break;
  offset += 1000;
}
console.log(`Fetched ${all.length} k9 hourly trades`);

// Group by slug
const bySlug = {};
for (const t of all) {
  if (!bySlug[t.slug]) bySlug[t.slug] = [];
  bySlug[t.slug].push(t);
}
const slugs = Object.keys(bySlug).sort((a, b) => {
  const aTs = bySlug[a][0].trade_timestamp;
  const bTs = bySlug[b][0].trade_timestamp;
  return parseFloat(bTs) - parseFloat(aTs);
});

// Get resolutions
console.log('Fetching resolutions...');
const resolutions = {};
for (const slug of slugs) {
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    const events = await r.json();
    const ev = events?.[0];
    let winner = null;
    if (ev?.closed) {
      for (const m of (ev.markets || [])) {
        const prices = JSON.parse(m.outcomePrices || '[]');
        if (prices[0] === '1') winner = 'Up';
        if (prices[1] === '1') winner = 'Down';
      }
    }
    resolutions[slug] = { winner, closed: ev?.closed || false };
  } catch {
    resolutions[slug] = { winner: null, closed: false };
  }
}

// Build summary data
const events = [];
for (const slug of slugs) {
  const trades = bySlug[slug];
  const sum = (arr, field) => arr.reduce((s, t) => s + Math.abs(parseFloat(t[field])), 0);
  const upBuys = trades.filter(t => t.outcome === 'Up' && parseFloat(t.shares) > 0);
  const upSells = trades.filter(t => t.outcome === 'Up' && parseFloat(t.shares) < 0);
  const dnBuys = trades.filter(t => t.outcome === 'Down' && parseFloat(t.shares) > 0);
  const dnSells = trades.filter(t => t.outcome === 'Down' && parseFloat(t.shares) < 0);

  events.push({
    slug,
    short: slug.replace('bitcoin-up-or-down-', ''),
    count: trades.length,
    upBuyS: sum(upBuys, 'shares'), upBuyU: sum(upBuys, 'usdc_size'),
    upSellS: sum(upSells, 'shares'), upSellU: sum(upSells, 'usdc_size'),
    dnBuyS: sum(dnBuys, 'shares'), dnBuyU: sum(dnBuys, 'usdc_size'),
    dnSellS: sum(dnSells, 'shares'), dnSellU: sum(dnSells, 'usdc_size'),
    winner: resolutions[slug]?.winner || null,
  });
}

function calcPnl(d) {
  if (!d.winner) return null;
  const netUp = d.upBuyS - d.upSellS;
  const netDn = d.dnBuyS - d.dnSellS;
  const payout = d.winner === 'Up' ? netUp : netDn;
  const totalCost = d.upBuyU + d.dnBuyU;
  const totalSell = d.upSellU + d.dnSellU;
  return payout + totalSell - totalCost;
}

function fmt(n) { return n >= 0 ? `+$${n.toFixed(0)}` : `-$${Math.abs(n).toFixed(0)}`; }
function fmtU(n) { return `$${n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`; }

let totalPnl = 0, totalVol = 0, wins = 0, losses = 0;

const lines = [];
lines.push('# K9 Hourly BTC Trades — March 5-6, 2026');
lines.push('');
lines.push(`> ${all.length.toLocaleString()} trades across ${slugs.length} hourly events`);
lines.push('');
lines.push('## Event Summary');
lines.push('');
lines.push('| Event | Winner | Trades | Volume | Up Net | Down Net | P&L |');
lines.push('|-------|--------|-------:|-------:|-------:|---------:|----:|');

for (const d of events) {
  const p = calcPnl(d);
  const vol = d.upBuyU + d.dnBuyU + d.upSellU + d.dnSellU;
  const netUp = (d.upBuyS - d.upSellS).toFixed(0);
  const netDn = (d.dnBuyS - d.dnSellS).toFixed(0);
  const pStr = p !== null ? fmt(p) : 'pending';
  const wStr = d.winner || '...';
  if (p !== null) {
    totalPnl += p;
    totalVol += vol;
    if (p > 0) wins++;
    else losses++;
  }
  const bold = p !== null && Math.abs(p) > 5000 ? '**' : '';
  lines.push(`| ${d.short} | ${wStr} | ${d.count} | ${fmtU(vol)} | ${netUp} | ${netDn} | ${bold}${pStr}${bold} |`);
}

lines.push('');
lines.push('## Totals (resolved events only)');
lines.push('');
lines.push('| Metric | Value |');
lines.push('|--------|------:|');
lines.push(`| Total P&L | **${fmt(totalPnl)}** |`);
lines.push(`| Total Volume | ${fmtU(totalVol)} |`);
lines.push(`| Win / Loss | ${wins}W / ${losses}L |`);
lines.push(`| Win Rate | ${((wins / (wins + losses)) * 100).toFixed(0)}% |`);
lines.push(`| Events | ${events.length} (${events.length - events.filter(d => !d.winner).length} resolved) |`);
lines.push(`| Total Trades | ${all.length.toLocaleString()} |`);

// Top wins/losses
const resolved = events.filter(d => d.winner).map(d => ({ short: d.short, pnl: calcPnl(d), count: d.count, vol: d.upBuyU + d.dnBuyU + d.upSellU + d.dnSellU })).sort((a, b) => b.pnl - a.pnl);

lines.push('');
lines.push('## Top 5 Wins');
lines.push('');
for (const r of resolved.slice(0, 5)) {
  lines.push(`- **${r.short}**: ${fmt(r.pnl)} (${r.count} trades, ${fmtU(r.vol)} volume)`);
}

lines.push('');
lines.push('## Top 5 Losses');
lines.push('');
for (const r of resolved.slice(-5).reverse()) {
  lines.push(`- **${r.short}**: ${fmt(r.pnl)} (${r.count} trades, ${fmtU(r.vol)} volume)`);
}

// Strategy pattern
const downWins = resolved.filter(r => r.short && events.find(e => e.short === r.short)?.winner === 'Down');
const upWins = resolved.filter(r => r.short && events.find(e => e.short === r.short)?.winner === 'Up');
lines.push('');
lines.push('## Pattern Analysis');
lines.push('');
lines.push(`- **Down wins**: ${downWins.length} events, avg P&L: ${fmt(downWins.reduce((s, r) => s + r.pnl, 0) / downWins.length)}`);
lines.push(`- **Up wins**: ${upWins.length} events, avg P&L: ${fmt(upWins.reduce((s, r) => s + r.pnl, 0) / upWins.length)}`);

const md = lines.join('\n');
writeFileSync('/Users/jordangk/Desktop/supert/supertrader/csv_exports/k9_hourly_trades.md', md);
console.log('\nWritten to csv_exports/k9_hourly_trades.md');
console.log(`\nTotals: ${fmt(totalPnl)} P&L | ${wins}W/${losses}L | ${fmtU(totalVol)} volume`);
