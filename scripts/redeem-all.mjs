/**
 * Manual bulk redeem. Loops the gasless redeemer until no redeemable positions remain
 * (or until N cycles). Handles gasless rate-limits and low POL gracefully.
 *
 * Usage:
 *   node scripts/redeem-all.mjs           # up to 40 cycles, 15s between
 *   node scripts/redeem-all.mjs 20 10     # 20 cycles, 10s between
 */
import 'dotenv/config';
import { gaslessRedeem } from './auto-redeem-gasless.mjs';

const MAX_CYCLES = parseInt(process.argv[2] || '40');
const SLEEP_SEC = parseInt(process.argv[3] || '15');
const FUNDER = process.env.FUNDER_ADDRESS?.toLowerCase();

async function countRedeemable() {
  try {
    const r = await fetch(`https://data-api.polymarket.com/positions?user=${FUNDER}&sizeThreshold=0.01&limit=200`);
    if (!r.ok) return { n: -1, $: 0 };
    const d = await r.json();
    const rs = (d || []).filter(p => p.redeemable);
    return { n: rs.length, $: rs.reduce((s, p) => s + parseFloat(p.size || 0), 0) };
  } catch { return { n: -1, $: 0 }; }
}

const start = await countRedeemable();
console.log(`[redeem-all] Start: ${start.n} redeemable, $${start.$.toFixed(2)}`);

let lastN = start.n;
let sameCount = 0;
for (let i = 1; i <= MAX_CYCLES; i++) {
  console.log(`\n=== Cycle ${i}/${MAX_CYCLES} ===`);
  try { await gaslessRedeem(); } catch (e) { console.error('cycle err:', e.message?.slice(0, 100)); }
  const cur = await countRedeemable();
  console.log(`[redeem-all] After cycle ${i}: ${cur.n} redeemable, $${cur.$.toFixed(2)}`);
  if (cur.n === 0) { console.log('[redeem-all] ALL DRAINED ✓'); break; }
  // Detect stall: same count 3 cycles in a row → bail
  if (cur.n === lastN) sameCount++; else { sameCount = 0; lastN = cur.n; }
  if (sameCount >= 3) {
    console.log(`[redeem-all] Stalled at ${cur.n} positions for 3 cycles — likely rate-limited or out of POL. Stopping.`);
    break;
  }
  await new Promise(r => setTimeout(r, SLEEP_SEC * 1000));
}

const end = await countRedeemable();
console.log(`\n[redeem-all] DONE. Remaining: ${end.n} positions, $${end.$.toFixed(2)}`);
process.exit(0);
