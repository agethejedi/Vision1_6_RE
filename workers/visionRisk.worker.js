// workers/visionRisk.worker.js
// Vision 1.6 hybrid:
// - Uses Cloudflare risk engine at /score for all scoring
// - Preserves the older, working batch + neighbor logic
// - Feeds age/neighbor feats to the UI for narratives & stats

let CFG = {
  apiBase: "",
  network: "eth",
  concurrency: 8,
  flags: { graphSignals: true, streamBatch: true, neighborStats: true },
};

// simple score cache (10 min) keyed by network:address
const SCORE_CACHE = new Map();
const SCORE_TTL_MS = 10 * 60 * 1000;

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
        const r = await scoreOne(it).catch((err) => {
          console.error("[worker] SCORE_BATCH error", err);
          return null;
        });
        if (r) post({ type: "RESULT_STREAM", data: r });
      }
      post({ id, type: "DONE" });
      return;
    }

    if (type === "NEIGHBORS") {
      const addr = (payload?.id || payload?.address || "").toLowerCase();
      const network = payload?.network || CFG.network || "eth";
      const hop = Number(payload?.hop ?? 1) || 1;
      const limit = Number(payload?.limit ?? 250) || 250;

      const data = await fetchNeighbors(addr, network, { hop, limit }).catch(
        () => stubNeighbors(addr)
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

/* ======================= core scoring ======================= */

function normId(x) {
  return String(x || "").toLowerCase();
}

async function scoreOne(item) {
  const idRaw = item?.id || item?.address || "";
  const id = normId(idRaw);
  const network = item?.network || CFG.network || "eth";
  if (!id) throw new Error("scoreOne: missing id");

  const cacheKey = `${network}:${id}`;
  const cached = SCORE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < SCORE_TTL_MS) {
    return cached.res;
  }

  if (!CFG.apiBase) throw new Error("scoreOne: missing apiBase");

  // call your Cloudflare engine
  const url =
    `${CFG.apiBase}/score?address=${encodeURIComponent(id)}` +
    `&network=${encodeURIComponent(network)}`;

  const t0 = Date.now();
  const r = await fetch(url, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 0 },
  }).catch(() => null);

  if (!r || !r.ok) {
    throw new Error(`scoreOne /score http ${r ? r.status : "no-response"}`);
  }

  const policy = await r.json().catch(() => ({}));
  const ms = Date.now() - t0;

  // baseline score logic driven by engine risk_score
  const localScore = 55;
  const blocked = !!(policy?.block || policy?.risk_score === 100);
  const mergedScore = blocked
    ? 100
    : typeof policy?.risk_score === "number"
    ? policy.risk_score
    : localScore;

  const reasons = policy?.reasons || policy?.risk_factors || [];

  // bring over feats from engine, and ensure ageDays exists
  let feats = { ...(policy?.feats || {}) };
  if (typeof feats.ageDays !== "number") {
    feats.ageDays = await fetchAgeDays(id, network).catch(() => 0);
  }
  if (!feats.local) feats.local = {};
  if (typeof feats.local.riskyNeighborRatio !== "number") {
    feats.local.riskyNeighborRatio = 0;
  }

  const res = {
    type: "address",
    id,
    address: id,
    network,
    label: id.slice(0, 10) + "…",

    block: blocked,
    risk_score: mergedScore,
    score: mergedScore,
    reasons,
    risk_factors: reasons,

    breakdown: makeBreakdown(policy),
    feats,
    explain: {
      ...(policy?.explain || {}),
      reasons,
      blocked,
      ofacHit: coerceOfacFromPolicy(policy, reasons),
      engineVersion: policy?.explain?.version || "RXL-V1.6.0",
      msEngine: ms,
    },
    parity: "SafeSend parity",
  };

  SCORE_CACHE.set(cacheKey, { ts: Date.now(), res });
  return res;
}

/* ======================= neighbors ======================= */

