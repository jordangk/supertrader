const {createClient}=require("@supabase/supabase-js");
require("dotenv").config();
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_KEY);
const K9 = "0xd0d6053c3c37e727402d84c14069780d360993aa";
const K9_PAD = "0x000000000000000000000000" + K9.slice(2);
const ALCHEMY = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;
const ORDER_FILLED = "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6";
const CTF = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982e";

async function alchemyRpc(method, params) {
  const resp = await fetch(ALCHEMY, {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({jsonrpc:"2.0",id:1,method,params}),
  });
  return (await resp.json()).result;
}

// Get block number closest to a unix timestamp
async function getBlockByTimestamp(ts) {
  // Use binary search between known bounds
  const latest = parseInt(await alchemyRpc("eth_blockNumber", []), 16);
  const latestBlock = await alchemyRpc("eth_getBlockByNumber", ["0x" + latest.toString(16), false]);
  const latestTs = parseInt(latestBlock.timestamp, 16);
  const diff = latestTs - ts;
  // Polygon ~2s blocks
  const estimate = latest - Math.floor(diff / 2);
  // Check and refine
  const block = await alchemyRpc("eth_getBlockByNumber", ["0x" + estimate.toString(16), false]);
  const blockTs = parseInt(block.timestamp, 16);
  const delta = ts - blockTs;
  const refined = estimate + Math.floor(delta / 2);
  return refined;
}

function decodeFill(log) {
  const topics = log.topics || [];
  if (topics.length < 4) return null;
  const maker = "0x" + topics[2].slice(-40).toLowerCase();
  const taker = "0x" + topics[3].slice(-40).toLowerCase();
  const k9IsMaker = maker === K9;
  const k9IsTaker = taker === K9;
  if (!k9IsMaker && !k9IsTaker) return null;

  const data = (log.data || "0x").slice(2);
  if (data.length < 256) return null;
  const chunks = [];
  for (let i = 0; i < data.length; i += 64) chunks.push(data.slice(i, i + 64));

  const makerAsset  = BigInt("0x" + chunks[0]);
  const takerAsset  = BigInt("0x" + chunks[1]);
  const makerAmount = BigInt("0x" + chunks[2]);
  const takerAmount = BigInt("0x" + chunks[3]);

  let usdcSize, shares, tokenId, side;
  if (k9IsMaker && makerAsset === 0n) {
    usdcSize = Number(makerAmount) / 1e6; shares = Number(takerAmount) / 1e6;
    tokenId = takerAsset; side = "buy";
  } else if (k9IsTaker && takerAsset === 0n) {
    usdcSize = Number(takerAmount) / 1e6; shares = Number(makerAmount) / 1e6;
    tokenId = makerAsset; side = "buy";
  } else if (k9IsMaker && takerAsset === 0n) {
    usdcSize = Number(takerAmount) / 1e6; shares = Number(makerAmount) / 1e6;
    tokenId = makerAsset; side = "sell";
  } else if (k9IsTaker && makerAsset === 0n) {
    usdcSize = Number(makerAmount) / 1e6; shares = Number(takerAmount) / 1e6;
    tokenId = takerAsset; side = "sell";
  } else {
    return null;
  }

  const price = shares > 0 ? Math.round((usdcSize / shares) * 1e8) / 1e8 : 0;
  return {
    txHash: log.transactionHash,
    role: k9IsMaker ? "MAKER" : "TAKER",
    side, shares, usdcSize, price,
    tokenId: tokenId.toString(),
    blockNumber: parseInt(log.blockNumber, 16),
    logIndex: parseInt(log.logIndex, 16),
  };
}

