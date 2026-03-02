import { useEffect, useRef, useState } from 'react';

export function useWebSocket() {
  const [prices, setPrices] = useState({ upPrice: null, downPrice: null, upStartPrice: null, downStartPrice: null });
  const [btc, setBtc] = useState({ current: null, start: null });
  const [event, setEvent] = useState(null);
  const ws = useRef(null);

  useEffect(() => {
    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws.current = new WebSocket(`${protocol}://${window.location.hostname}:3001`);

      ws.current.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'prices') {
            setPrices({
              upPrice: msg.upPrice,
              downPrice: msg.downPrice,
              upStartPrice: msg.upStartPrice,
              downStartPrice: msg.downStartPrice,
            });
          } else if (msg.type === 'btc') {
            setBtc({ current: msg.current, start: msg.start });
          } else if (msg.type === 'event') {
            setEvent(msg.event);
          }
        } catch {}
      };

      ws.current.onclose = () => setTimeout(connect, 2000);
      ws.current.onerror = () => ws.current.close();
    }
    connect();
    return () => ws.current?.close();
  }, []);

  return { prices, btc, event };
}
