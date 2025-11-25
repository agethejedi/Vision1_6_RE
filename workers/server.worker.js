// workers/server.worker.js
// RiskXLabs Vision API v1.6.4
// - /score      → address risk score + features
// - /neighbors  → simple neighbor graph for Vision
// Uses: Etherscan + Alchemy hybrid, OFAC / Scam / Tornado lists from KV-style secrets.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response('ok', { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/score') {
        return await handleScore(url, env);
      }
      if (path === '/neighbors') {
        return await handleNeighbors(url, env);
      }
      if (path === '/tx-debug') {
        return await handleTxDebug(url, env);
      }
      if (path === '/neighbors-debug') {
        return await handleNeighborsDebug(url, env);
      }

      return json({ ok: true, service: 'riskxlabs-vision-api', version: '1.6.4' });
    } catch (err) {
      console.error('[VisionAPI] unhandled error', err);
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  }
};

/* ========================= CORE HELPERS ========================== */

function normHex(addr) {
  if (!addr) return null;
  const s = String(addr).trim().toLowerCase();
  return s && s.startsWith('0x') ? s : null;
}

function parseHexSet(raw) {
  const out = new Set();
  if (!raw) return out;

  const txt = String(raw).trim();

  // JSON array
  if (txt.startsWith('[')) {
    try {
      const arr = JSON.parse(txt);
      for (const v of arr) {
        const a = normHex(v);
        if (a) out.add(a);
      }
      return out;
    } catch (e) {
      console.warn('[VisionAPI] parseHexSet JSON failed, falling back to split');
    }
  }

  // Delimited text
  txt
    .split(/[\s,;\n\r]+/)
    .map(normHex)
    .filter(Boolean)
    .forEach((a) => out.add(a));

  return out;
}

/* ========================= TX FETCH (HYBRID) ===================== */

/**
 * Normalized tx object:
 * { hash, from, to, value, time }  // time in seconds (number)
 */
