import { useEffect, useRef, useState } from 'react';

export function useWebSocket() {
  const [prices, setPrices] = useState({ upPrice: null, downPrice: null, upStartPrice: null, downStartPrice: null });
  const [btc, setBtc] = useState({ current: null, start: null });
  const [binanceBtc, setBinanceBtc] = useState(null);
  const [serverEma, setServerEma] = useState({ e12: null, e26: null, gap: 0, histogram: 0 });
  const [priceEma, setPriceEma] = useState({ upE12: null, upE26: null, downE12: null, downE26: null });
  const [event, setEvent] = useState(null);
  const [autoSell, setAutoSell] = useState(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [copyFeed, setCopyFeed] = useState([]); // combined k9 + our copy orders
  const [whaleTrades, setWhaleTrades] = useState([]);
  const ws = useRef(null);

  useEffect(() => {
    function connect() {
      const apiUrl = (import.meta.env.VITE_API_URL || 'http://localhost:3001').trim();
      const url = new URL(apiUrl);
      const wsUrl = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`;
      ws.current = new WebSocket(wsUrl);

      ws.current.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'prices') {
            setPrices(prev => {
              const up = msg.upPrice != null ? parseFloat(msg.upPrice) : null;
              const down = msg.downPrice != null ? parseFloat(msg.downPrice) : null;
              const pendingSells = (msg.pendingSells || []).map(ps => ({ ...ps }));
              if (msg.priceEma) setPriceEma(msg.priceEma);
              const next = { upPrice: up, downPrice: down, upStartPrice: msg.upStartPrice ?? prev.upStartPrice, downStartPrice: msg.downStartPrice ?? prev.downStartPrice, tokenUp: msg.tokenUp ?? prev.tokenUp, tokenDown: msg.tokenDown ?? prev.tokenDown, pendingSells };
              // Compare pending sells ignoring age (changes every tick)
              const psKey = ps => `${ps.id}|${ps.side}|${ps.shares}|${ps.targetPrice}`;
              const prevPsKeys = (prev.pendingSells || []).map(psKey).join(',');
              const nextPsKeys = pendingSells.map(psKey).join(',');
              if (prev.upPrice === next.upPrice && prev.downPrice === next.downPrice && prev.tokenUp === next.tokenUp && prevPsKeys === nextPsKeys) return prev;
              return next;
            });
          } else if (msg.type === 'btc') {
            setBtc(prev => {
              const current = msg.current != null ? parseFloat(msg.current) : null;
              const start = msg.start != null ? parseFloat(msg.start) : prev.start;
              if (prev.current === current && prev.start === start) return prev;
              return { current, start };
            });
          } else if (msg.type === 'event') {
            setEvent(msg.event);
          } else if (msg.type === 'binance_btc') {
            setBinanceBtc(msg.price != null ? parseFloat(msg.price) : null);
            if (msg.ema) setServerEma(msg.ema);
          } else if (msg.type === 'auto-sell') {
            setAutoSell(msg);
          } else if (msg.type === 'refresh') {
            setRefreshTrigger(t => t + 1);
          } else if (msg.type === 'k9_trades') {
            setCopyFeed(prev => {
              const entries = (msg.trades || []).map(t => ({
                ts: Date.now(), who: 'k9', side: t.side, outcome: t.outcome,
                shares: t.shares, price: t.price, usdc: t.usdcSize, slug: t.slug,
              }));
              return [...entries, ...prev].slice(0, 100);
            });
          } else if (msg.type === 'whale_trades') {
            setWhaleTrades(prev => {
              const entries = (msg.trades || []).map(t => ({
                ts: (t.ts || 0) * 1000, side: t.side, outcome: t.outcome,
                shares: t.shares, price: t.price, usdc: t.usdcSize, slug: t.slug,
                marketUp: t.marketUp, marketDown: t.marketDown, tx_hash: t.txHash,
                blockNumber: t.blockNumber, logIndex: t.logIndex,
              }));
              return [...entries, ...prev].slice(0, 200);
            });
          } else if (msg.type === 'k9_copy') {
            setCopyFeed(prev => {
              const entry = {
                ts: msg.ts || Date.now(), who: 'us', side: msg.side || msg.action,
                outcome: msg.outcome, shares: msg.shares, price: msg.price,
                usdc: msg.usdc, error: msg.error, orderId: msg.orderId,
              };
              return [entry, ...prev].slice(0, 100);
            });
          }
        } catch {}
      };

      ws.current.onclose = () => setTimeout(connect, 2000);
      ws.current.onerror = () => ws.current.close();
    }
    connect();
    return () => ws.current?.close();
  }, []);

  return { prices, btc, binanceBtc, serverEma, priceEma, event, autoSell, refreshTrigger, copyFeed, whaleTrades };
}
