/ workers/visionRisk.worker.js
// Vision v1.6 — front-end worker that calls the Cloudflare risk engine
// and handles neighbor fetching / batching for the graph.

let CFG = {
  apiBase: "",
  network: "eth",
  concurrency: 8,
  flags: {
    graphSignals: true,
    streamBatch: true,
    neighborStats: true,
    cacheNeighborsTTL: 600000 // 10 min
  }
};

const scoreCache = new Map();     // key: `${network}:${address}` → result
const neighborCache = new Map();  // key: `${network}:${address}` → {nodes,links,meta,ts}

/* ============ Wire up messages from main thread ============ */

self.onmessage = async (e) => {
  const { id, type, payload } = e.data || {};

  try {
    if (type === 'INIT') {
      if (payload?.apiBase) CFG.apiBase = String(payload.apiBase).replace(/\/$/, "");
      if (payload?.network) CFG.network = payload.network;
      if (payload?.concurrency) CFG.concurrency = payload.concurrency;
      if (payload?.flags) CFG.flags = { ...CFG.flags, ...payload.flags };

      post({ id, type: 'INIT_OK' });
      return;
    }

    if (type === 'SCORE_ONE') {
      const item = payload?.item;
      const res = await scoreOne(item);
      post({ id, type: 'RESULT', data: res });
      return;
    }

    if (type === 'SCORE_BATCH') {
      const items = Array.isArray(payload?.items) ? payload.items : [];
      for (const it of items) {
        const r = await scoreOne(it);
        post({ type: 'RESULT_STREAM', data: r });
        // gentle spacing to avoid bursts
        await sleep(60);
      }
      post({ id, type: 'DONE' });
      return;
    }

    if (type === 'NEIGHBORS') {
      const addr = (payload?.id || payload?.address || '').toLowerCase();
      const network = payload?.network || CFG.network || 'eth';
      const hop = Number(payload?.hop ?? 1) || 1;
      const limit = Number(payload?.limit ?? 120) || 120;

      const data = await getNeighbors(addr, network, { hop, limit });
      post({ id, type: 'RESULT', data });
      return;
    }

    throw new Error(`unknown type: ${type}`);
  } catch (err) {
    console.error('[worker] error', type, err);
    post({ id, type: 'ERROR', error: String(err?.message || err) });
  }
};

function post(msg) {
  self.postMessage(msg);
}

/* ================== SCORE CORE ================== */

async function scoreOne(item) {
  if (!item) throw new Error('scoreOne: missing item');

  // IMPORTANT: use the REAL id from the UI
  const idRaw = item.id || item.address || '';
  const id = String(idRaw).toLowerCase();
  if (!id) throw new Error('scoreOne: empty id');

  const network = item.network || CFG.network || 'eth';
  const cacheKey = `${network}:${id}`;

  // cache hit
  const cached = scoreCache.get(cacheKey);
  if (cached) return cached;

  if (!CFG.apiBase) throw new Error('scoreOne: apiBase not configured');

  const url = `${CFG.apiBase}/score?address=${encodeURIComponent(id)}&network=${encodeURIComponent(network)}`;
  // Debug: you can watch these in DevTools → Console
  console.debug('[worker] SCORE_ONE →', url);

  const r = await fetch(url, {
    headers: { 'accept': 'application/json' }
  });

  if (!r.ok) {
    throw new Error(`scoreOne: backend ${r.status}`);
  }

  const json = await r.json();
  // make sure id/network are present and normalized
  const result = {
    ...json,
    id,
    address: id,
    network
  };

  scoreCache.set(cacheKey, result);
  return result;
}

/* ================== NEIGHBORS ================== */

