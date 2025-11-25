// workers/server.worker.js
// RiskXLabs Vision API — Cloudflare Worker backend
//
// Routes:
//   GET /score?address=0x...&network=eth        → risk score + explain + feats
//   GET /neighbors?address=0x...&network=eth    → neighbor graph (1-hop)
//   GET /tx-debug?address=0x...&network=eth     → raw tx debug
//   GET /neighbors-debug?address=0x...&network=eth → neighbor graph debug
//
// Uses Cloudflare secrets / vars:
//   ALCHEMY_API_KEY            (reserved for future use)
//   ETHERSCAN_API_KEY
//   CHAINALYSIS_SANCTIONS_API  (reserved)
//   SCORECHAIN_API_KEY         (reserved)
//   OFACLIST                   (not used directly here)
//   OFAC_SET
//   SCAM_CLUSTERS
//   TORNADO_SET

const DAY_MS = 24 * 60 * 60 * 1000;

/* =================== Utility helpers =================== */

function clamp(x, a = 0, b = 1) {
  return Math.max(a, Math.min(b, x));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-allow-headers': 'Content-Type,Origin,Accept'
    }
  });
}

function parseHexSet(raw) {
  if (!raw || typeof raw !== 'string') return new Set();
  let arr;
  const trimmed = raw.trim();
  if (!trimmed) return new Set();
  if (trimmed[0] === '[') {
    try { arr = JSON.parse(trimmed); } catch { arr = []; }
  } else {
    arr = trimmed.split(/[\s,]+/);
  }
  const out = new Set();
  for (let v of arr) {
    if (!v) continue;
    v = String(v).trim().toLowerCase();
    if (!v) continue;
    if (!v.startsWith('0x')) v = '0x' + v.replace(/^0x/i, '');
    out.add(v);
  }
  return out;
}

/* =================== Etherscan TX history =================== */

const ETHERSCAN_BASE = {
  eth: 'https://api.etherscan.io',
  polygon: 'https://api.polygonscan.com',
  arbitrum: 'https://api.arbiscan.io'
};

