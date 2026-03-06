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

const slug = process.argv[2] || "btc-updown-5m-1772702400";
const epoch = parseInt(slug.split("-").pop());

(async()=>{
  console.log(`\n=== FULL CHAIN SCAN: ${slug} ===\n`);

  // Token map
  const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
  const d = await r.json();
  const m = d?.[0]?.markets?.[0];
  if (!m) { console.log("No market found"); return; }
  const tids = JSON.parse(typeof m.clobTokenIds === "string" ? m.clobTokenIds : JSON.stringify(m.clobTokenIds));
  const ocs = JSON.parse(typeof m.outcomes === "string" ? m.outcomes : JSON.stringify(m.outcomes || '["Up","Down"]'));
  const tokenMap = {};
  tids.forEach((tid, i) => { tokenMap[BigInt(tid).toString()] = ocs[i]; });

  // Search from 10 minutes BEFORE event start to 2 minutes after end
  const searchStart = epoch - 600;
  const searchEnd = epoch + 300 + 120;
  console.log(`Search window: ${new Date(searchStart*1000).toISOString()} → ${new Date(searchEnd*1000).toISOString()}`);
  console.log(`(10min before event start to 2min after event end)\n`);

  const startBlock = await getBlockByTimestamp(searchStart);
  const endBlock = await getBlockByTimestamp(searchEnd);
  console.log(`Block range: ${startBlock} → ${endBlock} (${endBlock - startBlock} blocks)`);

  // Fetch logs in chunks if range is large (max 2000 blocks per query)
  let allChainFills = [];
  const CHUNK = 2000;
  for (let from = startBlock; from <= endBlock; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, endBlock);
    const fromHex = "0x" + from.toString(16);
    const toHex = "0x" + to.toString(16);

    const [takerLogs, makerLogs] = await Promise.all([
      alchemyRpc("eth_getLogs", [{ address: CTF, fromBlock: fromHex, toBlock: toHex, topics: [ORDER_FILLED, null, null, K9_PAD] }]),
      alchemyRpc("eth_getLogs", [{ address: CTF, fromBlock: fromHex, toBlock: toHex, topics: [ORDER_FILLED, null, K9_PAD, null] }]),
    ]);

    const seen = new Set();
    const logs = [...(takerLogs||[]), ...(makerLogs||[])].filter(l => {
      const k = `${l.transactionHash}:${l.logIndex}`;
      if (seen.has(k)) return false; seen.add(k); return true;
    });

    for (const log of logs) {
      const f = decodeFill(log, tokenMap);
      if (f) allChainFills.push(f);
    }
  }

  console.log(`\nTotal on-chain fills for this event's tokens: ${allChainFills.length}`);

  // Get block timestamps for time distribution
  const blockNums = [...new Set(allChainFills.map(f => f.blockNumber))].sort((a,b) => a-b);
  const blockTsMap = {};
  // Only fetch timestamps for first and last and a sample
  const sampleBlocks = [blockNums[0], blockNums[Math.floor(blockNums.length/2)], blockNums[blockNums.length-1]];
  for (const bn of sampleBlocks) {
    if (bn === undefined) continue;
    const block = await alchemyRpc("eth_getBlockByNumber", ["0x" + bn.toString(16), false]);
    blockTsMap[bn] = parseInt(block.timestamp, 16);
  }

  if (blockNums.length > 0) {
    const firstTs = blockTsMap[blockNums[0]];
    const lastTs = blockTsMap[blockNums[blockNums.length-1]];
    console.log(`First fill: block ${blockNums[0]} (~${new Date(firstTs*1000).toISOString()}) = ${epoch - firstTs}s before event start`);
    console.log(`Last fill:  block ${blockNums[blockNums.length-1]} (~${new Date(lastTs*1000).toISOString()}) = ${lastTs - epoch}s after event start`);
  }

  // Breakdown
  const stats = { Up: {buyS:0,buyU:0,sellS:0,sellU:0}, Down: {buyS:0,buyU:0,sellS:0,sellU:0} };
  for (const f of allChainFills) {
    if (f.side === "buy") { stats[f.outcome].buyS += f.shares; stats[f.outcome].buyU += f.usdcSize; }
    else { stats[f.outcome].sellS += f.shares; stats[f.outcome].sellU += f.usdcSize; }
  }

  console.log(`\nOn-chain totals (full window):`);
  for (const oc of ["Up","Down"]) {
    const s = stats[oc];
    const net = s.buyS - s.sellS;
    console.log(`  ${oc}: BUY ${s.buyS.toFixed(1)}sh $${s.buyU.toFixed(2)} | SELL ${s.sellS.toFixed(1)}sh $${s.sellU.toFixed(2)} | NET ${net.toFixed(1)}sh`);
  }

  // Compare with Polymarket display
  console.log(`\nPolymarket shows: Up=774.2sh, Down=1453.0sh`);
  console.log(`Our chain:        Up=${(stats.Up.buyS - stats.Up.sellS).toFixed(1)}sh, Down=${(stats.Down.buyS - stats.Down.sellS).toFixed(1)}sh`);

  // Also check our DB
  const {data: dbTrades} = await sb.from("k9_observed_trades")
    .select("outcome,shares").eq("slug", slug);
  const dbUp = dbTrades.filter(t => t.outcome === "Up").reduce((a,t) => a + parseFloat(t.shares), 0);
  const dbDn = dbTrades.filter(t => t.outcome === "Down").reduce((a,t) => a + parseFloat(t.shares), 0);
  console.log(`Our DB:           Up=${dbUp.toFixed(1)}sh, Down=${dbDn.toFixed(1)}sh (${dbTrades.length} rows)`);
})();
