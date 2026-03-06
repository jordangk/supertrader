const {createClient}=require("@supabase/supabase-js");
require("dotenv").config();
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_KEY);

// Get our most recent trades and check if Polymarket has them yet
(async()=>{
  const now = Math.floor(Date.now()/1000);

  // Get our last 20 trades
  const {data:recent} = await sb.from("k9_observed_trades")
    .select("tx_hash,slug,outcome,shares,trade_timestamp,created_at")
    .order("id",{ascending:false})
    .limit(20);

  if (!recent || recent.length === 0) {
    console.log("No recent trades in our DB");
    return;
  }

  console.log(`Now: ${now} (${new Date().toISOString()})`);
  console.log(`Most recent trade: ${recent[0].trade_timestamp} (${Math.round(now - parseInt(recent[0].trade_timestamp))}s ago)\n`);

  // Get Polymarket trades for same time range
  const oldest = parseInt(recent[recent.length-1].trade_timestamp);
  const r = await fetch(
    `https://data-api.polymarket.com/trades?user=0xd0d6053c3c37e727402d84c14069780d360993aa&limit=500&after=${oldest-60}`
  );
  const polyTrades = await r.json();
  const polyTxSet = new Set(polyTrades.map(t => t.transactionHash));

  console.log(`Polymarket returned ${polyTrades.length} trades since ${oldest-60}`);
  console.log(`Our last 20 trades:\n`);

  let found = 0, missing = 0;
  for (const t of recent) {
    const age = now - parseInt(t.trade_timestamp);
    const inPoly = polyTxSet.has(t.tx_hash);
    if (inPoly) found++; else missing++;
    const status = inPoly ? "IN POLY" : "MISSING";
    console.log(
      `  ${age}s ago  ${t.slug.slice(-15).padEnd(15)}  ${t.outcome.padEnd(5)}  ${parseFloat(t.shares)>0?"BUY ":"SELL"}  tx=${t.tx_hash.slice(0,16)}...  ${status}`
    );
  }

  console.log(`\nFound in Polymarket: ${found}/${recent.length}`);
  console.log(`Missing from Polymarket: ${missing}/${recent.length}`);

  if (missing > 0 && found > 0) {
    // Find the boundary — latest trade that IS in Polymarket
    const foundTrades = recent.filter(t => polyTxSet.has(t.tx_hash));
    const missingTrades = recent.filter(t => !polyTxSet.has(t.tx_hash));
    const newestFound = parseInt(foundTrades[0]?.trade_timestamp || 0);
    const oldestMissing = parseInt(missingTrades[missingTrades.length-1]?.trade_timestamp || 0);
    console.log(`\nNewest trade IN Polymarket: ${now - newestFound}s ago`);
    console.log(`Oldest trade MISSING from Polymarket: ${now - oldestMissing}s ago`);
    console.log(`=> Polymarket API lag is roughly ${now - newestFound}s to ${now - oldestMissing}s`);
  }
})();
