const K9 = "0xd0d6053c3c37e727402d84c14069780d360993aa";
const K9_PAD = "0x000000000000000000000000" + K9.slice(2);
const ALCHEMY = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;
require("dotenv").config();

const CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const CTF_EXCHANGE = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";
const TRANSFER_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

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

  // Get ALL TransferSingle TO k9 for this event's tokens
  const transfersTo = await alchemyRpc("eth_getLogs", [{
    address: CONDITIONAL_TOKENS, fromBlock, toBlock,
    topics: [TRANSFER_SINGLE, null, null, K9_PAD],
  }]);

  // Get ALL TransferSingle FROM k9 for this event's tokens
  const transfersFrom = await alchemyRpc("eth_getLogs", [{
    address: CONDITIONAL_TOKENS, fromBlock, toBlock,
    topics: [TRANSFER_SINGLE, null, K9_PAD, null],
  }]);

  // Categorize transfers TO k9
  const inflows = { Up: { exchange: 0, rebate: 0, other: 0 }, Down: { exchange: 0, rebate: 0, other: 0 } };
  const rebateAddresses = {};
  for (const log of (transfersTo || [])) {
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
      inflows[outcome].exchange += amount;
    } else {
      inflows[outcome].rebate += amount;
      rebateAddresses[from] = (rebateAddresses[from] || 0) + amount;
    }
  }

  // Categorize transfers FROM k9
  const outflows = { Up: { exchange: 0, other: 0 }, Down: { exchange: 0, other: 0 } };
  for (const log of (transfersFrom || [])) {
    const data = (log.data || "0x").slice(2);
    const chunks = [];
    for (let i = 0; i < data.length; i += 64) chunks.push(data.slice(i, i + 64));
    if (chunks.length < 2) continue;
    const tokenId = BigInt("0x" + chunks[0]).toString();
    const amount = Number(BigInt("0x" + chunks[1])) / 1e6;
    const outcome = tokenMap[tokenId];
    if (!outcome) continue;
    const to = "0x" + log.topics[3].slice(-40).toLowerCase();
    if (to === CTF_EXCHANGE) {
      outflows[outcome].exchange += amount;
    } else {
      outflows[outcome].other += amount;
    }
  }

  console.log(`=== TOKEN FLOW: ${slug} ===\n`);

  for (const oc of ["Up", "Down"]) {
    const inf = inflows[oc];
    const out = outflows[oc];
    const netExchange = inf.exchange - out.exchange;
    const netTotal = inf.exchange + inf.rebate - out.exchange - out.other;
    console.log(`${oc}:`);
    console.log(`  IN from CTF Exchange:  ${inf.exchange.toFixed(2)}sh`);
    console.log(`  IN from rebates:       ${inf.rebate.toFixed(2)}sh`);
    console.log(`  OUT to CTF Exchange:   ${out.exchange.toFixed(2)}sh`);
    console.log(`  OUT to other:          ${out.other.toFixed(2)}sh`);
    console.log(`  NET (exchange only):   ${netExchange.toFixed(2)}sh`);
    console.log(`  NET (including rebate):${netTotal.toFixed(2)}sh`);
    console.log();
  }

  console.log(`Rebate sources:`);
  for (const [addr, amount] of Object.entries(rebateAddresses)) {
    console.log(`  ${addr}: ${amount.toFixed(2)}sh total`);
  }

  console.log(`\nPolymarket shows: Up=774.2sh, Down=1453.0sh`);
})();
