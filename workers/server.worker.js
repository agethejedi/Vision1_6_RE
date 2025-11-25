// workers/server.worker.js
// RiskXLabs Vision API — v1.6.3
// Standalone Cloudflare Worker: scoring + neighbors + CORS

const ETHERSCAN_ENDPOINTS = {
  eth: 'https://api.etherscan.io/api',
  // You can extend here later for polygon, arbitrum, etc.
};

// ============ Utilities ============

function corsJSON(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-allow-headers': 'Content-Type',
    },
  });
}

function parseHexSet(raw) {
  if (!raw) return new Set();
  if (raw instanceof Set) return raw;
  if (Array.isArray(raw)) {
    return new Set(raw.map(x => String(x).toLowerCase()));
  }
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return new Set(arr.map(x => String(x).toLowerCase()));
    }
  } catch (_) {}
  const split = String(raw)
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean);
  return new Set(split.map(x => x.toLowerCase()));
}

function clamp(x, min = 0, max = 1) {
  return Math.max(min, Math.min(max, x));
}

// ============ Feature builder ============

function buildFeaturesFromTxs(address, txs) {
  const addr = address.toLowerCase();
  const nowMs = Date.now();

  if (!Array.isArray(txs) || !txs.length) {
    const ageDays = 365; // conservative 1y if we have nothing
    return {
      ageDays,
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
        neighborCount: 0,
      },
    };
  }

  // txs: { timeStampSec, from, to, valueWei }
  const byDay = new Map();
  const counterpartCounts = new Map();
  const tsList = [];
  let firstSeenMs = nowMs;
  let lastSeenMs = 0;
  let selfTxCount = 0;

  for (const tx of txs) {
    const tsMs = tx.timeStampSec * 1000;
    if (!Number.isFinite(tsMs)) continue;
    tsList.push(tsMs);
    if (tsMs < firstSeenMs) firstSeenMs = tsMs;
    if (tsMs > lastSeenMs) lastSeenMs = tsMs;

    const dayKey = Math.floor(tsMs / 86400000);
    byDay.set(dayKey, (byDay.get(dayKey) || 0) + 1);

    const from = String(tx.from || '').toLowerCase();
    const to = String(tx.to || '').toLowerCase();

    if (from === addr && to === addr) {
      selfTxCount++;
      continue;
    }

    const cp =
      from === addr ? to :
      to === addr ? from :
      null;

    if (cp) {
      counterpartCounts.set(cp, (counterpartCounts.get(cp) || 0) + 1);
    }
  }

  const txCount = tsList.length;
  const ageDays = (nowMs - firstSeenMs) / 86400000;
  const activeDays = byDay.size || 0;
  const txPerDay = activeDays > 0 ? txCount / activeDays : 0;

  // Burst score: ratio of max daily volume to avg
  let burstScore = 0;
  if (byDay.size > 0) {
    const counts = Array.from(byDay.values());
    const maxPerDay = Math.max(...counts);
    const avgPerDay = txCount / byDay.size;
    burstScore = clamp((maxPerDay - avgPerDay) / (avgPerDay || 1), 0, 1);
  }

  const uniqueCounterparties = counterpartCounts.size;
  let topCounterpartyShare = 0;
  if (uniqueCounterparties > 0 && txCount > 0) {
    const max = Math.max(...Array.from(counterpartCounts.values()));
    topCounterpartyShare = clamp(max / txCount, 0, 1);
  }

  // Dormancy: last activity gap vs first activity gap
  const lastDiffDays = (nowMs - lastSeenMs) / 86400000;
  const dormantDays = lastDiffDays;
  const isDormant = dormantDays > 90; // > 3 months w/out activity
  const resurrectedRecently = isDormant === false && ageDays > 180 && lastDiffDays < 30;

  // For now, neighbor-level risk proxies are filled from tx-based stats
  const neighborCount = uniqueCounterparties;

  return {
    ageDays,
    firstSeenMs,
    txCount,
    activeDays,
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
      neighborAvgTx: txCount / Math.max(1, uniqueCounterparties || 1),
      neighborAvgAgeDays: ageDays,
      neighborCount,
    },
  };
}

