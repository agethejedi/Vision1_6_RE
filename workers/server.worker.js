// server.worker.js — RiskXLabs Vision API v1.6.3
// Cloudflare Worker: core risk engine + neighbors + CORS

const SERVICE_NAME = 'riskxlabs-vision-api';
const VERSION = 'RXL-V1.6.3';

/* =================== CORS helpers =================== */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // tighten later to your prod origin
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
};

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}

function textResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}

/* =================== Utils =================== */

function clamp(x, min = 0, max = 1) {
  return Math.max(min, Math.min(max, x));
}

function parseHexSet(str) {
  const set = new Set();
  if (!str || typeof str !== 'string') return set;
  const parts = str.split(/[\s,;]+/);
  for (let p of parts) {
    if (!p) continue;
    p = p.trim().toLowerCase();
    if (!p) continue;
    if (!p.startsWith('0x')) p = '0x' + p;
    if (p.length === 42) set.add(p);
  }
  return set;
}

function nowMs() {
  return Date.now();
}

/* =================== TX providers =================== */

async function fetchEtherscanTxs(address, network, env) {
  const key = env.ETHERSCAN_API_KEY;
  if (!key) throw new Error('ETHERSCAN_API_KEY not set');

  // NOTE: Only mainnet eth is wired for now
  if (network !== 'eth' && network !== 'ethereum') {
    throw new Error(`Etherscan only configured for eth, got ${network}`);
  }

  const url = `https://api.etherscan.io/api` +
    `?module=account&action=txlist` +
    `&address=${encodeURIComponent(address)}` +
    `&startblock=0&endblock=99999999&sort=asc` +
    `&apikey=${encodeURIComponent(key)}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Etherscan HTTP ${resp.status}`);
  }
  const json = await resp.json();
  if (json.status !== '1' || !Array.isArray(json.result)) {
    throw new Error(`Etherscan status ${json.status || '0'}`);
  }
  return { provider: 'etherscan', txs: json.result };
}

// Placeholder for future use; currently not used for scoring
async function fetchAlchemyTxs(_address, _network, env) {
  const key = env.ALCHEMY_API_KEY;
  if (!key) throw new Error('ALCHEMY_API_KEY not set');
  // Implementing full address-level tx fetch via Alchemy is non-trivial;
  // for now we treat this as "not yet available" and let the caller fall
  // through to synthetic behavior.
  throw new Error('Alchemy tx provider not implemented');
}

async function loadTxs(address, network, env, { wantDebug = false } = {}) {
  const debug = {
    ok: false,
    error: null,
    provider: null,
    raw: null
  };

  // Try providers in order
  const providers = [fetchEtherscanTxs, fetchAlchemyTxs];

  for (const fn of providers) {
    try {
      const { provider, txs } = await fn(address, network, env);
      debug.ok = true;
      debug.provider = provider;
      debug.raw = txs;
      return wantDebug ? { txs, debug } : { txs };
    } catch (err) {
      // continue to next provider
      if (!debug.error) debug.error = String(err.message || err);
    }
  }

  // If we get here, no provider succeeded → synthetic fallback
  const synthetic = [{
    timeStamp: String(Math.floor(nowMs() / 1000)),
    hash: '0xsynthetic',
    from: address,
    to: address,
    value: '0'
  }];

  debug.ok = false;
  debug.provider = null;
  debug.raw = synthetic;

  return wantDebug
    ? { txs: synthetic, debug }
    : { txs: synthetic };
}

/* =================== Feature extraction =================== */

