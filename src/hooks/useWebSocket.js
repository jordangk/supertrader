import { useEffect, useRef, useState } from 'react';

export function useWebSocket() {
  const [prices, setPrices] = useState({ upPrice: null, downPrice: null, upStartPrice: null, downStartPrice: null });
  const [btc, setBtc] = useState({ current: null, start: null });
  const [event, setEvent] = useState(null);
  const [autoSell, setAutoSell] = useState(null);
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
          } else if (msg.type === 'auto-sell') {
            setAutoSell(msg);
          }
        } catch {}
      };

      ws.current.onclose = () => setTimeout(connect, 2000);
      ws.current.onerror = () => ws.current.close();
    }
    connect();
    return () => ws.current?.close();
  }, []);

  return { prices, btc, event, autoSell };
}