// ============ Risk model ============

function scoreFromFeatures(address, network, feats, flags) {
  const addr = address.toLowerCase();
  const {
    ofacSet,
    scamSet,
    tornadoSet,
  } = flags;

  const ofacHit = ofacSet.has(addr);
  const scamFlag = scamSet.has(addr);
  const tornadoFlag = tornadoSet.has(addr);

  const factorImpacts = [];
  const reasons = [];

  let baseScore = 15;
  let rawContribution = 0;

  // --- Age ---
  let ageImpact = 0;
  const d = feats.ageDays;
  let ageBucket = 'unknown';

  if (d < 7) {
    ageImpact = 25;
    ageBucket = '< 1 week';
  } else if (d < 30) {
    ageImpact = 18;
    ageBucket = '1–4 weeks';
  } else if (d < 180) {
    ageImpact = 8;
    ageBucket = '1–6 months';
  } else if (d < 365 * 2) {
    ageImpact = 2;
    ageBucket = '6m–2y';
  } else if (Number.isFinite(d)) {
    ageImpact = -8;
    ageBucket = '> 2 years';
  }

  rawContribution += ageImpact;
  factorImpacts.push({
    id: 'age',
    label: 'Wallet age',
    delta: ageImpact,
    sourceKey: 'age',
    details: { ageDays: d, bucket: ageBucket },
  });

  // --- Velocity & bursts ---
  let velImpact = 0;
  let velBucket = 'normal';

  if (feats.txPerDay >= 50 || feats.burstScore >= 0.8) {
    velImpact = 22;
    velBucket = 'extreme';
  } else if (feats.txPerDay >= 10 || feats.burstScore >= 0.5) {
    velImpact = 12;
    velBucket = 'elevated';
  } else if (feats.txPerDay >= 1 || feats.burstScore >= 0.2) {
    velImpact = 4;
    velBucket = 'mild';
  }

  rawContribution += velImpact;
  factorImpacts.push({
    id: 'velocity',
    label: 'Transaction velocity & bursts',
    delta: velImpact,
    sourceKey: 'velocity',
    details: {
      txPerDay: feats.txPerDay,
      burstScore: feats.burstScore,
      bucket: velBucket,
    },
  });

  // --- Counterparty mix & concentration ---
  let mixImpact = 0;
  let mixBucket = 'normal';

  if (feats.uniqueCounterparties <= 2 && feats.topCounterpartyShare >= 0.9) {
    mixImpact = 14;
    mixBucket = 'concentrated';
  } else if (feats.uniqueCounterparties >= 20 && feats.topCounterpartyShare <= 0.3) {
    mixImpact = -4;
    mixBucket = 'diversified';
  }

  rawContribution += mixImpact;
  factorImpacts.push({
    id: 'mix',
    label: 'Counterparty mix & concentration',
    delta: mixImpact,
    sourceKey: 'mix',
    details: {
      uniqueCounterparties: feats.uniqueCounterparties,
      topCounterpartyShare: feats.topCounterpartyShare,
      bucket: mixBucket,
    },
  });

  // --- Neighbor risk (placeholder, 0 for now) ---
  const neighborImpact = 0;
  factorImpacts.push({
    id: 'neighbor',
    label: 'Neighbor & cluster risk',
    delta: neighborImpact,
    sourceKey: 'neighbor',
    details: {
      neighborCount: feats.neighborCount,
      sanctionedNeighborRatio: feats.sanctionedNeighborRatio,
      highRiskNeighborRatio: feats.highRiskNeighborRatio,
      mixedCluster: false,
    },
  });

  // --- Lists (OFAC, Tornado, Scam clusters) ---
  let listsImpact = 0;
  let ofacImpact = 0;
  let tornadoImpact = 0;
  let scamImpact = 0;
  const listDetails = {};

  if (ofacHit) {
    ofacImpact = 70;
    listsImpact += ofacImpact;
    reasons.push('OFAC / sanctions list match');
    listDetails.ofac = true;
    factorImpacts.push({
      id: 'ofac',
      label: 'OFAC / sanctions list match',
      delta: ofacImpact,
      sourceKey: 'lists',
      details: { ofac: true },
    });
  }

  if (tornadoFlag) {
    // Mixer proximity
    tornadoImpact = 35;
    listsImpact += tornadoImpact;
    reasons.push('Mixer proximity');
    listDetails.mixer = true;
    factorImpacts.push({
      id: 'mixer',
      label: 'Mixer proximity',
      delta: tornadoImpact,
      sourceKey: 'lists',
      details: { tornado: true },
    });
  }

  if (scamFlag) {
    // Sketchy / scam cluster — serious but slightly below OFAC
    scamImpact = 45;
    listsImpact += scamImpact;
    reasons.push('Sketchy cluster pattern');
    listDetails.scamCluster = true;
    factorImpacts.push({
      id: 'scamCluster',
      label: 'Sketchy cluster pattern',
      delta: scamImpact,
      sourceKey: 'lists',
      details: { scamCluster: true },
    });
  }

  rawContribution += listsImpact;
  factorImpacts.push({
    id: 'lists',
    label: 'External fraud & platform signals',
    delta: listsImpact,
    sourceKey: 'lists',
    details: listDetails,
  });

  const rawScore = baseScore + rawContribution;
  const score = clamp(rawScore, 0, 100);
  const block = ofacHit || score >= 100;

  const explain = {
    version: 'RXL-V1.6.3',
    address: addr,
    network,
    baseScore,
    rawContribution,
    score,
    confidence: 1,
    parts: Object.fromEntries(
      factorImpacts.map(f => [
        f.id,
        {
          id: f.id,
          label: f.label,
          impact: f.delta,
          details: f.details || {},
        },
      ]),
    ),
    feats,
    signals: {
      ofacHit,
      chainabuse: false,
      caFraud: false,
      scamPlatform: scamFlag,
      mixer: tornadoFlag,
      custodian: false,
      unifiedSanctions: null,
      chainalysis: null,
      scorechain: null,
    },
    notes: [],
    factorImpacts,
  };

  const risk_factors = factorImpacts.map(f => f.label);
  const reasonsOut = reasons.length ? reasons : risk_factors;

  return {
    address: addr,
    network,
    risk_score: score,
    reasons: reasonsOut,
    risk_factors,
    block,
    sanctionHits: ofacHit ? 1 : 0,
    feats,
    explain,
    score,
  };
}

