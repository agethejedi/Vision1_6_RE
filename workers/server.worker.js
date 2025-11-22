// server.worker.js — RiskXLabs Vision API v1.6.1
// Routes:
//   GET /                → health
//   GET /score           → risk scoring (with OFAC / scam / mixer overlays)
//   GET /txs             → stub tx summary
//   GET /neighbors       → stub neighbor graph
//
// Environment variables expected (Cloudflare Dashboard → Settings → Variables):
//   OFAC_SET       (plaintext)  - newline/comma/space-separated addresses
//   SCAM_CLUSTERS  (plaintext)  - Tokenlon, scam platforms, etc
//   TORNADO_SET    (plaintext)  - Tornado / mixer addresses
//
// Optionally (future / real data):
//   ALCHEMY_API_KEY, ETHERSCAN_API_KEY, CHAINALYSIS_SANCTIONS_API, SCORECHAIN_API_KEY

const VERSION = 'RXL-V1.6.1';

/* ====================== Core fetch handler ======================= */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    try {
      const sets = buildEnvSets(env);

      if (path === '/' || path === '/health') {
        return cors(json({
          ok: true,
          service: 'riskxlabs-vision-api',
          version: VERSION
        }));
      }

      if (path === '/score') {
        const res = await handleScore(url, env, sets);
        return cors(json(res));
      }

      if (path === '/txs') {
        const res = await handleTxs(url, env);
        return cors(json(res));
      }

      if (path === '/neighbors') {
        const res = await handleNeighbors(url, env);
        return cors(json(res));
      }

      return cors(json({ ok: false, error: 'Not found' }, 404));

    } catch (err) {
      console.error('[worker] fatal', err);
      return cors(json({ ok: false, error: String(err?.message || err) }, 500));
    }
  }
};

/* ====================== /score handler =========================== */

async function handleScore(url, env, sets) {
  const addressRaw = url.searchParams.get('address') || url.searchParams.get('addr');
  const network = (url.searchParams.get('network') || 'eth').toLowerCase();
  if (!addressRaw) {
    return { ok: false, error: 'missing address', status: 400 };
  }

  const address = String(addressRaw).toLowerCase();

  // --- 1) Base heuristic score (stubbed for now, but deterministic) ----
  // In a later sprint we’ll replace this with real on-chain data.
  let base = heuristicScore(address, network);

  // --- 2) Overlay sanctions / scam / mixer lists ----------------------
  base = applyListOverlays(base, address, sets);

  return base;
}

/* ====================== /txs handler (stub) ====================== */

async function handleTxs(url, env) {
  const addressRaw = url.searchParams.get('address') || url.searchParams.get('addr');
  const network = (url.searchParams.get('network') || 'eth').toLowerCase();
  const address = String(addressRaw || '').toLowerCase();

  // Stub: one very old tx so ageDays > 0 and Vision can compute age.
  // Shape matches the expectation of fetchAgeDays in visionRisk.worker.js.
  const now = Date.now();
  const twoYearsMs = 365 * 2 * 24 * 3600 * 1000;
  const tsMs = now - twoYearsMs;

  return {
    ok: true,
    network,
    address,
    result: [
      {
        hash: '0xstubtx',
        timeStamp: Math.floor(tsMs / 1000),
        raw: {
          metadata: {
            blockTimestamp: new Date(tsMs).toISOString()
          }
        }
      }
    ]
  };
}

/* ====================== /neighbors handler (stub) ================ */

async function handleNeighbors(url, env) {
  const addressRaw = url.searchParams.get('address') || url.searchParams.get('addr');
  const network = (url.searchParams.get('network') || 'eth').toLowerCase();
  const addr = String(addressRaw || '').toLowerCase();

  const limit = Number(url.searchParams.get('limit') || '40');
  const count = Math.max(8, Math.min(limit, 40));

  const nodes = [];
  const links = [];

  // Center node
  nodes.push({ id: addr, address: addr, network });

  // Simple radial fan-out around center, deterministic per address
  let seed = hashToSeed(addr);
  for (let i = 0; i < count; i++) {
    seed = lcg(seed);
    const id = pseudoAddress(seed);
    nodes.push({ id, address: id, network });
    links.push({ a: addr, b: id, weight: 1 });
  }

  console.log('[worker] neighbors(final)', {
    addr,
    totalNeighbors: count,
    shown: count,
    overflow: 0
  });

  return { nodes, links };
}

/* ====================== Heuristic risk model (stub) ============== */

// This is the same “28-point wallet” style you’ve been seeing.
// It gives Vision the right shape: { risk_score, reasons, feats, explain }.
// In later sprints we’ll replace this with real tx + neighbor analytics.

