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
  } else { return null; }
  const price = shares > 0 ? Math.round((usdcSize / shares) * 1e8) / 1e8 : 0;
  return { txHash: log.transactionHash, side, shares, usdcSize, price, tokenId: tokenId.toString(),
    logIndex: parseInt(log.logIndex, 16), role: k9IsMaker ? "MAKER" : "TAKER" };
}

(async()=>{
  // Check multiple events
  const events = [
    { slug: "btc-updown-5m-1772699100", start: 1772699100, end: 1772699400, label: "3:25 AM" },
    { slug: "btc-updown-5m-1772701500", start: 1772701500, end: 1772701800, label: "4:10 AM" },
  ];

  // Fetch token maps for both events
  const tokenMaps = {};
  for (const ev of events) {
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${ev.slug}`);
    const d = await r.json();
    const m = d?.[0]?.markets?.[0];
    if (!m) continue;
    const tids = JSON.parse(typeof m.clobTokenIds === "string" ? m.clobTokenIds : JSON.stringify(m.clobTokenIds));
    const ocs = JSON.parse(typeof m.outcomes === "string" ? m.outcomes : JSON.stringify(m.outcomes || '["Up","Down"]'));
    tokenMaps[ev.slug] = {};
    tids.forEach((tid, i) => { tokenMaps[ev.slug][BigInt(tid).toString()] = ocs[i]; });
  }

  for (const ev of events) {
    const tm = tokenMaps[ev.slug];
    if (!tm) { console.log(`No tokens for ${ev.slug}`); continue; }

    console.log(`\n=== ${ev.label} (${ev.slug}) ===`);

    const startBlock = await getBlockByTimestamp(ev.start - 30);
    const endBlock = await getBlockByTimestamp(ev.end + 60);
    const fromBlock = "0x" + startBlock.toString(16);
    const toBlock = "0x" + endBlock.toString(16);

    const [takerLogs, makerLogs] = await Promise.all([
      alchemyRpc("eth_getLogs", [{ address: CTF, fromBlock, toBlock, topics: [ORDER_FILLED, null, null, K9_PAD] }]),
      alchemyRpc("eth_getLogs", [{ address: CTF, fromBlock, toBlock, topics: [ORDER_FILLED, null, K9_PAD, null] }]),
    ]);

    const seen = new Set();
    const allLogs = [...(takerLogs||[]), ...(makerLogs||[])].filter(l => {
      const k = `${l.transactionHash}:${l.logIndex}`;
      if (seen.has(k)) return false; seen.add(k); return true;
    });

    // Decode all fills for this event
    const fills = [];
    for (const log of allLogs) {
      const f = decodeFill(log);
      if (!f) continue;
      const oc = tm[f.tokenId];
      if (!oc) continue;
      f.outcome = oc;
      fills.push(f);
    }

    // Find duplicate dedup keys (same tx + outcome + side + shares)
    const dedupCounts = {};
    for (const f of fills) {
      const key = `${f.txHash}:${f.outcome}:${f.side}:${f.shares}`;
      if (!dedupCounts[key]) dedupCounts[key] = [];
      dedupCounts[key].push(f);
    }

    const dupes = Object.entries(dedupCounts).filter(([, arr]) => arr.length > 1);
    const droppedFills = dupes.reduce((sum, [, arr]) => sum + arr.length - 1, 0);

    console.log(`Total on-chain fills: ${fills.length}`);
    console.log(`Unique dedup keys: ${Object.keys(dedupCounts).length}`);
    console.log(`Duplicate dedup keys: ${dupes.length} (dropping ${droppedFills} fills)`);

    if (dupes.length > 0) {
      let totalDroppedUsdc = 0;
      let totalDroppedShares = 0;
      console.log(`\nDuplicate fills that get DROPPED by our dedup:`);
      for (const [key, arr] of dupes) {
        const dropped = arr.length - 1;
        const droppedUsdc = arr.slice(1).reduce((a,f) => a + f.usdcSize, 0);
        const droppedSh = arr.slice(1).reduce((a,f) => a + f.shares, 0);
        totalDroppedUsdc += droppedUsdc;
        totalDroppedShares += droppedSh;
        console.log(`  ${arr[0].txHash.slice(0,20)}... ${arr[0].outcome} ${arr[0].side} ${arr[0].shares}sh @${arr[0].price} — ${arr.length} identical fills (${dropped} dropped)`);
        // Show logIndex difference
        console.log(`    logIndexes: ${arr.map(f=>f.logIndex).join(", ")} — roles: ${arr.map(f=>f.role).join(", ")}`);
      }
      console.log(`\nTotal dropped: ${droppedFills} fills, ${totalDroppedShares.toFixed(2)} shares, $${totalDroppedUsdc.toFixed(2)}`);
    }
  }
})();
