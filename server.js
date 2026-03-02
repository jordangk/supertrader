import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { createServer } from 'http';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';


const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Polymarket CLOB Client ───────────────────────────────────────────────
const CHAIN_ID = 137; // Polygon mainnet
// SignatureType: 0 = EOA, 1 = POLY_PROXY (email/Magic login), 2 = POLY_GNOSIS_SAFE (browser wallet)
const SIGNATURE_TYPE = 0; // EOA
let clobClient = null;

async function initClobClient() {
  try {
    const wallet = new Wallet(process.env.PRIVATE_KEY);
    console.log('[CLOB] Wallet address:', wallet.address);
    console.log('[CLOB] Signature type:', SIGNATURE_TYPE);

    // Derive API credentials
    const tempClient = new ClobClient(
      'https://clob.polymarket.com',
      CHAIN_ID,
      wallet,
    );
    const creds = await tempClient.createOrDeriveApiKey();
    console.log('[CLOB] API key derived:', creds.key);

    // Create authenticated client (EOA — no funderAddress)
    clobClient = new ClobClient(
      'https://clob.polymarket.com',
      CHAIN_ID,
      wallet,
      creds,
      SIGNATURE_TYPE,
    );
    console.log('[CLOB] Client ready');
  } catch (e) {
    console.error('[CLOB] Failed to init client:', e.message);
  }
}

// ── State ──────────────────────────────────────────────────────────────────
let activeEvent = null;
let liveState = {
  upPrice: null,
  downPrice: null,
  upStartPrice: null,
  downStartPrice: null,
  btcStart: null,
  btcCurrent: null,
  eventSlug: null,
  eventTitle: null,
  tokenUp: null,
  tokenDown: null,
};

// ── Fetch current mid-market price from CLOB REST ────────────────────────
async function fetchClobPrice(tokenId) {
  try {
    const res = await fetch(`https://clob.polymarket.com/price?token_id=${tokenId}&side=buy`);
    const data = await res.json();
    return data.price ? parseFloat(data.price) : null;
  } catch (e) {
    console.error('[CLOB REST] price fetch error:', e.message);
    return null;
  }
}

async function fetchClobBook(tokenId) {
  try {
    const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    const data = await res.json();
    const bestBid = data.bids?.[0]?.price;
    const bestAsk = data.asks?.[0]?.price;
    if (bestBid && bestAsk) return (parseFloat(bestBid) + parseFloat(bestAsk)) / 2;
    if (bestBid) return parseFloat(bestBid);
    if (bestAsk) return parseFloat(bestAsk);
    return null;
  } catch (e) {
    console.error('[CLOB REST] book fetch error:', e.message);
    return null;
  }
}

async function fetchInitialPrices() {
  if (!liveState.tokenUp || !liveState.tokenDown) return;
  const [upPrice, downPrice] = await Promise.all([
    fetchClobPrice(liveState.tokenUp),
    fetchClobPrice(liveState.tokenDown),
  ]);
  console.log('[CLOB REST] initial prices — up:', upPrice, 'down:', downPrice);
  if (upPrice != null) liveState.upPrice = upPrice;
  if (downPrice != null) liveState.downPrice = downPrice;
  // Capture start prices (first prices we see for this event)
  if (liveState.upStartPrice == null && upPrice != null) liveState.upStartPrice = upPrice;
  if (liveState.downStartPrice == null && downPrice != null) liveState.downStartPrice = downPrice;
  broadcast({ type: 'prices', ...liveState });
}

// ── Broadcast to all frontend clients ─────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// Track when WS last gave us a real price update
let lastWsPrice = 0;

// ── Fetch active 5m BTC event from Polymarket ─────────────────────────────
async function fetchActiveEvent() {
  try {
    // Find current 5m BTC event by timestamp
    const now = Math.floor(Date.now() / 1000);
    // Round down to nearest 5 min
    const slot = Math.floor(now / 300) * 300;
    const slug = `btc-updown-5m-${slot}`;

    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    const data = await res.json();
    const event = Array.isArray(data) ? data[0] : data;
    if (!event) return null;

    const market = event.markets?.[0];
    if (!market) return null;

    const tokenIds = typeof market.clobTokenIds === 'string'
      ? JSON.parse(market.clobTokenIds)
      : market.clobTokenIds;

    console.log('[EVENT] Market flags:', {
      negRisk: market.negRisk,
      enableNegRisk: event.enableNegRisk,
      negRiskAugmented: event.negRiskAugmented,
      tickSize: market.orderPriceMinTickSize,
      feeType: market.feeType,
    });

    return {
      slug: event.slug,
      title: event.title,
      startDate: event.startDate,
      endDate: event.endDate,
      tokenUp: tokenIds[0],   // index 0 = Up
      tokenDown: tokenIds[1], // index 1 = Down
      marketId: market.id,
      tickSize: market.orderPriceMinTickSize || '0.01',
      negRisk: !!market.negRisk,
    };
  } catch (e) {
    console.error('fetchActiveEvent error:', e.message);
    return null;
  }
}