function deriveFeatures(address, allTxs) {
  const addr = address.toLowerCase();

  if (!Array.isArray(allTxs) || allTxs.length === 0) {
    // Conservative neutral-ish defaults
    return {
      ageDays: 365,
      firstSeenMs: null,
      txCount: 0,
      activeDays: 0,
      txPerDay: 0,
      burstScore: 0,
      uniqueCounterparties: 0,
      topCounterpartyShare: 0,
      isDormant: false,
      dormantDays: 0,
      resurrectedRecently: false,
      neighborCount: 0,
      sanctionedNeighborRatio: 0,
      highRiskNeighborRatio: 0,
      dormantNeighborRatio: 0,
      mixerProximity: 0,
      custodianExposure: 0,
      scamPlatformExposure: 0,
      local: {
        riskyNeighborRatio: 0,
        neighborAvgTx: 0,
        neighborAvgAgeDays: 0,
        neighborCount: 0
      }
    };
  }

  const txs = allTxs.slice().sort((a, b) => {
    const ta = Number(a.timeStamp || 0);
    const tb = Number(b.timeStamp || 0);
    return ta - tb;
  });

  const now = nowMs();
  const firstTsMs = Number(txs[0].timeStamp || 0) * 1000 || now;
  const lastTsMs = Number(txs[txs.length - 1].timeStamp || 0) * 1000 || now;

  const ageDays = Math.max(0, (now - firstTsMs) / 86400000);
  const spanDays = Math.max(1, (lastTsMs - firstTsMs) / 86400000);
  const txCount = txs.length;
  const txPerDay = txCount / spanDays;

  // simple burst metric: relative to linear baseline
  let maxDaily = 0;
  const byDay = new Map();
  for (const tx of txs) {
    const d = Math.floor(Number(tx.timeStamp || 0) / 86400);
    byDay.set(d, (byDay.get(d) || 0) + 1);
  }
  byDay.forEach(v => { if (v > maxDaily) maxDaily = v; });
  const burstScore = clamp(maxDaily / Math.max(1, txPerDay * 2));

  // counterparties
  const cpCounts = new Map();
  for (const tx of txs) {
    const from = String(tx.from || '').toLowerCase();
    const to = String(tx.to || '').toLowerCase();
    let cp = null;
    if (from === addr && to) cp = to;
    else if (to === addr && from) cp = from;
    if (!cp) continue;
    cpCounts.set(cp, (cpCounts.get(cp) || 0) + 1);
  }
  const uniqueCounterparties = cpCounts.size;
  let topCounterpartyShare = 0;
  if (txCount > 0 && uniqueCounterparties > 0) {
    let maxCount = 0;
    cpCounts.forEach(v => { if (v > maxCount) maxCount = v; });
    topCounterpartyShare = maxCount / txCount;
  }

  // simple dormancy flags
  const inactiveThresholdDays = 45;
  const dormantDays = Math.max(0, (now - lastTsMs) / 86400000);
  const isDormant = dormantDays >= inactiveThresholdDays;
  const resurrectedRecently = !isDormant && dormantDays <= 7 && ageDays > 90;

  // neighbor metrics filled later where we have list sets; defaults here:
  const neighborCount = uniqueCounterparties;

  return {
    ageDays,
    firstSeenMs: firstTsMs,
    txCount,
    activeDays: spanDays,
    txPerDay,
    burstScore,
    uniqueCounterparties,
    topCounterpartyShare,
    isDormant,
    dormantDays,
    resurrectedRecently,
    neighborCount,
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
      neighborCount
    }
  };
}

/* =================== Risk model =================== */

