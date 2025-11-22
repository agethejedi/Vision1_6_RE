// server.worker.js — RiskXLabs Vision API v1.6.2
// NOTE: if your bundler cannot resolve this path, adjust to './risk-model.js'
import { scoreAddress } from './lib/risk-model.js';

const VERSION = 'RXL-V1.6.2';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (path === '/' || path === '/health') {
        return json(
          { ok: true, service: 'riskxlabs-vision-api', version: VERSION },
          200
        );
      }

      if (path === '/score') {
        return handleScore(url, env);
      }

      if (path === '/txs') {
        return handleTxs(url, env);
      }

      if (path === '/neighbors') {
        return handleNeighbors(url, env);
      }

      return json(
        { ok: false, error: 'Not found', path, version: VERSION },
        404
      );
    } catch (err) {
      return json(
        {
          ok: false,
          error: 'Unhandled exception in worker',
          detail: String(err && err.message ? err.message : err),
          version: VERSION
        },
        500
      );
    }
  }
};

/* ============= SCORE HANDLER ==================================== */

async function handleScore(url, env) {
  const addressRaw = url.searchParams.get('address') || '';
  const network = (url.searchParams.get('network') || 'eth').toLowerCase();
  const address = addressRaw.toLowerCase().trim();

  if (!address || !address.startsWith('0x') || address.length < 10) {
    return json(
      { ok: false, error: 'Missing or invalid address', address: addressRaw },
      400
    );
  }

  // 1) Build list membership sets from env plaintext vars
  const {
    ofacSet,
    scamSet,
    tornadoSet
  } = buildAddressSetsFromEnv(env);

  // 2) On-chain features from Etherscan (or synthetic fallback)
  const feats = await buildFeaturesFromChain(address, network, env).catch(
    () => syntheticFeatures()
  );

  // 3) List signals
  const addrHitOfac = ofacSet.has(address);
  const addrHitScam = scamSet.has(address);
  const addrHitTornado = tornadoSet.has(address);

  const listSignals = {
    ofacHit: addrHitOfac,
    scamPlatform: addrHitScam,
    mixer: addrHitTornado
  };

  // 4) Risk model
  const model = scoreAddress(feats, listSignals);
  let riskScore = model.score;
  const reasons = [...model.reasons];

  let block = false;
  let sanctionHits = null;

  if (addrHitOfac) {
    block = true;
    sanctionHits = 1;
    riskScore = 100;
    if (!reasons.includes('OFAC / sanctions list match')) {
      reasons.push('OFAC / sanctions list match');
    }
  }

  if (addrHitTornado && !addrHitOfac) {
    // Tornado / mixer cluster → high but not necessarily 100
    if (riskScore < 85) riskScore = 85;
    if (!reasons.includes('Known mixer / Tornado Cash cluster')) {
      reasons.push('Known mixer / Tornado Cash cluster');
    }
  }

  if (addrHitScam && !addrHitOfac) {
    if (riskScore < 75) riskScore = 75;
    if (!reasons.includes('Known scam / fraud platform cluster')) {
      reasons.push('Known scam / fraud platform cluster');
    }
  }

  const payload = {
    address,
    network,
    risk_score: riskScore,
    reasons,
    risk_factors: reasons,
    block,
    sanctionHits,
    feats: {
      ...feats,
      local: {
        riskyNeighborRatio:
          feats.highRiskNeighborRatio != null
            ? feats.highRiskNeighborRatio
            : 0,
        neighborAvgTx: feats.txPerDay || 0,
        neighborAvgAgeDays: feats.ageDays || 0,
        neighborCount: feats.neighborCount || null
      }
    },
    explain: {
      ...model.explain,
      version: VERSION,
      address,
      network,
      feats,
      signals: {
        ofacHit: addrHitOfac,
        scamPlatform: addrHitScam,
        mixer: addrHitTornado,
        chainabuse: false,
        caFraud: false,
        custodian: false,
        unifiedSanctions: null,
        chainalysis: null,
        scorechain: null
      },
      notes: model.explain?.notes || []
    },
    score: riskScore
  };

  return json(payload, 200);
}

/* ============= TXS HANDLER (ETHERSCAN) ========================== */