// ============ Neighbor graph ============

function buildNeighborGraph(address, txs, limit = 120) {
  const addr = address.toLowerCase();
  const nodesMap = new Map();
  const links = [];

  nodesMap.set(addr, { id: addr, address: addr, network: 'eth' });

  for (const tx of txs) {
    const from = String(tx.from || '').toLowerCase();
    const to = String(tx.to || '').toLowerCase();

    const isFrom = from === addr;
    const isTo = to === addr;
    if (!isFrom && !isTo) continue;

    const neighbor = isFrom ? to : to === addr ? from : null;
    if (!neighbor || neighbor === addr) continue;

    if (!nodesMap.has(neighbor)) {
      nodesMap.set(neighbor, { id: neighbor, address: neighbor, network: 'eth' });
    }
    links.push({ a: addr, b: neighbor, weight: 1 });
  }

  const allNodes = Array.from(nodesMap.values());

  if (allNodes.length === 1) {
    // Only center → let front-end know it's sparse; it will fall back to stub
    return { nodes: allNodes, links: [] };
  }

  const max = Math.max(1, limit | 0);
  const neighborsOnly = allNodes.slice(1, max + 1);
  const keptIds = new Set([addr, ...neighborsOnly.map(n => n.id)]);
  const prunedLinks = links.filter(L => keptIds.has(L.a) && keptIds.has(L.b));

  return {
    nodes: [allNodes[0], ...neighborsOnly],
    links: prunedLinks,
  };
}

// ============ Tx history (Etherscan primary) ============

