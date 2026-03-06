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
  // Step 1: Get all unique slugs from our DB
  console.log("=== FIX ALL EVENTS ===\n");
  console.log("Step 1: Getting all event slugs...");

  let allSlugs = [];
  let offset = 0;
  while (true) {
    const {data, error} = await sb.from("k9_observed_trades")
      .select("slug")
      .range(offset, offset + 999);
    if (error || !data || data.length === 0) break;
    allSlugs = allSlugs.concat(data.map(t => t.slug));
    if (data.length < 1000) break;
    offset += 1000;
  }
  const slugs = [...new Set(allSlugs)];
  console.log(`Found ${slugs.length} unique events\n`);

  let totalDupesRemoved = 0;
  let totalFillsAdded = 0;

  // Step 2: For each slug, clean dupes
  console.log("Step 2: Cleaning duplicates...");
  for (const slug of slugs) {
    const {data: rows} = await sb.from("k9_observed_trades")
      .select("id,tx_hash,outcome,shares").eq("slug", slug).order("id", {ascending: true});
    if (!rows || rows.length === 0) continue;

    const groups = {};
    for (const t of rows) {
      const key = `${t.tx_hash}:${t.outcome}:${t.shares}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }

    const idsToDelete = [];
    for (const [, arr] of Object.entries(groups)) {
      if (arr.length > 1) {
        for (const t of arr.slice(1)) idsToDelete.push(t.id);
      }
    }

    if (idsToDelete.length > 0) {
      for (let i = 0; i < idsToDelete.length; i += 100) {
        const batch = idsToDelete.slice(i, i + 100);
        await sb.from("k9_observed_trades").delete().in("id", batch);
      }
      totalDupesRemoved += idsToDelete.length;
      console.log(`  ${slug}: removed ${idsToDelete.length} dupes (${rows.length} → ${rows.length - idsToDelete.length})`);
    }
  }
  console.log(`Total dupes removed: ${totalDupesRemoved}\n`);

  // Step 3: For each 5m/15m slug, backfill missing fills from chain
  console.log("Step 3: Backfilling missing fills from chain...");
  const epochSlugs = slugs.filter(s => /\d{10}$/.test(s)); // only epoch-based slugs
  console.log(`${epochSlugs.length} epoch-based events to check\n`);

  for (const slug of epochSlugs) {
    const epoch = parseInt(slug.split("-").pop());
    if (isNaN(epoch)) continue;

    // Get token map
    let tokenMap;
    try {
      const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
      const d = await r.json();
      const m = d?.[0]?.markets?.[0];
      if (!m) continue;
      const tids = JSON.parse(typeof m.clobTokenIds === "string" ? m.clobTokenIds : JSON.stringify(m.clobTokenIds));
      const ocs = JSON.parse(typeof m.outcomes === "string" ? m.outcomes : JSON.stringify(m.outcomes || '["Up","Down"]'));
      tokenMap = {};
      tids.forEach((tid, i) => { tokenMap[BigInt(tid).toString()] = ocs[i]; });
    } catch(e) { continue; }

    // Get current DB state
    const {data: dbRows} = await sb.from("k9_observed_trades")
      .select("tx_hash,outcome,shares").eq("slug", slug);
    if (!dbRows) continue;

    const dbKeyCounts = {};
    for (const t of dbRows) {
      const side = parseFloat(t.shares) >= 0 ? "buy" : "sell";
      const shares = Math.abs(parseFloat(t.shares));
      const key = `${t.tx_hash}:${t.outcome}:${side}:${shares}`;
      dbKeyCounts[key] = (dbKeyCounts[key] || 0) + 1;
    }

    // Get on-chain fills
    let startBlock, endBlock;
    try {
      startBlock = await getBlockByTimestamp(epoch - 30);
      endBlock = await getBlockByTimestamp(epoch + 360);
    } catch(e) { continue; }

    const fromBlock = "0x" + startBlock.toString(16);
    const toBlock = "0x" + endBlock.toString(16);

    let takerLogs, makerLogs;
    try {
      [takerLogs, makerLogs] = await Promise.all([
        alchemyRpc("eth_getLogs", [{address: CTF, fromBlock, toBlock, topics: [ORDER_FILLED, null, null, K9_PAD]}]),
        alchemyRpc("eth_getLogs", [{address: CTF, fromBlock, toBlock, topics: [ORDER_FILLED, null, K9_PAD, null]}]),
      ]);
    } catch(e) { continue; }

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

    // Find missing
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
        const fills = chainKeyFills[key].slice(dbCount);
        for (const f of fills) toInsert.push(f);
      }
    }

    if (toInsert.length > 0) {
      // Get block timestamps
      const blockNums = [...new Set(toInsert.map(f => f.blockNumber))];
      const blockTsMap = {};
      for (const bn of blockNums) {
        try {
          const block = await alchemyRpc("eth_getBlockByNumber", ["0x" + bn.toString(16), false]);
          blockTsMap[bn] = parseInt(block.timestamp, 16);
        } catch(e) { blockTsMap[bn] = epoch; }
      }

      const rows = toInsert.map(f => ({
        slug, outcome: f.outcome, price: f.price,
        shares: f.side === "sell" ? -f.shares : f.shares,
        usdc_size: f.side === "sell" ? -f.usdcSize : f.usdcSize,
        tx_hash: f.txHash, trade_timestamp: blockTsMap[f.blockNumber] || epoch,
      }));

      const {error} = await sb.from("k9_observed_trades").insert(rows);
      if (!error) {
        totalFillsAdded += rows.length;
        console.log(`  ${slug}: +${rows.length} fills (chain=${chainFills.length}, db was ${dbRows.length})`);
      } else {
        console.log(`  ${slug}: insert error: ${error.message}`);
      }
    }

    // Rate limit — small delay between events
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nTotal fills backfilled: ${totalFillsAdded}`);
  console.log(`\n=== DONE ===`);
})();