async function fetchNeighbors(address, network, { hop = 1, limit = 250 } = {}) {
  if (!CFG.apiBase) return stubNeighbors(address);
  const addr = normId(address);
  const t0 = Date.now();

  const url =
    `${CFG.apiBase}/neighbors?address=${encodeURIComponent(addr)}` +
    `&network=${encodeURIComponent(network)}` +
    `&hop=${hop}&limit=${limit}`;

  const r = await fetch(url, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 0 },
  }).catch(() => null);

  if (!r || !r.ok) {
    console.warn("[worker] /neighbors http", r && r.status);
    return neighborsFromTxs(addr, network, t0);
  }

  const raw = await r.json().catch(() => ({}));
  const nodes = [];
  const links = [];
  const seen = new Set();

  const pushNode = (n) => {
    const id = normId(n?.id || n?.address || n?.addr);
    if (!id || seen.has(id)) return;
    seen.add(id);
    nodes.push({ id, address: id, network, ...n });
  };
  const pushLink = (L) => {
    const a = normId(L?.a ?? L?.source ?? L?.from ?? L?.idA);
    const b = normId(L?.b ?? L?.target ?? L?.to ?? L?.idB);
    if (!a || !b || a === b) return;
    links.push({ a, b, weight: Number(L?.weight ?? 1) || 1 });
  };

  if (Array.isArray(raw?.nodes)) raw.nodes.forEach(pushNode);
  if (Array.isArray(raw?.links)) raw.links.forEach(pushLink);

  if (!nodes.length && Array.isArray(raw)) {
    const tmp = new Set();
    for (const L of raw) {
      const a = normId(L?.a ?? L?.source ?? L?.from ?? L?.idA);
      const b = normId(L?.b ?? L?.target ?? L?.to ?? L?.idB);
      if (a) tmp.add(a);
      if (b) tmp.add(b);
      pushLink(L);
    }
    tmp.forEach((id) => nodes.push({ id, address: id, network }));
  }

  if (!nodes.length && !links.length) {
    console.warn("[worker] neighbors empty → fallback /txs");
    return neighborsFromTxs(addr, network, t0);
  }

  const msFetch = Date.now() - t0;
  console.debug("[worker] neighbors(final)", {
    addr,
    totalNeighbors: nodes.length - 1,
    shown: nodes.length - 1,
    overflow: 0,
    msFetch,
  });

  return { nodes, links };
}

async function neighborsFromTxs(address, network, t0) {
  if (!CFG.apiBase) return stubNeighbors(address);
  const url =
    `${CFG.apiBase}/txs?address=${encodeURIComponent(address)}` +
    `&network=${encodeURIComponent(network)}&limit=32&direction=any`;

  const r = await fetch(url, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 0 },
  }).catch(() => null);

  if (!r || !r.ok) {
    console.warn("[worker] /txs neighborhood http", r && r.status);
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
    const other = from === center ? to : to === center ? from : null;
    if (!other || seen.has(other)) continue;
    seen.add(other);
    nodes.push({ id: other, address: other, network });
    links.push({ a: center, b: other, weight: 1 });
  }

  const msFetch = Date.now() - t0;
  console.debug("[worker] neighbors(final /txs)", {
    addr: center,
    totalNeighbors: nodes.length - 1,
    shown: nodes.length - 1,
    overflow: 0,
    msFetch,
  });

  return { nodes, links };
}

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

  console.debug("[worker] neighbors(stub)", {
    addr: centerId,
    totalNeighbors: n,
    shown: n,
    overflow: 0,
  });

  return { nodes, links };
}

/* ======================= helpers ======================= */

const WEIGHTS = {
  OFAC: 40,
  "OFAC/sanctions list match": 40,
  "sanctioned Counterparty": 40,
  "fan In High": 9,
  "shortest Path To Sanctioned": 6,
  "burst Anomaly": 0,
  "known Mixer Proximity": 0,
};

function makeBreakdown(policy) {
  const src = policy?.reasons || policy?.risk_factors || [];
  if (!Array.isArray(src) || src.length === 0) return [];
  const list = src.map((r) => ({
    label: String(r),
    delta: WEIGHTS[r] ?? 0,
  }));
  const hasSanctioned = list.some((x) => /sanction|ofac/i.test(x.label));
  if ((policy?.block || policy?.risk_score === 100) && !hasSanctioned) {
    list.unshift({ label: "sanctioned Counterparty", delta: 40 });
  }
  return list.sort((a, b) => (b.delta - a.delta));
}

async function fetchAgeDays(address, network) {
  if (!CFG.apiBase) return 0;
  const url =
    `${CFG.apiBase}/txs?address=${encodeURIComponent(address)}` +
    `&network=${encodeURIComponent(network)}&limit=1&sort=asc`;
  const r = await fetch(url, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 0 },
  }).catch(() => null);
  if (!r || !r.ok) return 0;
  const data = await r.json().catch(() => ({}));
  const arr = Array.isArray(data?.result) ? data.result : [];
  if (arr.length === 0) return 0;

  const t = arr[0];
  const iso = t?.raw?.metadata?.blockTimestamp || t?.metadata?.blockTimestamp;
  const sec = t?.timeStamp || t?.timestamp || t?.blockTime;
  let ms = 0;
  if (iso) {
    const d = new Date(iso);
    if (!isNaN(d)) ms = d.getTime();
  }
  if (!ms && sec) {
    const n = Number(sec);
    if (!isNaN(n) && n > 1_000_000_000)
      ms = n < 2_000_000_000 ? n * 1000 : n;
  }
  if (!ms) return 0;

  const days = (Date.now() - ms) / 86_400_000;
  return days > 0 ? Math.round(days) : 0;
}

function coerceOfacFromPolicy(policy, reasons) {
  const txt = Array.isArray(reasons)
    ? reasons.join(" | ").toLowerCase()
    : String(reasons || "").toLowerCase();
  return !!(
    policy?.block ||
    policy?.risk_score === 100 ||
    /ofac|sanction/.test(txt)
  );
}
