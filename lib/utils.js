// lib/utils.js

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export function parseQuery(searchParams) {
  const out = {};
  for (const [k, v] of searchParams.entries()) out[k] = v;
  return out;
}

export function normalizeAddress(addr) {
  if (!addr) return '';
  const s = String(addr).trim();
  if (!s) return '';
  return s.toLowerCase();
}

export function computeAgeDays(txs) {
  if (!Array.isArray(txs) || !txs.length) return null;
  let earliest = Infinity;
  for (const t of txs) {
    const iso = t?.metadata?.blockTimestamp || t?.raw?.metadata?.blockTimestamp;
    const sec = t?.timestamp || t?.timeStamp || t?.blockTime;
    let ms = 0;
    if (iso) {
      const d = new Date(iso);
      if (!isNaN(d)) ms = d.getTime();
    }
    if (!ms && sec) {
      const n = Number(sec);
      if (!isNaN(n) && n > 1000000000) ms = (n < 2000000000 ? n*1000 : n);
    }
    if (!ms) continue;
    if (ms < earliest) earliest = ms;
  }
  if (!isFinite(earliest)) return null;
  const days = (Date.now() - earliest) / 86400000;
  return days > 0 ? Math.round(days) : 0;
}

export function bandForScore(score, bands) {
  if (!bands || typeof bands !== 'object') return 'unknown';
  for (const [name, range] of Object.entries(bands)) {
    const [lo, hi] = range;
    if (score >= lo && score <= hi) return name;
  }
  return 'unknown';
}

export function toUnixSeconds(ms) {
  if (typeof ms !== 'number') ms = Date.now();
  return Math.floor(ms / 1000);
}

export function randomHex(n) {
  const alphabet = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < n; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
