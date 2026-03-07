import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

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

// Check most recent k9 trade on the 5pm hourly event
const { data } = await supabase.from('k9_observed_trades')
  .select('slug, outcome, shares, usdc_size, trade_timestamp, tx_hash')
  .eq('slug', 'bitcoin-up-or-down-march-6-5pm-et')
  .order('trade_timestamp', { ascending: false })
  .limit(10);

console.log('Latest k9 trades on bitcoin-up-or-down-march-6-5pm-et:');
for (const t of (data || [])) {
  const ts = new Date(parseFloat(t.trade_timestamp) * 1000).toISOString();
  const sh = parseFloat(t.shares);
  console.log(`  ${ts}  ${sh > 0 ? 'BUY ' : 'SELL'} ${t.outcome.padEnd(5)} ${Math.abs(sh).toFixed(2).padStart(8)}sh  $${Math.abs(parseFloat(t.usdc_size)).toFixed(2).padStart(8)}`);
}

// Check current time
console.log(`\nCurrent time: ${new Date().toISOString()}`);
if (data?.length) {
  const lastTs = parseFloat(data[0].trade_timestamp);
  const ago = Math.floor(Date.now() / 1000) - lastTs;
  console.log(`Last k9 hourly trade: ${ago}s ago (${Math.floor(ago / 60)}m)`);
}
