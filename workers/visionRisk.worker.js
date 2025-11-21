// workers/visionRisk.worker.js
// Vision 1.6 — Frontend worker that talks to the Cloudflare risk engine.
// - All scoring comes from /score on your API worker
// - Neighbors come from /neighbors (with fallback + logging)
// - Still streams RESULT_STREAM for batches so the UI can update halos progressively.

let CFG = {
  apiBase: "",
  network: "eth",
  concurrency: 6,
  flags: { graphSignals: true, streamBatch: true, neighborStats: true },
};

// Simple in-memory score cache (10 min TTL)
const SCORE_CACHE = new Map(); // key => { ts, res }
const SCORE_TTL_MS = 10 * 60 * 1000;

/* ============================ message loop ============================ */

self.onmessage = async (e) => {
  const { id, type, payload } = e.data || {};
  try {
    if (type === "INIT") {
      if (payload?.apiBase) {
        CFG.apiBase = String(payload.apiBase).replace(/\/$/, "");
      }
      if (payload?.network) CFG.network = payload.network;
      if (payload?.concurrency) CFG.concurrency = payload.concurrency;
      if (payload?.flags) CFG.flags = { ...CFG.flags, ...payload.flags };
      post({ id, type: "INIT_OK" });
      return;
    }

    if (type === "SCORE_ONE") {
      const item = payload?.item;
      const res = await scoreOne(item);
      post({ id, type: "RESULT", data: res });
      return;
    }

    if (type === "SCORE_BATCH") {
      const items = Array.isArray(payload?.items) ? payload.items : [];
      await scoreBatch(id, items);
      return;
    }

    if (type === "NEIGHBORS") {
      const addr = (payload?.id || payload?.address || "").toLowerCase();
      const network = payload?.network || CFG.network || "eth";
      const hop = Number(payload?.hop ?? 1) || 1;
      const limit = Number(payload?.limit ?? 250) || 250;

      const data = await fetchNeighbors(addr, network, { hop, limit });
      post({ id, type: "RESULT", data });
      return;
    }

    throw new Error(`unknown type: ${type}`);
  } catch (err) {
    post({
      id,
      type: "ERROR",
      error: String(err?.message || err),
    });
  }
};

function post(msg) {
  self.postMessage(msg);
}

function normId(x) {
  return String(x || "").toLowerCase();
}

/* ============================ scoring ============================ */

async function scoreOne(item) {
  const idRaw = item?.id || item?.address || "";
  const address = normId(idRaw);
  const network = item?.network || CFG.network || "eth";
  if (!address) throw new Error("scoreOne: missing id");

  const cacheKey = `${network}:${address}`;
  const cached = SCORE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < SCORE_TTL_MS) {
    return cached.res;
  }

  if (!CFG.apiBase) throw new Error("scoreOne: missing apiBase");

  const url =
    `${CFG.apiBase}/score` +
    `?address=${encodeURIComponent(address)}` +
    `&network=${encodeURIComponent(network)}`;

  const t0 = Date.now();
  const r = await fetch(url, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 0 },
  });
  if (!r.ok) {
    throw new Error(`score http ${r.status}`);
  }
  const body = await r.json().catch(() => ({}));
  const ms = Date.now() - t0;

  const res = normalizeEngineResponse(body, { address, network, ms });

  SCORE_CACHE.set(cacheKey, { ts: Date.now(), res });

  return res;
}

// Batch with basic concurrency + streaming
async function scoreBatch(batchId, items) {
  if (!items.length) {
    post({ id: batchId, type: "DONE" });
    return;
  }

  const concurrency = CFG.concurrency || 4;
  let index = 0;

  const next = async () => {
    const myIndex = index++;
    if (myIndex >= items.length) return;

    const it = items[myIndex];
    try {
      const r = await scoreOne(it);
      post({ type: "RESULT_STREAM", data: r });
    } catch (err) {
      console.error("[worker] SCORE_BATCH error", err);
    }
    await next();
  };

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(next());
  }
  await Promise.all(workers);
  post({ id: batchId, type: "DONE" });
}

// Take the Cloudflare /score payload and adapt it to what the UI expects.
// app.js still runs its own normalizeResult, so we mainly:
//
// - guarantee id/address/network
// - add type + label
// - copy risk_score → score (legacy)
//
function normalizeEngineResponse(body = {}, { address, network, ms }) {
  const addr = normId(body.address || address);
  const net = body.network || network || CFG.network || "eth";

  const riskScore =
    typeof body.risk_score === "number"
      ? body.risk_score
      : typeof body.score === "number"
      ? body.score
      : 0;

  const reasons = Array.isArray(body.reasons)
    ? body.reasons
    : Array.isArray(body.risk_factors)
    ? body.risk_factors
    : [];

  const res = {
    type: "address",
    id: addr,
    address: addr,
    network: net,
    label: addr.slice(0, 6) + "…" + addr.slice(-4),

    risk_score: riskScore,
    score: riskScore,
    block: !!body.block,
    sanctionHits: body.sanctionHits || null,

    reasons,
    risk_factors: reasons,

    feats: body.feats || {},
    explain: body.explain || {},

    // Keep original payload around for debugging if needed
    _raw: {
      ms,
      fromEngine: true,
    },
  };

  return res;
}

/* ============================ neighbors ============================ */

