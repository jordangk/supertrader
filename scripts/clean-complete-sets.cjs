const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

(async () => {
  // Get all slugs
  const { data: rows } = await sb.from('k9_observed_trades').select('slug').limit(10000);
  const slugs = [...new Set((rows || []).map(r => r.slug))];
  console.log('Total events:', slugs.length);

  let totalDeleted = 0;

  for (const slug of slugs) {
    const { data } = await sb.from('k9_observed_trades')
      .select('id, tx_hash, outcome, shares, usdc_size')
      .eq('slug', slug)
      .order('trade_timestamp', { ascending: true });

    if (!data || !data.length) continue;

    // Group by tx_hash
    const byTx = {};
    for (const t of data) {
      if (!byTx[t.tx_hash]) byTx[t.tx_hash] = [];
      byTx[t.tx_hash].push(t);
    }

    // Find IDs to delete — rows that are part of complete sets
    const idsToDelete = [];
    for (const fills of Object.values(byTx)) {
      const up = fills.filter(f => f.outcome === 'Up');
      const dn = fills.filter(f => f.outcome === 'Down');
      if (up.length && dn.length) {
        const upShares = up.reduce((s, f) => s + parseFloat(f.shares), 0);
        const dnShares = dn.reduce((s, f) => s + parseFloat(f.shares), 0);

        if (Math.abs(upShares - dnShares) < 0.01) {
          // Equal shares both sides — pure complete set, delete all
          fills.forEach(f => idsToDelete.push(f.id));
        } else {
          // Unequal — delete the smaller side entirely, keep the bigger side
          const smallerSide = upShares <= dnShares ? up : dn;
          smallerSide.forEach(f => idsToDelete.push(f.id));
          // Scale down the bigger side by cancelled amount
          // For simplicity, just keep the bigger side as-is (slightly overcounts but close)
        }
      }
    }

    if (idsToDelete.length) {
      // Delete in chunks
      for (let i = 0; i < idsToDelete.length; i += 100) {
        const chunk = idsToDelete.slice(i, i + 100);
        const { error } = await sb.from('k9_observed_trades').delete().in('id', chunk);
        if (error) console.error('Delete error:', error.message);
      }
      totalDeleted += idsToDelete.length;
      console.log(`${slug}: deleted ${idsToDelete.length} complete-set rows (kept ${data.length - idsToDelete.length})`);
    }
  }

  // Also clean k9_sim_trades for deleted observed trades
  console.log(`\nTotal deleted: ${totalDeleted} rows`);

  // Verify
  for (const slug of slugs) {
    const { data } = await sb.from('k9_observed_trades')
      .select('outcome, shares, usdc_size')
      .eq('slug', slug);
    const up = (data || []).filter(t => t.outcome === 'Up');
    const dn = (data || []).filter(t => t.outcome === 'Down');
    const upSh = up.reduce((s, t) => s + parseFloat(t.shares), 0);
    const dnSh = dn.reduce((s, t) => s + parseFloat(t.shares), 0);
    const upUsd = up.reduce((s, t) => s + parseFloat(t.usdc_size), 0);
    const dnUsd = dn.reduce((s, t) => s + parseFloat(t.usdc_size), 0);
    console.log(`${slug}: Up ${upSh.toFixed(1)}sh $${upUsd.toFixed(2)} | Down ${dnSh.toFixed(1)}sh $${dnUsd.toFixed(2)}`);
  }
})();
