// Fetch trades for a specific wallet on a specific event via Alchemy getLogs
const ALCHEMY = 'https://polygon-mainnet.g.alchemy.com/v2/8kruQGYamUT6J4Ib0aMfw';
const CTF = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const DEFAULT_WALLET = 'd0d6053c3c37e727402d84c14069780d360993aa';
const ORDER_FILLED = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';

const slug = process.argv[2] || 'bitcoin-up-or-down-march-8-9am-et';
const walletArg = (process.argv[3] || '').toLowerCase().replace('0x', '') || DEFAULT_WALLET;
const WALLET = walletArg;
const WALLET_PAD = '0x000000000000000000000000' + WALLET;
console.log(`Wallet: 0x${WALLET}`);

// 1. Resolve event tokens
console.log(`Resolving ${slug}...`);
const evResp = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
const evData = await evResp.json();
const ev = evData?.[0];
if (!ev) { console.log('Event not found'); process.exit(1); }
console.log('Title:', ev.title, '| Closed:', ev.closed);

const market = ev.markets?.[0];
const tokenIds = JSON.parse(market.clobTokenIds || '[]');
const TOKEN_UP = BigInt(tokenIds[0]).toString(16).padStart(64, '0');
const TOKEN_DN = BigInt(tokenIds[1]).toString(16).padStart(64, '0');
console.log('Up token:', TOKEN_UP.slice(0, 16) + '...');
console.log('Dn token:', TOKEN_DN.slice(0, 16) + '...');

// 2. Get current block
const blockResp = await fetch(ALCHEMY, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
});
const currentBlock = parseInt((await blockResp.json()).result, 16);
// 8AM-9AM ET = ~5-6 hours ago. At ~2s/block = ~10800 blocks. Use 12000 for safety.
const lookback = 12000;
console.log(`Block range: ${currentBlock - lookback} to ${currentBlock} (${lookback} blocks, ~${Math.round(lookback*2/3600)}h)`);

// 3. Fetch logs in 2000-block chunks (Alchemy limit)
async function getLogsChunked(topics, from, to) {
  const CHUNK = 2000;
  let all = [];
  for (let start = from; start <= to; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, to);
    const resp = await fetch(ALCHEMY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
        params: [{ fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16), address: CTF, topics }]
      })
    });
    const data = await resp.json();
    if (data.error) { console.log('RPC Error at block', start, ':', data.error.message); continue; }
    all = all.concat(data.result || []);
  }
  return all;
}

const from = currentBlock - lookback;
console.log('Fetching taker logs...');
const takerLogs = await getLogsChunked([ORDER_FILLED, null, null, WALLET_PAD], from, currentBlock);
console.log('Fetching maker logs...');
const makerLogs = await getLogsChunked([ORDER_FILLED, null, WALLET_PAD, null], from, currentBlock);
const allLogs = [...takerLogs, ...makerLogs];

console.log(`\nTotal logs: ${allLogs.length} (taker: ${takerLogs.length}, maker: ${makerLogs.length})`);

// 4. Filter for our event's tokens and tally
let upBuyS = 0, upBuyU = 0, upSellS = 0, upSellU = 0;
let dnBuyS = 0, dnBuyU = 0, dnSellS = 0, dnSellU = 0;
let matched = 0;

for (const log of allLogs) {
  const data = log.data.slice(2);
  const makerAddr = log.topics[2].slice(26).toLowerCase();
  const takerAddr = log.topics[3].slice(26).toLowerCase();
  const makerAssetId = data.slice(0, 64);
  const takerAssetId = data.slice(64, 128);
  const makerAmt = Number(BigInt('0x' + data.slice(128, 192))) / 1e6;
  const takerAmt = Number(BigInt('0x' + data.slice(192, 256))) / 1e6;

  const hasUp = makerAssetId === TOKEN_UP || takerAssetId === TOKEN_UP;
  const hasDn = makerAssetId === TOKEN_DN || takerAssetId === TOKEN_DN;
  if (!hasUp && !hasDn) continue;

  matched++;
  const isWalletMaker = makerAddr === WALLET;

  if (isWalletMaker) {
    // wallet sends makerAsset, receives takerAsset
    if (takerAssetId === TOKEN_UP) { upBuyS += takerAmt; upBuyU += makerAmt; }
    if (makerAssetId === TOKEN_UP) { upSellS += makerAmt; upSellU += takerAmt; }
    if (takerAssetId === TOKEN_DN) { dnBuyS += takerAmt; dnBuyU += makerAmt; }
    if (makerAssetId === TOKEN_DN) { dnSellS += makerAmt; dnSellU += takerAmt; }
  } else {
    // wallet is taker: sends takerAsset, receives makerAsset
    if (makerAssetId === TOKEN_UP) { upBuyS += makerAmt; upBuyU += takerAmt; }
    if (takerAssetId === TOKEN_UP) { upSellS += takerAmt; upSellU += makerAmt; }
    if (makerAssetId === TOKEN_DN) { dnBuyS += makerAmt; dnBuyU += takerAmt; }
    if (takerAssetId === TOKEN_DN) { dnSellS += takerAmt; dnSellU += makerAmt; }
  }
}

