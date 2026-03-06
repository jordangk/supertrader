const K9 = "0xd0d6053c3c37e727402d84c14069780d360993aa";
const K9_PAD = "0x000000000000000000000000" + K9.slice(2);
const ALCHEMY = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;
require("dotenv").config();

const CTF_EXCHANGE = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";
const CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const TRANSFER_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const ORDER_FILLED = "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6";

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

const slug = process.argv[2] || "btc-updown-5m-1772702400";
const epoch = parseInt(slug.split("-").pop());

(async()=>{
  // Token map
  const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
  const d = await r.json();
  const m = d?.[0]?.markets?.[0];
  const tids = JSON.parse(typeof m.clobTokenIds === "string" ? m.clobTokenIds : JSON.stringify(m.clobTokenIds));
  const ocs = JSON.parse(typeof m.outcomes === "string" ? m.outcomes : JSON.stringify(m.outcomes || '["Up","Down"]'));
  const tokenMap = {};
  tids.forEach((tid, i) => { tokenMap[BigInt(tid).toString()] = ocs[i]; });

  const startBlock = await getBlockByTimestamp(epoch - 600);
  const endBlock = await getBlockByTimestamp(epoch + 600);
  const fromBlock = "0x" + startBlock.toString(16);
  const toBlock = "0x" + endBlock.toString(16);

  // Get TransferSingle TO k9
  const transfers = await alchemyRpc("eth_getLogs", [{
    address: CONDITIONAL_TOKENS, fromBlock, toBlock,
    topics: [TRANSFER_SINGLE, null, null, K9_PAD],
  }]);

  // Group by txHash: exchange transfers vs rebate transfers
  const byTx = {};
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
    const tx = log.transactionHash;
    if (!byTx[tx]) byTx[tx] = { exchange: [], rebate: [] };
    if (from === CTF_EXCHANGE) {
      byTx[tx].exchange.push({ outcome, amount });
    } else {
      byTx[tx].rebate.push({ outcome, amount, from });
    }
  }

  // Calculate rebate rate per fill
  let totalExchange = 0, totalRebate = 0;
  let pairs = 0;
  const rates = [];

  for (const [tx, data] of Object.entries(byTx)) {
    if (data.exchange.length === 0 || data.rebate.length === 0) continue;
    // Match by outcome
    for (const reb of data.rebate) {
      const match = data.exchange.find(e => e.outcome === reb.outcome);
      if (match) {
        const rate = reb.amount / match.amount;
        rates.push(rate);
        totalExchange += match.amount;
        totalRebate += reb.amount;
        pairs++;
      }
    }
  }

  rates.sort((a, b) => a - b);

  console.log(`=== REBATE ANALYSIS: ${slug} ===\n`);
  console.log(`Matched pairs (exchange fill + rebate): ${pairs}`);
  console.log(`Total exchange shares: ${totalExchange.toFixed(2)}`);
  console.log(`Total rebate shares: ${totalRebate.toFixed(2)}`);
  console.log(`Overall rebate rate: ${(totalRebate / totalExchange * 100).toFixed(3)}%\n`);

  if (rates.length > 0) {
    console.log(`Per-fill rebate rates:`);
    console.log(`  Min:    ${(rates[0] * 100).toFixed(3)}%`);
    console.log(`  Median: ${(rates[Math.floor(rates.length/2)] * 100).toFixed(3)}%`);
    console.log(`  Max:    ${(rates[rates.length-1] * 100).toFixed(3)}%`);
    console.log(`  Avg:    ${(rates.reduce((a,b)=>a+b,0) / rates.length * 100).toFixed(3)}%`);
  }

  // Also check the fee rate from CLOB
  console.log(`\nCLOB fee rate for this market: ${m.makerBasisPoints || 'N/A'} bps maker / ${m.takerBasisPoints || 'N/A'} bps taker`);

  // Check rewards info
  const rewardResp = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
  const rewardData = await rewardResp.json();
  const mkt = rewardData?.[0]?.markets?.[0];
  if (mkt) {
    console.log(`Rewards daily rate: ${mkt.rewardsDailyRate || 'N/A'}`);
    console.log(`Rewards max spread: ${mkt.rewardsMaxSpread || 'N/A'}`);
    console.log(`Rewards min size: ${mkt.rewardsMinSize || 'N/A'}`);
  }
})();
