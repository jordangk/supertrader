const {createClient}=require("@supabase/supabase-js");
require("dotenv").config();
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_KEY);
const K9 = "0xd0d6053c3c37e727402d84c14069780d360993aa";
const ALCHEMY = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;

(async()=>{
  const slug = "btc-updown-5m-1772699100";

  // Get our trades for this event
  const {data:ours} = await sb.from("k9_observed_trades")
    .select("tx_hash,outcome,shares,price")
    .eq("slug", slug).order("trade_timestamp",{ascending:true});

  // Get Polymarket trades — paginate to get all
  let polyAll = [];
  let offset = 0;
  while (true) {
    const r = await fetch(
      `https://data-api.polymarket.com/trades?user=${K9}&market=${slug}&limit=500&offset=${offset}`
    );
    const batch = await r.json();
    if (!batch || batch.length === 0) break;
    polyAll = polyAll.concat(batch);
    if (batch.length < 500) break;
    offset += 500;
  }
  const poly = polyAll;
  const polyTxSet = new Set(poly.map(t => t.transactionHash));

  // Find txs that are in ours but NOT in Polymarket
  const ourTxs = [...new Set(ours.map(t => t.tx_hash))];
  const extraTxs = ourTxs.filter(tx => !polyTxSet.has(tx));
  const matchedTxs = ourTxs.filter(tx => polyTxSet.has(tx));

  console.log(`Our txs: ${ourTxs.length}, Matched: ${matchedTxs.length}, Extra: ${extraTxs.length}\n`);

  // Fetch receipts for 3 extra txs and 2 matched txs to compare
  async function getReceipt(txHash) {
    const resp = await fetch(ALCHEMY, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getTransactionReceipt",params:[txHash]}),
    });
    const {result} = await resp.json();
    return result;
  }

  async function analyzeOrderFilled(txHash, label) {
    const receipt = await getReceipt(txHash);
    if (!receipt) { console.log(`${label} ${txHash.slice(0,20)}... NO RECEIPT`); return; }

    const ORDER_FILLED = "0xd0a08e8c493f9c94f29311571544f65a27aaf2868ec6113d5b5f1b30de925330";
    const ctf = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== ctf) continue;
      if (!log.topics[0] || log.topics[0].toLowerCase() !== ORDER_FILLED.toLowerCase()) continue;

      const maker = "0x" + log.topics[2].slice(-40).toLowerCase();
      const taker = "0x" + log.topics[3].slice(-40).toLowerCase();
      const k9IsMaker = maker === K9;
      const k9IsTaker = taker === K9;

      if (!k9IsMaker && !k9IsTaker) continue;

      console.log(`${label} ${txHash.slice(0,20)}...`);
      console.log(`  maker: ${maker.slice(0,10)}...${k9IsMaker ? " ← K9" : ""}`);
      console.log(`  taker: ${taker.slice(0,10)}...${k9IsTaker ? " ← K9" : ""}`);
      console.log(`  k9 role: ${k9IsMaker ? "MAKER" : "TAKER"}`);
      console.log(`  from: ${receipt.from.toLowerCase().slice(0,10)}...`);
      return;
    }
  }

  console.log("=== EXTRA TXS (in our DB, NOT in Polymarket) ===");
  for (const tx of extraTxs.slice(0, 5)) {
    await analyzeOrderFilled(tx, "EXTRA");
    console.log("");
  }

  console.log("=== MATCHED TXS (in both) ===");
  for (const tx of matchedTxs.slice(0, 3)) {
    await analyzeOrderFilled(tx, "MATCH");
    console.log("");
  }
})();
