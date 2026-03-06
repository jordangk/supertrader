require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const WALLET = "0x53D395D95538d7B0A6346770378c79001e2360Ee";
const WALLET_PAD = "0x000000000000000000000000" + WALLET.slice(2).toLowerCase();
const ALCHEMY = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;
const CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const TRANSFER_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const CTF_EXCHANGE = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";

const slug = process.argv[2] || "btc-updown-5m-1772707200";
const epoch = parseInt(slug.split("-").pop());

async function alchemyRpc(method, params) {
  const resp = await fetch(ALCHEMY, {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({jsonrpc:"2.0",id:1,method,params}),
  });
  return (await resp.json()).result;
}

async function getBlockByTimestamp(ts) {
  const latest = parseInt(await alchemyRpc("eth_blockNumber", []), 16);
  const latestBlock = await alchemyRpc("eth_getBlockByNumber", ["0x" + latest.toString(16), false]);
  const latestTs = parseInt(latestBlock.timestamp, 16);
  const estimate = latest - Math.floor((latestTs - ts) / 2);
  const block = await alchemyRpc("eth_getBlockByNumber", ["0x" + estimate.toString(16), false]);
  const delta = ts - parseInt(block.timestamp, 16);
  return estimate + Math.floor(delta / 2);
}

(async () => {
  console.log(`=== REWARDS CHECK: ${slug} ===`);
  console.log(`Wallet: ${WALLET}\n`);

  // Get token map
  const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
  const d = await r.json();
  const m = d && d[0] && d[0].markets && d[0].markets[0];
  if (!m) { console.log("Event not found"); return; }

  const tids = JSON.parse(typeof m.clobTokenIds === "string" ? m.clobTokenIds : JSON.stringify(m.clobTokenIds));
  const ocs = JSON.parse(typeof m.outcomes === "string" ? m.outcomes : JSON.stringify(m.outcomes || '["Up","Down"]'));
  const tokenMap = {};
  tids.forEach((tid, i) => { tokenMap[BigInt(tid).toString()] = ocs[i]; });

  console.log("Market:", m.question || slug);
  console.log("Active:", m.active, "| Closed:", m.closed);
  console.log("Winning outcome:", m.winningOutcome || "not resolved yet");
  console.log("");

  // Check on-chain TransferSingle events TO our wallet
  const startBlock = await getBlockByTimestamp(epoch - 60);
  const endBlock = await getBlockByTimestamp(epoch + 600);
  const fromBlock = "0x" + startBlock.toString(16);
  const toBlock = "0x" + endBlock.toString(16);

  const transfers = await alchemyRpc("eth_getLogs", [{
    address: CONDITIONAL_TOKENS, fromBlock, toBlock,
    topics: [TRANSFER_SINGLE, null, null, WALLET_PAD],
  }]);

  let exchangeShares = { Up: 0, Down: 0 };
  let rebateShares = { Up: 0, Down: 0 };
  let rebateCount = 0;

  for (const log of (transfers || [])) {
    const data = (log.data || "0x").slice(2);
    const chunks = [];
    for (let i = 0; i < data.length; i += 64) chunks.push(data.slice(i, i + 64));
    if (chunks.length < 2) continue;
    const tokenId = BigInt("0x" + chunks[0]).toString();
    const amount = Number(BigInt("0x" + chunks[1])) / 1e6;
    const outcome = tokenMap[tokenId];
    if (!outcome) continue;
    const from = "0x" + log.topics[2].slice(-40).toLowerCase();
    if (from === CTF_EXCHANGE) {
      exchangeShares[outcome] = (exchangeShares[outcome] || 0) + amount;
    } else {
      rebateShares[outcome] = (rebateShares[outcome] || 0) + amount;
      rebateCount++;
    }
  }

  console.log("Exchange fills (from CTF):");
  console.log(`  Up:   ${exchangeShares.Up.toFixed(2)} shares`);
  console.log(`  Down: ${exchangeShares.Down.toFixed(2)} shares`);
  console.log("");
  console.log(`Rebate transfers (${rebateCount} transfers):`);
  console.log(`  Up:   +${rebateShares.Up.toFixed(2)} shares`);
  console.log(`  Down: +${rebateShares.Down.toFixed(2)} shares`);
  console.log("");
  console.log("Total (exchange + rebate):");
  console.log(`  Up:   ${(exchangeShares.Up + rebateShares.Up).toFixed(2)} shares`);
  console.log(`  Down: ${(exchangeShares.Down + rebateShares.Down).toFixed(2)} shares`);

  if (exchangeShares.Up + exchangeShares.Down > 0) {
    const totalExchange = exchangeShares.Up + exchangeShares.Down;
    const totalRebate = rebateShares.Up + rebateShares.Down;
    console.log(`\nRebate rate: ${(totalRebate / totalExchange * 100).toFixed(2)}%`);
  } else {
    console.log("\nNo fills found for this wallet on this event.");
  }

  // Also check DB trades
  const {data: dbTrades} = await sb.from("polymarket_trades")
    .select("*")
    .eq("polymarket_event_id", slug)
    .order("created_at", {ascending: true});

  if (dbTrades && dbTrades.length > 0) {
    console.log(`\nDB trades (${dbTrades.length}):`);
    for (const t of dbTrades) {
      console.log(`  ${t.direction} ${t.shares} sh @ ${t.purchase_price} | status: ${t.order_status} | ${t.polymarket_order_id}`);
    }
  } else {
    console.log("\nNo DB trades for this event.");
  }
})();