(async()=>{
  const slug = "btc-updown-5m-1772699100";
  const eventStart = 1772699100; // 3:25 AM ET
  const eventEnd   = 1772699400; // 3:30 AM ET

  console.log(`\n=== Chain vs DB: ${slug} ===`);
  console.log(`Event window: ${new Date(eventStart*1000).toISOString()} → ${new Date(eventEnd*1000).toISOString()}\n`);

  // 1. Get token IDs for this event from gamma API
  console.log("Fetching token IDs from Gamma...");
  const gammaResp = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
  const gammaData = await gammaResp.json();
  const market = gammaData?.[0]?.markets?.[0];
  if (!market) { console.log("No market found!"); return; }
  const tokenIds = JSON.parse(typeof market.clobTokenIds === "string" ? market.clobTokenIds : JSON.stringify(market.clobTokenIds));
  const outcomes = JSON.parse(typeof market.outcomes === "string" ? market.outcomes : JSON.stringify(market.outcomes || '["Up","Down"]'));
  const tokenMap = {};
  tokenIds.forEach((tid, i) => { tokenMap[BigInt(tid).toString()] = outcomes[i] || `token${i}`; });
  console.log("Token map:", Object.entries(tokenMap).map(([k,v])=>`${v}=${k}`).join(", "));

  // 2. Get block range — search a bit before and after event window
  console.log("\nEstimating block range...");
  const startBlock = await getBlockByTimestamp(eventStart - 30); // 30s before
  const endBlock   = await getBlockByTimestamp(eventEnd + 60);   // 60s after
  console.log(`Block range: ${startBlock} → ${endBlock} (${endBlock - startBlock} blocks)\n`);

  // 3. Fetch ALL OrderFilled logs for k9 (as maker and taker) in this block range
  console.log("Fetching on-chain OrderFilled logs...");
  const fromBlock = "0x" + startBlock.toString(16);
  const toBlock   = "0x" + endBlock.toString(16);

  // k9 as taker (topic[3])
  const logsAsTaker = await alchemyRpc("eth_getLogs", [{
    address: CTF, fromBlock, toBlock,
    topics: [ORDER_FILLED, null, null, K9_PAD],
  }]);

  // k9 as maker (topic[2])
  const logsAsMaker = await alchemyRpc("eth_getLogs", [{
    address: CTF, fromBlock, toBlock,
    topics: [ORDER_FILLED, null, K9_PAD, null],
  }]);

  const allLogs = [...(logsAsTaker||[]), ...(logsAsMaker||[])];
  // Deduplicate by transactionHash + logIndex
  const seen = new Set();
  const uniqueLogs = allLogs.filter(l => {
    const key = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`Raw logs: ${allLogs.length} (${logsAsTaker?.length||0} taker + ${logsAsMaker?.length||0} maker), unique: ${uniqueLogs.length}`);

  // 4. Decode all fills
  const chainFills = [];
  for (const log of uniqueLogs) {
    const fill = decodeFill(log);
    if (!fill) continue;
    // Only include fills for THIS event's tokens
    const outcome = tokenMap[fill.tokenId];
    if (!outcome) continue;
    fill.outcome = outcome;
    chainFills.push(fill);
  }

  console.log(`On-chain fills for this event: ${chainFills.length}`);
  const chainTxSet = new Set(chainFills.map(f => f.txHash));
  console.log(`Unique tx hashes on-chain: ${chainTxSet.size}`);

  // 5. Get our DB trades
  console.log("\nFetching our DB trades...");
  const {data: dbTrades, error} = await sb.from("k9_observed_trades")
    .select("tx_hash,outcome,shares,price,usdc_size,trade_timestamp")
    .eq("slug", slug)
    .order("id", {ascending: true});
  if (error) { console.log("DB error:", error.message); return; }
  console.log(`DB trades: ${dbTrades.length}`);
  const dbTxSet = new Set(dbTrades.map(t => t.tx_hash));
  console.log(`Unique DB tx hashes: ${dbTxSet.size}`);

  // 6. Compare
  const inBothTx = [...chainTxSet].filter(tx => dbTxSet.has(tx));
  const onChainOnly = [...chainTxSet].filter(tx => !dbTxSet.has(tx));
  const dbOnly = [...dbTxSet].filter(tx => !chainTxSet.has(tx));

  console.log(`\n=== COMPARISON ===`);
  console.log(`On-chain txs: ${chainTxSet.size}`);
  console.log(`Our DB txs:   ${dbTxSet.size}`);
  console.log(`In both:      ${inBothTx.length}`);
  console.log(`On-chain ONLY (we missed): ${onChainOnly.length}`);
  console.log(`DB ONLY (not on-chain in range): ${dbOnly.length}`);

  // 7. Breakdown by role
  const chainByRole = { MAKER: 0, TAKER: 0 };
  const chainBySide = { buy: 0, sell: 0 };
  for (const f of chainFills) {
    chainByRole[f.role]++;
    chainBySide[f.side]++;
  }
  console.log(`\nOn-chain breakdown: ${chainByRole.MAKER} maker fills, ${chainByRole.TAKER} taker fills`);
  console.log(`On-chain sides: ${chainBySide.buy} buys, ${chainBySide.sell} sells`);

  // 8. Show missed txs detail
  if (onChainOnly.length > 0) {
    console.log(`\n=== MISSED TRANSACTIONS (on-chain but NOT in our DB) ===`);
    for (const tx of onChainOnly.slice(0, 20)) {
      const fills = chainFills.filter(f => f.txHash === tx);
      for (const f of fills) {
        console.log(`  ${tx.slice(0,20)}... ${f.role} ${f.side.toUpperCase()} ${f.outcome} ${f.shares.toFixed(2)}sh @${f.price.toFixed(4)} $${f.usdcSize.toFixed(2)} block=${f.blockNumber}`);
      }
    }
    if (onChainOnly.length > 20) console.log(`  ... and ${onChainOnly.length - 20} more`);

    // Check roles of missed
    const missedFills = chainFills.filter(f => onChainOnly.includes(f.txHash));
    const missedByRole = { MAKER: 0, TAKER: 0 };
    const missedBySide = { buy: 0, sell: 0 };
    for (const f of missedFills) {
      missedByRole[f.role]++;
      missedBySide[f.side]++;
    }
    console.log(`\nMissed breakdown: ${missedByRole.MAKER} maker, ${missedByRole.TAKER} taker`);
    console.log(`Missed sides: ${missedBySide.buy} buys, ${missedBySide.sell} sells`);
    console.log(`Missed total USDC: $${missedFills.reduce((a,f)=>a+f.usdcSize,0).toFixed(2)}`);
  }

  // 9. DB-only detail (shouldn't happen but check)
  if (dbOnly.length > 0) {
    console.log(`\n=== DB-ONLY (in our DB but NOT on-chain in block range) ===`);
    for (const tx of dbOnly.slice(0, 10)) {
      const trades = dbTrades.filter(t => t.tx_hash === tx);
      for (const t of trades) {
        console.log(`  ${tx.slice(0,20)}... ${t.outcome} ${parseFloat(t.shares)>0?"BUY":"SELL"} ${Math.abs(parseFloat(t.shares)).toFixed(2)}sh @${parseFloat(t.price).toFixed(4)} ts=${t.trade_timestamp}`);
      }
    }
    if (dbOnly.length > 10) console.log(`  ... and ${dbOnly.length - 10} more`);
  }

  // 10. Summary stats
  const chainBuys = chainFills.filter(f => f.side === "buy");
  const chainSells = chainFills.filter(f => f.side === "sell");
  const totalBuyUsdc = chainBuys.reduce((a,f) => a + f.usdcSize, 0);
  const totalSellUsdc = chainSells.reduce((a,f) => a + f.usdcSize, 0);
  const totalBuyShares = chainBuys.reduce((a,f) => a + f.shares, 0);
  const totalSellShares = chainSells.reduce((a,f) => a + f.shares, 0);

  console.log(`\n=== ON-CHAIN TOTALS ===`);
  console.log(`Buys:  ${chainBuys.length} fills, ${totalBuyShares.toFixed(2)} shares, $${totalBuyUsdc.toFixed(2)}`);
  console.log(`Sells: ${chainSells.length} fills, ${totalSellShares.toFixed(2)} shares, $${totalSellUsdc.toFixed(2)}`);

  // Per outcome
  for (const oc of ["Up", "Down"]) {
    const buys = chainFills.filter(f => f.outcome === oc && f.side === "buy");
    const sells = chainFills.filter(f => f.outcome === oc && f.side === "sell");
    const netShares = buys.reduce((a,f)=>a+f.shares,0) - sells.reduce((a,f)=>a+f.shares,0);
    const netUsdc = buys.reduce((a,f)=>a+f.usdcSize,0) - sells.reduce((a,f)=>a+f.usdcSize,0);
    console.log(`  ${oc}: ${buys.length} buys / ${sells.length} sells, net ${netShares.toFixed(2)} shares, net $${netUsdc.toFixed(2)}`);
  }
})();
