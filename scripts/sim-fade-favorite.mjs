/**
 * Simulator: Fade the Favorite
 *
 * Piggybacks on the running arb campaigns — reads prices from
 * the server's /api/arb/campaigns endpoint (which has live book data).
 *
 * Strategy: When one side hits 80¢, simulate buying the other at price + 1¢.
 * On event resolution, check KS result and record P&L to DB.
 */
import 'dotenv/config';
import pg from 'pg';

const API = `http://localhost:${process.env.PORT || 3001}`;

const pool = new pg.Pool({
  host: 'aws-0-us-west-2.pooler.supabase.com',
  port: 6543,
  database: 'postgres',
  user: 'postgres.xiembvvkptvphoupflnz',
  password: process.env.DB_PASSWORD || 'QA?p4SbLfmN2b!@',
  ssl: { rejectUnauthorized: false },
});

const TRIGGER_PRICE = 0.80;
const SIM_SHARES = 10;
const POLL_MS = 10_000;

// In-memory: entered events
const entered = new Set();

async function boot() {
  const r = await pool.query('SELECT coin, event_start_ts FROM sim_fade_trades');
  for (const row of r.rows) entered.add(`${row.coin}-${row.event_start_ts}`);
  console.log(`[sim-fade] Restored ${entered.size} entered events`);
}

/**
 * Get live prices from the running server's campaign data
 */
async function getCampaignPrices() {
  try {
    const r = await fetch(`${API}/api/arb/campaigns`);
    if (!r.ok) return [];
    const d = await r.json();
    const campaigns = (d.campaigns || []).filter(c => c.status === 'running' && c.live);
    return campaigns;
  } catch {
    return [];
  }
}

/**
 * Extract slot start timestamp from a Kalshi ticker
 * e.g. KXBTC15M-26APR020130-30 → slot start unix
 */
function tickerToSlotStart(ticker) {
  const m = ticker?.match?.(/KX(\w+)15M-(\d{2})(\w{3})(\d{2})(\d{4})-(\d{2})/);
  if (!m) return null;
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const endUtc = new Date(Date.UTC(2000 + parseInt(m[2]), months[m[3]], parseInt(m[4]), parseInt(m[5].slice(0, 2)) + 4, parseInt(m[5].slice(2)), parseInt(m[6])));
  return Math.floor(endUtc.getTime() / 1000) - 900;
}

function coinFromType(recurringType) {
  if (!recurringType) return null;
  return recurringType.replace('15m', '').toUpperCase();
}

/**
 * Main price check — read from campaigns
 */