async function handleTxs(url, env) {
  const addressRaw = url.searchParams.get('address') || '';
  const network = (url.searchParams.get('network') || 'eth').toLowerCase();
  const limit = Number(url.searchParams.get('limit') || '100') || 100;
  const sort = (url.searchParams.get('sort') || 'asc').toLowerCase();
  const address = addressRaw.toLowerCase().trim();

  if (!address || !address.startsWith('0x')) {
    return json(
      { ok: false, error: 'Missing or invalid address', address: addressRaw },
      400
    );
  }

  const apiKey = env.ETHERSCAN_API_KEY;
  if (!apiKey || network !== 'eth') {
    // Fallback stub
    return json(
      {
        ok: true,
        source: 'synthetic',
        result: []
      },
      200
    );
  }

  const params = new URLSearchParams({
    module: 'account',
    action: 'txlist',
    address,
    startblock: '0',
    endblock: '99999999',
    page: '1',
    offset: String(limit),
    sort
  });

  const urlEth = `https://api.etherscan.io/api?${params.toString()}&apikey=${encodeURIComponent(
    apiKey
  )}`;

  const r = await fetch(urlEth);
  if (!r.ok) {
    return json(
      { ok: false, error: 'Upstream error from Etherscan', status: r.status },
      502
    );
  }

  const data = await r.json();
  if (!data || data.status === '0') {
    return json(
      { ok: true, source: 'etherscan', result: [] },
      200
    );
  }

  return json(
    {
      ok: true,
      source: 'etherscan',
      result: Array.isArray(data.result) ? data.result : []
    },
    200
  );
}

/* ============= NEIGHBORS HANDLER (LIGHT STUB) =================== */

async function handleNeighbors(url, env) {
  const addressRaw = url.searchParams.get('address') || '';
  const network = (url.searchParams.get('network') || 'eth').toLowerCase();
  const limit = Number(url.searchParams.get('limit') || '60') || 60;
  const address = addressRaw.toLowerCase().trim();

  if (!address || !address.startsWith('0x')) {
    return json(
      { ok: false, error: 'Missing or invalid address', address: addressRaw },
      400
    );
  }

  // For now, keep a deterministic synthetic ring so the graph behaves.
  const nodes = [{ id: address, address, network }];
  const links = [];
  const n = Math.min(limit, 60);

  for (let i = 0; i < n; i++) {
    const child = mkPseudoAddress(address, i);
    nodes.push({ id: child, address: child, network });
    links.push({ a: address, b: child, weight: 1 });
  }

  return json(
    {
      ok: true,
      source: 'synthetic',
      nodes,
      links,
      meta: { totalNeighbors: n, shown: n, overflow: 0 }
    },
    200
  );
}

/* ============= FEATURE BUILDER (ETHERSCAN → MODEL) ============== */

async function buildFeaturesFromChain(address, network, env) {
  const apiKey = env.ETHERSCAN_API_KEY;
  if (!apiKey || network !== 'eth') {
    return syntheticFeatures();
  }

  // Get up to 1000 txs ascending by time
  const params = new URLSearchParams({
    module: 'account',
    action: 'txlist',
    address,
    startblock: '0',
    endblock: '99999999',
    page: '1',
    offset: '1000',
    sort: 'asc'
  });

  const urlEth = `https://api.etherscan.io/api?${params.toString()}&apikey=${encodeURIComponent(
    apiKey
  )}`;

  const r = await fetch(urlEth);
  if (!r.ok) return syntheticFeatures();

  const data = await r.json().catch(() => null);
  if (!data || !Array.isArray(data.result) || data.result.length === 0) {
    return syntheticFeatures({ hasHistory: false });
  }

  const txs = data.result;

  const nowSec = Math.floor(Date.now() / 1000);
  const firstTs = Number(txs[0].timeStamp || txs[0].timestamp || nowSec);
  const lastTs = Number(
    txs[txs.length - 1].timeStamp || txs[txs.length - 1].timestamp || nowSec
  );

  const ageDays = Math.max(0, (nowSec - firstTs) / 86400);
  const activeDays = Math.max(1, (lastTs - firstTs) / 86400);
  const txCount = txs.length;
  const txPerDay = txCount / activeDays;

  // Very coarse burst metric: max txs in 1-hour buckets / median
  const burstScore = estimateBurstScore(txs);

  // Counterparty mix
  const cpStats = computeCounterpartyStats(address, txs);

  // Neighbor proxies (for now just derived from mix)
  const neighborCount = cpStats.uniqueCounterparties;
  const highRiskNeighborRatio = 0; // will be filled by future lists crawl
  const sanctionedNeighborRatio = 0;
  const dormantNeighborRatio = 0;

  return {
    ageDays,
    firstSeenMs: firstTs * 1000,
    txCount,
    activeDays,
    txPerDay,
    burstScore,
    uniqueCounterparties: cpStats.uniqueCounterparties,
    topCounterpartyShare: cpStats.topShare,
    isDormant: false,
    dormantDays: 0,
    resurrectedRecently: false,
    neighborCount,
    sanctionedNeighborRatio,
    highRiskNeighborRatio,
    dormantNeighborRatio,
    mixerProximity: 0,
    custodianExposure: 0,
    scamPlatformExposure: 0
  };
}

