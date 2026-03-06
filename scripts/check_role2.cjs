const {createClient}=require("@supabase/supabase-js");
require("dotenv").config();
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_KEY);
const K9 = "0xd0d6053c3c37e727402d84c14069780d360993aa";
const ALCHEMY = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;
const ORDER_FILLED = "0xd0a08e8c493f9c94f29311571544f65a27aaf2868ec6113d5b5f1b30de925330";
const CTF = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";

(async()=>{
  const slug = "btc-updown-5m-1772700300";

  // Get Polymarket tx hashes for this event
  const r = await fetch(
    `https://data-api.polymarket.com/trades?user=${K9}&limit=500&after=1772700300&before=1772700600`
  );
  const polyAll = await r.json();
  const poly = polyAll.filter(t => t.eventSlug === slug);
  const polyTxSet = new Set(poly.map(t => t.transactionHash));

  // Get our tx hashes
  const {data:ours} = await sb.from("k9_observed_trades")
    .select("tx_hash").eq("slug", slug);
  const extra = [...new Set(ours.map(t => t.tx_hash))].filter(tx => !polyTxSet.has(tx));
  const matched = [...new Set(ours.map(t => t.tx_hash))].filter(tx => polyTxSet.has(tx));

  console.log("Poly trades for this event:", poly.length);
  console.log("Our txs:", [...new Set(ours.map(t => t.tx_hash))].length);
  console.log("Matched:", matched.length, "Extra:", extra.length);

  // Check 3 matched and 3 extra
  for (const [label, txs] of [["MATCHED", matched.slice(0,3)], ["EXTRA", extra.slice(0,3)]]) {
    console.log("\n--- " + label + " ---");
    for (const txHash of txs) {
      const resp = await fetch(ALCHEMY, {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getTransactionReceipt",params:[txHash]}),
      });
      const {result: receipt} = await resp.json();
      const txFrom = receipt.from.toLowerCase();
      let fills = 0;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== CTF) continue;
        if (log.topics[0].toLowerCase() !== ORDER_FILLED) continue;
        const maker = "0x" + log.topics[2].slice(-40).toLowerCase();
        const taker = "0x" + log.topics[3].slice(-40).toLowerCase();
        if (maker !== K9 && taker !== K9) continue;
        fills++;
        if (fills <= 2) {
          console.log(txHash.slice(0,18) + "  k9=" + (maker===K9?"MAKER":"TAKER") + "  tx.from=" + (txFrom===K9?"K9":txFrom.slice(0,14)));
        }
      }
      if (fills > 2) console.log("  ... " + fills + " total fills in this tx");
    }
  }
})();