async function checkPrices() {
  const campaigns = await getCampaignPrices();

  for (const c of campaigns) {
    const coin = coinFromType(c.recurring_type);
    if (!coin) continue;

    const live = c.live;
    if (!live?.ksYes || !live?.ksNo) continue;

    // Get slot from the campaign's session ticker
    const ticker = c.kalshi_ticker || c.kalshi_url;
    const slotStart = tickerToSlotStart(ticker);
    if (!slotStart) continue;

    // Skip if event already ended (prices go to 100/0 at settlement)
    const now = Math.floor(Date.now() / 1000);
    if (now > slotStart + 900 - 30) continue; // skip last 30s of slot

    const key = `${coin}-${slotStart}`;
    if (entered.has(key)) continue;

    // Prices from both platforms
    const ksYesBid = live.ksYesBid;
    const ksNoBid = live.ksNoBid;
    const ksYesAsk = live.ksYes;
    const ksNoAsk = live.ksNo;
    const polyUpAsk = live.polyUp;
    const polyDownAsk = live.polyDown;
    const polyUpBid = live.polyUpBid;
    const polyDownBid = live.polyDownBid;

    // Skip if missing data
    if (!ksYesBid || !ksNoBid || !polyUpAsk || !polyDownAsk) continue;

    // Skip settled
    if (ksYesBid >= 0.99 || ksNoBid >= 0.99) continue;
    if (polyUpAsk >= 0.99 || polyDownAsk >= 0.99) continue;

    const polyAsset = coin.toLowerCase();
    const polySlug = `${polyAsset}-updown-15m-${slotStart}`;

    // Check which platform hit 80¢ first, buy same outcome on the OTHER (cheaper) platform
    // Poly UP = KS YES, Poly DOWN = KS NO
    let triggerSrc = null, triggerSide = null, triggerPrice = null;
    let buySide = null, buyPrice = null, buyLabel = null;
    let ksPriceAtTrigger = null, polyPriceAtTrigger = null;

    // Check UP/YES side
    const polyUpHit = polyUpBid && polyUpBid >= TRIGGER_PRICE;
    const ksYesHit = ksYesBid && ksYesBid >= TRIGGER_PRICE;
    // Check DOWN/NO side
    const polyDownHit = polyDownBid && polyDownBid >= TRIGGER_PRICE;
    const ksNoHit = ksNoBid && ksNoBid >= TRIGGER_PRICE;

    if (polyUpHit && ksYesAsk > 0.01 && ksYesAsk < polyUpBid) {
      // Poly UP hit 80¢ → buy KS YES
      triggerSrc = ksYesHit ? 'BOTH' : 'POLY';
      triggerSide = 'yes'; triggerPrice = polyUpBid;
      buySide = 'yes'; buyPrice = ksYesAsk; buyLabel = 'KS YES';
      ksPriceAtTrigger = ksYesBid; polyPriceAtTrigger = polyUpBid;
    } else if (ksYesHit && polyUpAsk > 0.01 && polyUpAsk < ksYesBid) {
      // KS YES hit 80¢ → buy Poly UP
      triggerSrc = 'KS';
      triggerSide = 'yes'; triggerPrice = ksYesBid;
      buySide = 'yes'; buyPrice = polyUpAsk; buyLabel = 'POLY UP';
      ksPriceAtTrigger = ksYesBid; polyPriceAtTrigger = polyUpBid;
    } else if (polyDownHit && ksNoAsk > 0.01 && ksNoAsk < polyDownBid) {
      // Poly DOWN hit 80¢ → buy KS NO
      triggerSrc = ksNoHit ? 'BOTH' : 'POLY';
      triggerSide = 'no'; triggerPrice = polyDownBid;
      buySide = 'no'; buyPrice = ksNoAsk; buyLabel = 'KS NO';
      ksPriceAtTrigger = ksNoBid; polyPriceAtTrigger = polyDownBid;
    } else if (ksNoHit && polyDownAsk > 0.01 && polyDownAsk < ksNoBid) {
      // KS NO hit 80¢ → buy Poly DOWN
      triggerSrc = 'KS';
      triggerSide = 'no'; triggerPrice = ksNoBid;
      buySide = 'no'; buyPrice = polyDownAsk; buyLabel = 'POLY DOWN';
      ksPriceAtTrigger = ksNoBid; polyPriceAtTrigger = polyDownBid;
    }

    if (!triggerSrc) continue;

    const gap = triggerPrice - buyPrice;
    const cost = buyPrice * SIM_SHARES;
    await pool.query(
      `INSERT INTO sim_fade_trades (coin, event_start_ts, kalshi_ticker, poly_slug, trigger_side, trigger_price, buy_side, buy_price, shares, cost, trigger_src, ks_price_at_trigger, poly_price_at_trigger, gap_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (coin, event_start_ts) DO NOTHING`,
      [coin, slotStart, ticker, polySlug, triggerSide, triggerPrice, buySide, buyPrice, SIM_SHARES, cost, triggerSrc, ksPriceAtTrigger, polyPriceAtTrigger, Math.round(gap * 100)],
    );
    entered.add(key);
    console.log(`[sim-fade] ${coin} ${triggerSrc} ${triggerSide === 'yes' ? 'UP' : 'DOWN'}@${(triggerPrice * 100).toFixed(0)}¢ → BUY ${buyLabel} @ ${(buyPrice * 100).toFixed(0)}¢ ($${cost.toFixed(2)}) | KS:${(ksPriceAtTrigger*100).toFixed(0)}¢ Poly:${(polyPriceAtTrigger*100).toFixed(0)}¢ gap:${(gap * 100).toFixed(0)}¢ | slot:${slotStart}`);
  }
}

/**
 * Resolve settled events
 */
