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

// Get k9 trades - fetch all with pagination
let all = [];
let offset = 0;
while (true) {
  const { data } = await supabase.from('k9_observed_trades')
    .select('slug, trade_timestamp')
    .order('trade_timestamp', { ascending: false })
    .range(offset, offset + 999);
  if (!data || !data.length) break;
  all = all.concat(data);
  if (data.length < 1000) break;
  offset += 1000;
}

const counts = {};
for (const r of all) {
  counts[r.slug] = (counts[r.slug] || 0) + 1;
}

const sorted = Object.entries(counts).sort((a, b) => {
  const ea = parseInt(a[0].split('-').pop()) || 0;
  const eb = parseInt(b[0].split('-').pop()) || 0;
  return eb - ea;
});

console.log(`Total k9 trades: ${all.length}`);
console.log(`Total k9 events: ${sorted.length}`);
console.log('\nK9 events (newest first):');
for (const [slug, count] of sorted.slice(0, 25)) {
  console.log(`  ${slug}: ${count} trades`);
}