async function fetchTxHistoryHybrid(address, network, env) {
  const center = normHex(address);
  if (!center) throw new Error('Invalid address');

  if (network !== 'eth') {
    // For now we only support Ethereum mainnet neighbors.
    return { provider: 'synthetic', txs: [] };
  }

  let txs = [];
  let provider = null;

  // ---- 1) Etherscan first ---------------------------------------
  if (env.ETHERSCAN_API_KEY) {
    try {
      const key = env.ETHERSCAN_API_KEY;

      async function fetchEtherscan(action) {
        const u = `https://api.etherscan.io/api?module=account&action=${action}` +
                  `&address=${center}&startblock=0&endblock=99999999&sort=asc&apikey=${key}`;
        const r = await fetch(u);
        if (!r.ok) throw new Error(`etherscan ${action} HTTP ${r.status}`);
        const j = await r.json();
        if (j.status !== '1' || !Array.isArray(j.result)) return [];
        return j.result;
      }

      const [normal, internal, token] = await Promise.all([
        fetchEtherscan('txlist'),
        fetchEtherscan('txlistinternal'),
        fetchEtherscan('tokentx'),
      ]);

      const all = [];

      function pushFromEtherscan(list, kind) {
        for (const t of list || []) {
          const from = normHex(t.from);
          const to = normHex(t.to || t.contractAddress);
          const ts = Number(t.timeStamp || t.time || 0) || 0;
          all.push({
            hash: t.hash || `${kind}:${t.transactionHash || '0x'}`,
            from: from || center,
            to: to || center,
            value: String(t.value ?? '0'),
            time: ts,
          });
        }
      }

      pushFromEtherscan(normal, 'normal');
      pushFromEtherscan(internal, 'internal');
      pushFromEtherscan(token, 'token');

      if (all.length) {
        all.sort((a, b) => a.time - b.time);
        txs = all;
        provider = 'etherscan';
      }
    } catch (e) {
      console.warn('[VisionAPI] Etherscan fetch failed', e);
    }
  }

  // ---- 2) Alchemy fallback ---------------------------------------
  if (!txs.length && env.ALCHEMY_API_KEY && network === 'eth') {
    try {
      const key = env.ALCHEMY_API_KEY;
      const rpc = `https://eth-mainnet.g.alchemy.com/v2/${key}`;

      async function alchemyTransfers(body) {
        const r = await fetch(rpc, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`alchemy HTTP ${r.status}`);
        const j = await r.json();
        return j.result?.transfers || [];
      }

      const baseBody = {
        id: 1,
        jsonrpc: '2.0',
        method: 'alchemy_getAssetTransfers',
        params: [{
          category: ['external', 'erc20', 'erc721', 'erc1155'],
          maxCount: '0x3e8', // 1000
          withMetadata: true,
        }],
      };

      const [outbound, inbound] = await Promise.all([
        alchemyTransfers({
          ...baseBody,
          params: [{ ...baseBody.params[0], fromAddress: center }],
        }),
        alchemyTransfers({
          ...baseBody,
          params: [{ ...baseBody.params[0], toAddress: center }],
        }),
      ]);

      const seen = new Set();
      const all = [];

      function pushAl(list, dir) {
        for (const t of list || []) {
          const hash = t.hash || t.transactionHash || `${dir}:${t.uniqueId}`;
          if (seen.has(hash)) continue;
          seen.add(hash);

          const from = normHex(t.from) || center;
          const to = normHex(t.to) || center;
          const ts = Number(t.metadata?.blockTimestamp ? Date.parse(t.metadata.blockTimestamp) / 1000 : 0) || 0;
          all.push({
            hash,
            from,
            to,
            value: String(t.value ?? '0'),
            time: ts,
          });
        }
      }

      pushAl(outbound, 'out');
      pushAl(inbound, 'in');

      if (all.length) {
        all.sort((a, b) => a.time - b.time);
        txs = all;
        provider = 'alchemy';
      }
    } catch (e) {
      console.warn('[VisionAPI] Alchemy fetch failed', e);
    }
  }

  // ---- 3) Synthetic fallback -------------------------------------
  if (!txs.length) {
    const now = Math.floor(Date.now() / 1000);
    txs = [{
      hash: '0xsynthetic',
      from: center,
      to: center,
      value: '0',
      time: now,
    }];
    provider = 'synthetic';
  }

  return { provider, txs };
}

/* ========================= NEIGHBOR BUILD ======================== */

function buildNeighborStats(address, txs, ctxLists) {
  const center = normHex(address);
  const counts = new Map();

  for (const t of txs) {
    const from = normHex(t.from);
    const to = normHex(t.to);
    if (!from || !to) continue;

    if (from === center && to !== center) {
      counts.set(to, (counts.get(to) || 0) + 1);
    } else if (to === center && from !== center) {
      counts.set(from, (counts.get(from) || 0) + 1);
    }
  }

  const neighbors = [...counts.keys()];
  const neighborCount = neighbors.length;

  let sanctionedNeighbors = 0;
  let mixerNeighbors = 0;
  let scamNeighbors = 0;

  for (const n of neighbors) {
    if (ctxLists.ofacSet.has(n)) sanctionedNeighbors++;
    if (ctxLists.tornadoSet.has(n)) mixerNeighbors++;
    if (ctxLists.scamSet.has(n)) scamNeighbors++;
  }

  const highRiskNeighbors = sanctionedNeighbors + mixerNeighbors + scamNeighbors;

  const featsLocal = {
    neighborCount,
    riskyNeighborRatio: neighborCount ? highRiskNeighbors / neighborCount : 0,
    neighborAvgTx: neighborCount
      ? [...counts.values()].reduce((a, b) => a + b, 0) / neighborCount
      : 0,
    neighborAvgAgeDays: null, // could compute later with per-neighbor lookups
  };

  return {
    neighbors,
    counts,
    sanctionedNeighbors,
    mixerNeighbors,
    scamNeighbors,
    featsLocal,
  };
}

/* ========================= RISK MODEL (INLINE) =================== */

