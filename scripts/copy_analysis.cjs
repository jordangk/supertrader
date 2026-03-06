const {createClient}=require("@supabase/supabase-js");
require("dotenv").config();
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_KEY);

const PCTS = [1, 5, 10, 20, 50];

async function fetchAllTrades() {
  let all = [];
  let from = 0;
  const batch = 1000;
  while(true) {
    const {data} = await sb.from("k9_observed_trades")
      .select("slug,outcome,shares,usdc_size,price,trade_timestamp")
      .order("id",{ascending:true})
      .range(from, from+batch-1);
    if(!data || !data.length) break;
    all = all.concat(data);
    if(data.length < batch) break;
    from += batch;
  }
  return all;
}

(async()=>{
  const allTrades = await fetchAllTrades();
  console.log(`Loaded ${allTrades.length} total trades\n`);

  // Group by slug
  const bySlug={};
  for(const t of allTrades){
    if(!bySlug[t.slug]) bySlug[t.slug]={Up:{bought:0,sold:0,cost:0,rev:0},Down:{bought:0,sold:0,cost:0,rev:0},count:0,firstTs:parseInt(t.trade_timestamp)||0};
    bySlug[t.slug].count++;
    const sh=Math.abs(parseFloat(t.shares));
    const usd=Math.abs(parseFloat(t.usdc_size));
    const out=t.outcome;
    if(!bySlug[t.slug][out]) bySlug[t.slug][out]={bought:0,sold:0,cost:0,rev:0};
    if(parseFloat(t.shares)>0){
      bySlug[t.slug][out].bought+=sh;
      bySlug[t.slug][out].cost+=usd;
    } else {
      bySlug[t.slug][out].sold+=sh;
      bySlug[t.slug][out].rev+=usd;
    }
  }

  // Check resolution via gamma API
  const results = [];
  for(const [slug, data] of Object.entries(bySlug)){
    let resolution = null;
    try {
      const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
      const events = await r.json();
      if(events && events[0]){
        const market = events[0].markets?.[0];
        if(market){
          const outcomes = JSON.parse(typeof market.outcomes==='string'?market.outcomes:JSON.stringify(market.outcomes||'["Up","Down"]'));
          const prices = JSON.parse(typeof market.outcomePrices==='string'?market.outcomePrices:JSON.stringify(market.outcomePrices||'[]'));
          if(market.resolved || market.closed){
            if(prices.length>=2){
              if(parseFloat(prices[0])>parseFloat(prices[1])) resolution=outcomes[0];
              else resolution=outcomes[1];
            }
          }
          // Also check if active/unresolved but price ~1.0
          if(!resolution && prices.length>=2){
            if(parseFloat(prices[0])>=0.95) resolution=outcomes[0];
            else if(parseFloat(prices[1])>=0.95) resolution=outcomes[1];
          }
        }
      }
    } catch(e){}

    // Only count TAKER trades for accuracy (filter out market-maker fills)
    // For now use all data since we can't distinguish taker vs maker in DB
    const upNet = data.Up.bought - data.Up.sold;
    const downNet = data.Down.bought - data.Down.sold;
    const upCost = data.Up.cost - data.Up.rev;
    const downCost = data.Down.cost - data.Down.rev;
    const totalCost = upCost + downCost;

    const pnlByPct = {};
    for(const pct of PCTS){
      const frac = pct/100;
      const cost = totalCost * frac;
      let value = null;
      if(resolution==='Up'){
        value = (upNet * 1.0 + downNet * 0.0) * frac;
      } else if(resolution==='Down'){
        value = (upNet * 0.0 + downNet * 1.0) * frac;
      }
      const pnl = value !== null ? value - cost : null;
      pnlByPct[pct] = {cost, value, pnl};
    }

    results.push({slug, data, resolution, upNet, downNet, totalCost, pnlByPct, count: data.count});
  }

  results.sort((a,b)=>a.data.firstTs-b.data.firstTs);

  // Print table
  console.log(`${'Event'.padEnd(42)} Res   Trades  Net Up  Net Dn   Cost   |   1% PNL    5% PNL   10% PNL   20% PNL   50% PNL`);
  console.log('='.repeat(160));

  let totals = {};
  for(const p of PCTS) totals[p]={cost:0,pnl:0,count:0};

  for(const r of results){
    const res = (r.resolution || '?').padEnd(4);
    const pctCols = PCTS.map(p=>{
      const d = r.pnlByPct[p];
      if(d.pnl!==null){
        totals[p].cost+=d.cost;
        totals[p].pnl+=d.pnl;
        totals[p].count++;
        const s = d.pnl>=0?'+':'';
        return (s+'$'+d.pnl.toFixed(2)).padStart(9);
      }
      return '     ???';
    }).join('  ');

    console.log(
      `${r.slug.padEnd(42)} ${res} ${String(r.count).padStart(5)}  ${r.upNet.toFixed(0).padStart(6)}  ${r.downNet.toFixed(0).padStart(6)}  $${r.totalCost.toFixed(0).padStart(5)}   | ${pctCols}`
    );
  }

  console.log('='.repeat(160));
  console.log('\nTOTALS (resolved events):');
  for(const p of PCTS){
    const t=totals[p];
    const roi = t.cost!==0 ? ((t.pnl/Math.abs(t.cost))*100).toFixed(1) : 'N/A';
    console.log(`  ${String(p).padStart(2)}% → cost: $${t.cost.toFixed(2).padStart(8)}, PNL: ${t.pnl>=0?'+':''}$${t.pnl.toFixed(2).padStart(8)}, ROI: ${roi}%  (${t.count} events)`);
  }
})();