async function getNeighbors(address, network, { hop = 1, limit = 120 } = {}) {
  const addr = String(address || '').toLowerCase();
  if (!addr) throw new Error('neighbors: empty address');
  const key = `${network}:${addr}`;
  const now = Date.now();
  const ttl = CFG.flags.cacheNeighborsTTL || 600000;

  const cached = neighborCache.get(key);
  if (cached && (now - cached.ts) < ttl) {
    return cached.data;
  }

  if (!CFG.apiBase) {
    // no backend route yet → stub
    const stub = stubNeighbors(addr, network);
    neighborCache.set(key, { ts: now, data: stub });
    return stub;
  }

  const url = `${CFG.apiBase}/neighbors?address=${encodeURIComponent(addr)}&network=${encodeURIComponent(network)}&hop=${hop}&limit=${limit}`;
  console.debug('[worker] NEIGHBORS →', url);

  let data;
  try {
    const resp = await fetch(url, { headers: { 'accept': 'application/json' } });
    if (!resp.ok) {
      console.warn('[worker] neighbors backend error', resp.status);
      data = stubNeighbors(addr, network);
    } else {
      const raw = await resp.json().catch(() => ({}));
      data = normalizeNeighbors(raw, addr, network, limit);
    }
  } catch (e) {
    console.warn('[worker] neighbors fetch failed, using stub', e);
    data = stubNeighbors(addr, network);
  }

  neighborCache.set(key, { ts: now, data });
  console.debug('[worker] neighbors(final)', {
    addr,
    totalNeighbors: (data.nodes?.length || 1) - 1,
    shown: (data.nodes?.length || 1) - 1,
    overflow: 0
  });

  return data;
}

function normalizeNeighbors(raw, centerId, network, limit) {
  const center = centerId.toLowerCase();
  const nodes = [];
  const links = [];

  const pushNode = (n) => {
    const id = String(n?.id || n?.address || n?.addr || '').toLowerCase();
    if (!id) return;
    nodes.push({ id, address: id, network, ...n });
  };
  const pushLink = (L) => {
    const a = String(L?.a ?? L?.source ?? L?.from ?? L?.idA ?? '').toLowerCase();
    const b = String(L?.b ?? L?.target ?? L?.to   ?? L?.idB ?? '').toLowerCase();
    if (!a || !b || a === b) return;
    links.push({ a, b, weight: Number(L?.weight ?? 1) || 1 });
  };

  if (Array.isArray(raw?.nodes)) raw.nodes.forEach(pushNode);
  if (Array.isArray(raw?.links)) raw.links.forEach(pushLink);

  // If backend returns a flat edge list
  if (!nodes.length && Array.isArray(raw)) {
    const set = new Set();
    for (const L of raw) {
      const a = String(L?.a ?? L?.source ?? L?.from ?? L?.idA ?? '').toLowerCase();
      const b = String(L?.b ?? L?.target ?? L?.to   ?? L?.idB ?? '').toLowerCase();
      if (a) set.add(a);
      if (b) set.add(b);
      pushLink(L);
    }
    set.forEach(id => nodes.push({ id, address: id, network }));
  }

  if (!nodes.length && !links.length) {
    return stubNeighbors(center, network);
  }

  // ensure center present
  const centerNode = { id: center, address: center, network };
  let haveCenter = nodes.some(n => n.id === center);
  const finalNodes = haveCenter ? nodes : [centerNode, ...nodes];

  // ensure center is connected
  const existing = new Set();
  for (const L of links) {
    if (L.a === center) existing.add(L.b);
    if (L.b === center) existing.add(L.a);
  }
  for (const n of finalNodes) {
    if (n.id !== center && !existing.has(n.id)) {
      links.push({ a: center, b: n.id, weight: 1 });
    }
  }

  // cap visible neighbors
  const max = Math.max(1, limit | 0);
  const keptNeighbors = finalNodes.slice(1, max + 1);
  const keptIds = new Set(keptNeighbors.map(n => n.id));
  const prunedLinks = links.filter(L => keptIds.has(L.a) || keptIds.has(L.b));

  return {
    nodes: [centerNode, ...keptNeighbors],
    links: prunedLinks
  };
}

function stubNeighbors(center, network) {
  const centerId = center.toLowerCase() || '0xseed';
  const n = 10;
  const nodes = [{ id: centerId, address: centerId, network }];
  const links = [];
  for (let i = 0; i < n; i++) {
    const id = `0x${Math.random().toString(16).slice(2).padStart(40, '0').slice(0, 40)}`;
    nodes.push({ id, address: id, network });
    links.push({ a: centerId, b: id, weight: 1 });
  }
  return { nodes, links };
}

/* ================== helpers ================== */

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}
