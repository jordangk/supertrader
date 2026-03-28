/**
 * HTTP API base for `fetch()`. Empty string = same-origin `/api` (Vite proxies to the server).
 * In dev, `VITE_API_URL=http://localhost:3001` is treated as empty — that URL skips the proxy
 * and calls :3001 directly, which often fails or confuses setup.
 */
export function getApiBase() {
  const raw = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
  if (
    import.meta.env.DEV &&
    raw &&
    /^https?:\/\/(localhost|127\.0\.0\.1):3001$/i.test(raw)
  ) {
    return '';
  }
  return raw;
}