function heuristicScore(address, network) {
  // Fixed features so scores are deterministic and stable.
  const ageDays = 1309;
  const txCount = 809;
  const activeDays = 30;
  const txPerDay = txCount / activeDays;
  const burstScore = 0.51;
  const uniqueCounterparties = 10;
  const topCounterpartyShare = 0.02;

  const neighborCount = 9;
  const sanctionedNeighborRatio = 0.28;
  const highRiskNeighborRatio = 0.32;
  const dormantNeighborRatio = 0.0;
  const mixerProximity = 0.42;
  const custodianExposure = 0.38;
  const scamPlatformExposure = 0.49;

  const reasons = [
    'Transaction velocity & bursts',
    'Wallet age',
    'Neighbor & cluster risk',
    'Counterparty mix & concentration'
  ];

  const feats = {
    ageDays,
    firstSeenMs: null,
    txCount,
    activeDays,
    txPerDay,
    burstScore,
    uniqueCounterparties,
    topCounterpartyShare,
    isDormant: false,
    dormantDays: 0,
    resurrectedRecently: false,
    neighborCount,
    sanctionedNeighborRatio,
    highRiskNeighborRatio,
    dormantNeighborRatio,
    mixerProximity,
    custodianExposure,
    scamPlatformExposure,
    local: {
      riskyNeighborRatio: highRiskNeighborRatio,
      neighborAvgTx: txPerDay,
      neighborAvgAgeDays: ageDays
    }
  };

  // Very simple rule ensemble → 28
  const baseScore = 15;
  const rawContribution = 13;
  const score = baseScore + rawContribution;

  const explain = {
    version: VERSION,
    address,
    network,
    baseScore,
    rawContribution,
    score,
    confidence: 1,
    parts: {
      age: {
        id: 'age',
        label: 'Wallet age',
        impact: -10,
        details: { ageDays, bucket: '> 2 years' }
      },
      velocity: {
        id: 'velocity',
        label: 'Transaction velocity & bursts',
        impact: 20,
        details: { txPerDay, burstScore, bucket: 'extreme' }
      },
      mix: {
        id: 'mix',
        label: 'Counterparty mix & concentration',
        impact: -2,
        details: {
          uniqueCounterparties,
          topCounterpartyShare,
          bucket: 'diversified'
        }
      },
      concentration: {
        id: 'concentration',
        label: 'Flow concentration (fan-in/out)',
        impact: 0,
        details: {}
      },
      dormant: {
        id: 'dormant',
        label: 'Dormancy & resurrection patterns',
        impact: 0,
        details: {
          isDormant: false,
          dormantDays: 0,
          resurrectedRecently: false
        }
      },
      neighbor: {
        id: 'neighbor',
        label: 'Neighbor & cluster risk',
        impact: 5,
        details: {
          neighborCount,
          sanctionedNeighborRatio,
          highRiskNeighborRatio,
          mixedCluster: true
        }
      },
      lists: {
        id: 'lists',
        label: 'External fraud & platform signals',
        impact: 0,
        details: {}
      },
      governance: {
        id: 'governance',
        label: 'Governance / override',
        impact: 0,
        details: {}
      }
    },
    feats,
    signals: {
      ofacHit: false,
      chainabuse: false,
      caFraud: false,
      scamPlatform: false,
      mixer: false,
      custodian: false,
      unifiedSanctions: null,
      chainalysis: null,
      scorechain: null
    },
    notes: []
  };

  return {
    address,
    network,
    risk_score: score,
    reasons: [...reasons],
    risk_factors: [...reasons],
    block: false,
    sanctionHits: null,
    feats,
    explain
  };
}

/* ====================== List overlays (OFAC / scam / mixer) ===== */

function applyListOverlays(base, address, sets) {
  const addr = String(address || '').toLowerCase();

  const reasons = new Set(base.reasons || base.risk_factors || []);
  const explain = base.explain || {};
  const signals = explain.signals || {};
  let score = typeof base.risk_score === 'number'
    ? base.risk_score
    : (typeof base.score === 'number' ? base.score : 0);
  let block = !!base.block;
  let sanctionHits = base.sanctionHits || null;

  // 1) Hard OFAC / sanctions list
  if (sets.ofac.has(addr)) {
    block = true;
    signals.ofacHit = true;
    sanctionHits = (sanctionHits || 0) + 1;
    reasons.add('OFAC / sanctions list match');
    score = 100; // force to max
  }

  // 2) Tornado / mixer exposure
  if (sets.tornado.has(addr)) {
    signals.mixer = true;
    reasons.add('Mixer or Tornado Cash exposure');
    if (!block) {
      score = Math.max(score, 80);
    }
  }

  // 3) Scam platform / cluster (incl. Tokenlon)
  if (sets.scam.has(addr)) {
    signals.scamPlatform = true;
    reasons.add('Scam-associated platform / cluster');
    if (!block) {
      score = Math.max(score, 70);
    }
  }

  explain.signals = signals;

  const out = {
    ...base,
    risk_score: score,
    score,
    block,
    sanctionHits,
    reasons: Array.from(reasons),
    risk_factors: Array.from(reasons),
    explain
  };

  return out;
}

/* ====================== Env parsing helpers ====================== */

function buildEnvSets(env = {}) {
  return {
    ofac: buildLowercaseSet(env.OFAC_SET),
    scam: buildLowercaseSet(env.SCAM_CLUSTERS),
    tornado: buildLowercaseSet(env.TORNADO_SET)
  };
}

function buildLowercaseSet(raw) {
  if (!raw) return new Set();
  return new Set(
    String(raw)
      .split(/[\s,]+/)
      .map(x => x.trim().toLowerCase())
      .filter(Boolean)
  );
}

/* ====================== Utility helpers ========================= */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function cors(resp) {
  const headers = new Headers(resp.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(resp.body, { status: resp.status, headers });
}

/* ----- tiny PRNG helpers for deterministic stub neighbors -------- */

function hashToSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function lcg(seed) {
  return (1664525 * seed + 1013904223) >>> 0;
}

function pseudoAddress(seed) {
  // Make a pseudo 40-hex address from a 32-bit seed
  const hex = (seed >>> 0).toString(16).padStart(8, '0');
  const repeated = (hex + hex + hex + hex + hex + hex).slice(0, 40);
  return '0x' + repeated;
}
