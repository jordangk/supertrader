const {createClient}=require("@supabase/supabase-js");
require("dotenv").config();
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_KEY);
const K9 = "0xd0d6053c3c37e727402d84c14069780d360993aa";
const ALCHEMY = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;
const ORDER_FILLED = "0xd0a08e8c493f9c94f29311571544f65a27aaf2868ec6113d5b5f1b30de925330";
const CTF = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";

async function checkTx(txHash) {
  const resp = await fetch(ALCHEMY, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getTransactionReceipt",params:[txHash]}),
  });
  const {result} = await resp.json();
  if (!result) return console.log(`  ${txHash.slice(0,20)}... NO RECEIPT`);

  const txFrom = result.from.toLowerCase();

  for (const log of result.logs) {
    if (log.address.toLowerCase() !== CTF) continue;
    if (log.topics[0].toLowerCase() !== ORDER_FILLED.toLowerCase()) continue;

    const maker = "0x" + log.topics[2].slice(-40).toLowerCase();
    const taker = "0x" + log.topics[3].slice(-40).toLowerCase();
    const k9IsMaker = maker === K9;
    const k9IsTaker = taker === K9;
    if (!k9IsMaker && !k9IsTaker) continue;

    console.log(`  ${txHash.slice(0,20)}...  k9=${k9IsMaker?"MAKER":"TAKER"}  tx.from=${txFrom===K9?"K9":txFrom.slice(0,12)+"..."}`);
    return k9IsMaker ? "maker" : "taker";
  }
}

(async()=>{
  // Get trades for a known event, pick some that matched Polymarket and some that didn't
  const slug = "btc-updown-5m-1772700300";
  const {data:ours} = await sb.from("k9_observed_trades")
    .select("tx_hash").eq("slug", slug);
  const ourTxs = [...new Set(ours.map(t => t.tx_hash))];

  // Get Polymarket trades using time-window approach
  const r = await fetch(
    `https://data-api.polymarket.com/trades?user=${K9}&limit=500&after=1772700300&before=1772700600`
  );
  const polyAll = await r.json();
  const poly = polyAll.filter(t => t.eventSlug === slug);
  const polyTxSet = new Set(poly.map(t => t.transactionHash));

  const matched = ourTxs.filter(tx => polyTxSet.has(tx));
  const extra = ourTxs.filter(tx => !polyTxSet.has(tx));

  console.log(`${slug}: ${ourTxs.length} our txs, ${poly.length} poly trades`);
  console.log(`Matched: ${matched.length}, Extra: ${extra.length}\n`);

  // Check 5 matched txs
  let makerCount = 0, takerCount = 0;
  console.log("MATCHED (in Polymarket):");
  for (const tx of matched.slice(0, 5)) {
    const role = await checkTx(tx);
    if (role === "maker") makerCount++; else takerCount++;
  }

  // Check 5 extra txs
  console.log("\nEXTRA (NOT in Polymarket):");
  let extraMaker = 0, extraTaker = 0;
  for (const tx of extra.slice(0, 10)) {
    const role = await checkTx(tx);
    if (role === "maker") extraMaker++; else extraTaker++;
  }

  console.log(`\nMatched sample: ${takerCount} taker, ${makerCount} maker`);
  console.log(`Extra sample:   ${extraTaker} taker, ${extraMaker} maker`);
})();