// ── Polymarket CLOB WebSocket for live prices ──────────────────────────────
let clobWs = null;

function connectClobStream(tokenIds) {
  if (clobWs) clobWs.close();

  clobWs = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

  clobWs.on('open', () => {
    console.log('[CLOB WS] connected');
    clobWs.send(JSON.stringify({
      assets_ids: tokenIds,
      type: 'market',
    }));
  });

  clobWs.on('message', (raw) => {
    try {
      const msgs = JSON.parse(raw);
      const arr = Array.isArray(msgs) ? msgs : [msgs];
      let changed = false;
      for (const msg of arr) {
        let price = null;
        let assetId = msg.asset_id || msg.market;

        // Only use trade-based prices, NOT book snapshots (which reset to 50¢ on thin books)
        if (msg.event_type === 'price_change' || msg.type === 'price_change') {
          price = parseFloat(msg.price);
        } else if (msg.event_type === 'last_trade_price' || msg.type === 'last_trade_price') {
          price = parseFloat(msg.price);
        }
        // Skip book messages — they cause flashing with stale mid-market on thin 5m events

        if (price != null && !isNaN(price) && price > 0 && price < 1) {
          if (assetId === liveState.tokenUp) {
            liveState.upPrice = price;
            if (liveState.upStartPrice == null) liveState.upStartPrice = price;
            changed = true;
          } else if (assetId === liveState.tokenDown) {
            liveState.downPrice = price;
            if (liveState.downStartPrice == null) liveState.downStartPrice = price;
            changed = true;
          }
        }
      }
      if (changed) {
        lastWsPrice = Date.now();
        broadcast({ type: 'prices', ...liveState });
      }
    } catch {}
  });

  clobWs.on('close', () => {
    console.log('[CLOB WS] disconnected, reconnecting in 3s...');
    setTimeout(() => { if (liveState.tokenUp) connectClobStream([liveState.tokenUp, liveState.tokenDown]); }, 3000);
  });

  clobWs.on('error', (e) => console.error('[CLOB WS] error:', e.message));
}

// ── BTC price from Polymarket RTDS (Chainlink feed) ──────────────────────
let btcWs = null;
let btcRetryDelay = 3000;

function connectBtcStream() {
  if (btcWs) btcWs.close();
  btcWs = new WebSocket('wss://ws-live-data.polymarket.com');
  btcWs.on('open', () => {
    btcRetryDelay = 3000; // Reset backoff on successful connect
    console.log('[BTC RTDS] connected to Polymarket Chainlink feed');
    btcWs.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [{
        topic: 'crypto_prices_chainlink',
        type: '*',
        filters: '{"symbol":"btc/usd"}',
      }],
    }));
  });
  btcWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.topic === 'crypto_prices_chainlink' && msg.payload?.value) {
        liveState.btcCurrent = parseFloat(msg.payload.value);
        if (liveState.btcStart == null) liveState.btcStart = liveState.btcCurrent;
        broadcast({ type: 'btc', current: liveState.btcCurrent, start: liveState.btcStart });
      }
    } catch {}
  });
  btcWs.on('close', () => {
    console.log(`[BTC RTDS] disconnected, reconnecting in ${btcRetryDelay / 1000}s...`);
    setTimeout(connectBtcStream, btcRetryDelay);
    btcRetryDelay = Math.min(btcRetryDelay * 2, 30000); // Exponential backoff, max 30s
  });
  btcWs.on('error', (e) => console.error('[BTC RTDS] error:', e.message));
}

// ── Refresh event on the 5-min boundary ──────────────────────────────────
let eventTimer = null;

