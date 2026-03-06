#!/usr/bin/env node
/** Quick check: next split timing and whether we've already split for upcoming event */
const now = Date.now();
const nowSecs = Math.floor(now / 1000);
const nextSlot = (Math.floor(nowSecs / 300) + 1) * 300;
const preSplitStart = (nextSlot * 1000) - now - (15 * 1000);
const refreshAt = (nextSlot * 1000) - now + 2000;
const upcomingSlug = `btc-updown-5m-${nextSlot}`;

console.log('Next 5m event:', upcomingSlug);
console.log('Boundary:', new Date(nextSlot * 1000).toISOString());
console.log('Pre-split starts in:', preSplitStart > 0 ? Math.round(preSplitStart / 1000) + 's' : 'already passed / running');
console.log('Refresh (event switch) in:', Math.round(refreshAt / 1000) + 's');

// Check if we already split for upcoming
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

(async () => {
  const { data } = await sb.from('polymarket_trades').select('id, notes').eq('polymarket_event_id', nextSlot);
  const splits = (data || []).filter(r => {
    try { return r.notes && JSON.parse(r.notes).type === 'ctf-split'; } catch { return false; }
  });
  console.log('Split for next event:', splits.length >= 2 ? 'YES' : 'NO');
  if (splits.length >= 2) {
    const n = JSON.parse(splits[0].notes);
    console.log('  Amount:', '$' + n.amount);
  }
})();
