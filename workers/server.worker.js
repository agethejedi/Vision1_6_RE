// server.worker.js — RiskXLabs Vision API v1.6.3
// Cloudflare Worker: scoring + neighbors + debug txs
// Uses Etherscan primary, Alchemy fallback, and your OFAC / scam / tornado sets from secrets.
//
// Expected secrets (from your screenshot):
//   ETHERSCAN_MAIN_API_KEY
//   ALCHEMY_MAIN_API_KEY
//   OFAC_ETH_WALLETS
//   SCAM_ETH_WALLETS
//   TORNADO_ETH_WALLETS

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // Basic health
      if (path === "/" || path === "/health") {
        return json({ ok: true, service: "riskxlabs-vision-api", version: "RXL-V1.6.3" });
      }

      // Risk scoring
      if (path === "/score") {
        const address = (url.searchParams.get("address") || "").toLowerCase();
        const network = (url.searchParams.get("network") || "eth").toLowerCase();
        if (!address) return json({ error: "missing address" }, 400);

        const ofacSet = parseHexSet(env.OFAC_ETH_WALLETS);
        const scamSet = parseHexSet(env.SCAM_ETH_WALLETS);
        const tornadoSet = parseHexSet(env.TORNADO_ETH_WALLETS);

        // 1) Get txs (real if possible, otherwise synthetic)
        const { txs, source } = await fetchTxs(address, network, env);

        // 2) Derive features
        const feats = deriveFeatures(address, txs);

        // 3) Apply risk model
        const scoring = scoreWallet(address, network, feats, {
          ofacSet,
          scamSet,
          tornadoSet
        });

        const base = {
          address,
          network,
          risk_score: scoring.score,
          reasons: scoring.reasons,
          risk_factors: scoring.reasons,
          block: scoring.block,
          sanctionHits: scoring.sanctionHits,
          feats: scoring.feats
        };

        const explain = {
          version: "RXL-V1.6.3",
          address,
          network,
          baseScore: scoring.meta.baseScore,
          rawContribution: scoring.meta.rawContribution,
          score: scoring.score,
          confidence: scoring.meta.confidence,
          parts: scoring.meta.parts,
          feats: scoring.feats,
          signals: scoring.signals,
          notes: scoring.meta.notes || []
        };

        return json({ ...base, explain, score: scoring.score });
      }

      // Neighbors for Vision graph
      if (path === "/neighbors") {
        const address = (url.searchParams.get("address") || "").toLowerCase();
        const network = (url.searchParams.get("network") || "eth").toLowerCase();
        const limit = Number(url.searchParams.get("limit") || "120") || 120;

        if (!address) return json({ error: "missing address" }, 400);

        const { txs } = await fetchTxs(address, network, env);
        const graph = buildNeighborsGraph(address, txs, limit);
        return json(graph);
      }

      // Debug: raw tx fetch route
      if (path === "/debug/txs") {
        const address = (url.searchParams.get("address") || "").toLowerCase();
        const network = (url.searchParams.get("network") || "eth").toLowerCase();
        if (!address) return json({ ok: false, error: "missing address" }, 400);
        const out = await fetchTxs(address, network, env, { debug: true });
        return json(out);
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (err) {
      console.error("Worker error:", err);
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  }
};

/* =================== JSON helper =================== */

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

/* =================== Secret → Set helpers =================== */

function parseHexSet(raw) {
  if (!raw) return new Set();
  // supports comma / newline separated addresses
  const parts = raw
    .split(/[\s,]+/)
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);
  return new Set(parts);
}

/* =================== TX FETCH LAYER =================== */

/**
 * Fetch transactions for an address from Etherscan, with Alchemy fallback.
 * Returns { txs, source, error? }.
 */