/* ============= HELPERS ========================================= */

function syntheticFeatures(opts = {}) {
  if (opts.hasHistory === false) {
    // Brand-new wallet
    return {
      ageDays: 0,
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
      scamPlatformExposure: 0
    };
  }

  // Historical synthetic baseline (matches what you were seeing before)
  return {
    ageDays: 1309,
    firstSeenMs: null,
    txCount: 809,
    activeDays: 30,
    txPerDay: 26.97,
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
    scamPlatformExposure: 0.49
  };
}

function estimateBurstScore(txs) {
  if (!Array.isArray(txs) || txs.length < 5) return 0;
  const buckets = new Map();
  for (const t of txs) {
    const ts = Number(t.timeStamp || t.timestamp || 0);
    if (!ts) continue;
    const hour = Math.floor(ts / 3600);
    buckets.set(hour, (buckets.get(hour) || 0) + 1);
  }
  const counts = [...buckets.values()];
  if (!counts.length) return 0;
  counts.sort((a, b) => a - b);
  const max = counts[counts.length - 1];
  const median = counts[Math.floor(counts.length / 2)] || 1;
  const ratio = max / Math.max(1, median);
  return Math.max(0, Math.min(1, (ratio - 1) / 9)); // 1→0, 10→1
}

function computeCounterpartyStats(address, txs) {
  const self = address.toLowerCase();
  const counts = new Map();
  for (const t of txs) {
    const from = String(t.from || '').toLowerCase();
    const to = String(t.to || '').toLowerCase();
    let cp = null;
    if (from === self && to && to !== self) cp = to;
    else if (to === self && from && from !== self) cp = from;
    if (!cp) continue;
    counts.set(cp, (counts.get(cp) || 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const unique = counts.size;
  let topShare = 0;
  if (total > 0) {
    const max = Math.max(...counts.values());
    topShare = max / total;
  }
  return { uniqueCounterparties: unique, topShare };
}

function buildAddressSetsFromEnv(env) {
  const ofacSet = parseAddressSet(env.OFAC_SET || env.OFACLIST);
  const scamSet = parseAddressSet(env.SCAM_CLUSTERS);
  const tornadoSet = parseAddressSet(env.TORNADO_SET);
  return { ofacSet, scamSet, tornadoSet };
}

function parseAddressSet(raw) {
  const set = new Set();
  if (!raw || typeof raw !== 'string') return set;

  const txt = raw.trim();

  // If it looks like JSON, try that first
  if ((txt.startsWith('[') && txt.endsWith(']')) || (txt.startsWith('{') && txt.endsWith('}'))) {
    try {
      const parsed = JSON.parse(txt);
      if (Array.isArray(parsed)) {
        for (const x of parsed) {
          const addr = String(x || '').toLowerCase();
          if (addr.startsWith('0x') && addr.length >= 10) set.add(addr);
        }
        return set;
      }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.addresses)) {
        for (const x of parsed.addresses) {
          const addr = String(x || '').toLowerCase();
          if (addr.startsWith('0x') && addr.length >= 10) set.add(addr);
        }
        return set;
      }
    } catch (_e) {
      // fall through to splitter
    }
  }

  // Otherwise treat as CSV / newline / whitespace list
  const parts = txt
    .split(/[\s,;]+/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.startsWith('0x') && p.length >= 10);

  for (const p of parts) set.add(p);
  return set;
}

function mkPseudoAddress(seed, idx) {
  // cheap deterministic child address
  const base = seed.replace(/^0x/, '');
  const suffix = idx.toString(16).padStart(4, '0');
  return '0x' + (base + suffix).slice(0, 40);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,OPTIONS'
    }
  });
}