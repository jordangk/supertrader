const {createClient}=require("@supabase/supabase-js");
require("dotenv").config();
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_KEY);
const K9 = "0xd0d6053c3c37e727402d84c14069780d360993aa";

(async()=>{
  const slug = "btc-updown-5m-1772699100";
  const eventStart = 1772699100;
  const eventEnd = 1772699400;

  // 1. Polymarket trades — single fetch with AbortController timeout
  let poly = [];
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    const r = await fetch(`https://data-api.polymarket.com/trades?user=${K9}&limit=500&after=${eventStart}&before=${eventEnd}`, {signal: ac.signal});
    clearTimeout(timer);
    const all = await r.json();
    poly = (all || []).filter(t => t.eventSlug === slug);
  } catch(e) {
    console.log("Polymarket API error/timeout:", e.message);
  }

  // 2. Our DB
  const {data: db} = await sb.from("k9_observed_trades")
    .select("outcome,shares,price,usdc_size,tx_hash").eq("slug", slug);

  // 3. Polymarket breakdown
  const polyStats = { Up: {buyS:0,buyU:0,sellS:0,sellU:0}, Down: {buyS:0,buyU:0,sellS:0,sellU:0} };
  for (const t of poly) {
    const shares = parseFloat(t.size || 0);
    const price = parseFloat(t.price || 0);
    const usdc = shares * price;
    const oc = (t.outcome || t.outcomeName || "").includes("Up") ? "Up" : "Down";
    const side = t.side || "";
    if (side === "BUY") { polyStats[oc].buyS += shares; polyStats[oc].buyU += usdc; }
    else { polyStats[oc].sellS += shares; polyStats[oc].sellU += usdc; }
  }

  // 4. Our DB breakdown
  const dbStats = { Up: {buyS:0,buyU:0,sellS:0,sellU:0}, Down: {buyS:0,buyU:0,sellS:0,sellU:0} };
  for (const t of db) {
    const sh = parseFloat(t.shares);
    const u = parseFloat(t.usdc_size);
    if (sh >= 0) { dbStats[t.outcome].buyS += sh; dbStats[t.outcome].buyU += u; }
    else { dbStats[t.outcome].sellS += Math.abs(sh); dbStats[t.outcome].sellU += Math.abs(u); }
  }

  console.log(`=== ${slug} ===\n`);
  console.log(`                  POLYMARKET (${poly.length} trades)         OUR DB (${db.length} fills)`);
  console.log(`                  ──────────────────────────     ──────────────────────────`);
  for (const oc of ["Up", "Down"]) {
    const p = polyStats[oc];
    const d = dbStats[oc];
    console.log(`  ${oc} BUY:       ${p.buyS.toFixed(1).padStart(8)}sh  $${p.buyU.toFixed(2).padStart(8)}      ${d.buyS.toFixed(1).padStart(8)}sh  $${d.buyU.toFixed(2).padStart(8)}`);
    console.log(`  ${oc} SELL:      ${p.sellS.toFixed(1).padStart(8)}sh  $${p.sellU.toFixed(2).padStart(8)}      ${d.sellS.toFixed(1).padStart(8)}sh  $${d.sellU.toFixed(2).padStart(8)}`);
    console.log(`  ${oc} NET:       ${(p.buyS-p.sellS).toFixed(1).padStart(8)}sh  $${(p.buyU-p.sellU).toFixed(2).padStart(8)}      ${(d.buyS-d.sellS).toFixed(1).padStart(8)}sh  $${(d.buyU-d.sellU).toFixed(2).padStart(8)}`);
    console.log();
  }

  const pTotal = poly.reduce((a,t) => a + parseFloat(t.size||0) * parseFloat(t.price||0), 0);
  const dTotal = db.reduce((a,t) => a + Math.abs(parseFloat(t.usdc_size)), 0);
  console.log(`  TOTAL VOLUME:   $${pTotal.toFixed(2).padStart(8)}                    $${dTotal.toFixed(2).padStart(8)}`);

  // Tx overlap
  const polyTxs = new Set(poly.map(t => t.transactionHash));
  const dbTxs = new Set(db.map(t => t.tx_hash));
  const overlap = [...polyTxs].filter(tx => dbTxs.has(tx));
  const polyOnly = [...polyTxs].filter(tx => !dbTxs.has(tx));
  const dbOnly = [...dbTxs].filter(tx => !polyTxs.has(tx));
  console.log(`\n  Poly txs: ${polyTxs.size}  |  Our txs: ${dbTxs.size}  |  Overlap: ${overlap.length}`);
  console.log(`  Poly-only: ${polyOnly.length}  |  DB-only (maker fills): ${dbOnly.length}`);
})();