function scoreWithModel(address, network, feats, sets) {
  const { ofacSet, scamSet, tornadoSet } = sets;

  const addr = address.toLowerCase();
  const ageDays = feats.ageDays ?? 0;
  const txPerDay = feats.txPerDay ?? 0;
  const uniq = feats.uniqueCounterparties ?? 0;
  const topShare = feats.topCounterpartyShare ?? 0;

  const ofacHit = ofacSet.has(addr);
  const inScam = scamSet.has(addr);
  const inTornado = tornadoSet.has(addr);

  let baseScore = 15;
  let rawContribution = 0;

  const parts = {};

  // Age
  let ageImpact = 0;
  let ageBucket = '> 2y';
  if (ageDays < 7) {
    ageImpact = 25;
    ageBucket = '< 1 week';
  } else if (ageDays < 30) {
    ageImpact = 18;
    ageBucket = '< 1 month';
  } else if (ageDays < 180) {
    ageImpact = 8;
    ageBucket = '1–6m';
  } else if (ageDays < 730) {
    ageImpact = 2;
    ageBucket = '6m–2y';
  } else {
    ageImpact = -5;
    ageBucket = '> 2y';
  }
  rawContribution += ageImpact;
  parts.age = {
    id: 'age',
    label: 'Wallet age',
    impact: ageImpact,
    details: { ageDays, bucket: ageBucket }
  };

  // Velocity
  let vImpact = 0;
  let vBucket = 'normal';
  if (txPerDay > 50) {
    vImpact = 22;
    vBucket = 'extreme';
  } else if (txPerDay > 10) {
    vImpact = 15;
    vBucket = 'high';
  } else if (txPerDay > 3) {
    vImpact = 10;
    vBucket = 'elevated';
  } else if (txPerDay > 0.5) {
    vImpact = 4;
    vBucket = 'mild';
  }
  rawContribution += vImpact;
  parts.velocity = {
    id: 'velocity',
    label: 'Transaction velocity & bursts',
    impact: vImpact,
    details: { txPerDay, burstScore: feats.burstScore ?? 0, bucket: vBucket }
  };

  // Mix / concentration
  let mixImpact = 0;
  let mixBucket = 'diversified';
  if (uniq <= 1 || topShare > 0.8) {
    mixImpact = 14;
    mixBucket = 'concentrated';
  } else if (uniq <= 3 || topShare > 0.5) {
    mixImpact = 8;
    mixBucket = 'moderate';
  } else if (uniq > 20 && topShare < 0.2) {
    mixImpact = -2;
    mixBucket = 'very diversified';
  }
  rawContribution += mixImpact;
  parts.mix = {
    id: 'mix',
    label: 'Counterparty mix & concentration',
    impact: mixImpact,
    details: {
      uniqueCounterparties: uniq,
      topCounterpartyShare: topShare,
      bucket: mixBucket
    }
  };

  // Neighbor risk (here we just use scam/tornado membership as a proxy)
  let neighborImpact = 0;
  const neighborCount = feats.neighborCount ?? feats.local?.neighborCount ?? uniq ?? 0;
  const sanctionedNeighborRatio = feats.sanctionedNeighborRatio ?? 0;
  const highRiskNeighborRatio = feats.highRiskNeighborRatio ?? 0;

  if (sanctionedNeighborRatio > 0.1 || highRiskNeighborRatio > 0.3) {
    neighborImpact = 15;
  } else if (highRiskNeighborRatio > 0.1) {
    neighborImpact = 8;
  }
  rawContribution += neighborImpact;
  parts.neighbor = {
    id: 'neighbor',
    label: 'Neighbor & cluster risk',
    impact: neighborImpact,
    details: {
      neighborCount,
      sanctionedNeighborRatio,
      highRiskNeighborRatio,
      mixedCluster: neighborImpact > 0
    }
  };

  // Lists (OFAC, scam, tornado)
  let listImpact = 0;
  const listDetails = {};
  if (ofacHit) {
    listImpact += 70;
    listDetails.ofac = true;
  }
  if (inScam) {
    listImpact += 30;
    listDetails.scamCluster = true;
  }
  if (inTornado) {
    listImpact += 25;
    listDetails.tornado = true;
  }
  rawContribution += listImpact;
  parts.lists = {
    id: 'lists',
    label: 'External fraud & platform signals',
    impact: listImpact,
    details: listDetails
  };

  // dormant / governance placeholders
  parts.dormant = {
    id: 'dormant',
    label: 'Dormancy & resurrection patterns',
    impact: 0,
    details: {
      isDormant: feats.isDormant ?? false,
      dormantDays: feats.dormantDays ?? 0,
      resurrectedRecently: feats.resurrectedRecently ?? false
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

  let score = clamp(baseScore + rawContribution, 0, 100);

  // Force minimum score for OFAC
  if (ofacHit && score < 87) score = 87;

  const reasons = [];
  const risk_factors = [];

  if (ageImpact > 0) { reasons.push('Wallet age'); risk_factors.push('Wallet age'); }
  if (vImpact > 0) { reasons.push('Transaction velocity & bursts'); risk_factors.push('Transaction velocity & bursts'); }
  if (mixImpact > 0) { reasons.push('Counterparty mix & concentration'); risk_factors.push('Counterparty mix & concentration'); }
  if (neighborImpact > 0) { reasons.push('Neighbor & cluster risk'); risk_factors.push('Neighbor & cluster risk'); }
  if (listImpact > 0) { reasons.push('OFAC / sanctions list match'); risk_factors.push('OFAC / sanctions list match'); }

  const sanctionHits = ofacHit ? 1 : 0;
  const block = !!(ofacHit || score >= 90);

  const explain = {
    version: VERSION,
    address: addr,
    network,
    baseScore,
    rawContribution,
    score,
    confidence: 1,
    parts,
    feats,
    signals: {
      ofacHit,
      chainabuse: false,
      caFraud: false,
      scamPlatform: inScam,
      mixer: inTornado,
      custodian: false,
      unifiedSanctions: null,
      chainalysis: null,
      scorechain: null
    },
    notes: []
  };

  return {
    address: addr,
    network,
    risk_score: score,
    reasons,
    risk_factors,
    block,
    sanctionHits,
    feats,
    explain,
    score
  };
}

/* =================== Neighbors from tx graph =================== */

function buildNeighborsFromTxs(address, allTxs, network, limit = 120) {
  const center = address.toLowerCase();
  const nodes = [{ id: center, address: center, network }];
  const links = [];
  const seen = new Set([center]);

  for (const tx of allTxs) {
    const from = String(tx.from || '').toLowerCase();
    const to = String(tx.to || '').toLowerCase();
    let cp = null;
    if (from === center && to) cp = to;
    else if (to === center && from) cp = from;
    if (!cp) continue;
    if (seen.has(cp)) continue;
    seen.add(cp);
    nodes.push({ id: cp, address: cp, network });
    links.push({ a: center, b: cp, weight: 1 });
    if (nodes.length - 1 >= limit) break;
  }

  return { nodes, links };
}

/* =================== Worker entry =================== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return textResponse('', 204);
    }

    // Root / health
    if (pathname === '/' || pathname === '/health') {
      return jsonResponse({
        ok: true,
        service: SERVICE_NAME,
        version: VERSION,
        time: new Date().toISOString()
      });
    }

    // /score
    if (pathname === '/score') {
      try {
        const address = (searchParams.get('address') || '').toLowerCase();
        const network = (searchParams.get('network') || 'eth').toLowerCase();
        if (!address || !address.startsWith('0x')) {
          return jsonResponse({ ok: false, error: 'Missing or invalid address' }, 400);
        }

        const ofacSet = parseHexSet(env.OFAC_SET);
        const scamSet = parseHexSet(env.SCAM_CLUSTERS);
        const tornadoSet = parseHexSet(env.TORNADO_SET);

        const { txs } = await loadTxs(address, network, env);
        const feats = deriveFeatures(address, txs);
        const result = scoreWithModel(address, network, feats, {
          ofacSet,
          scamSet,
          tornadoSet
        });

        return jsonResponse(result);
      } catch (err) {
        return jsonResponse(
          { ok: false, error: String(err.message || err) },
          500
        );
      }
    }

    // /txs-debug
    if (pathname === '/txs-debug') {
      try {
        const address = (searchParams.get('address') || '').toLowerCase();
        const network = (searchParams.get('network') || 'eth').toLowerCase();
        if (!address || !address.startsWith('0x')) {
          return jsonResponse({ ok: false, error: 'Missing or invalid address' }, 400);
        }

        const { txs, debug } = await loadTxs(address, network, env, {
          wantDebug: true
        });

        return jsonResponse({
          ok: debug.ok,
          error: debug.ok ? null : (debug.error || 'no providers succeeded; returning synthetic'),
          provider: debug.provider,
          raw: txs
        });
      } catch (err) {
        return jsonResponse(
          { ok: false, error: String(err.message || err) },
          500
        );
      }
    }

    // /neighbors
    if (pathname === '/neighbors') {
      try {
        const address = (searchParams.get('address') || '').toLowerCase();
        const network = (searchParams.get('network') || 'eth').toLowerCase();
        const limit = Number(searchParams.get('limit') || '120') || 120;
        if (!address || !address.startsWith('0x')) {
          return jsonResponse({ ok: false, error: 'Missing or invalid address' }, 400);
        }

        const { txs } = await loadTxs(address, network, env);
        const graph = buildNeighborsFromTxs(address, txs, network, limit);

        return jsonResponse(graph);
      } catch (err) {
        return jsonResponse(
          { ok: false, error: String(err.message || err) },
          500
        );
      }
    }

    // /neighbors-debug
    if (pathname === '/neighbors-debug') {
      try {
        const address = (searchParams.get('address') || '').toLowerCase();
        const network = (searchParams.get('network') || 'eth').toLowerCase();
        const limit = Number(searchParams.get('limit') || '120') || 120;
        if (!address || !address.startsWith('0x')) {
          return jsonResponse({ ok: false, error: 'Missing or invalid address' }, 400);
        }

        const { txs, debug } = await loadTxs(address, network, env, {
          wantDebug: true
        });
        const graph = buildNeighborsFromTxs(address, txs, network, limit);

        return jsonResponse({
          ok: true,
          providerOk: debug.ok,
          provider: debug.provider,
          txSample: debug.raw?.slice?.(0, 5) || null,
          graph
        });
      } catch (err) {
        return jsonResponse(
          { ok: false, error: String(err.message || err) },
          500
        );
      }
    }

    // Fallback 404
    return jsonResponse({ ok: false, error: 'Not found' }, 404);
  }
};