async function fetchTxs(address, network, env, { debug = false } = {}) {
  // For now we only support mainnet ETH
  if (network !== "eth") {
    return { txs: [], source: "unsupported-network" };
  }

  const etherscanKey = env.ETHERSCAN_MAIN_API_KEY;
  const alchemyKey = env.ALCHEMY_MAIN_API_KEY;

  // 1) Try Etherscan
  if (etherscanKey) {
    try {
      const esUrl =
        `https://api.etherscan.io/api` +
        `?module=account&action=txlist` +
        `&address=${encodeURIComponent(address)}` +
        `&startblock=0&endblock=99999999&sort=asc&apikey=${encodeURIComponent(etherscanKey)}`;

      const r = await fetch(esUrl);
      if (r.ok) {
        const json = await r.json();
        if (json.status === "1" && Array.isArray(json.result)) {
          const txs = json.result;
          if (debug) {
            return { ok: true, provider: "etherscan", raw: txs.slice(0, 20) };
          }
          return { txs, source: "etherscan" };
        }
      }
    } catch (e) {
      console.warn("[txs] etherscan failed:", e);
    }
  }

  // 2) Try Alchemy (very simple fallback using eth_getLogs as a stand-in)
  if (alchemyKey) {
    try {
      const rpcUrl = `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`;
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getLogs",
        params: [
          {
            address: address,
            fromBlock: "0x0",
            toBlock: "latest"
          }
        ]
      };

      const r = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });

      if (r.ok) {
        const json = await r.json();
        if (Array.isArray(json.result)) {
          // logs aren't full tx objects, but we can treat them as pseudo-tx for age/velocity
          const logs = json.result;
          if (debug) {
            return { ok: true, provider: "alchemy-logs", raw: logs.slice(0, 20) };
          }
          const txs = logs.map((log) => ({
            timeStamp: log.timeStamp || null,
            from: log.topics?.[1] || address,
            to: log.address || address,
            value: "0"
          }));
          return { txs, source: "alchemy-logs" };
        }
      }
    } catch (e) {
      console.warn("[txs] alchemy fallback failed:", e);
    }
  }

  // 3) If both fail, return synthetic placeholder so we still score something
  const synthetic = makeSyntheticTxs(address);
  if (debug) {
    return {
      ok: false,
      error: "no providers succeeded; returning synthetic",
      provider: null,
      raw: synthetic
    };
  }
  return { txs: synthetic, source: "synthetic" };
}

function makeSyntheticTxs(address) {
  // lightly varied synthetic set, just enough for a baseline
  const nowSec = Math.floor(Date.now() / 1000);
  const daysAgo = 365;
  const ts = nowSec - daysAgo * 86400;
  return [
    {
      timeStamp: String(ts),
      hash: "0xsynthetic",
      from: address,
      to: address,
      value: "0"
    }
  ];
}

/* =================== FEATURE DERIVATION =================== */

function deriveFeatures(address, txs) {
  const addr = address.toLowerCase();
  const nowMs = Date.now();

  if (!Array.isArray(txs) || txs.length === 0) {
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
        neighborAvgAgeDays: 0
      }
    };
  }

  const parsed = [];
  for (const t of txs) {
    let sec = 0;
    if (t.timeStamp) {
      const n = Number(t.timeStamp);
      if (!Number.isNaN(n) && n > 1000000000) sec = n;
    }
    if (!sec && t.timestamp) {
      const n = Number(t.timestamp);
      if (!Number.isNaN(n) && n > 1000000000) sec = n;
    }
    if (!sec && t.time) {
      const n = Number(t.time);
      if (!Number.isNaN(n) && n > 1000000000) sec = n;
    }
    if (!sec && t.blockTime) {
      const n = Number(t.blockTime);
      if (!Number.isNaN(n) && n > 1000000000) sec = n;
    }
    const ms = sec ? sec * 1000 : null;
    parsed.push({
      tsMs: ms,
      from: String(t.from || "").toLowerCase(),
      to: String(t.to || "").toLowerCase(),
      value: t.value || "0"
    });
  }

  const withTs = parsed.filter(p => p.tsMs != null);
  if (!withTs.length) {
    return {
      ageDays: 365,
      firstSeenMs: null,
      txCount: txs.length,
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
        neighborAvgAgeDays: 0
      }
    };
  }

  withTs.sort((a, b) => a.tsMs - b.tsMs);
  const first = withTs[0].tsMs;
  const last = withTs[withTs.length - 1].tsMs;

  const ageDays = Math.max(0, Math.round((nowMs - first) / 86400000));
  const spanDays = Math.max(1, Math.round((last - first) / 86400000) || 1);
  const txCount = withTs.length;
  const txPerDay = txCount / spanDays;

  // Very simple burst score: ratio of peak-day-count to average
  const dayBuckets = new Map();
  for (const p of withTs) {
    const day = Math.floor(p.tsMs / 86400000);
    dayBuckets.set(day, (dayBuckets.get(day) || 0) + 1);
  }
  const perDayCounts = Array.from(dayBuckets.values());
  const maxPerDay = Math.max(...perDayCounts);
  const avgPerDay = txCount / perDayCounts.length;
  const burstScore = avgPerDay > 0 ? clamp(maxPerDay / avgPerDay - 1, 0, 1) : 0;

  // Counterparties & concentration
  const counts = new Map();
  for (const p of withTs) {
    let other = null;
    if (p.from === addr && p.to) other = p.to;
    else if (p.to === addr && p.from) other = p.from;
    if (!other) continue;
    counts.set(other, (counts.get(other) || 0) + 1);
  }
  const uniqueCounterparties = counts.size;
  let topCounterpartyShare = 0;
  if (uniqueCounterparties > 0) {
    const max = Math.max(...counts.values());
    topCounterpartyShare = clamp(max / Math.max(1, txCount), 0, 1);
  }

  // Dormancy
  const inactiveDays = Math.max(0, Math.round((nowMs - last) / 86400000));
  const isDormant = inactiveDays > 90;
  const dormantDays = isDormant ? inactiveDays : 0;
  const resurrectedRecently = isDormant && inactiveDays <= 30;

  return {
    ageDays,
    firstSeenMs: first,
    txCount,
    activeDays: spanDays,
    txPerDay,
    burstScore,
    uniqueCounterparties,
    topCounterpartyShare,
    isDormant,
    dormantDays,
    resurrectedRecently,
    neighborCount: uniqueCounterparties,
    sanctionedNeighborRatio: 0,
    highRiskNeighborRatio: 0,
    dormantNeighborRatio: 0,
    mixerProximity: 0,
    custodianExposure: 0,
    scamPlatformExposure: 0,
    local: {
      riskyNeighborRatio: 0,
      neighborAvgTx: txPerDay,
      neighborAvgAgeDays: ageDays
    }
  };
}

