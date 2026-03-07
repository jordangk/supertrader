import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

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
const FUNDER = '0x53D395D95538d7B0A6346770378c79001e2360Ee';

async function getResolution(slug) {
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    const events = await r.json();
    if (!events?.length) return null;
    const ev = events[0];
    if (!ev.closed) return { closed: false, winner: null };
    for (const m of (ev.markets || [])) {
      const prices = JSON.parse(m.outcomePrices || '[]');
      if (prices[0] === '1') return { closed: true, winner: 'Up' };
      if (prices[1] === '1') return { closed: true, winner: 'Down' };
    }
    return { closed: true, winner: null };
  } catch { return null; }
}

async function fetchAllK9(slugs) {
  let all = [];
  for (const slug of slugs) {
    let offset = 0;
    while (true) {
      const { data } = await supabase.from('k9_observed_trades')
        .select('*').eq('slug', slug)
        .order('trade_timestamp', { ascending: true })
        .range(offset, offset + 999);
      if (!data || !data.length) break;
      all = all.concat(data);
      if (data.length < 1000) break;
      offset += 1000;
    }
  }
  return all;
}

(async () => {
  // 1. Get our trades
  const ourRes = await fetch(`https://data-api.polymarket.com/trades?user=${FUNDER}&limit=2000`);
  const ourAll = await ourRes.json();
  console.log(`Our trades: ${ourAll.length}`);

  // Get unique slugs, sorted newest first
  const slugSet = [...new Set(ourAll.map(t => t.eventSlug || t.slug).filter(Boolean))];
  const sorted = slugSet.sort((a, b) => {
    const ea = parseInt(a.split('-').pop()) || 0;
    const eb = parseInt(b.split('-').pop()) || 0;
    return eb - ea;
  }).slice(0, 15);
  console.log(`Events (newest first): ${sorted.length}`);

  // 2. Get k9 trades (paginated per slug)
  console.log('Fetching k9 trades...');
  const k9All = await fetchAllK9(sorted);
  console.log(`k9 trades fetched: ${k9All.length}`);

  // 3. Get resolutions
  console.log('Fetching resolutions...');
  const resolutions = {};
  for (const slug of sorted) {
    resolutions[slug] = await getResolution(slug);
    console.log(`  ${slug} -> ${resolutions[slug]?.winner || 'pending'}`);
  }

  // 4. Build CSVs
  const summaryRows = [['slug','winner','k9_buy_usdc','k9_buy_shares','k9_sell_usdc','k9_sell_shares','k9_net_shares','k9_pnl','us_buy_usdc','us_buy_shares','us_sell_usdc','us_sell_shares','us_net_shares','us_pnl','k9_trades','us_trades','pnl_diff']];
  const detailRows = [['slug','who','outcome','side','price','shares','usdc','timestamp']];

  for (const slug of sorted) {
    const k9Trades = k9All.filter(t => t.slug === slug);
    const ourTrades = ourAll.filter(t => (t.eventSlug || t.slug) === slug);
    const res = resolutions[slug];

    // k9 summary
    const k9Sum = {};
    for (const side of ['Up', 'Down']) {
      const kt = k9Trades.filter(t => t.outcome === side);
      const buys = kt.filter(t => parseFloat(t.shares) > 0);
      const sells = kt.filter(t => parseFloat(t.shares) < 0);
      k9Sum[side] = {
        buyUsdc: buys.reduce((s, t) => s + parseFloat(t.usdc_size), 0),
        buyShares: buys.reduce((s, t) => s + parseFloat(t.shares), 0),
        sellUsdc: sells.reduce((s, t) => s + Math.abs(parseFloat(t.usdc_size)), 0),
        sellShares: sells.reduce((s, t) => s + Math.abs(parseFloat(t.shares)), 0),
      };
      k9Sum[side].netShares = k9Sum[side].buyShares - k9Sum[side].sellShares;
    }

    // our summary
    const ourSum = {};
    for (const side of ['Up', 'Down']) {
      const ot = ourTrades.filter(t => {
        const o = (t.outcome || t.title || '');
        return side === 'Up' ? o.includes('Up') : o.includes('Down');
      });
      const buys = ot.filter(t => (t.side || '').toUpperCase() === 'BUY');
      const sells = ot.filter(t => (t.side || '').toUpperCase() === 'SELL');
      ourSum[side] = {
        buyUsdc: buys.reduce((s, t) => s + parseFloat(t.size || 0) * parseFloat(t.price || 0), 0),
        buyShares: buys.reduce((s, t) => s + parseFloat(t.size || 0), 0),
        sellUsdc: sells.reduce((s, t) => s + parseFloat(t.size || 0) * parseFloat(t.price || 0), 0),
        sellShares: sells.reduce((s, t) => s + parseFloat(t.size || 0), 0),
      };
      ourSum[side].netShares = ourSum[side].buyShares - ourSum[side].sellShares;
    }

    // P&L
    const winner = res?.winner;
    function calcPnl(sum) {
      if (!winner) return null;
      const payout = sum[winner]?.netShares || 0;
      const totalCost = (sum.Up?.buyUsdc || 0) + (sum.Down?.buyUsdc || 0);
      const totalSellProceeds = (sum.Up?.sellUsdc || 0) + (sum.Down?.sellUsdc || 0);
      return payout + totalSellProceeds - totalCost;
    }

    const k9Pnl = calcPnl(k9Sum);
    const ourPnl = calcPnl(ourSum);
    const pnlDiff = k9Pnl != null && ourPnl != null ? (k9Pnl - ourPnl) : '';

    summaryRows.push([
      slug, winner || 'pending',
      (k9Sum.Up.buyUsdc + k9Sum.Down.buyUsdc).toFixed(2),
      (k9Sum.Up.buyShares + k9Sum.Down.buyShares).toFixed(2),
      (k9Sum.Up.sellUsdc + k9Sum.Down.sellUsdc).toFixed(2),
      (k9Sum.Up.sellShares + k9Sum.Down.sellShares).toFixed(2),
      (k9Sum.Up.netShares + k9Sum.Down.netShares).toFixed(2),
      k9Pnl != null ? k9Pnl.toFixed(2) : '',
      (ourSum.Up.buyUsdc + ourSum.Down.buyUsdc).toFixed(2),
      (ourSum.Up.buyShares + ourSum.Down.buyShares).toFixed(2),
      (ourSum.Up.sellUsdc + ourSum.Down.sellUsdc).toFixed(2),
      (ourSum.Up.sellShares + ourSum.Down.sellShares).toFixed(2),
      (ourSum.Up.netShares + ourSum.Down.netShares).toFixed(2),
      ourPnl != null ? ourPnl.toFixed(2) : '',
      k9Trades.length, ourTrades.length,
      typeof pnlDiff === 'number' ? pnlDiff.toFixed(2) : '',
    ]);

    // Detail rows - k9
    for (const t of k9Trades) {
      const sh = parseFloat(t.shares);
      detailRows.push([
        slug, 'k9', t.outcome, sh > 0 ? 'buy' : 'sell',
        parseFloat(t.price).toFixed(4),
        Math.abs(sh).toFixed(4),
        Math.abs(parseFloat(t.usdc_size)).toFixed(2),
        new Date(parseFloat(t.trade_timestamp) * 1000).toISOString(),
      ]);
    }

    // Detail rows - us
    for (const t of ourTrades) {
      const outcome = (t.outcome || t.title || '').includes('Up') ? 'Up' : 'Down';
      detailRows.push([
        slug, 'us', outcome, (t.side || '').toLowerCase(),
        parseFloat(t.price || 0).toFixed(4),
        parseFloat(t.size || 0).toFixed(4),
        (parseFloat(t.size || 0) * parseFloat(t.price || 0)).toFixed(2),
        t.timestamp ? new Date(t.timestamp * 1000).toISOString() : '',
      ]);
    }
  }

  mkdirSync('/Users/jordangk/Desktop/supert/supertrader/csv_exports', { recursive: true });
  writeFileSync('/Users/jordangk/Desktop/supert/supertrader/csv_exports/event_summary.csv', summaryRows.map(r => r.join(',')).join('\n'));
  writeFileSync('/Users/jordangk/Desktop/supert/supertrader/csv_exports/trade_detail.csv', detailRows.map(r => r.join(',')).join('\n'));

  console.log('\n=== EVENT SUMMARY ===');
  console.log('slug | winner | k9_pnl | us_pnl | k9_trades | us_trades | pnl_diff');
  for (const r of summaryRows.slice(1)) {
    const [slug, winner, , , , , , k9p, , , , , , usp, k9t, ust, diff] = r;
    const short = slug.replace('btc-updown-', '').replace('sol-updown-', 'SOL-');
    console.log(`${short.padEnd(20)} ${(winner||'').padEnd(7)} k9=$${(k9p||'?').toString().padStart(8)} us=$${(usp||'?').toString().padStart(8)} k9t=${k9t.toString().padStart(5)} ust=${ust.toString().padStart(4)} diff=$${(diff||'').toString().padStart(8)}`);
  }

  console.log(`\nFiles: csv_exports/event_summary.csv, csv_exports/trade_detail.csv`);
  console.log(`Detail rows: ${detailRows.length - 1}`);
})().catch(e => console.error(e));
