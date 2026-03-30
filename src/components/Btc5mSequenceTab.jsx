import React, { useEffect, useMemo, useState } from 'react';

const WINDOW_SEC = 300;
const MAX_SAMPLES = 5000;

function fmtPct(x) {
  if (x == null || Number.isNaN(x)) return '—';
  return `${(x * 100).toFixed(1)}¢`;
}

function parseBtc5mEpoch(raw) {
  const s = String(raw || '');
  const m = s.match(/btc-updown-5m-(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function current5mEpoch() {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor(now / WINDOW_SEC) * WINDOW_SEC;
}

function avg(arr, key) {
  if (!arr.length) return null;
  const vals = arr.map((x) => x[key]).filter((v) => v != null && !Number.isNaN(v));
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function winnerFromOutcomePrices(market) {
  try {
    const arr = typeof market?.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices)
      : market?.outcomePrices;
    if (!Array.isArray(arr) || arr.length < 2) return null;
    if (arr[0] === '1' || arr[0] === 1) return 'Up';
    if (arr[1] === '1' || arr[1] === 1) return 'Down';
    return null;
  } catch {
    return null;
  }
}

async function fetchTokenPrice(tokenId) {
  try {
    const r = await fetch(`https://clob.polymarket.com/price?token_id=${encodeURIComponent(tokenId)}&side=sell`);
    const d = await r.json();
    const p = parseFloat(d?.price);
    return Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

async function fetchOneWindow(epoch) {
  const slug = `btc-updown-5m-${epoch}`;
  const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
  const arr = await r.json();
  const ev = Array.isArray(arr) ? arr[0] : null;
  const m = ev?.markets?.[0];
  if (!m) return { epoch, slug, error: 'no market' };
  const tids = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
  const upToken = tids?.[0];
  const downToken = tids?.[1];
  const [up, down] = await Promise.all([
    upToken ? fetchTokenPrice(upToken) : Promise.resolve(null),
    downToken ? fetchTokenPrice(downToken) : Promise.resolve(null),
  ]);
  const sum = up != null && down != null ? up + down : null;
  const skew = up != null ? up - 0.5 : null;
  const winner = ev?.closed ? winnerFromOutcomePrices(m) : null;
  return {
    epoch,
    slug,
    up,
    down,
    sum,
    skew,
    closed: !!ev?.closed,
    winner,
    url: `https://polymarket.com/event/${slug}`,
  };
}

export default function Btc5mSequenceTab() {
  const [anchorInput, setAnchorInput] = useState('');
  const [rows, setRows] = useState([]);
  const [samples, setSamples] = useState([]);
  const [loading, setLoading] = useState(false);
  const [xOutcome, setXOutcome] = useState(null);
  const [x3Outcome, setX3Outcome] = useState(null);
  const [snapshotX1Close, setSnapshotX1Close] = useState(null);
  const anchorEpoch = useMemo(() => parseBtc5mEpoch(anchorInput) || current5mEpoch(), [anchorInput]);

  const xEnd = anchorEpoch + WINDOW_SEC;
  const x1End = anchorEpoch + 2 * WINDOW_SEC;
  const x3End = anchorEpoch + 4 * WINDOW_SEC;

  useEffect(() => {
    setSamples([]);
    setXOutcome(null);
    setX3Outcome(null);
    setSnapshotX1Close(null);
  }, [anchorEpoch]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const now = Math.floor(Date.now() / 1000);
      setLoading(true);
      const seq = [anchorEpoch, anchorEpoch + WINDOW_SEC, anchorEpoch + 2 * WINDOW_SEC, anchorEpoch + 3 * WINDOW_SEC];
      const data = await Promise.all(seq.map((e) => fetchOneWindow(e)));
      if (cancelled) return;
      setRows(data);
      setLoading(false);

      const s = {
        ts: now,
        x: data[0]?.up ?? null,
        x1: data[1]?.up ?? null,
        x2: data[2]?.up ?? null,
        x3: data[3]?.up ?? null,
      };
      setSamples((prev) => [...prev, s].slice(-MAX_SAMPLES));
      if (!xOutcome && data[0]?.winner) setXOutcome(data[0].winner);
      if (!x3Outcome && data[3]?.winner) setX3Outcome(data[3].winner);

      if (!snapshotX1Close && now >= x1End) {
        const inX1 = [...samples, s].filter((p) => p.ts >= xEnd && p.ts < x1End);
        if (inX1.length) {
          const a1 = avg(inX1, 'x1');
          const a2 = avg(inX1, 'x2');
          const a3 = avg(inX1, 'x3');
          setSnapshotX1Close({
            sampleCount: inX1.length,
            avgX1: a1,
            avgX2: a2,
            avgX3: a3,
            x3Signal: a3 == null ? null : (a3 >= 0.5 ? 'Up' : 'Down'),
            x3SignalStrengthCents: a3 == null ? null : Math.abs((a3 - 0.5) * 100),
            capturedAt: now,
          });
        }
      }
    }

    load();
    const iv = setInterval(load, 1000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [anchorEpoch, x1End, xEnd, samples, snapshotX1Close, xOutcome, x3Outcome]);

  const liveAverages = useMemo(() => {
    const inX1 = samples.filter((p) => p.ts >= xEnd && p.ts < x1End);
    return {
      sampleCount: inX1.length,
      avgX1: avg(inX1, 'x1'),
      avgX2: avg(inX1, 'x2'),
      avgX3: avg(inX1, 'x3'),
    };
  }, [samples, xEnd, x1End]);

  const now = Math.floor(Date.now() / 1000);
  const secsToXEnd = Math.max(0, xEnd - now);
  const secsToX1End = Math.max(0, x1End - now);
  const phase = now < xEnd ? 'tracking X (pre-close)' : now < x1End ? 'tracking X+1 (for end-of-X+1 averages)' : 'X+1 closed';

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <input
          className="flex-1 bg-gray-950 border border-gray-700 rounded px-2 py-1.5 font-mono text-[11px]"
          value={anchorInput}
          onChange={(e) => setAnchorInput(e.target.value)}
          placeholder="Paste BTC 5m URL/slug for event X (optional)"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => setAnchorInput('')}
          className="px-2 py-1 rounded bg-gray-800 text-gray-300 text-[10px] hover:bg-gray-700"
        >
          now
        </button>
      </div>

      <div className="text-[10px] text-gray-500">
        Event study: tracks X, X+1, X+2, X+3 once per second. After X+1 closes, freezes avg prices of X+1/X+2/X+3.
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[10px] font-mono">
        <div className="rounded border border-gray-800 bg-black/20 p-2 text-gray-300">phase: {phase}</div>
        <div className="rounded border border-gray-800 bg-black/20 p-2 text-gray-300">to X close: {secsToXEnd}s</div>
        <div className="rounded border border-gray-800 bg-black/20 p-2 text-gray-300">to X+1 close: {secsToX1End}s</div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr className="text-gray-500 border-b border-gray-800">
              <th className="text-left py-1 pr-2">Window</th>
              <th className="text-left py-1 pr-2">Up</th>
              <th className="text-left py-1 pr-2">Down</th>
              <th className="text-left py-1 pr-2">Sum</th>
              <th className="text-left py-1 pr-2">Up-50</th>
              <th className="text-left py-1">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={r.epoch} className="border-b border-gray-800/60">
                <td className="py-1 pr-2 text-gray-300">{idx === 0 ? 'X' : `X+${idx}`}</td>
                <td className="py-1 pr-2 text-green-400">{fmtPct(r.up)}</td>
                <td className="py-1 pr-2 text-red-400">{fmtPct(r.down)}</td>
                <td className="py-1 pr-2 text-gray-300">{fmtPct(r.sum)}</td>
                <td className={`py-1 pr-2 ${r.skew == null ? 'text-gray-500' : r.skew >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {r.skew == null ? '—' : `${r.skew >= 0 ? '+' : ''}${(r.skew * 100).toFixed(1)}¢`}
                </td>
                <td className="py-1 text-gray-300">
                  {r.winner || (r.closed ? 'closed (unresolved)' : 'live')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded border border-gray-800 bg-black/20 p-2">
          <div className="text-[11px] text-cyan-400 font-semibold mb-1">At End Of X+1 (prediction snapshot)</div>
          {!snapshotX1Close ? (
            <div className="text-[10px] text-gray-500">
              Collecting... this will freeze once X+1 closes.
              <div className="text-gray-600 mt-1">
                Current live avg (X+1 window): X+1 {fmtPct(liveAverages.avgX1)} | X+2 {fmtPct(liveAverages.avgX2)} | X+3 {fmtPct(liveAverages.avgX3)} | n={liveAverages.sampleCount}
              </div>
            </div>
          ) : (
            <div className="text-[10px] font-mono space-y-1">
              <div className="text-gray-300">samples: {snapshotX1Close.sampleCount}</div>
              <div className="text-gray-300">avg X+1: {fmtPct(snapshotX1Close.avgX1)}</div>
              <div className="text-gray-300">avg X+2: {fmtPct(snapshotX1Close.avgX2)}</div>
              <div className="text-gray-300">avg X+3: {fmtPct(snapshotX1Close.avgX3)}</div>
              <div className="text-gray-300">
                X+3 signal at X+1 close: {snapshotX1Close.x3Signal || '—'}
                {snapshotX1Close.x3SignalStrengthCents != null ? ` (strength ${snapshotX1Close.x3SignalStrengthCents.toFixed(1)}¢)` : ''}
              </div>
            </div>
          )}
        </div>

        <div className="rounded border border-gray-800 bg-black/20 p-2">
          <div className="text-[11px] text-amber-400 font-semibold mb-1">Outcome Check</div>
          <div className="text-[10px] font-mono space-y-1">
            <div className="text-gray-300">X outcome: {xOutcome || 'pending'}</div>
            <div className="text-gray-300">X+3 outcome: {x3Outcome || 'pending'}</div>
            {snapshotX1Close?.x3Signal && x3Outcome && (
              <div className={snapshotX1Close.x3Signal === x3Outcome ? 'text-green-400' : 'text-red-400'}>
                prediction vs X+3 result: {snapshotX1Close.x3Signal} vs {x3Outcome} ({snapshotX1Close.x3Signal === x3Outcome ? 'MATCH' : 'MISS'})
              </div>
            )}
          </div>
        </div>
      </div>

      {loading && <div className="text-[10px] text-gray-500">Refreshing…</div>}
    </div>
  );
}
