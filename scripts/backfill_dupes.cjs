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

async function getBlockByTimestamp(ts) {
  const latest = parseInt(await alchemyRpc("eth_blockNumber", []), 16);
  const latestBlock = await alchemyRpc("eth_getBlockByNumber", ["0x" + latest.toString(16), false]);
  const latestTs = parseInt(latestBlock.timestamp, 16);
  const estimate = latest - Math.floor((latestTs - ts) / 2);
  const block = await alchemyRpc("eth_getBlockByNumber", ["0x" + estimate.toString(16), false]);
  const delta = ts - parseInt(block.timestamp, 16);
  return estimate + Math.floor(delta / 2);
}

function decodeFill(log, tokenMap) {
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
  } else { return null; }
  const price = shares > 0 ? Math.round((usdcSize / shares) * 1e8) / 1e8 : 0;
  const outcome = tokenMap[tokenId.toString()];
  if (!outcome) return null;
  return { txHash: log.transactionHash, logIndex: parseInt(log.logIndex, 16),
    blockNumber: parseInt(log.blockNumber, 16), outcome, side, shares, usdcSize, price };
}

(async()=>{
  const slug = "btc-updown-5m-1772699100";
  const eventStart = 1772699100;
  const eventEnd = 1772699400;

  console.log(`Backfilling dupes for ${slug}\n`);

  // Get token map
  const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
  const d = await r.json();
  const m = d?.[0]?.markets?.[0];
  if (!m) { console.log("No market found"); return; }
  const tids = JSON.parse(typeof m.clobTokenIds === "string" ? m.clobTokenIds : JSON.stringify(m.clobTokenIds));
  const ocs = JSON.parse(typeof m.outcomes === "string" ? m.outcomes : JSON.stringify(m.outcomes || '["Up","Down"]'));
  const tokenMap = {};
  tids.forEach((tid, i) => { tokenMap[BigInt(tid).toString()] = ocs[i]; });

  // Get block range
  const startBlock = await getBlockByTimestamp(eventStart - 30);
  const endBlock = await getBlockByTimestamp(eventEnd + 60);
  const fromBlock = "0x" + startBlock.toString(16);
  const toBlock = "0x" + endBlock.toString(16);

  // Get all on-chain fills
  const [takerLogs, makerLogs] = await Promise.all([
    alchemyRpc("eth_getLogs", [{ address: CTF, fromBlock, toBlock, topics: [ORDER_FILLED, null, null, K9_PAD] }]),
    alchemyRpc("eth_getLogs", [{ address: CTF, fromBlock, toBlock, topics: [ORDER_FILLED, null, K9_PAD, null] }]),
  ]);
  const seen = new Set();
  const allLogs = [...(takerLogs||[]), ...(makerLogs||[])].filter(l => {
    const k = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });

  const chainFills = [];
  for (const log of allLogs) {
    const f = decodeFill(log, tokenMap);
    if (f) chainFills.push(f);
  }
  console.log(`On-chain fills: ${chainFills.length}`);

  // Get our DB trades
  const {data: dbTrades} = await sb.from("k9_observed_trades")
    .select("tx_hash,outcome,shares,price,usdc_size,trade_timestamp")
    .eq("slug", slug);
  console.log(`DB trades: ${dbTrades.length}`);

  // Build set of what we have: tx_hash + outcome + side + shares (the old dedup key)
  const dbKeys = new Set();
  const dbKeyCounts = {};
  for (const t of dbTrades) {
    const side = parseFloat(t.shares) >= 0 ? "buy" : "sell";
    const shares = Math.abs(parseFloat(t.shares));
    const key = `${t.tx_hash}:${t.outcome}:${side}:${shares}`;
    if (!dbKeyCounts[key]) dbKeyCounts[key] = 0;
    dbKeyCounts[key]++;
    dbKeys.add(key);
  }

  // Find chain fills where we have fewer than the on-chain count for same dedup key
  const chainKeyCounts = {};
  const chainKeyFills = {};
  for (const f of chainFills) {
    const key = `${f.txHash}:${f.outcome}:${f.side}:${f.shares}`;
    if (!chainKeyCounts[key]) { chainKeyCounts[key] = 0; chainKeyFills[key] = []; }
    chainKeyCounts[key]++;
    chainKeyFills[key].push(f);
  }

  const toInsert = [];
  for (const [key, chainCount] of Object.entries(chainKeyCounts)) {
    const dbCount = dbKeyCounts[key] || 0;
    if (chainCount > dbCount) {
      const missing = chainCount - dbCount;
      // Take the fills we don't have (skip first dbCount, insert the rest)
      const fills = chainKeyFills[key].slice(dbCount);
      for (const f of fills) {
        toInsert.push(f);
      }
    }
  }

  console.log(`\nMissing fills to insert: ${toInsert.length}`);
  if (toInsert.length === 0) { console.log("Nothing to backfill!"); return; }

  // Get block timestamps for trade_timestamp
  const blockNums = [...new Set(toInsert.map(f => f.blockNumber))];
  const blockTsMap = {};
  for (const bn of blockNums) {
    const block = await alchemyRpc("eth_getBlockByNumber", ["0x" + bn.toString(16), false]);
    blockTsMap[bn] = parseInt(block.timestamp, 16);
  }

  for (const f of toInsert) {
    const ts = blockTsMap[f.blockNumber] || eventStart;
    console.log(`  INSERT: ${f.txHash.slice(0,20)}... logIdx=${f.logIndex} ${f.outcome} ${f.side.toUpperCase()} ${f.shares}sh @${f.price} $${f.usdcSize.toFixed(2)} ts=${ts}`);
  }

  // Insert
  const rows = toInsert.map(f => ({
    slug,
    outcome: f.outcome,
    price: f.price,
    shares: f.side === "sell" ? -f.shares : f.shares,
    usdc_size: f.side === "sell" ? -f.usdcSize : f.usdcSize,
    tx_hash: f.txHash,
    trade_timestamp: blockTsMap[f.blockNumber] || eventStart,
  }));

  const {error} = await sb.from("k9_observed_trades").insert(rows);
  if (error) {
    console.log("\nInsert error:", error.message);
  } else {
    console.log(`\nInserted ${rows.length} missing fills!`);
  }

  // Verify
  const {data: after} = await sb.from("k9_observed_trades")
    .select("id").eq("slug", slug);
  console.log(`DB trades after: ${after.length} (was ${dbTrades.length})`);
})();
