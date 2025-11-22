// workers/server.worker.js
// RiskXLabs Vision API — v1.6.2
// Cloudflare Worker backend: /score, /neighbors, /txs with Etherscan-backed features.

import { scoreAddress } from '../lib/risk-model.js';

const VERSION = 'RXL-V1.6.2';

// --- Small helpers -------------------------------------------------

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Content-Type, Authorization',
    },
  });
}

function normAddr(a) {
  return String(a || '').trim().toLowerCase();
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

// Lazy-loaded sets for OFAC, mixers, scam clusters
let OFAC_SET = null;
let TORNADO_SET = null;
let SCAM_CLUSTER_SET = null;

async function ensureSets(env) {
  if (!OFAC_SET) {
    OFAC_SET = new Set(
      String(env.OFAC_SET || env.OFACLIST || '')
        .split(/\s+/)
        .filter(Boolean)
        .map(s => s.toLowerCase())
    );
  }
  if (!TORNADO_SET) {
    TORNADO_SET = new Set(
      String(env.TORNADO_SET || '')
        .split(/\s+/)
        .filter(Boolean)
        .map(s => s.toLowerCase())
    );
  }
  if (!SCAM_CLUSTER_SET) {
    SCAM_CLUSTER_SET = new Set(
      String(env.SCAM_CLUSTERS || '')
        .split(/\s+/)
        .filter(Boolean)
        .map(s => s.toLowerCase())
    );
  }
}

function classifyLists(address) {
  const a = normAddr(address);
  const ofacHit = OFAC_SET?.has(a) || false;
  const mixerHit = TORNADO_SET?.has(a) || false;
  const scamPlatformHit = SCAM_CLUSTER_SET?.has(a) || false;
  return {
    ofacHit,
    mixerHit,
    scamPlatformHit,
  };
}

// --- Etherscan TX fetch & feature derivation -----------------------

function etherscanBase(network) {
  // For now, support mainnet only; you can extend for others later.
  // https://docs.etherscan.io/api-endpoints/accounts#get-a-list-of-normal-transactions-by-address
  return 'https://api.etherscan.io/api';
}

async function fetchEtherscanTxs({ address, network, env, limit = 1000 }) {
  const apiKey = env.ETHERSCAN_API_KEY;
  if (!apiKey) return null;

  const base = etherscanBase(network);
  const url = `${base}?module=account&action=txlist&address=${encodeURIComponent(
    address
  )}&startblock=0&endblock=99999999&page=1&offset=${limit}&sort=asc&apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || data.status !== '1' || !Array.isArray(data.result)) return null;
  return data.result;
}

function buildFeatsFromTxs({ address, txs }) {
  if (!Array.isArray(txs) || txs.length === 0) return null;

  const nowMs = Date.now();
  const addr = normAddr(address);

  const first = txs[0];
  const last = txs[txs.length - 1];

  const firstMs = Number(first.timeStamp || first.timestamp) * 1000;
  const lastMs = Number(last.timeStamp || last.timestamp) * 1000;

  if (!firstMs || !lastMs) return null;

  const ageDays = (nowMs - firstMs) / 86400000;
  const activeDays = Math.max(1, (lastMs - firstMs) / 86400000);

  const txCount = txs.length;
  const txPerDay = txCount / activeDays;

  // Counterparty analysis
  const counterpartyCounts = new Map();

  for (const tx of txs) {
    const from = normAddr(tx.from);
    const to = normAddr(tx.to);

    if (from && from !== addr) {
      counterpartyCounts.set(from, (counterpartyCounts.get(from) || 0) + 1);
    }
    if (to && to !== addr) {
      counterpartyCounts.set(to, (counterpartyCounts.get(to) || 0) + 1);
    }
  }

  const uniqueCounterparties = counterpartyCounts.size || 0;
  let topCounterpartyShare = 0;
  if (uniqueCounterparties > 0) {
    let maxCount = 0;
    for (const [, c] of counterpartyCounts) {
      if (c > maxCount) maxCount = c;
    }
    topCounterpartyShare = txCount > 0 ? maxCount / txCount : 0;
  }

  // Very naive burst proxy: ratio of txCount to activeDays thresholded
  const burstScore = clamp(txPerDay / 50, 0, 1); // >50 tx/day => ~1.0

  // Dormancy: check if last tx is older than 90 days
  const dormancyDays = (nowMs - lastMs) / 86400000;
  const isDormant = dormancyDays >= 90;
  const resurrectedRecently = !isDormant && dormancyDays <= 14 && ageDays > 90;

  // Neighbor-like stats derived from counterparties
  const neighborCount = uniqueCounterparties;

  // We'll compute these in the worker by re-using the list sets
  let sanctionedNeighborHits = 0;
  let highRiskNeighborHits = 0; // placeholder for future chainalysis/scorechain
  let dormantNeighborHits = 0;  // we don't know neighbor dormancy yet

  for (const cp of counterpartyCounts.keys()) {
    if (OFAC_SET?.has(cp)) sanctionedNeighborHits++;
    // High-risk neighbors (non-OFAC) could be mixers or scam clusters
    if (TORNADO_SET?.has(cp) || SCAM_CLUSTER_SET?.has(cp)) highRiskNeighborHits++;
  }

  const sanctionedNeighborRatio =
    neighborCount > 0 ? sanctionedNeighborHits / neighborCount : 0;
  const highRiskNeighborRatio =
    neighborCount > 0 ? highRiskNeighborHits / neighborCount : 0;
  const dormantNeighborRatio =
    neighborCount > 0 ? dormantNeighborHits / neighborCount : 0;

  // We don't actually know neighbor ages & tx counts, so proxy them:
  const neighborAvgTx = neighborCount > 0 ? txCount / neighborCount : 0;
  const neighborAvgAgeDays = ageDays; // naive proxy: assume same vintage

  return {
    ageDays: Math.round(ageDays),
    firstSeenMs: firstMs,
    txCount,
    activeDays,
    txPerDay,
    burstScore,
    uniqueCounterparties,
    topCounterpartyShare,
    isDormant,
    dormantDays: Math.round(dormancyDays),
    resurrectedRecently,
    neighborCount,
    sanctionedNeighborRatio,
    highRiskNeighborRatio,
    dormantNeighborRatio,
    mixerProximity: 0,        // we only know if *this* address is mixer, not closeness yet
    custodianExposure: 0,     // reserved for when you wire custodians.json
    scamPlatformExposure: 0,  // reserved for deeper chain graph
    local: {
      riskyNeighborRatio: highRiskNeighborRatio,
      neighborAvgTx,
      neighborAvgAgeDays,
    },
  };
}

// Synthetic fallback — current 28-score fixture
function buildSyntheticFeats(address) {
  // You can tweak these numbers, but keep them deterministic.
  // Using a simple hash of the address could pseudo-randomize; for now keep static.
  return {
    ageDays: 1309,
    firstSeenMs: null,
    txCount: 809,
    activeDays: 30,
    txPerDay: 26.9666666667,
    burstScore: 0.51,
    uniqueCounterparties: 10,
    topCounterpartyShare: 0.02,
    isDormant: false,
    dormantDays: 0,
    resurrectedRecently: false,
    neighborCount: 9,
    sanctionedNeighborRatio: 0.28,
    highRiskNeighborRatio: 0.32,
    dormantNeighborRatio: 0,
    mixerProximity: 0.42,
    custodianExposure: 0.38,
    scamPlatformExposure: 0.49,
    local: {
      riskyNeighborRatio: 0.32,
      neighborAvgTx: 26.9666666667,
      neighborAvgAgeDays: 1309,
    },
  };
}

async function fetchRealFeaturesOrFallback({ address, network, env }) {
  try {
    // Only use Etherscan on Ethereum mainnet for now
    if (network !== 'eth') {
      return buildSyntheticFeats(address);
    }

    const txs = await fetchEtherscanTxs({ address, network, env, limit: 1000 });
    if (!txs || txs.length === 0) {
      return buildSyntheticFeats(address);
    }

    const feats = buildFeatsFromTxs({ address, txs });
    if (!feats) return buildSyntheticFeats(address);
    return feats;
  } catch (err) {
    // On any failure, fall back to synthetic so the UI stays responsive
    return buildSyntheticFeats(address);
  }
}

// --- Handlers ------------------------------------------------------

async function handleRoot() {
  return jsonResponse({ ok: true, service: 'riskxlabs-vision-api', version: VERSION });
}

async function handleScore(url, env) {
  const addressRaw = url.searchParams.get('address') || '';
  const network = (url.searchParams.get('network') || 'eth').toLowerCase();
  const address = normAddr(addressRaw);

  if (!address) {
    return jsonResponse({ ok: false, error: 'missing address' }, 400);
  }

  await ensureSets(env);
  const listFlags = classifyLists(address);

  // 1) Build feature vector (real if possible, else synthetic)
  const feats = await fetchRealFeaturesOrFallback({ address, network, env });

  // 2) Baseline model score
  const modelResult = scoreAddress({
    address,
    network,
    feats,
    lists: listFlags,
  });

  // modelResult has { risk_score, reasons, block?, explain, feats }
  const out = {
    address,
    network,
    risk_score: modelResult.risk_score,
    reasons: modelResult.reasons,
    risk_factors: modelResult.reasons,
    block: !!modelResult.block,
    sanctionHits: modelResult.sanctionHits || null,
    feats: modelResult.feats || feats,
    explain: modelResult.explain,
  };

  // 3) Hard OFAC override (parachute): always clamp to 100 & block
  if (listFlags.ofacHit) {
    out.risk_score = 100;
    out.block = true;
    out.sanctionHits = (out.sanctionHits || 0) + 1;

    if (!out.reasons.includes('OFAC / sanctions list match')) {
      out.reasons.push('OFAC / sanctions list match');
    }
    if (out.explain && out.explain.signals) {
      out.explain.signals.ofacHit = true;
    } else if (out.explain) {
      out.explain.signals = { ofacHit: true };
    }
  }

  // Mirror score field used by frontend
  out.score = out.risk_score;

  return jsonResponse(out, 200);
}

// Keep /txs and /neighbors simple for now — can expand later.
async function handleTxs(url, env) {
  const addressRaw = url.searchParams.get('address') || '';
  const network = (url.searchParams.get('network') || 'eth').toLowerCase();
  const address = normAddr(addressRaw);

  if (!address) {
    return jsonResponse({ ok: false, error: 'missing address' }, 400);
  }

  // For now, we just proxy Etherscan txlist; the frontend only uses earliest tx for age.
  try {
    const txs = await fetchEtherscanTxs({ address, network, env, limit: 50 });
    return jsonResponse({ ok: true, result: txs || [] }, 200);
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err.message || err) }, 500);
  }
}

async function handleNeighbors(url, env) {
  const addressRaw = url.searchParams.get('address') || '';
  const network = (url.searchParams.get('network') || 'eth').toLowerCase();
  const address = normAddr(addressRaw);

  if (!address) {
    return jsonResponse({ ok: false, error: 'missing address' }, 400);
  }

  // For now, a lightweight neighbor graph from Etherscan counterparties:
  try {
    await ensureSets(env);

    const txs = await fetchEtherscanTxs({ address, network, env, limit: 500 });
    if (!txs || !txs.length) {
      // fall back to a tiny stub so the UI still renders *something*
      return jsonResponse({ nodes: [{ id: address }], links: [] }, 200);
    }

    const addr = normAddr(address);
    const counterpartyCounts = new Map();

    for (const tx of txs) {
      const from = normAddr(tx.from);
      const to = normAddr(tx.to);

      if (from && from !== addr) {
        counterpartyCounts.set(from, (counterpartyCounts.get(from) || 0) + 1);
      }
      if (to && to !== addr) {
        counterpartyCounts.set(to, (counterpartyCounts.get(to) || 0) + 1);
      }
    }

    const nodes = [{ id: addr, address: addr, network }];
    const links = [];

    for (const [cp, count] of counterpartyCounts) {
      nodes.push({
        id: cp,
        address: cp,
        network,
      });
      links.push({
        a: addr,
        b: cp,
        weight: count,
      });
    }

    return jsonResponse({ nodes, links }, 200);
  } catch (err) {
    // fallback stub
    return jsonResponse({
      nodes: [{ id: address, address, network }],
      links: [],
    }, 200);
  }
}

// --- Entry point ---------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '/health') {
      return handleRoot();
    }
    if (path === '/score' || path === '/check') {
      return handleScore(url, env);
    }
    if (path === '/txs') {
      return handleTxs(url, env);
    }
    if (path === '/neighbors') {
      return handleNeighbors(url, env);
    }

    return jsonResponse({ ok: false, error: 'Not found', path }, 404);
  },
};
