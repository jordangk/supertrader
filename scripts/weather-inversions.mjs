/**
 * Weather Inversion Scanner — runs hourly, finds true inversions, places 10sh limit orders.
 * Imported by server.js, not standalone.
 */

const CITIES = [
  'nyc','denver','chicago','miami','los-angeles','houston','london','paris','tokyo','seoul',
  'san-francisco','toronto','munich','madrid','hong-kong','singapore','warsaw','shanghai',
  'beijing','taipei','wellington','kuala-lumpur','jakarta',
  'istanbul','moscow','amsterdam','helsinki','lagos','sao-paulo','buenos-aires','mexico-city',
  'seattle','dallas','atlanta','austin',
];

const firedInversions = new Set(); // "city-dateStr-temp-side" — never buy same twice

export function getInversionsFired() { return firedInversions; }

export async function scanWeatherInversions(placeLive99Order, clobClient) {
  if (!clobClient) return [];

  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const now = new Date();
  const results = [];

  for (let d = 0; d <= 2; d++) {
    const dt = new Date(now.getTime() + d * 86400000);
    const dateStr = `${months[dt.getUTCMonth()]}-${dt.getUTCDate()}-${dt.getUTCFullYear()}`;
    const label = d === 0 ? 'TODAY' : d === 1 ? 'TOMORROW' : 'DAY+2';
    const maxNoPrice = d === 0 ? 0.999 : d === 1 ? 0.998 : 0.997; // today max 99.9¢, tomorrow max 99.8¢, day+2 max 99.7¢

    for (const city of CITIES) {
      const slug = `highest-temperature-in-${city}-on-${dateStr}`;
      try {
        const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(5000) });
        const data = await r.json();
        const ev = Array.isArray(data) ? data[0] : data;
        if (!ev?.markets?.length) continue;

        const mkts = [];
        for (const m of ev.markets) {
          const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          const tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
          if (!prices || !tokens || tokens.length < 2) continue;
          const temp = parseInt((m.question || '').match(/(\d+)°/)?.[1] || 0);
          if (!temp) continue;
          const noPrice = parseFloat(prices[1] || 0);
          const yesPrice = parseFloat(prices[0] || 0);
          const effNo = noPrice < 0.01 ? 1.0 : noPrice;
          mkts.push({ temp, noPrice, effNo, yesPrice, noToken: tokens[1], negRisk: m.negRisk || false });
        }
        mkts.sort((a, b) => a.temp - b.temp);
        const peakIdx = mkts.reduce((best, m, i) => m.yesPrice > mkts[best].yesPrice ? i : best, 0);

        // HIGH side
        let maxSoFar = 0;
        for (let i = peakIdx + 1; i < mkts.length; i++) {
          const dist = i - peakIdx;
          if (dist < 3 || mkts[i].effNo < 0.95) { maxSoFar = Math.max(maxSoFar, mkts[i].effNo); continue; }
          if (mkts[i].noPrice < 0.01) { maxSoFar = Math.max(maxSoFar, mkts[i].effNo); continue; }
          if (maxSoFar > 0 && (mkts[i].effNo < maxSoFar - 0.001) && mkts[i].noPrice <= maxNoPrice) {
            const key = `${city}-${dateStr}-${mkts[i].temp}-HIGH`;
            if (!firedInversions.has(key)) {
              results.push({ label, city, side: 'HIGH', temp: mkts[i].temp, noPrice: mkts[i].noPrice, noToken: mkts[i].noToken, negRisk: mkts[i].negRisk, gap: maxSoFar - mkts[i].effNo, key });
            }
          }
          maxSoFar = Math.max(maxSoFar, mkts[i].effNo);
        }

        // LOW side
        maxSoFar = 0;
        for (let i = peakIdx - 1; i >= 0; i--) {
          const dist = peakIdx - i;
          if (dist < 3 || mkts[i].effNo < 0.95) { maxSoFar = Math.max(maxSoFar, mkts[i].effNo); continue; }
          if (mkts[i].noPrice < 0.01) { maxSoFar = Math.max(maxSoFar, mkts[i].effNo); continue; }
          if (maxSoFar > 0 && (mkts[i].effNo < maxSoFar - 0.001) && mkts[i].noPrice <= maxNoPrice) {
            const key = `${city}-${dateStr}-${mkts[i].temp}-LOW`;
            if (!firedInversions.has(key)) {
              results.push({ label, city, side: 'LOW', temp: mkts[i].temp, noPrice: mkts[i].noPrice, noToken: mkts[i].noToken, negRisk: mkts[i].negRisk, gap: maxSoFar - mkts[i].effNo, key });
            }
          }
          maxSoFar = Math.max(maxSoFar, mkts[i].effNo);
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Place orders
  let placed = 0;
  for (const r of results) {
    if (firedInversions.has(r.key)) continue;
    firedInversions.add(r.key);
    const limitPrice = r.noPrice >= 0.99 ? 0.999 : r.noPrice;
    try {
      await placeLive99Order(r.noToken, 10, r.negRisk, `[weather-inv] ${r.city} ${r.temp}° NO 10sh`);
      placed++;
      console.log(`[weather-inv] ✓ ${r.label} ${r.city} ${r.side} ${r.temp}° NO 10sh @ ${(r.noPrice*100).toFixed(1)}¢ (gap ${(r.gap*100).toFixed(1)}¢)`);
    } catch (e) {
      console.error(`[weather-inv] err: ${e.message?.slice(0, 60)}`);
    }
  }

  return { found: results.length, placed };
}