function scheduleNextEvent() {
  if (eventTimer) clearTimeout(eventTimer);
  // Next 5-min boundary + 2s buffer for Polymarket to create it
  const now = Date.now();
  const nowSecs = Math.floor(now / 1000);
  const nextSlot = (Math.floor(nowSecs / 300) + 1) * 300;
  const delay = (nextSlot * 1000) - now + 2000;
  console.log(`[EVENT] Next event in ${Math.round(delay / 1000)}s`);
  eventTimer = setTimeout(async () => {
    await refreshEvent();
    scheduleNextEvent();
  }, delay);
}

async function refreshEvent() {
  const event = await fetchActiveEvent();
  if (event && event.slug !== liveState.eventSlug) {
    console.log('[EVENT] new active event:', event.slug);
    liveState.eventSlug = event.slug;
    liveState.eventTitle = event.title;
    liveState.tokenUp = event.tokenUp;
    liveState.tokenDown = event.tokenDown;
    liveState.upPrice = null;
    liveState.downPrice = null;
    liveState.upStartPrice = null;
    liveState.downStartPrice = null;
    // Capture current BTC as the start price for this event, then reset so next tick re-captures
    liveState.btcStart = liveState.btcCurrent;
    activeEvent = event;
    broadcast({ type: 'event', event });
    // Fetch initial prices via REST immediately
    await fetchInitialPrices();
    // Then connect WS for live streaming
    if (event.tokenUp && event.tokenDown) {
      connectClobStream([event.tokenUp, event.tokenDown]);
    }
  }
}

// ── Price poll every 500ms via REST ──────────────────────────────────────
let pricePollInterval = null;
let pricePollInFlight = false;
function startPricePoll() {
  if (pricePollInterval) clearInterval(pricePollInterval);
  pricePollInterval = setInterval(async () => {
    if (!liveState.tokenUp || !liveState.tokenDown) return;
    if (pricePollInFlight) return; // skip if previous request still pending
    pricePollInFlight = true;
    try {
      const [upPrice, downPrice] = await Promise.all([
        fetchClobPrice(liveState.tokenUp),
        fetchClobPrice(liveState.tokenDown),
      ]);
      let changed = false;
      if (upPrice != null && upPrice !== liveState.upPrice) { liveState.upPrice = upPrice; changed = true; }
      if (downPrice != null && downPrice !== liveState.downPrice) { liveState.downPrice = downPrice; changed = true; }
      if (liveState.upStartPrice == null && upPrice != null) liveState.upStartPrice = upPrice;
      if (liveState.downStartPrice == null && downPrice != null) liveState.downStartPrice = downPrice;
      if (changed) broadcast({ type: 'prices', ...liveState });
    } finally {
      pricePollInFlight = false;
    }
  }, 500);
}