async function resolveEvents() {
  try {
    const r = await pool.query('SELECT * FROM sim_fade_trades WHERE result IS NULL ORDER BY ts LIMIT 50');
    if (!r.rows.length) return;

    // Use the server's session data to check results
    const campaigns = await getCampaignPrices();

    for (const trade of r.rows) {
      // Check if this event's slot has passed (> 900s ago)
      const now = Math.floor(Date.now() / 1000);
      const eventEnd = parseInt(trade.event_start_ts) + 900;
      if (now < eventEnd + 60) continue; // wait at least 60s after event end

      // Try to get result from Kalshi via the server
      try {
        const sr = await fetch(`${API}/api/arb/sessions`);
        if (!sr.ok) continue;
        const sd = await sr.json();
        // Look for a resolved session with this ticker
        const session = (sd.sessions || []).find(s => s.kalshi_ticker === trade.kalshi_ticker);
        if (session?.kalshi_result) {
          const result = session.kalshi_result;
          const won = result === trade.buy_side;
          const payout = won ? SIM_SHARES * 1.0 : 0;
          const pnl = payout - parseFloat(trade.cost);

          await pool.query(
            'UPDATE sim_fade_trades SET result = $1, payout = $2, pnl = $3, resolved_at = NOW() WHERE id = $4',
            [result, payout, pnl, trade.id],
          );
          const tag = won ? '✓ WIN' : '✗ LOSE';
          console.log(`[sim-fade] ${tag} ${trade.coin} bought ${trade.buy_side.toUpperCase()} @ ${(parseFloat(trade.buy_price) * 100).toFixed(0)}¢ → result=${result} pnl=$${pnl.toFixed(2)}`);
          continue;
        }
      } catch {}

      // Fallback: if event ended > 20min ago and no result from sessions, try Kalshi API directly
      if (now > eventEnd + 1200) {
        try {
          // Use kalshiFetch if available, otherwise just mark as timeout
          const { kalshiFetch } = await import('../lib/kalshiAuth.mjs');
          const { KALSHI_TRADE_API } = await import('../lib/kalshiPrice.mjs');
          const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets/${trade.kalshi_ticker}`);
          if (mr.ok) {
            const md = await mr.json();
            const result = md.market?.result;
            if (result && result !== 'pending') {
              const won = result === trade.buy_side;
              const payout = won ? SIM_SHARES * 1.0 : 0;
              const pnl = payout - parseFloat(trade.cost);
              await pool.query(
                'UPDATE sim_fade_trades SET result = $1, payout = $2, pnl = $3, resolved_at = NOW() WHERE id = $4',
                [result, payout, pnl, trade.id],
              );
              const tag = won ? '✓ WIN' : '✗ LOSE';
              console.log(`[sim-fade] ${tag} ${trade.coin} bought ${trade.buy_side.toUpperCase()} @ ${(parseFloat(trade.buy_price) * 100).toFixed(0)}¢ → result=${result} pnl=$${pnl.toFixed(2)} (via KS API)`);
            }
          }
          await new Promise(r => setTimeout(r, 300));
        } catch {}
      }
    }
  } catch (e) {
    console.error('[sim-fade] Resolve error:', e.message?.slice(0, 100));
  }
}

async function printSummary() {
  const r = await pool.query(`
    SELECT coin,
      COUNT(*) FILTER (WHERE result IS NOT NULL) AS settled,
      COUNT(*) FILTER (WHERE result IS NULL) AS pending,
      COUNT(*) FILTER (WHERE pnl > 0) AS wins,
      COUNT(*) FILTER (WHERE pnl <= 0 AND result IS NOT NULL) AS losses,
      COALESCE(SUM(pnl) FILTER (WHERE result IS NOT NULL), 0) AS total_pnl,
      COALESCE(AVG(buy_price) FILTER (WHERE result IS NOT NULL), 0) AS avg_entry
    FROM sim_fade_trades
    GROUP BY coin ORDER BY coin
  `);
  if (!r.rows.length) return;
  console.log('\n[sim-fade] === SUMMARY ===');
  let grandPnl = 0, grandSettled = 0, grandWins = 0;
  for (const row of r.rows) {
    const s = parseInt(row.settled);
    const w = parseInt(row.wins);
    const winRate = s > 0 ? (w / s * 100).toFixed(0) : '—';
    const pnl = parseFloat(row.total_pnl);
    grandPnl += pnl; grandSettled += s; grandWins += w;
    console.log(`  ${row.coin}: ${s} settled (${w}W/${row.losses}L ${winRate}%) avg@${(parseFloat(row.avg_entry) * 100).toFixed(0)}¢ P&L: $${pnl.toFixed(2)} | ${row.pending} pending`);
  }
  const totalWinRate = grandSettled > 0 ? (grandWins / grandSettled * 100).toFixed(0) : '—';
  console.log(`  TOTAL: ${grandSettled} trades ${totalWinRate}% win  P&L: $${grandPnl.toFixed(2)}\n`);
}

// ── Main loop ──
async function run() {
  await boot();
  console.log(`[sim-fade] Running: trigger=${TRIGGER_PRICE * 100}¢, shares=${SIM_SHARES}, poll=${POLL_MS / 1000}s`);
  console.log(`[sim-fade] Reading prices from ${API}/api/arb/campaigns`);

  let tickCount = 0;
  const tick = async () => {
    try {
      await checkPrices();
      tickCount++;
      if (tickCount % 6 === 0) await resolveEvents();   // every ~60s
      if (tickCount % 90 === 0) await printSummary();   // every ~15min
    } catch (e) {
      console.error('[sim-fade] Tick error:', e.message?.slice(0, 100));
    }
    setTimeout(tick, POLL_MS);
  };
  tick();
}

run();