// Fetch neighbors from your Cloudflare worker, with some guard rails.
// Uses /neighbors primarily; falls back to a simple /txs-derived spoke graph
// if needed so the UI always has *something* to draw.
async function fetchNeighbors(address, network, { hop = 1, limit = 250 } = {}) {
  const addr = normId(address);
  if (!addr) return stubNeighbors("0xseed");

  if (!CFG.apiBase) return stubNeighbors(addr);

  const t0 = Date.now();
  const url =
    `${CFG.apiBase}/neighbors` +
    `?address=${encodeURIComponent(addr)}` +
    `&network=${encodeURIComponent(network)}` +
    `&hop=${hop}` +
    `&limit=${limit}`;

  try {
    const r = await fetch(url, {
      headers: { accept: "application/json" },
      cf: { cacheTtl: 0 },
    });

    if (!r.ok) {
      console.warn("[worker] /neighbors http", r.status);
      return await neighborsFromTxs(addr, network, { t0 });
    }

    const raw = await r.json().catch(() => ({}));

    const nodes = [];
    const links = [];

    const seen = new Set();

    const pushNode = (n) => {
      const id = normId(n?.id || n?.address || n?.addr);
      if (!id || seen.has(id)) return;
      seen.add(id);
      nodes.push({
        id,
        address: id,
        network,
        ...n,
      });
    };

    const pushLink = (L) => {
      const a = normId(L?.a ?? L?.source ?? L?.from ?? L?.idA);
      const b = normId(L?.b ?? L?.target ?? L?.to ?? L?.idB);
      if (!a || !b || a === b) return;
      links.push({ a, b, weight: Number(L?.weight ?? 1) || 1 });
    };

    if (Array.isArray(raw?.nodes)) raw.nodes.forEach(pushNode);
    if (Array.isArray(raw?.links)) raw.links.forEach(pushLink);

    // Some implementations just return an edge list
    if (!nodes.length && Array.isArray(raw)) {
      const tmpNodes = new Set();
      for (const L of raw) {
        const a = normId(L?.a ?? L?.source ?? L?.from ?? L?.idA);
        const b = normId(L?.b ?? L?.target ?? L?.to ?? L?.idB);
        if (a) tmpNodes.add(a);
        if (b) tmpNodes.add(b);
        pushLink(L);
      }
      tmpNodes.forEach((id) =>
        nodes.push({ id, address: id, network })
      );
    }

    if (!nodes.length && !links.length) {
      console.warn(
        "[worker] neighbors empty → falling back to /txs neighborhood"
      );
      return await neighborsFromTxs(addr, network, { t0 });
    }

    const msFetch = Date.now() - t0;

    const meta = {
      addr,
      totalNeighbors: nodes.length - 1, // excluding center
      shown: nodes.length - 1,
      overflow: 0,
      msFetch,
      source: "neighbors",
    };

    console.debug("[worker] neighbors(final)", meta);

    return { nodes, links, meta };
  } catch (err) {
    console.error("[worker] neighbors error", err);
    return await neighborsFromTxs(addr, network, { t0 });
  }
}

// Fallback: build a simple spoke graph from /txs
async function neighborsFromTxs(address, network, { t0 }) {
  if (!CFG.apiBase) return stubNeighbors(address);

  const url =
    `${CFG.apiBase}/txs` +
    `?address=${encodeURIComponent(address)}` +
    `&network=${encodeURIComponent(network)}` +
    `&limit=32` +
    `&direction=any`;

  try {
    const r = await fetch(url, {
      headers: { accept: "application/json" },
      cf: { cacheTtl: 0 },
    });
    if (!r.ok) {
      console.warn("[worker] /txs neighborhood http", r.status);
      return stubNeighbors(address);
    }

    const data = await r.json().catch(() => ({}));
    const arr = Array.isArray(data?.result) ? data.result : [];

    const center = normId(address);
    const nodes = [{ id: center, address: center, network }];
    const links = [];

    const seen = new Set([center]);

    for (const tx of arr) {
      const from = normId(tx.from || tx.from_address);
      const to = normId(tx.to || tx.to_address);
      const other =
        from === center ? to : to === center ? from : null;
      if (!other || seen.has(other)) continue;
      seen.add(other);
      nodes.push({ id: other, address: other, network });
      links.push({ a: center, b: other, weight: 1 });
    }

    const msFetch = Date.now() - t0;

    const meta = {
      addr: center,
      totalNeighbors: nodes.length - 1,
      shown: nodes.length - 1,
      overflow: 0,
      msFetch,
      source: "txs-fallback",
    };

    console.debug("[worker] neighbors(final /txs)", meta);

    return { nodes, links, meta };
  } catch (err) {
    console.error("[worker] neighborsFromTxs error", err);
    return stubNeighbors(address);
  }
}

// Safe stub used when backend is unavailable
function stubNeighbors(center) {
  const centerId = normId(center || "0xseed");
  const n = 10;
  const nodes = [{ id: centerId, address: centerId, network: CFG.network }];
  const links = [];

  for (let i = 0; i < n; i++) {
    const id =
      "0x" +
      Math.random().toString(16).slice(2).padStart(40, "0").slice(0, 40);
    nodes.push({ id, address: id, network: CFG.network });
    links.push({ a: centerId, b: id, weight: 1 });
  }

  const meta = {
    addr: centerId,
    totalNeighbors: n,
    shown: n,
    overflow: 0,
    msFetch: 0,
    source: "stub",
  };

  console.debug("[worker] neighbors(stub)", meta);

  return { nodes, links, meta };
}