// ── Buy order ──────────────────────────────────────────────────────────────
app.post('/api/buy', async (req, res) => {
  const { side, amount } = req.body; // side: 'up' | 'down', amount: number

  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });

  const price = side === 'up' ? liveState.upPrice : liveState.downPrice;
  const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;

  if (!price) return res.status(400).json({ error: 'No price available' });

  const buyPrice = Math.min(price + 0.01, 0.99);
  const shares = amount / buyPrice;

  // Snapshot of both prices & time left at moment of buy
  const endDate = activeEvent.endDate ? new Date(activeEvent.endDate) : null;
  const timeLeftSecs = endDate ? Math.max(0, Math.floor((endDate - Date.now()) / 1000)) : null;

  // Record to Supabase — same polymarket_trades table
  const tradeData = {
    polymarket_event_id: liveState.eventSlug,
    direction: side === 'up' ? 'up' : 'down',
    purchase_price: buyPrice,
    purchase_amount: amount,
    purchase_time: new Date().toISOString(),
    btc_price_at_purchase: liveState.btcCurrent,
    order_type: 'supertrader',
    order_status: 'pending',
    shares: shares,
    notes: JSON.stringify({
      tokenId,
      eventTitle: liveState.eventTitle,
      upPriceAtBuy: liveState.upPrice,
      downPriceAtBuy: liveState.downPrice,
      timeLeftSecs,
    }),
  };

  const { data: trade, error: dbErr } = await supabase
    .from('polymarket_trades')
    .insert(tradeData)
    .select()
    .single();

  if (dbErr) console.error('DB error:', dbErr);

  // Fetch existing holdings before this buy
  const { data: existingOrders } = await supabase
    .from('polymarket_trades')
    .select('direction, shares, purchase_amount')
    .eq('order_type', 'supertrader')
    .eq('polymarket_event_id', liveState.eventSlug)
    .neq('order_status', 'resolved');

  const holdings = { up: { shares: 0, cost: 0 }, down: { shares: 0, cost: 0 } };
  for (const o of (existingOrders || [])) {
    const s = o.direction;
    if (holdings[s]) {
      holdings[s].shares += parseFloat(o.shares || 0);
      holdings[s].cost += parseFloat(o.purchase_amount || 0);
    }
  }
  holdings.up.value = liveState.upPrice ? holdings.up.shares * liveState.upPrice : null;
  holdings.down.value = liveState.downPrice ? holdings.down.shares * liveState.downPrice : null;

  // Place order via Polymarket CLOB Client (properly signed)
  let orderData = null;
  let orderError = null;
  if (!clobClient) {
    orderError = 'CLOB client not initialized';
  } else {
    try {
      // Round price to 2 decimals (Polymarket requirement)
      const roundedPrice = Math.round(buyPrice * 100) / 100;
      // size = number of shares to buy (amount in dollars / price per share)
      // Ceil to 2dp to ensure we always meet minimum order size after CLOB rounding
      const rawSize = amount / roundedPrice;
      const roundedSize = Math.ceil(rawSize * 100) / 100;

      const tickSize = String(activeEvent.tickSize || '0.01');
      const negRisk = !!activeEvent.negRisk;
      console.log('[ORDER] Creating signed order:', { tokenId, price: roundedPrice, size: roundedSize, dollarAmount: amount, side: 'BUY', tickSize, negRisk });

      const signedOrder = await clobClient.createOrder(
        {
          tokenID: tokenId,
          price: roundedPrice,
          side: 'BUY',
          size: roundedSize,
        },
        { tickSize, negRisk },
      );

      console.log('[ORDER] Posting signed order...');
      orderData = await clobClient.postOrder(signedOrder);
      console.log('[ORDER]', orderData);

      // Check if Polymarket accepted
      if (orderData.error || orderData.errorMsg) {
        orderError = orderData.error || orderData.errorMsg;
        console.error('[ORDER REJECTED]', orderError);
      }
    } catch (e) {
      orderError = e.message;
      console.error('[ORDER ERROR]', e.message);
    }
  }

  // Update DB with result
  const orderId = orderData?.orderID || orderData?.orderId || orderData?.id;
  if (trade) {
    if (!orderError && orderId) {
      await supabase.from('polymarket_trades').update({
        polymarket_order_id: orderId,
        order_status: 'filled',
      }).eq('id', trade.id);
    } else {
      await supabase.from('polymarket_trades').update({
        order_status: orderError ? 'error' : 'pending',
        notes: JSON.stringify({
          ...JSON.parse(tradeData.notes),
          orderError: orderError || null,
        }),
      }).eq('id', trade.id);
    }
  }

  const success = !orderError && !dbErr;
  res.json({
    success,
    error: orderError || (dbErr ? dbErr.message : null),
    dbError: dbErr ? dbErr.message : null,
    trade: trade || tradeData, // return tradeData even if DB failed
    order: orderData,
    price: buyPrice,
    shares,
    snapshot: {
      upPrice: liveState.upPrice,
      downPrice: liveState.downPrice,
      btcPrice: liveState.btcCurrent,
      timeLeftSecs,
      holdings,
    },
  });
});

// ── Recent orders ──────────────────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  const { data, error } = await supabase
    .from('polymarket_trades')
    .select('*')
    .eq('order_type', 'supertrader')
    .order('created_at', { ascending: false })
    .limit(50);
  res.json({ orders: data || [], error });
});

// ── Wallet balance ─────────────────────────────────────────────────────────
app.get('/api/wallet', async (req, res) => {
  try {
    const r = await fetch(`https://data-api.polymarket.com/portfolio?user=${process.env.FUNDER_ADDRESS}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Active event ───────────────────────────────────────────────────────────
app.get('/api/event', (req, res) => res.json({ event: activeEvent, liveState }));

// ── WS frontend connection ─────────────────────────────────────────────────
wss.on('connection', (ws) => {
  // Send current state immediately on connect
  ws.send(JSON.stringify({ type: 'event', event: activeEvent }));
  ws.send(JSON.stringify({ type: 'prices', ...liveState }));
  ws.send(JSON.stringify({ type: 'btc', current: liveState.btcCurrent, start: liveState.btcStart }));
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  console.log(`SuperTrader server running on http://localhost:${PORT}`);
  await initClobClient();
  await refreshEvent();
  connectBtcStream();
  startPricePoll();
  scheduleNextEvent();
});
