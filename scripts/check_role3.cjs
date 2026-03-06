const {createClient}=require("@supabase/supabase-js");
require("dotenv").config();
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_KEY);
const K9 = "0xd0d6053c3c37e727402d84c14069780d360993aa";
const ALCHEMY = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;
const ORDER_FILLED = "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6";
const CTF = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";

async function checkTx(txHash) {
  const resp = await fetch(ALCHEMY, {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getTransactionReceipt",params:[txHash]}),
  });
  const {result: receipt} = await resp.json();
  if (!receipt) return null;
  const txFrom = receipt.from.toLowerCase();
  const results = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== CTF) continue;
    if (log.topics[0].toLowerCase() !== ORDER_FILLED) continue;
    if (log.topics.length < 4) continue;
    const maker = "0x" + log.topics[2].slice(-40).toLowerCase();
    const taker = "0x" + log.topics[3].slice(-40).toLowerCase();
    if (maker !== K9 && taker !== K9) continue;
    results.push({ role: maker === K9 ? "MAKER" : "TAKER", txFrom });
  }
  return results;
}

(async()=>{
  const slug = "btc-updown-5m-1772700300";

  const {data:ours} = await sb.from("k9_observed_trades")
    .select("tx_hash").eq("slug", slug);
  const ourTxs = [...new Set(ours.map(t => t.tx_hash))];

  const r = await fetch(
    `https://data-api.polymarket.com/trades?user=${K9}&limit=500&after=1772700300&before=1772700600`
  );
  const polyAll = await r.json();
  const poly = polyAll.filter(t => t.eventSlug === slug);
  const polyTxSet = new Set(poly.map(t => t.transactionHash));
  const matched = ourTxs.filter(tx => polyTxSet.has(tx));
  const extra = ourTxs.filter(tx => !polyTxSet.has(tx));

  console.log(`Poly: ${poly.length} trades, Us: ${ourTxs.length} txs`);
  console.log(`Matched: ${matched.length}, Extra: ${extra.length}\n`);

  // Sample 5 matched, 10 extra
  let mMaker=0, mTaker=0, eMaker=0, eTaker=0;

  console.log("MATCHED (in Polymarket):");
  for (const tx of matched.slice(0,5)) {
    const fills = await checkTx(tx);
    for (const f of (fills||[])) {
      console.log(`  ${tx.slice(0,18)}  ${f.role}  from=${f.txFrom===K9?"K9":f.txFrom.slice(0,14)}`);
      if (f.role === "MAKER") mMaker++; else mTaker++;
    }
  }

  console.log("\nEXTRA (NOT in Polymarket):");
  for (const tx of extra.slice(0,10)) {
    const fills = await checkTx(tx);
    for (const f of (fills||[])) {
      console.log(`  ${tx.slice(0,18)}  ${f.role}  from=${f.txFrom===K9?"K9":f.txFrom.slice(0,14)}`);
      if (f.role === "MAKER") eMaker++; else eTaker++;
    }
  }

  console.log(`\nMatched: ${mTaker} taker fills, ${mMaker} maker fills`);
  console.log(`Extra:   ${eTaker} taker fills, ${eMaker} maker fills`);
})();
