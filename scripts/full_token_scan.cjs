const K9 = "0xd0d6053c3c37e727402d84c14069780d360993aa";
const K9_PAD = "0x000000000000000000000000" + K9.slice(2);
const ALCHEMY = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;
require("dotenv").config();

const CTF_EXCHANGE     = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982e";
const NEGRISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

const ORDER_FILLED      = "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6";
const TRANSFER_SINGLE   = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const TRANSFER_BATCH    = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";
const POSITION_SPLIT    = "0x2e6bb91f8cbcda0c93623c54d0403a43514571de2b5d3d0c46c6137a4ad3956c";
const POSITION_MERGE    = "0x6f13ca62553fcc2bcd2372180a43949c1e4cebba603901ede2f4e14f36b282ca";

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
  console.log(`\n=== FULL TOKEN SCAN: ${slug} ===\n`);

  // Token map from Gamma
  const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
  const d = await r.json();
  const m = d?.[0]?.markets?.[0];
  if (!m) { console.log("No market found"); return; }
  const tids = JSON.parse(typeof m.clobTokenIds === "string" ? m.clobTokenIds : JSON.stringify(m.clobTokenIds));
  const ocs = JSON.parse(typeof m.outcomes === "string" ? m.outcomes : JSON.stringify(m.outcomes || '["Up","Down"]'));
  const tokenMap = {};
  tids.forEach((tid, i) => { tokenMap[BigInt(tid).toString()] = ocs[i]; });
  console.log("Tokens:");
  for (const [tid, oc] of Object.entries(tokenMap)) {
    console.log(`  ${oc}: ${tid}`);
  }
  console.log("negRisk:", m.negRisk);
  console.log("conditionId:", m.conditionId);

  // Wide block range: 10min before to 5min after
  const startBlock = await getBlockByTimestamp(epoch - 600);
  const endBlock = await getBlockByTimestamp(epoch + 600);
  const fromBlock = "0x" + startBlock.toString(16);
  const toBlock = "0x" + endBlock.toString(16);
  console.log(`\nBlock range: ${startBlock}-${endBlock} (${endBlock-startBlock} blocks)\n`);

  // 1. OrderFilled on CTF Exchange (what we already track)
  const [ctfTaker, ctfMaker] = await Promise.all([
    alchemyRpc("eth_getLogs", [{address: CTF_EXCHANGE, fromBlock, toBlock, topics: [ORDER_FILLED, null, null, K9_PAD]}]),
    alchemyRpc("eth_getLogs", [{address: CTF_EXCHANGE, fromBlock, toBlock, topics: [ORDER_FILLED, null, K9_PAD, null]}]),
  ]);
  console.log(`CTF Exchange OrderFilled: ${(ctfTaker||[]).length} taker + ${(ctfMaker||[]).length} maker = ${(ctfTaker||[]).length + (ctfMaker||[]).length}`);

  // 2. OrderFilled on NegRisk Exchange
  const [negTaker, negMaker] = await Promise.all([
    alchemyRpc("eth_getLogs", [{address: NEGRISK_EXCHANGE, fromBlock, toBlock, topics: [ORDER_FILLED, null, null, K9_PAD]}]),
    alchemyRpc("eth_getLogs", [{address: NEGRISK_EXCHANGE, fromBlock, toBlock, topics: [ORDER_FILLED, null, K9_PAD, null]}]),
  ]);
  console.log(`NegRisk Exchange OrderFilled: ${(negTaker||[]).length} taker + ${(negMaker||[]).length} maker = ${(negTaker||[]).length + (negMaker||[]).length}`);

  // 3. ERC1155 TransferSingle on ConditionalTokens TO k9
  const transfersTo = await alchemyRpc("eth_getLogs", [{
    address: CONDITIONAL_TOKENS, fromBlock, toBlock,
    topics: [TRANSFER_SINGLE, null, null, K9_PAD],
  }]);
  console.log(`\nConditionalTokens TransferSingle TO k9: ${(transfersTo||[]).length}`);

  // Filter for this event's token IDs
  let relevantTransfersTo = 0;
  for (const log of (transfersTo || [])) {
    const data = (log.data || "0x").slice(2);
    const chunks = [];
    for (let i = 0; i < data.length; i += 64) chunks.push(data.slice(i, i + 64));
    if (chunks.length >= 2) {
      const tokenId = BigInt("0x" + chunks[0]).toString();
      if (tokenMap[tokenId]) {
        relevantTransfersTo++;
      }
    }
  }
  console.log(`  Relevant to this event: ${relevantTransfersTo}`);

  // 4. TransferSingle FROM k9
  const transfersFrom = await alchemyRpc("eth_getLogs", [{
    address: CONDITIONAL_TOKENS, fromBlock, toBlock,
    topics: [TRANSFER_SINGLE, null, K9_PAD, null],
  }]);
  console.log(`ConditionalTokens TransferSingle FROM k9: ${(transfersFrom||[]).length}`);

  let relevantTransfersFrom = 0;
  for (const log of (transfersFrom || [])) {
    const data = (log.data || "0x").slice(2);
    const chunks = [];
    for (let i = 0; i < data.length; i += 64) chunks.push(data.slice(i, i + 64));
    if (chunks.length >= 2) {
      const tokenId = BigInt("0x" + chunks[0]).toString();
      if (tokenMap[tokenId]) {
        relevantTransfersFrom++;
      }
    }
  }
  console.log(`  Relevant to this event: ${relevantTransfersFrom}`);

  // 5. Check for splits/merges on ConditionalTokens
  const splits = await alchemyRpc("eth_getLogs", [{
    address: CONDITIONAL_TOKENS, fromBlock, toBlock,
    topics: [POSITION_SPLIT, K9_PAD],
  }]);
  console.log(`\nPositionSplit by k9: ${(splits||[]).length}`);

  const merges = await alchemyRpc("eth_getLogs", [{
    address: CONDITIONAL_TOKENS, fromBlock, toBlock,
    topics: [POSITION_MERGE, K9_PAD],
  }]);
  console.log(`PositionMerge by k9: ${(merges||[]).length}`);

  // 6. Check NegRiskAdapter for splits/merges
  const negSplits = await alchemyRpc("eth_getLogs", [{
    address: NEG_RISK_ADAPTER, fromBlock, toBlock,
    topics: [POSITION_SPLIT, K9_PAD],
  }]);
  console.log(`NegRiskAdapter PositionSplit by k9: ${(negSplits||[]).length}`);

  // 7. Show sample of relevant transfers
  if (relevantTransfersTo > 0) {
    console.log(`\nSample TransferSingle TO k9 (this event's tokens):`);
    let count = 0;
    for (const log of (transfersTo || [])) {
      const data = (log.data || "0x").slice(2);
      const chunks = [];
      for (let i = 0; i < data.length; i += 64) chunks.push(data.slice(i, i + 64));
      if (chunks.length >= 2) {
        const tokenId = BigInt("0x" + chunks[0]).toString();
        const amount = Number(BigInt("0x" + chunks[1])) / 1e6;
        const outcome = tokenMap[tokenId];
        if (outcome) {
          const from = "0x" + log.topics[2].slice(-40).toLowerCase();
          console.log(`  ${log.transactionHash.slice(0,20)}... ${outcome} ${amount.toFixed(2)}sh from=${from.slice(0,14)}...`);
          if (++count >= 10) break;
        }
      }
    }
  }
})();