function runRiskModel(address, network, txs, neighborCtx, lists) {
  const addr = normHex(address);

  const nowSec = Date.now() / 1000;
  const times = txs.map(t => t.time || 0).filter(Boolean);
  const firstTs = times.length ? Math.min(...times) : nowSec;
  const lastTs = times.length ? Math.max(...times) : nowSec;

  const ageDays = Math.max(0, (nowSec - firstTs) / 86400);
  const activeDays = Math.max(1, (lastTs - firstTs) / 86400);
  const txCount = txs.length;
  const txPerDay = txCount / activeDays;

  // Flow concentration: share of most-common counterparty
  const counter = new Map();
  for (const t of txs) {
    const from = normHex(t.from);
    const to = normHex(t.to);
    if (from === addr && to && to !== addr) {
      counter.set(to, (counter.get(to) || 0) + 1);
    } else if (to === addr && from && from !== addr) {
      counter.set(from, (counter.get(from) || 0) + 1);
    }
  }
  const uniqueCounterparties = counter.size;
  const maxFlows = uniqueCounterparties
    ? Math.max(...counter.values())
    : 0;
  const topCounterpartyShare = uniqueCounterparties
    ? maxFlows / txCount
    : 0;

  // Simple burst metric: max daily tx vs avg
  const perDay = new Map();
  for (const t of txs) {
    const d = Math.floor((t.time || nowSec) / 86400);
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  const maxDay = perDay.size ? Math.max(...perDay.values()) : 0;
  const avgDay = perDay.size ? txCount / perDay.size : 0;
  const burstScore = avgDay ? Math.min(1, maxDay / (avgDay * 3)) : 0;

  const feats = {
    ageDays,
    firstSeenMs: firstTs * 1000,
    txCount,
    activeDays,
    txPerDay,
    burstScore,
    uniqueCounterparties,
    topCounterpartyShare,
    isDormant: false,
    dormantDays: 0,
    resurrectedRecently: false,
    neighborCount: neighborCtx.featsLocal.neighborCount,
    sanctionedNeighborRatio: neighborCtx.featsLocal.neighborCount
      ? neighborCtx.sanctionedNeighbors / neighborCtx.featsLocal.neighborCount
      : 0,
    highRiskNeighborRatio: neighborCtx.featsLocal.riskyNeighborRatio,
    dormantNeighborRatio: 0,
    mixerProximity: neighborCtx.mixerNeighbors > 0 ? 0.8 : 0,
    custodianExposure: 0,
    scamPlatformExposure: neighborCtx.scamNeighbors > 0 ? 0.7 : 0,
    local: neighborCtx.featsLocal,
  };

  /* --------- scoring contributions ------------------------ */

  let baseScore = 15;
  let rawContribution = 0;
  const parts = {};

  // Wallet age
  let ageImpact = 0;
  let ageBucket = '> 2 years';
  if (ageDays < 7) {
    ageImpact = 25;
    ageBucket = '< 1 week';
  } else if (ageDays < 180) {
    ageImpact = 10;
    ageBucket = '1w–6m';
  } else if (ageDays < 730) {
    ageImpact = 2;
    ageBucket = '6m–2y';
  } else {
    ageImpact = -10;
    ageBucket = '> 2 years';
  }
  rawContribution += ageImpact;
  parts.age = {
    id: 'age',
    label: 'Wallet age',
    impact: ageImpact,
    details: { ageDays, bucket: ageBucket },
  };

  // Velocity
  let velImpact = 0;
  let velBucket = 'normal';
  if (txPerDay > 50 || burstScore > 0.8) {
    velImpact = 22;
    velBucket = 'extreme';
  } else if (txPerDay > 10 || burstScore > 0.6) {
    velImpact = 14;
    velBucket = 'elevated';
  } else if (txPerDay > 1 || burstScore > 0.3) {
    velImpact = 6;
    velBucket = 'active';
  }
  rawContribution += velImpact;
  parts.velocity = {
    id: 'velocity',
    label: 'Transaction velocity & bursts',
    impact: velImpact,
    details: { txPerDay, burstScore, bucket: velBucket },
  };

  // Mix / concentration
  let mixImpact = 0;
  let mixBucket = 'diversified';
  if (uniqueCounterparties <= 2 && topCounterpartyShare >= 0.8 && txCount >= 10) {
    mixImpact = 14;
    mixBucket = 'concentrated';
  } else if (uniqueCounterparties <= 5 && topCounterpartyShare >= 0.6) {
    mixImpact = 6;
    mixBucket = 'moderate concentration';
  }
  rawContribution += mixImpact;
  parts.mix = {
    id: 'mix',
    label: 'Counterparty mix & concentration',
    impact: mixImpact,
    details: { uniqueCounterparties, topCounterpartyShare, bucket: mixBucket },
  };

  // Neighbor risk
  let neighborImpact = 0;
  const { featsLocal, sanctionedNeighbors, mixerNeighbors, scamNeighbors } = neighborCtx;
  const mixedCluster =
    sanctionedNeighbors + mixerNeighbors + scamNeighbors > 0 &&
    featsLocal.neighborCount > 0;

  if (featsLocal.neighborCount > 0) {
    if (featsLocal.riskyNeighborRatio >= 0.5) {
      neighborImpact = 18;
    } else if (featsLocal.riskyNeighborRatio >= 0.25) {
      neighborImpact = 10;
    } else if (featsLocal.neighborCount >= 10) {
      neighborImpact = 4;
    }
  }
  rawContribution += neighborImpact;
  parts.neighbor = {
    id: 'neighbor',
    label: 'Neighbor & cluster risk',
    impact: neighborImpact,
    details: {
      neighborCount: featsLocal.neighborCount,
      sanctionedNeighborRatio: feats.sanctionedNeighborRatio,
      highRiskNeighborRatio: feats.highRiskNeighborRatio,
      mixedCluster,
    },
  };

  // Dormancy placeholder
  parts.dormant = {
    id: 'dormant',
    label: 'Dormancy & resurrection patterns',
    impact: 0,
    details: {
      isDormant: false,
      dormantDays: feats.dormantDays,
      resurrectedRecently: false,
    },
  };

  // External lists (OFAC, Tornado, Scam cluster)
  let listsImpact = 0;
  const listDetails = {};
  let sanctionHits = 0;
  let block = false;

  if (lists.ofacSet.has(addr)) {
    listsImpact += 70;
    listDetails.ofac = true;
    sanctionHits = 1;
    block = true;
  }
  if (lists.tornadoSet.has(addr)) {
    listsImpact += 25;
    listDetails.tornado = true;
  }
  if (lists.scamSet.has(addr)) {
    listsImpact += 35;
    listDetails.scamCluster = true;
  }

  // Tornado + Scam combo → strong boost (~75–90 total)
  if (listDetails.tornado && listDetails.scamCluster) {
    listsImpact += 15; // pushes many combos into 80–90 range
  }

  rawContribution += listsImpact;
  parts.lists = {
    id: 'lists',
    label: 'External fraud & platform signals',
    impact: listsImpact,
    details: listDetails,
  };

  // Governance placeholder
  parts.governance = {
    id: 'governance',
    label: 'Governance / override',
    impact: 0,
    details: {},
  };

  const score = Math.max(0, Math.min(100, baseScore + rawContribution));

  const reasons = [];
  const risk_factors = [];

  if (ageImpact > 0) { reasons.push('Wallet age'); risk_factors.push('Wallet age'); }
  if (velImpact > 0) { reasons.push('Transaction velocity & bursts'); risk_factors.push('Transaction velocity & bursts'); }
  if (mixImpact > 0) { reasons.push('Counterparty mix & concentration'); risk_factors.push('Counterparty mix & concentration'); }
  if (neighborImpact > 0) { reasons.push('Neighbor & cluster risk'); risk_factors.push('Neighbor & cluster risk'); }
  if (listsImpact > 0) { reasons.push('OFAC / sanctions list match'); risk_factors.push('OFAC / sanctions list match'); }

  const explain = {
    version: 'RXL-V1.6.4',
    address: addr,
    network,
    baseScore,
    rawContribution,
    score,
    confidence: 1,
    parts,
    feats,
    signals: {
      ofacHit: !!listDetails.ofac,
      chainabuse: false,
      caFraud: false,
      scamPlatform: !!listDetails.scamCluster,
      mixer: !!listDetails.tornado,
      custodian: false,
      unifiedSanctions: null,
      chainalysis: null,
      scorechain: null,
    },
    notes: [],
  };

  return {
    address: addr,
    network,
    risk_score: score,
    score,
    reasons,
    risk_factors,
    block,
    sanctionHits,
    feats,
    explain,
  };
}

/* ========================= ROUTES =============================== */

async function handleScore(url, env) {
  const address = url.searchParams.get('address');
  const network = url.searchParams.get('network') || 'eth';

  const addr = normHex(address);
  if (!addr) {
    return json({ ok: false, error: 'Missing or invalid address' }, 400);
  }

  const lists = {
    ofacSet: parseHexSet(env.OFAC_SET),
    scamSet: parseHexSet(env.SCAM_CLUSTERS),
    tornadoSet: parseHexSet(env.TORNADO_SET),
  };

  const { provider, txs } = await fetchTxHistoryHybrid(addr, network, env);
  const neighborCtx = buildNeighborStats(addr, txs, lists);

  const scored = runRiskModel(addr, network, txs, neighborCtx, lists);
  return json(scored);
}

async function handleNeighbors(url, env) {
  const address = url.searchParams.get('address');
  const network = url.searchParams.get('network') || 'eth';
  const hop = Number(url.searchParams.get('hop') || '1') || 1;
  const limit = Number(url.searchParams.get('limit') || '120') || 120;

  const addr = normHex(address);
  if (!addr) {
    return json({ ok: false, error: 'Missing or invalid address' }, 400);
  }

  const lists = {
    ofacSet: parseHexSet(env.OFAC_SET),
    scamSet: parseHexSet(env.SCAM_CLUSTERS),
    tornadoSet: parseHexSet(env.TORNADO_SET),
  };

  const { provider, txs } = await fetchTxHistoryHybrid(addr, network, env);
  const neighborCtx = buildNeighborStats(addr, txs, lists);

  const neighbors = neighborCtx.neighbors;
  const capped = neighbors.slice(0, Math.max(1, limit | 0));

  const nodes = [
    { id: addr, address: addr, network },
    ...capped.map((n) => ({ id: n, address: n, network })),
  ];

  const links = capped.map((n) => ({
    a: addr,
    b: n,
    weight: neighborCtx.counts.get(n) || 1,
  }));

  return json({ nodes, links, provider, totalNeighbors: neighbors.length });
}

/* ============ Debug routes (optional, but handy) ================= */

async function handleTxDebug(url, env) {
  const address = url.searchParams.get('address');
  const network = url.searchParams.get('network') || 'eth';
  const addr = normHex(address);
  if (!addr) return json({ ok: false, error: 'Missing or invalid address' }, 400);

  const { provider, txs } = await fetchTxHistoryHybrid(addr, network, env);
  return json({ ok: true, provider, count: txs.length, sample: txs.slice(0, 25) });
}

async function handleNeighborsDebug(url, env) {
  const address = url.searchParams.get('address');
  const network = url.searchParams.get('network') || 'eth';
  const addr = normHex(address);
  if (!addr) return json({ ok: false, error: 'Missing or invalid address' }, 400);

  const lists = {
    ofacSet: parseHexSet(env.OFAC_SET),
    scamSet: parseHexSet(env.SCAM_CLUSTERS),
    tornadoSet: parseHexSet(env.TORNADO_SET),
  };

  const { provider, txs } = await fetchTxHistoryHybrid(addr, network, env);
  const neighborCtx = buildNeighborStats(addr, txs, lists);

  return json({
    ok: true,
    provider,
    neighborCount: neighborCtx.featsLocal.neighborCount,
    sanctionedNeighbors: neighborCtx.sanctionedNeighbors,
    mixerNeighbors: neighborCtx.mixerNeighbors,
    scamNeighbors: neighborCtx.scamNeighbors,
    featsLocal: neighborCtx.featsLocal,
    neighbors: neighborCtx.neighbors.slice(0, 50),
  });
}