/* =================== RISK MODEL =================== */

function scoreWallet(address, network, feats, { ofacSet, scamSet, tornadoSet }) {
  const addr = address.toLowerCase();
  const inOfac = ofacSet.has(addr);
  const inScam = scamSet.has(addr);
  const inTornado = tornadoSet.has(addr);

  const signals = {
    ofacHit: inOfac,
    chainabuse: false,
    caFraud: false,
    scamPlatform: inScam,
    mixer: inTornado,
    custodian: false,
    unifiedSanctions: null,
    chainalysis: null,
    scorechain: null
  };

  let baseScore = 15;
  const parts = {};

  // Age contribution
  const ageDays = feats.ageDays ?? 365;
  let ageImpact = 0;
  let ageBucket = "> 2 years";
  if (ageDays < 7) {
    ageImpact = 25;
    ageBucket = "< 1 week";
  } else if (ageDays < 180) {
    ageImpact = 15;
    ageBucket = "1w–6m";
  } else if (ageDays < 730) {
    ageImpact = 2;
    ageBucket = "6m–2y";
  } else {
    ageImpact = -5;
    ageBucket = "> 2 years";
  }
  parts.age = {
    id: "age",
    label: "Wallet age",
    impact: ageImpact,
    details: { ageDays, bucket: ageBucket }
  };

  // Velocity
  const txPerDay = feats.txPerDay ?? 0;
  const burstScore = feats.burstScore ?? 0;
  let velImpact = 0;
  let velBucket = "normal";
  if (txPerDay > 50 || burstScore > 0.8) {
    velImpact = 22;
    velBucket = "extreme";
  } else if (txPerDay > 10 || burstScore > 0.4) {
    velImpact = 12;
    velBucket = "elevated";
  }
  parts.velocity = {
    id: "velocity",
    label: "Transaction velocity & bursts",
    impact: velImpact,
    details: { txPerDay, burstScore, bucket: velBucket }
  };

  // Counterparty mix / concentration
  const uniqueCounterparties = feats.uniqueCounterparties ?? 0;
  const topShare = feats.topCounterpartyShare ?? 0;
  let mixImpact = 0;
  let mixBucket = "diversified";
  if (uniqueCounterparties <= 2 && topShare > 0.8 && feats.txCount > 20) {
    mixImpact = 14;
    mixBucket = "concentrated";
  }
  parts.mix = {
    id: "mix",
    label: "Counterparty mix & concentration",
    impact: mixImpact,
    details: { uniqueCounterparties, topCounterpartyShare: topShare, bucket: mixBucket }
  };

  // Neighbor risk (placeholder; you can wire real cluster stats later)
  let neighborImpact = 0;
  const neighborCount = feats.neighborCount ?? uniqueCounterparties;
  let mixedCluster = false;
  if (neighborCount > 20) {
    neighborImpact = 5;
    mixedCluster = true;
  }
  parts.neighbor = {
    id: "neighbor",
    label: "Neighbor & cluster risk",
    impact: neighborImpact,
    details: {
      neighborCount,
      mixedCluster
    }
  };

  // External lists
  let listsImpact = 0;
  const listDetails = {};
  if (inOfac) {
    listsImpact += 70;
    listDetails.ofac = true;
  }
  if (inScam) {
    listsImpact += 20;
    listDetails.scamPlatform = true;
  }
  if (inTornado) {
    listsImpact += 18;
    listDetails.mixer = true;
  }
  parts.lists = {
    id: "lists",
    label: "External fraud & platform signals",
    impact: listsImpact,
    details: listDetails
  };

  // Dormancy
  let dormantImpact = 0;
  const isDormant = feats.isDormant ?? false;
  const dormantDays = feats.dormantDays ?? 0;
  const resurrectedRecently = feats.resurrectedRecently ?? false;
  if (isDormant && dormantDays > 365) {
    dormantImpact += 5;
  } else if (resurrectedRecently) {
    dormantImpact += 8;
  }
  parts.dormant = {
    id: "dormant",
    label: "Dormancy & resurrection patterns",
    impact: dormantImpact,
    details: { isDormant, dormantDays, resurrectedRecently }
  };

  // Concentration (placeholder)
  parts.concentration = {
    id: "concentration",
    label: "Flow concentration (fan-in/out)",
    impact: 0,
    details: {}
  };

  // Governance (placeholder override path)
  parts.governance = {
    id: "governance",
    label: "Governance / override",
    impact: 0,
    details: {}
  };

  // Sum up contributions
  const contribution =
    ageImpact +
    velImpact +
    mixImpact +
    neighborImpact +
    listsImpact +
    dormantImpact;

  let rawScore = baseScore + contribution;
  rawScore = clamp(rawScore, 0, 100);

  const sanctionHits = inOfac ? 1 : 0;
  const block = rawScore >= 85 || inOfac;

  const reasons = [];
  if (velImpact > 0) reasons.push("Transaction velocity & bursts");
  if (ageImpact > 0 || ageImpact < 0) reasons.push("Wallet age");
  if (neighborImpact > 0) reasons.push("Neighbor & cluster risk");
  if (mixImpact > 0) reasons.push("Counterparty mix & concentration");
  if (listsImpact > 0 && inOfac) reasons.push("OFAC / sanctions list match");

  // Confidence: if we had real txs, treat as high; if synthetic, low
  const confidence =
    feats.txCount && feats.ageDays !== 365 ? 1.0 : 0.6;

  const meta = {
    baseScore,
    rawContribution: contribution,
    confidence,
    parts
  };

  return {
    score: rawScore,
    reasons,
    block,
    sanctionHits,
    feats,
    signals,
    meta
  };
}

/* =================== NEIGHBOR GRAPH =================== */

function buildNeighborsGraph(address, txs, limit = 120) {
  const center = address.toLowerCase();
  const nodes = [{ id: center, address: center, network: "eth" }];
  const links = [];

  if (!Array.isArray(txs) || txs.length === 0) {
    return { nodes, links };
  }

  const counts = new Map();
  const addr = center;

  for (const t of txs) {
    const from = String(t.from || "").toLowerCase();
    const to = String(t.to || "").toLowerCase();
    let other = null;
    if (from === addr && to) other = to;
    else if (to === addr && from) other = from;
    if (!other) continue;
    counts.set(other, (counts.get(other) || 0) + 1);
  }

  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, limit));

  for (const [neigh, weight] of sorted) {
    nodes.push({ id: neigh, address: neigh, network: "eth" });
    links.push({ a: center, b: neigh, weight });
  }

  return { nodes, links };
}

/* =================== small utils =================== */

function clamp(x, a = 0, b = 100) {
  return Math.max(a, Math.min(b, x));
}
