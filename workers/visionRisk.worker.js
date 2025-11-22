// workers/visionRisk.worker.js
// Vision 1.6 — front-end worker
// Proxies scoring & neighbors to the Cloudflare risk engine.

let CFG = {
  apiBase: "",
  network: "eth",
  concurrency: 8,
  flags: {
    graphSignals: true,
    streamBatch: true,
    neighborStats: true,
    cacheNeighborsTTL: 600000 // 10 min
  },
};

self.onmessage = async (e) => {
  const { id, type, payload } = e.data || {};
  try {
    if (type === "INIT") {
      if (payload?.apiBase) CFG.apiBase = String(payload.apiBase).replace(/\/$/, "");
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
      for (const it of items) {
        const r = await scoreOne(it);
        post({ type: "RESULT_STREAM", data: r });
      }
      post({ id, type: "DONE" });
      return;
    }

    if (type === "NEIGHBORS") {
      const addr = (payload?.id || payload?.address || "").toLowerCase();
      const network = payload?.network || CFG.network || "eth";
      const hop = Number(payload?.hop ?? 1) || 1;
      const limit = Number(payload?.limit ?? 250) || 250;

      const data = await fetchNeighbors(addr, network, { hop, limit }).catch(() =>
        stubNeighbors(addr)
      );
      post({ id, type: "RESULT", data });
      return;
    }

    throw new Error(`unknown type: ${type}`);
  } catch (err) {
    post({ id, type: "ERROR", error: String(err?.message || err) });
  }
};

function post(msg) {
  self.postMessage(msg);
}

/* ====================== SCORE CORE ======================= */

async function scoreOne(item) {
  const idRaw = item?.id || item?.address || "";
  const id = String(idRaw).toLowerCase();
  const network = item?.network || CFG.network || "eth";
  if (!id) throw new Error("scoreOne: missing id");
  if (!CFG.apiBase) throw new Error("scoreOne: apiBase not configured");

  const url = `${CFG.apiBase}/score?address=${encodeURIComponent(
    id
  )}&network=${encodeURIComponent(network)}`;

  const r = await fetch(url, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 0 },
  });

  if (!r.ok) {
    throw new Error(`score fetch failed: ${r.status}`);
  }

  const body = await r.json().catch(() => ({}));

  // body is already the risk-engine response (risk_score, reasons, feats, explain, etc.)
  const merged = normalizeFromEngine(body, id, network);

  return merged;
}

function normalizeFromEngine(engineRes, id, network) {
  const base = engineRes || {};

  // Ensure id / address / network are present and normalized
  const addr = (base.address || id || "").toLowerCase();
  const net = base.network || network || "eth";

  const risk_score =
    typeof base.risk_score === "number" ? base.risk_score : base.score || 0;

  // Feats: add local neighbor stats if the engine exposes them flat
  const feats = { ...(base.feats || {}) };

  if (!feats.local) {
    feats.local = {};
  }

  // Map high-level neighbor features into feats.local.* expected by app.js
  if (typeof feats.highRiskNeighborRatio === "number") {
    feats.local.riskyNeighborRatio = feats.highRiskNeighborRatio;
  } else if (typeof feats.sanctionedNeighborRatio === "number") {
    feats.local.riskyNeighborRatio = feats.sanctionedNeighborRatio;
  }

  if (typeof feats.neighborAvgAgeDays === "number") {
    feats.local.neighborAvgAgeDays = feats.neighborAvgAgeDays;
  }
  if (typeof feats.neighborAvgTx === "number") {
    feats.local.neighborAvgTx = feats.neighborAvgTx;
  }
  if (typeof feats.neighborCount === "number") {
    feats.local.neighborCount = feats.neighborCount;
  }

  const explain = base.explain && typeof base.explain === "object"
    ? { ...base.explain }
    : { reasons: base.reasons || base.risk_factors || [] };

  const blocked = !!(
    base.block ||
    risk_score === 100 ||
    base.sanctionHits ||
    explain?.signals?.ofacHit
  );

  return {
    type: "address",
    id: addr,
    address: addr,
    network: net,
    risk_score,
    score: risk_score,
    reasons: base.reasons || base.risk_factors || [],
    risk_factors: base.risk_factors || base.reasons || [],
    block: blocked,
    sanctionHits: base.sanctionHits || null,
    feats,
    explain,
    parity: base.parity || "SafeSend parity",
  };
}

/* ====================== NEIGHBORS ======================== */

async function fetchNeighbors(address, network, { hop = 1, limit = 250 } = {}) {
  if (!CFG.apiBase) return stubNeighbors(address);

  const url = `${CFG.apiBase}/neighbors?address=${encodeURIComponent(
    address
  )}&network=${encodeURIComponent(network)}&hop=${hop}&limit=${limit}`;

  const r = await fetch(url, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 0 },
  });

  if (!r.ok) return stubNeighbors(address);
  const raw = await r.json().catch(() => ({}));

  const nodes = [];
  const links = [];

  const pushNode = (n) => {
    const id = String(n?.id || n?.address || n?.addr || "").toLowerCase();
    if (!id) return;
    nodes.push({ id, address: id, network, ...n });
  };
  const pushLink = (L) => {
    const a = String(
      L?.a ?? L?.source ?? L?.idA ?? L?.from ?? ""
    ).toLowerCase();
    const b = String(
      L?.b ?? L?.target ?? L?.idB ?? L?.to ?? ""
    ).toLowerCase();
    if (!a || !b || a === b) return;
    links.push({ a, b, weight: Number(L?.weight ?? 1) || 1 });
  };

  if (Array.isArray(raw?.nodes)) raw.nodes.forEach(pushNode);
  if (Array.isArray(raw?.links)) raw.links.forEach(pushLink);

  // Fallback if the API returns only edges
  if (!nodes.length && Array.isArray(raw)) {
    const set = new Set();
    for (const L of raw) {
      const a = String(
        L?.a ?? L?.source ?? L?.from ?? L?.idA ?? ""
      ).toLowerCase();
      const b = String(
        L?.b ?? L?.target ?? L?.to ?? L?.idB ?? ""
      ).toLowerCase();
      if (a) set.add(a);
      if (b) set.add(b);
      pushLink(L);
    }
    set.forEach((id) => nodes.push({ id, address: id, network }));
  }

  if (!nodes.length && !links.length) return stubNeighbors(address);

  return { nodes, links };
}

function stubNeighbors(center) {
  const centerId = String(center || "").toLowerCase() || "0xseed";
  const n = 10;
  const nodes = [{ id: centerId, address: centerId, network: CFG.network }];
  const links = [];
  for (let i = 0; i < n; i++) {
    const id = `0x${Math.random()
      .toString(16)
      .slice(2)
      .padStart(40, "0")
      .slice(0, 40)}`;
    nodes.push({ id, address: id, network: CFG.network });
    links.push({ a: centerId, b: id, weight: 1 });
  }
  return { nodes, links };
}