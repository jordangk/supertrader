import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { createServer } from 'http';


const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── State ──────────────────────────────────────────────────────────────────
let activeEvent = null;
let liveState = {
  upPrice: null,
  downPrice: null,
  btcStart: null,
  btcCurrent: null,
  eventSlug: null,
  eventTitle: null,
  tokenUp: null,
  tokenDown: null,
};

// ── Broadcast to all frontend clients ─────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

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

    return {
      slug: event.slug,
      title: event.title,
      startDate: event.startDate,
      endDate: event.endDate,
      tokenUp: tokenIds[0],   // index 0 = Up
      tokenDown: tokenIds[1], // index 1 = Down
      marketId: market.id,
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
        if (msg.event_type === 'price_change' || msg.type === 'price_change') {
          const price = parseFloat(msg.price);
          if (msg.asset_id === liveState.tokenUp || msg.market === liveState.tokenUp) {
            liveState.upPrice = price;
            changed = true;
          } else if (msg.asset_id === liveState.tokenDown || msg.market === liveState.tokenDown) {
            liveState.downPrice = price;
            changed = true;
          }
        }
        if (msg.event_type === 'book' || msg.type === 'book') {
          const bestBid = msg.bids?.[0]?.price;
          if (bestBid) {
            if (msg.asset_id === liveState.tokenUp) { liveState.upPrice = parseFloat(bestBid); changed = true; }
            if (msg.asset_id === liveState.tokenDown) { liveState.downPrice = parseFloat(bestBid); changed = true; }
          }
        }
      }
      if (changed) broadcast({ type: 'prices', ...liveState });
    } catch {}
  });

  clobWs.on('close', () => {
    console.log('[CLOB WS] disconnected, reconnecting in 3s...');
    setTimeout(() => { if (liveState.tokenUp) connectClobStream([liveState.tokenUp, liveState.tokenDown]); }, 3000);
  });

  clobWs.on('error', (e) => console.error('[CLOB WS] error:', e.message));
}

// ── BTC price from Binance (same as poly) ─────────────────────────────────
let btcWs = null;

function connectBtcStream() {
  if (btcWs) btcWs.close();
  btcWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker');
  btcWs.on('message', (raw) => {
    try {
      const d = JSON.parse(raw);
      liveState.btcCurrent = parseFloat(d.c);
      if (!liveState.btcStart) liveState.btcStart = parseFloat(d.o); // 24h open
      broadcast({ type: 'btc', current: liveState.btcCurrent, start: liveState.btcStart });
    } catch {}
  });
  btcWs.on('close', () => setTimeout(connectBtcStream, 3000));
  btcWs.on('error', () => {});
}

// ── Poll for active event every 30s ───────────────────────────────────────
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
    activeEvent = event;
    if (event.tokenUp && event.tokenDown) {
      connectClobStream([event.tokenUp, event.tokenDown]);
    }
    broadcast({ type: 'event', event });
  }
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
    notes: JSON.stringify({ tokenId, eventTitle: liveState.eventTitle }),
  };

  const { data: trade, error: dbErr } = await supabase
    .from('polymarket_trades')
    .insert(tradeData)
    .select()
    .single();

  if (dbErr) console.error('DB error:', dbErr);

  // Place order via Polymarket CLOB API
  try {
    const orderRes = await fetch('https://clob.polymarket.com/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token_id: tokenId,
        price: buyPrice,
        size: parseFloat(amount.toFixed(2)),
        side: 'BUY',
        order_type: 'GTC',
        funder: process.env.FUNDER_ADDRESS,
      }),
    });
    const orderData = await orderRes.json();
    console.log('[ORDER]', orderData);

    // Update DB with order ID
    if (trade && orderData.orderId) {
      await supabase.from('polymarket_trades').update({
        polymarket_order_id: orderData.orderId,
        order_status: 'filled',
      }).eq('id', trade.id);
    }

    res.json({ success: true, trade, order: orderData, price: buyPrice, shares });
  } catch (e) {
    console.error('[ORDER ERROR]', e.message);
    res.json({ success: false, error: e.message, trade, price: buyPrice, shares });
  }
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
  await refreshEvent();
  connectBtcStream();
  setInterval(refreshEvent, 30000);
});
