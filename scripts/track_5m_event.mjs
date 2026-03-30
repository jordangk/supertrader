import fs from 'fs';

const ALCHEMY_WS = 'wss://polygon-mainnet.g.alchemy.com/v2/8kruQGYamUT6J4Ib0aMfw';
const ALCHEMY_HTTP = 'https://polygon-mainnet.g.alchemy.com/v2/8kruQGYamUT6J4Ib0aMfw';
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const K9_WALLET = '0xd0d6053c3c37e727402d84c14069780d360993aa';
const K9_PAD = '0x000000000000000000000000' + K9_WALLET.slice(2);
const ORDER_FILLED = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';
const GAMMA_API = 'https://gamma-api.polymarket.com/events';

const DURATION_MS = 5 * 60 * 1000 + 10_000; // 5m + 10s buffer
const OUT_DIR = '/Users/jordangk/Desktop/supert/supertrader/csv_exports';

// ── Token map: fetch from Gamma API ──
const tokenMap = {}; // tokenId string -> { slug, outcome }

async function fetchTokensForSlug(slug) {
  try {
    const res = await fetch(`${GAMMA_API}?slug=${slug}`);
    const data = await res.json();
    const markets = data?.[0]?.markets || [];
    for (const m of markets) {
      const tokens = JSON.parse(m.clobTokenIds || '[]');
      const outcomes = JSON.parse(m.outcomes || '[]');
      tokens.forEach((tid, i) => {
        tokenMap[tid] = { slug, outcome: outcomes[i] || (i === 0 ? 'Up' : 'Down') };
      });
    }
  } catch (e) {
    console.error(`Token fetch error for ${slug}:`, e.message);
  }
}

function decodeOrderFilled(log) {
  const topics = log.topics || [];
  if (topics.length < 4) return null;
  const logMaker = '0x' + topics[2].slice(-40).toLowerCase();
  const logTaker = '0x' + topics[3].slice(-40).toLowerCase();
  const walletLower = K9_WALLET.toLowerCase();
  if (logMaker !== walletLower && logTaker !== walletLower) return null;

  const data = (log.data || '0x').slice(2);
  if (data.length < 256) return null;
  const chunks = [];
  for (let i = 0; i < data.length; i += 64) chunks.push(data.slice(i, i + 64));

  const makerAsset  = BigInt('0x' + chunks[0]);
  const takerAsset  = BigInt('0x' + chunks[1]);
  const makerAmount = BigInt('0x' + chunks[2]);
  const takerAmount = BigInt('0x' + chunks[3]);

  const isMaker = logMaker === walletLower;
  let usdcSize, shares, tokenId, side;
  if (isMaker && makerAsset === 0n) {
    usdcSize = Number(makerAmount) / 1e6; shares = Number(takerAmount) / 1e6;
    tokenId = takerAsset; side = 'buy';
  } else if (!isMaker && takerAsset === 0n) {
    usdcSize = Number(takerAmount) / 1e6; shares = Number(makerAmount) / 1e6;
    tokenId = makerAsset; side = 'buy';
  } else if (isMaker && takerAsset === 0n) {
    usdcSize = Number(takerAmount) / 1e6; shares = Number(makerAmount) / 1e6;
    tokenId = makerAsset; side = 'sell';
  } else if (!isMaker && makerAsset === 0n) {
    usdcSize = Number(makerAmount) / 1e6; shares = Number(takerAmount) / 1e6;
    tokenId = takerAsset; side = 'sell';
  } else {
    return null;
  }

  const price = shares > 0 ? Math.round((usdcSize / shares) * 1e8) / 1e8 : 0;
  const info = tokenMap[tokenId.toString()];

  return {
    ts: new Date().toISOString(),
    txHash: log.transactionHash,
    slug: info?.slug || 'unknown',
    outcome: info?.outcome || 'unknown',
    side,
    price,
    shares: Math.round(shares * 100) / 100,
    usdcSize: Math.round(usdcSize * 100) / 100,
  };
}

