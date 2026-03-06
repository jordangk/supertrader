#!/usr/bin/env node
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const slug = process.argv[2] || 'btc-updown-5m-1772807400';
const match = slug.match(/(\d{10,})/);
const eventId = match ? parseInt(match[1]) : null;

(async () => {
  if (!eventId) {
    console.log('Usage: node scripts/check_split.cjs <slug>');
    console.log('Example: node scripts/check_split.cjs btc-updown-5m-1772807400');
    return;
  }
  const { data, error } = await sb
    .from('polymarket_trades')
    .select('id, direction, shares, purchase_amount, purchase_time, notes')
    .eq('polymarket_event_id', eventId)
    .order('purchase_time', { ascending: true });

  if (error) {
    console.error('Error:', error.message);
    return;
  }
  const splits = (data || []).filter(r => {
    try {
      const n = r.notes ? JSON.parse(r.notes) : {};
      return n.type === 'ctf-split';
    } catch { return false; }
  });
  const split = splits.length >= 2;
  const amount = splits[0] ? JSON.parse(splits[0].notes || '{}').amount : null;
  console.log('Event:', slug);
  console.log('Event ID:', eventId);
  console.log('Split:', split ? 'YES' : 'NO');
  if (split) {
    console.log('Amount: $' + amount);
    console.log('Records:', splits.length, '(up + down)');
    for (const s of splits) {
      const n = JSON.parse(s.notes || '{}');
      console.log('  -', s.direction, s.shares, 'sh @ $0.50, tx:', n.txHash?.slice(0, 18) + '...');
    }
  }
})();
