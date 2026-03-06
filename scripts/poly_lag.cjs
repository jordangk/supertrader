const {createClient}=require("@supabase/supabase-js");
require("dotenv").config();
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_KEY);

const slugs = [
  "btc-updown-5m-1772700900",
  "btc-updown-5m-1772700300",
  "btc-updown-5m-1772700000",
  "btc-updown-5m-1772699700",
  "btc-updown-5m-1772699400",
  "btc-updown-5m-1772699100",
];

(async()=>{
  let allPolyDelays = [];
  let allOurDelays = [];

  for (const slug of slugs) {
    const {data:ours} = await sb.from("k9_observed_trades")
      .select("tx_hash,trade_timestamp,created_at")
      .eq("slug", slug).order("trade_timestamp",{ascending:true});
    if (!ours || ours.length === 0) continue;

    const epoch = parseInt(slug.split("-").pop());
    const r = await fetch(
      `https://data-api.polymarket.com/trades?user=0xd0d6053c3c37e727402d84c14069780d360993aa&limit=500&after=${epoch}&before=${epoch+300}`
    );
    const polyAll = await r.json();
    const poly = polyAll.filter(t => t.eventSlug === slug);
    if (poly.length === 0) continue;

    const polyByTx = {};
    for (const t of poly) polyByTx[t.transactionHash] = t;

    let lags = [];
    for (const o of ours) {
      const p = polyByTx[o.tx_hash];
      if (!p) continue;
      const ourTs = parseInt(o.trade_timestamp);
      const polyTs = parseInt(p.timestamp);
      const ourCreated = Math.floor(new Date(o.created_at).getTime()/1000);
      lags.push({
        polyDelay: polyTs - ourTs,
        ourDelay: ourCreated - ourTs,
      });
    }
    if (lags.length === 0) continue;

    const pd = lags.map(l => l.polyDelay);
    const od = lags.map(l => l.ourDelay);
    allPolyDelays = allPolyDelays.concat(pd);
    allOurDelays = allOurDelays.concat(od);

    console.log(`${slug} (${lags.length} matched)`);
    console.log(`  Poly API delay:  min=${Math.min(...pd)}s  max=${Math.max(...pd)}s  avg=${(pd.reduce((a,b)=>a+b,0)/pd.length).toFixed(1)}s`);
    console.log(`  Our detection:   min=${Math.min(...od)}s  max=${Math.max(...od)}s  avg=${(od.reduce((a,b)=>a+b,0)/od.length).toFixed(1)}s`);
  }

  if (allPolyDelays.length) {
    console.log(`\n=== OVERALL (${allPolyDelays.length} matched trades) ===`);
    allPolyDelays.sort((a,b)=>a-b);
    allOurDelays.sort((a,b)=>a-b);
    console.log(`Poly API delay:  min=${allPolyDelays[0]}s  max=${allPolyDelays[allPolyDelays.length-1]}s  median=${allPolyDelays[Math.floor(allPolyDelays.length/2)]}s  avg=${(allPolyDelays.reduce((a,b)=>a+b,0)/allPolyDelays.length).toFixed(1)}s`);
    console.log(`Our detection:   min=${allOurDelays[0]}s  max=${allOurDelays[allOurDelays.length-1]}s  median=${allOurDelays[Math.floor(allOurDelays.length/2)]}s  avg=${(allOurDelays.reduce((a,b)=>a+b,0)/allOurDelays.length).toFixed(1)}s`);

    // Distribution
    const dist = {};
    for (const d of allPolyDelays) {
      const bucket = Math.floor(d/10)*10;
      const label = `${bucket}-${bucket+9}s`;
      dist[label] = (dist[label]||0) + 1;
    }
    console.log(`\nPoly delay distribution:`);
    for (const [range, count] of Object.entries(dist).sort((a,b)=>parseInt(a)-parseInt(b))) {
      console.log(`  ${range.padEnd(10)} ${count} trades ${"#".repeat(Math.min(count, 50))}`);
    }
  }
})();