// ── Main ──
async function main() {
  // Figure out the BTC 5m slug for the 4:40 PM PDT event
  // 4:40 PM PDT = 23:40 UTC on 2026-03-24
  const target = new Date('2026-03-24T23:40:00Z');
  const epoch = Math.floor(target.getTime() / 1000);
  const btc5mSlug = `btc-updown-5m-${epoch}`;
  console.log(`[TRACKER] BTC 5m slug: ${btc5mSlug} (epoch ${epoch})`);

  // Load tokens for current + next epochs
  const interval = 300;
  const base = Math.floor(epoch / interval) * interval;
  for (let i = -1; i <= 2; i++) {
    const slug = `btc-updown-5m-${base + i * interval}`;
    await fetchTokensForSlug(slug);
  }
  console.log(`[TRACKER] Token map: ${Object.keys(tokenMap).length} tokens loaded`);

  // Wait until 4:40 PM PDT
  const now = Date.now();
  const waitMs = target.getTime() - now;
  if (waitMs > 0) {
    console.log(`[TRACKER] Waiting ${(waitMs / 1000).toFixed(0)}s until 4:40 PM PDT...`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  console.log(`[TRACKER] GO — recording for 5 minutes`);

  const priceRows = [['timestamp', 'coin', 'price']];
  const tradeRows = [['timestamp', 'txHash', 'slug', 'outcome', 'side', 'price', 'shares', 'usdcSize']];
  let lastBtc = null, lastEth = null;
  const seenTx = new Set();

  // ── Binance BTC stream ──
  const btcWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade');
  btcWs.onmessage = (evt) => {
    const t = JSON.parse(evt.data);
    if (t.p !== lastBtc) { lastBtc = t.p; priceRows.push([new Date().toISOString(), 'BTC', t.p]); }
  };

  // ── Binance ETH stream ──
  const ethWs = new WebSocket('wss://stream.binance.com:9443/ws/ethusdt@trade');
  ethWs.onmessage = (evt) => {
    const t = JSON.parse(evt.data);
    if (t.p !== lastEth) { lastEth = t.p; priceRows.push([new Date().toISOString(), 'ETH', t.p]); }
  };

  // ── Alchemy k9 watcher ──
  const alchWs = new WebSocket(ALCHEMY_WS);
  let subId = 0;
  alchWs.onopen = () => {
    // Subscribe: k9 as maker
    alchWs.send(JSON.stringify({
      jsonrpc: '2.0', id: ++subId, method: 'eth_subscribe',
      params: ['logs', { address: CTF_EXCHANGE, topics: [ORDER_FILLED, null, null, K9_PAD] }],
    }));
    // Subscribe: k9 as taker
    alchWs.send(JSON.stringify({
      jsonrpc: '2.0', id: ++subId, method: 'eth_subscribe',
      params: ['logs', { address: CTF_EXCHANGE, topics: [ORDER_FILLED, null, K9_PAD, null] }],
    }));
    console.log('[TRACKER] Alchemy WS connected, subscribed to k9 trades');
  };
  alchWs.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.method !== 'eth_subscription') return;
      const log = msg.params?.result;
      if (!log) return;
      const dedup = `${log.transactionHash}:${log.logIndex || '0'}`;
      if (seenTx.has(dedup)) return;
      seenTx.add(dedup);
      const trade = decodeOrderFilled(log);
      if (trade) {
        console.log(`[K9 TRADE] ${trade.side} ${trade.outcome} ${trade.shares}sh @${(trade.price * 100).toFixed(1)}¢ ($${trade.usdcSize}) — ${trade.slug}`);
        tradeRows.push([trade.ts, trade.txHash, trade.slug, trade.outcome, trade.side, trade.price, trade.shares, trade.usdcSize]);
      }
    } catch {}
  };
  alchWs.onerror = (e) => console.error('[ALCHEMY] error:', e.message || e);

  // ── Stop after duration ──
  setTimeout(() => {
    btcWs.close();
    ethWs.close();
    alchWs.close();

    const priceCsv = priceRows.map(r => r.join(',')).join('\n');
    const tradeCsv = tradeRows.map(r => r.join(',')).join('\n');

    const priceFile = `${OUT_DIR}/btc_eth_5m_event_prices.csv`;
    const tradeFile = `${OUT_DIR}/k9_trades_5m_event.csv`;
    fs.writeFileSync(priceFile, priceCsv);
    fs.writeFileSync(tradeCsv.length > tradeRows[0].join(',').length + 1 ? tradeFile : tradeFile, tradeCsv);

    console.log(`\n[DONE] ${priceRows.length - 1} price changes → ${priceFile}`);
    console.log(`[DONE] ${tradeRows.length - 1} k9 trades → ${tradeFile}`);
    process.exit(0);
  }, DURATION_MS);
}

main().catch(e => { console.error(e); process.exit(1); });