// Build time-ordered trade list to check for simultaneous buy/sell
const trades = [];
for (const log of allLogs) {
  const data = log.data.slice(2);
  const makerAddr = log.topics[2].slice(26).toLowerCase();
  const makerAssetId = data.slice(0, 64);
  const takerAssetId = data.slice(64, 128);
  const makerAmt = Number(BigInt('0x' + data.slice(128, 192))) / 1e6;
  const takerAmt = Number(BigInt('0x' + data.slice(192, 256))) / 1e6;

  const hasUp = makerAssetId === TOKEN_UP || takerAssetId === TOKEN_UP;
  const hasDn = makerAssetId === TOKEN_DN || takerAssetId === TOKEN_DN;
  if (!hasUp && !hasDn) continue;

  const isWalletMaker = makerAddr === WALLET;
  let outcome, side, shares, usdc;
  if (isWalletMaker) {
    if (takerAssetId === TOKEN_UP) { outcome='Up'; side='BUY'; shares=takerAmt; usdc=makerAmt; }
    else if (makerAssetId === TOKEN_UP) { outcome='Up'; side='SELL'; shares=makerAmt; usdc=takerAmt; }
    else if (takerAssetId === TOKEN_DN) { outcome='Down'; side='BUY'; shares=takerAmt; usdc=makerAmt; }
    else if (makerAssetId === TOKEN_DN) { outcome='Down'; side='SELL'; shares=makerAmt; usdc=takerAmt; }
  } else {
    if (makerAssetId === TOKEN_UP) { outcome='Up'; side='BUY'; shares=makerAmt; usdc=takerAmt; }
    else if (takerAssetId === TOKEN_UP) { outcome='Up'; side='SELL'; shares=takerAmt; usdc=makerAmt; }
    else if (makerAssetId === TOKEN_DN) { outcome='Down'; side='BUY'; shares=makerAmt; usdc=takerAmt; }
    else if (takerAssetId === TOKEN_DN) { outcome='Down'; side='SELL'; shares=takerAmt; usdc=makerAmt; }
  }
  const block = parseInt(log.blockNumber, 16);
  const price = shares > 0 ? usdc / shares : 0;
  trades.push({ block, outcome, side, shares, usdc, price, txHash: log.transactionHash });
}

trades.sort((a, b) => a.block - b.block);

console.log(`Matched event trades: ${matched}\n`);
console.log(`Up  BUY:  ${upBuyS.toFixed(1)} shares ($${upBuyU.toFixed(2)})`);
console.log(`Up  SELL: ${upSellS.toFixed(1)} shares ($${upSellU.toFixed(2)})`);
console.log(`Up  NET:  ${(upBuyS - upSellS).toFixed(1)} shares`);
console.log();
console.log(`Down BUY:  ${dnBuyS.toFixed(1)} shares ($${dnBuyU.toFixed(2)})`);
console.log(`Down SELL: ${dnSellS.toFixed(1)} shares ($${dnSellU.toFixed(2)})`);
console.log(`Down NET:  ${(dnBuyS - dnSellS).toFixed(1)} shares`);
console.log();
const totalVol = upBuyU + upSellU + dnBuyU + dnSellU;
console.log(`Total volume: $${totalVol.toFixed(2)}`);
console.log(`Total trades: ${matched}`);

// Check for same-block buy+sell on same outcome (market-making pattern)
console.log('\n=== Same-block buy+sell analysis ===');
const byBlock = {};
for (const t of trades) {
  if (!byBlock[t.block]) byBlock[t.block] = [];
  byBlock[t.block].push(t);
}

let mmBlocks = 0;
let mmTrades = 0;
for (const [block, bTrades] of Object.entries(byBlock)) {
  const upBuys = bTrades.filter(t => t.outcome === 'Up' && t.side === 'BUY');
  const upSells = bTrades.filter(t => t.outcome === 'Up' && t.side === 'SELL');
  const dnBuys = bTrades.filter(t => t.outcome === 'Down' && t.side === 'BUY');
  const dnSells = bTrades.filter(t => t.outcome === 'Down' && t.side === 'SELL');

  const upMM = upBuys.length > 0 && upSells.length > 0;
  const dnMM = dnBuys.length > 0 && dnSells.length > 0;
  if (upMM || dnMM) {
    mmBlocks++;
    mmTrades += bTrades.length;
  }
}
console.log(`Blocks with same-outcome buy+sell: ${mmBlocks} / ${Object.keys(byBlock).length} total blocks`);
console.log(`Trades in MM blocks: ${mmTrades} / ${trades.length}`);

// Check for same-block opposite-side trades (buy Up + buy Down = hedged)
let hedgedBlocks = 0;
for (const [block, bTrades] of Object.entries(byBlock)) {
  const buyUp = bTrades.some(t => t.outcome === 'Up' && t.side === 'BUY');
  const buyDn = bTrades.some(t => t.outcome === 'Down' && t.side === 'BUY');
  if (buyUp && buyDn) hedgedBlocks++;
}
console.log(`Blocks buying BOTH Up+Down: ${hedgedBlocks}`);

// Show first 20 trades chronologically
console.log('\n=== First 20 trades ===');
for (const t of trades.slice(0, 20)) {
  console.log(`Block ${t.block} | ${t.side.padEnd(4)} ${t.outcome.padEnd(4)} | ${t.shares.toFixed(1)} shares @ ${t.price.toFixed(3)} ($${t.usdc.toFixed(2)})`);
}

// Show last 20 trades
console.log('\n=== Last 20 trades ===');
for (const t of trades.slice(-20)) {
  console.log(`Block ${t.block} | ${t.side.padEnd(4)} ${t.outcome.padEnd(4)} | ${t.shares.toFixed(1)} shares @ ${t.price.toFixed(3)} ($${t.usdc.toFixed(2)})`);
}