async function fetchTxHistory(address, network, env, maxTx = 200) {
  const addr = address.toLowerCase();
  const ethersKey = env.ETHERSCAN_API_KEY;
  const base = ETHERSCAN_ENDPOINTS[network] || ETHERSCAN_ENDPOINTS.eth;

  const results = [];
  const errors = [];

  // --- Provider 1: Etherscan txlist ---
  if (ethersKey && base) {
    try {
      const url = `${base}?module=account&action=txlist&address=${addr}` +
        `&startblock=0&endblock=99999999&sort=asc&page=1&offset=${maxTx}&apikey=${ethersKey}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        errors.push(`etherscan bad status ${resp.status}`);
      } else {
        const json = await resp.json();
        if (json.status === '1' && Array.isArray(json.result)) {
          const txs = json.result.map(t => ({
            hash: t.hash,
            from: t.from,
            to: t.to,
            value: t.value,
            timeStampSec: Number(t.timeStamp || 0),
          }));
          results.push({ provider: 'etherscan', txs });
        } else {
          errors.push(`etherscan status=${json.status} message=${json.message || ''}`);
        }
      }
    } catch (e) {
      errors.push(`etherscan error ${e.message || e}`);
    }
  } else {
    errors.push('etherscan missing api key');
  }

  if (results.length) {
    return {
      ok: true,
      provider: results[0].provider,
      txs: results[0].txs,
      raw: null,
    };
  }

  // If we reach here, no provider succeeded → synthetic
  const syntheticNowSec = Math.floor(Date.now() / 1000);
  return {
    ok: false,
    provider: null,
    txs: [
      {
        timeStampSec: syntheticNowSec,
        hash: '0xsynthetic',
        from: addr,
        to: addr,
        value: '0',
      },
    ],
    raw: {
      ok: false,
      error: 'no providers succeeded; returning synthetic',
      errors,
    },
  };
}

// ============ Worker entrypoint ============

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return corsJSON({ ok: true });
    }

    const path = url.pathname.replace(/^\/+/, '');

    if (path === '' || path === 'score') {
      const address = String(url.searchParams.get('address') || '').toLowerCase();
      const network = (url.searchParams.get('network') || 'eth').toLowerCase();
      if (!address || !address.startsWith('0x') || address.length < 6) {
        return corsJSON({ ok: false, error: 'Missing or invalid address' }, 400);
      }

      // Load sets from env (names must match Cloudflare UI)
      const ofacSet = parseHexSet(env.OFAC_SET || env.OFACLIST);
      const scamSet = parseHexSet(env.SCAM_CLUSTERS);
      const tornadoSet = parseHexSet(env.TORNADO_SET);

      const txRes = await fetchTxHistory(address, network, env, 200);
      const feats = buildFeaturesFromTxs(address, txRes.txs || []);

      const scored = scoreFromFeatures(address, network, feats, {
        ofacSet,
        scamSet,
        tornadoSet,
      });

      return corsJSON(scored, 200);
    }

    if (path === 'neighbors') {
      const address = String(url.searchParams.get('address') || '').toLowerCase();
      const network = (url.searchParams.get('network') || 'eth').toLowerCase();
      const limit = Number(url.searchParams.get('limit') || 120);

      if (!address || !address.startsWith('0x')) {
        return corsJSON({ ok: false, error: 'Missing or invalid address' }, 400);
      }

      const txRes = await fetchTxHistory(address, network, env, 200);
      const graph = buildNeighborGraph(address, txRes.txs || [], limit);
      return corsJSON(graph, 200);
    }

    if (path === 'tx-debug') {
      const address = String(url.searchParams.get('address') || '').toLowerCase();
      const network = (url.searchParams.get('network') || 'eth').toLowerCase();
      if (!address || !address.startsWith('0x')) {
        return corsJSON({ ok: false, error: 'Missing or invalid address' }, 400);
      }
      const txRes = await fetchTxHistory(address, network, env, 200);
      if (!txRes.ok) {
        return corsJSON({
          ok: false,
          error: 'no providers succeeded; returning synthetic',
          provider: txRes.provider,
          raw: txRes.raw || null,
        });
      }
      return corsJSON({
        ok: true,
        provider: txRes.provider,
        sample: txRes.txs.slice(0, 5),
        count: txRes.txs.length,
      });
    }

    return corsJSON({ ok: false, error: 'Not found' }, 404);
  },
};