// Simple in-memory cache (best-effort)
const txCache = new Map(); // key -> { ts, data }
const TX_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchEtherscanTxs(address, network, etherscanKey) {
  if (!etherscanKey) {
    return { ok: false, error: 'no etherscan key', provider: 'etherscan', txs: [] };
  }

  const key = `${network}:${address}`;
  const now = Date.now();
  const cached = txCache.get(key);
  if (cached && (now - cached.ts) < TX_CACHE_TTL) {
    return { ok: true, provider: 'etherscan-cache', txs: cached.data };
  }

  const base = ETHERSCAN_BASE[network] || ETHERSCAN_BASE.eth;
  const url = `${base}/api?module=account&action=txlist&address=${encodeURIComponent(address)}&startblock=0&endblock=99999999&sort=asc&apikey=${encodeURIComponent(etherscanKey)}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    return { ok: false, error: `etherscan status ${resp.status}`, provider: 'etherscan', txs: [] };
  }
  const json = await resp.json();
  if (json.status !== '1' || !Array.isArray(json.result)) {
    return { ok: false, error: `etherscan status ${json.status}`, provider: 'etherscan', txs: [] };
  }

  const txs = json.result.map(tx => ({
    hash: tx.hash,
    from: String(tx.from || '').toLowerCase(),
    to: String(tx.to || '').toLowerCase(),
    value: tx.value || '0',
    timeStampMs: Number(tx.timeStamp || 0) * 1000
  }));

  txCache.set(key, { ts: now, data: txs });

  return { ok: true, provider: 'etherscan', txs };
}

function syntheticTx(address) {
  const now = Date.now();
  return [{
    hash: '0xsynthetic',
    from: address,
    to: address,
    value: '0',
    timeStampMs: now - 365 * DAY_MS
  }];
}

/* =================== Feature extraction =================== */

function deriveFeaturesFromTx(address, txs, nowMs) {
  const addr = address.toLowerCase();
  const list = (Array.isArray(txs) && txs.length) ? [...txs] : syntheticTx(addr);

  list.sort((a, b) => (a.timeStampMs || 0) - (b.timeStampMs || 0));

  const firstSeenMs = list[0].timeStampMs || nowMs;
  const lastSeenMs = list[list.length - 1].timeStampMs || nowMs;

  let ageDays = (nowMs - firstSeenMs) / DAY_MS;
  if (ageDays < 0) ageDays = 0;

  const dayMap = new Map();
  const counterpartCounts = new Map();
  const neighbors = new Set();

  for (const tx of list) {
    const ts = tx.timeStampMs || nowMs;
    const dayKey = Math.floor(ts / DAY_MS);
    dayMap.set(dayKey, (dayMap.get(dayKey) || 0) + 1);

    const from = tx.from?.toLowerCase?.() || '';
    const to = tx.to?.toLowerCase?.() || '';

    const other = (from === addr ? to : (to === addr ? from : null));
    if (other && other !== addr) {
      neighbors.add(other);
      counterpartCounts.set(other, (counterpartCounts.get(other) || 0) + 1);
    }
  }

  const txCount = list.length;
  const activeDays = dayMap.size || 1;
  const txPerDay = txCount / activeDays;

  let maxPerDay = 0;
  for (const c of dayMap.values()) if (c > maxPerDay) maxPerDay = c;
  const burstScoreRaw = maxPerDay / (txPerDay || 1);
  const burstScore = clamp((burstScoreRaw - 1) / 9);

  let uniqueCounterparties = neighbors.size;
  let topCounterpartyShare = 0;
  if (txCount > 0 && counterpartCounts.size) {
    let max = 0;
    for (const c of counterpartCounts.values()) if (c > max) max = c;
    topCounterpartyShare = max / txCount;
  }

  return {
    ageDays,
    firstSeenMs,
    txCount,
    activeDays,
    txPerDay,
    burstScore,
    uniqueCounterparties,
    topCounterpartyShare,
    isDormant: false,
    dormantDays: (nowMs - lastSeenMs) / DAY_MS,
    resurrectedRecently: false,
    neighborCount: neighbors.size,
    sanctionedNeighborRatio: 0,
    highRiskNeighborRatio: 0,
    dormantNeighborRatio: 0,
    mixerProximity: 0,
    custodianExposure: 0,
    scamPlatformExposure: 0,
    local: {
      riskyNeighborRatio: 0,
      neighborAvgTx: txPerDay,
      neighborAvgAgeDays: ageDays,
      neighborCount: neighbors.size
    }
  };
}

/* =================== Scoring =================== */

function scoreFromFeatures(address, feats, signals, network) {
  const parts = {};
  let baseScore = 15;
  let rawContribution = 0;

  const ageDays = feats.ageDays ?? 0;
  let ageImpact = 0;
  let ageBucket;
  if (ageDays < 7) {
    ageImpact = 25; ageBucket = '< 1 week';
  } else if (ageDays < 180) {
    ageImpact = 10; ageBucket = '< 6 months';
  } else if (ageDays < 365 * 2) {
    ageImpact = 2; ageBucket = '6m–2y';
  } else {
    ageImpact = -5; ageBucket = '> 2 years';
  }
  rawContribution += ageImpact;
  parts.age = {
    id: 'age',
    label: 'Wallet age',
    impact: ageImpact,
    details: { ageDays, bucket: ageBucket }
  };

  const txPerDay = feats.txPerDay ?? 0;
  const burstScore = feats.burstScore ?? 0;
  let velImpact = 0;
  let velBucket = 'normal';
  if (txPerDay > 50 || burstScore > 0.9) {
    velImpact = 25; velBucket = 'extreme';
  } else if (txPerDay > 10 || burstScore > 0.7) {
    velImpact = 15; velBucket = 'elevated';
  } else if (txPerDay > 3 || burstScore > 0.5) {
    velImpact = 5; velBucket = 'mild';
  }
  rawContribution += velImpact;
  parts.velocity = {
    id: 'velocity',
    label: 'Transaction velocity & bursts',
    impact: velImpact,
    details: { txPerDay, burstScore, bucket: velBucket }
  };

  const uniq = feats.uniqueCounterparties ?? 0;
  const topShare = feats.topCounterpartyShare ?? 0;
  let mixImpact = 0;
  let mixBucket = 'diversified';
  if (uniq <= 1 && topShare >= 0.9) {
    mixImpact = 14; mixBucket = 'concentrated';
  } else if (uniq < 4 && topShare >= 0.6) {
    mixImpact = 8; mixBucket = 'semi-concentrated';
  } else if (uniq > 25 && topShare < 0.2) {
    mixImpact = -2; mixBucket = 'diversified';
  }
  rawContribution += mixImpact;
  parts.mix = {
    id: 'mix',
    label: 'Counterparty mix & concentration',
    impact: mixImpact,
    details: { uniqueCounterparties: uniq, topCounterpartyShare: topShare, bucket: mixBucket }
  };

  const neighborCount = feats.neighborCount ?? feats.local?.neighborCount ?? 0;
  let neighborImpact = 0;
  if (neighborCount > 40) neighborImpact = 5;
  parts.neighbor = {
    id: 'neighbor',
    label: 'Neighbor & cluster risk',
    impact: neighborImpact,
    details: {
      neighborCount,
      sanctionedNeighborRatio: feats.sanctionedNeighborRatio ?? 0,
      highRiskNeighborRatio: feats.highRiskNeighborRatio ?? 0,
      mixedCluster: neighborCount > 0
    }
  };
  rawContribution += neighborImpact;

  let listsImpact = 0;
  const listDetails = {};
  if (signals.ofacHit) {
    listsImpact += 70;
    listDetails.ofac = true;
  }
  if (signals.mixer) {
    listsImpact += 35;
    listDetails.mixer = true;
  }
  if (signals.scamCluster) {
    listsImpact += 30;
    listDetails.scamCluster = true;
  }
  parts.lists = {
    id: 'lists',
    label: 'External fraud & platform signals',
    impact: listsImpact,
    details: listDetails
  };
  rawContribution += listsImpact;

  parts.dormant = {
    id: 'dormant',
    label: 'Dormancy & resurrection patterns',
    impact: 0,
    details: {
      isDormant: feats.isDormant || false,
      dormantDays: feats.dormantDays || 0,
      resurrectedRecently: feats.resurrectedRecently || false
    }
  };

  parts.concentration = {
    id: 'concentration',
    label: 'Flow concentration (fan-in/out)',
    impact: 0,
    details: {}
  };

  parts.governance = {
    id: 'governance',
    label: 'Governance / override',
    impact: 0,
    details: {}
  };

  let score = baseScore + rawContribution;

  if (signals.ofacHit) {
    score = 100;
  } else if (signals.mixer && signals.scamCluster) {
    score = Math.max(score, 90);
  } else if (signals.mixer || signals.scamCluster) {
    score = Math.max(score, 80);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const block = !!(signals.ofacHit || score >= 90);

  const explain = {
    version: 'RXL-V1.6.3',
    address,
    network,
    baseScore,
    rawContribution,
    score,
    confidence: 1,
    parts,
    feats,
    signals,
    notes: []
  };

  return { score, block, explain };
}

/* =================== Risk response + neighbors =================== */

async function buildRiskResponse(address, network, env) {
  const addr = address.toLowerCase();
  const nowMs = Date.now();

  const ofacSet = parseHexSet(env.OFAC_SET);
  const scamSet = parseHexSet(env.SCAM_CLUSTERS);
  const tornadoSet = parseHexSet(env.TORNADO_SET);

  const { ok, provider, txs, error } =
    await fetchEtherscanTxs(addr, network, env.ETHERSCAN_API_KEY)
      .catch(err => ({ ok: false, error: String(err), provider: 'etherscan', txs: [] }));

  const txList = ok ? txs : syntheticTx(addr);
  const feats = deriveFeaturesFromTx(addr, txList, nowMs);

  const ofacHit = ofacSet.has(addr);
  const mixerHit = tornadoSet.has(addr);
  const scamClusterHit = scamSet.has(addr);

  feats.mixerProximity = mixerHit ? 1 : 0;
  feats.scamPlatformExposure = scamClusterHit ? 1 : 0;

  const signals = {
    ofacHit,
    chainabuse: false,
    caFraud: false,
    scamPlatform: scamClusterHit,
    mixer: mixerHit,
    custodian: false,
    unifiedSanctions: null,
    chainalysis: null,
    scorechain: null
  };

  const { score, block, explain } = scoreFromFeatures(addr, feats, signals, network);

  const reasons = [];
  if (explain.parts.age.impact !== 0) reasons.push('Wallet age');
  if (explain.parts.velocity.impact !== 0) reasons.push('Transaction velocity & bursts');
  if (explain.parts.mix.impact !== 0) reasons.push('Counterparty mix & concentration');
  if (ofacHit) reasons.push('OFAC / sanctions list match');
  if (mixerHit) reasons.push('Mixer proximity (Tornado)');
  if (scamClusterHit) reasons.push('Sketchy cluster pattern');

  return {
    address: addr,
    network,
    risk_score: score,
    reasons,
    risk_factors: reasons,
    block,
    sanctionHits: ofacHit ? 1 : 0,
    feats,
    explain,
    score
  };
}

async function buildNeighborGraph(address, network, env, limit = 120) {
  const addr = address.toLowerCase();
  const { ok, txs } =
    await fetchEtherscanTxs(addr, network, env.ETHERSCAN_API_KEY)
      .catch(err => ({ ok: false, error: String(err), provider: 'etherscan', txs: [] }));

  const list = ok && txs.length ? txs : syntheticTx(addr);
  const neighbors = new Map();

  for (const tx of list) {
    const from = tx.from?.toLowerCase?.() || '';
    const to = tx.to?.toLowerCase?.() || '';
    const other = (from === addr ? to : (to === addr ? from : null));
    if (!other || other === addr) continue;
    if (!neighbors.has(other)) {
      neighbors.set(other, { id: other, address: other, network });
    }
  }

  const nodes = [{ id: addr, address: addr, network }];
  const links = [];

  const cap = Math.min(limit, neighbors.size);
  let i = 0;
  for (const [nid, node] of neighbors.entries()) {
    if (i++ >= cap) break;
    nodes.push(node);
    links.push({ a: addr, b: nid, weight: 1 });
  }

  return { nodes, links };
}

/* =================== Worker entrypoint =================== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response('', {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,OPTIONS',
          'access-control-allow-headers': 'Content-Type,Origin,Accept'
        }
      });
    }

    try {
      if (path === '/score') {
        const address = (url.searchParams.get('address') || '').trim().toLowerCase();
        const network = (url.searchParams.get('network') || 'eth').toLowerCase();
        if (!address || !address.startsWith('0x') || address.length < 10) {
          return jsonResponse({ ok: false, error: 'Missing or invalid address' }, 400);
        }
        const res = await buildRiskResponse(address, network, env);
        return jsonResponse(res, 200);
      }

      if (path === '/neighbors') {
        const address = (url.searchParams.get('address') || '').trim().toLowerCase();
        const network = (url.searchParams.get('network') || 'eth').toLowerCase();
        const limit = Number(url.searchParams.get('limit') || '120') || 120;
        if (!address || !address.startsWith('0x') || address.length < 10) {
          return jsonResponse({ ok: false, error: 'Missing or invalid address' }, 400);
        }
        const graph = await buildNeighborGraph(address, network, env, limit);
        return jsonResponse(graph, 200);
      }

      if (path === '/tx-debug') {
        const address = (url.searchParams.get('address') || '').trim().toLowerCase();
        const network = (url.searchParams.get('network') || 'eth').toLowerCase();
        if (!address || !address.startsWith('0x') || address.length < 10) {
          return jsonResponse({ ok: false, error: 'Missing or invalid address' }, 400);
        }
        const resp = await fetchEtherscanTxs(address, network, env.ETHERSCAN_API_KEY)
          .catch(err => ({ ok: false, error: String(err), provider: 'etherscan', txs: [] }));
        if (!resp.ok) {
          return jsonResponse({ ok: false, error: resp.error || 'no providers succeeded; returning synthetic', provider: null, raw: syntheticTx(address) });
        }
        return jsonResponse({ ok: true, provider: resp.provider, raw: resp.txs });
      }

      if (path === '/neighbors-debug') {
        const address = (url.searchParams.get('address') || '').trim().toLowerCase();
        const network = (url.searchParams.get('network') || 'eth').toLowerCase();
        if (!address || !address.startsWith('0x') || address.length < 10) {
          return jsonResponse({ ok: false, error: 'Missing or invalid address' }, 400);
        }
        const graph = await buildNeighborGraph(address, network, env, 120);
        return jsonResponse(graph, 200);
      }

      // Root or unknown path
      return jsonResponse({ ok: false, error: 'Not found' }, 404);
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err && err.message || err) }, 500);
    }
  }
};
