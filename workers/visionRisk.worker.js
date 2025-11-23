// server.worker.js — RiskXLabs Vision API
// Version: RXL-V1.6.2
//
// Routes:
//   GET /               → service info
//   GET /health         → health ping
//   GET /score          → risk score for address
//   GET /neighbors      → neighbor graph from tx history
//
// Secrets / Vars expected in Cloudflare:
//   ALCHEMY_API_KEY           (Secret)
//   ETHERSCAN_API_KEY         (Secret)
//   OFAC_SET                  (Plaintext, comma/newline separated addresses)
//   TORNADO_SET               (Plaintext, comma/newline separated addresses)
//   SCAM_CLUSTERS             (Plaintext, comma/newline separated addresses)

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/") {
        return json({
          ok: true,
          service: "riskxlabs-vision-api",
          version: "RXL-V1.6.2"
        });
      }

      if (path === "/health") {
        return json({ ok: true, status: "healthy", ts: Date.now() });
      }

      if (path === "/score") {
        const address = (url.searchParams.get("address") || "").toLowerCase();
        const network = (url.searchParams.get("network") || "eth").toLowerCase();
        if (!address) {
          return json({ ok: false, error: "missing address" }, 400);
        }
        const result = await handleScore(address, network, env);
        return json(result);
      }

      if (path === "/neighbors") {
        const address = (url.searchParams.get("address") || "").toLowerCase();
        const network = (url.searchParams.get("network") || "eth").toLowerCase();
        const limit = Number(url.searchParams.get("limit") || "120") || 120;
        if (!address) {
          return json({ ok: false, error: "missing address" }, 400);
        }
        const graph = await handleNeighbors(address, network, env, { limit });
        return json(graph);
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (err) {
      console.error("top-level error", err);
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  }
};

/* ====================================================================== */
/* ========================= SCORE HANDLER =============================== */
/* ====================================================================== */

async function handleScore(address, network, env) {
  const now = Date.now();

  // --- Load list sets from *actual* CF secret names ---
  const ofacSet     = parseSet(env.OFAC_SET);
  const tornadoSet  = parseSet(env.TORNADO_SET);
  const scamSet     = parseSet(env.SCAM_CLUSTERS);

  // --- Fetch tx history (Etherscan → Alchemy fallback) ---
  const txs = await fetchTxHistory(address, network, env, 100);

  // --- Derive behavioral features ---
  const feats = deriveFeaturesFromTxs(txs, now);

  // --- List-based signals ---
  const addrLower = address.toLowerCase();
  const ofacHit   = ofacSet.has(addrLower);
  const inTornado = tornadoSet.has(addrLower);
  const inScam    = scamSet.has(addrLower);

  // --- Risk model (simple but deterministic) ---
  const { score, reasons, parts } = computeRisk(feats, {
    ofacHit,
    inTornado,
    inScam
  });

  const block = !!(ofacHit || inTornado || score >= 95);
  const sanctionHits = ofacHit ? 1 : 0;

  const explain = {
    version: "RXL-V1.6.2",
    address,
    network,
    baseScore: parts.baseScore ?? 0,
    rawContribution: parts.rawContribution ?? 0,
    score,
    confidence: parts.confidence ?? 1,
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
    address,
    network,
    risk_score: score,
    reasons,
    risk_factors: reasons,
    block,
    sanctionHits,
    feats,
    explain,
    score // duplicate for convenience
  };
}

/* ====================================================================== */
/* ========================= NEIGHBORS HANDLER ========================== */
/* ====================================================================== */

async function handleNeighbors(address, network, env, { limit = 120 } = {}) {
  const txs = await fetchTxHistory(address, network, env, 250);

  if (!txs.length) {
    // minimal stub if we truly have nothing
    return stubNeighbors(address, network);
  }

  const center = address.toLowerCase();
  const nodes = new Map(); // id -> node
  const links = [];

  // ensure center node
  nodes.set(center, { id: center, address: center, network });

  for (const tx of txs) {
    const from = (tx.from || "").toLowerCase();
    const to   = (tx.to || "").toLowerCase();
    if (!from || !to) continue;

    const isFromCenter = from === center;
    const isToCenter   = to === center;
    if (!isFromCenter && !isToCenter) continue;

    const neighborId = isFromCenter ? to : from;
    if (!neighborId) continue;

    if (!nodes.has(neighborId)) {
      nodes.set(neighborId, { id: neighborId, address: neighborId, network });
    }

    links.push({
      a: center,
      b: neighborId,
      weight: 1
    });
  }

  // limit neighbors
  const allNodes = Array.from(nodes.values());
  const neighbors = allNodes.filter(n => n.id !== center).slice(0, limit);
  const neighborIds = new Set(neighbors.map(n => n.id));
  const prunedLinks = links.filter(L => neighborIds.has(L.b) || neighborIds.has(L.a));

  return {
    nodes: [{ id: center, address: center, network }, ...neighbors],
    links: prunedLinks
  };
}

/* ====================================================================== */
/* ========================= TX HISTORY ================================= */
/* ====================================================================== */

async function fetchTxHistory(address, network, env, maxTx = 100) {
  // 1) Try Etherscan
  try {
    const txs = await fetchFromEtherscan(address, network, env, maxTx);
    if (txs && txs.length) {
      return txs;
    }
  } catch (err) {
    console.warn("Etherscan fetch failed, will try Alchemy:", err);
  }

  // 2) Fallback to Alchemy
  try {
    const txs = await fetchFromAlchemy(address, network, env, maxTx);
    if (txs && txs.length) {
      return txs;
    }
  } catch (err) {
    console.warn("Alchemy fetch failed:", err);
  }

  // 3) If everything fails, return empty → model will fall back to synthetic
  return [];
}

async function fetchFromEtherscan(address, network, env, maxTx) {
  const apiKey = env.ETHERSCAN_API_KEY;
  if (!apiKey) return [];

  // Only mainnet ETH for now; other networks can be added later.
  const base = (network === "eth" || network === "ethereum")
    ? "https://api.etherscan.io/api"
    : null;

  if (!base) return [];

  const url = new URL(base);
  url.searchParams.set("module", "account");
  url.searchParams.set("action", "txlist");
  url.searchParams.set("address", address);
  url.searchParams.set("sort", "asc");
  url.searchParams.set("page", "1");
  url.searchParams.set("offset", String(maxTx));
  url.searchParams.set("apikey", apiKey);

  const resp = await fetch(url.toString(), { cf: { cacheTtl: 10, cacheEverything: false } });
  if (!resp.ok) {
    throw new Error(`etherscan status ${resp.status}`);
  }

  const body = await resp.json();
  if (body.status !== "1" || !Array.isArray(body.result)) {
    return [];
  }

  return body.result.map(tx => ({
    hash: tx.hash,
    from: tx.from,
    to: tx.to,
    timeStamp: Number(tx.timeStamp) || 0,
    value: tx.value,
    isError: tx.isError === "1"
  }));
}

async function fetchFromAlchemy(address, network, env, maxTx) {
  const apiKey = env.ALCHEMY_API_KEY;
  if (!apiKey) return [];

  // Only Ethereum mainnet for now
  const base = (network === "eth" || network === "ethereum")
    ? `https://eth-mainnet.g.alchemy.com/v2/${apiKey}`
    : null;

  if (!base) return [];

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "alchemy_getAssetTransfers",
    params: [{
      fromBlock: "0x0",
      toBlock: "latest",
      fromAddress: address,
      toAddress: address,
      category: ["external", "internal", "erc20", "erc721", "erc1155"],
      maxCount: "0x" + maxTx.toString(16),
      withMetadata: false
    }]
  };

  const resp = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!resp.ok) throw new Error(`alchemy status ${resp.status}`);

  const json = await resp.json();
  const arr = json?.result?.transfers;
  if (!Array.isArray(arr)) return [];

  return arr.map(tx => ({
    hash: tx.hash,
    from: tx.from,
    to: tx.to,
    timeStamp: tx.metadata?.blockTimestamp
      ? Math.floor(new Date(tx.metadata.blockTimestamp).getTime() / 1000)
      : 0,
    value: "0x0",
    isError: false
  }));
}

/* ====================================================================== */
/* ========================= FEATURE DERIVATION ========================= */
/* ====================================================================== */

function deriveFeaturesFromTxs(txs, nowMs) {
  if (!Array.isArray(txs) || !txs.length) {
    // synthetic baseline — long-standing, low activity
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

  const firstTs = Math.min(...txs.map(t => t.timeStamp || 0).filter(Boolean));
  const lastTs  = Math.max(...txs.map(t => t.timeStamp || 0).filter(Boolean)) || firstTs;
  const ageDays = firstTs
    ? Math.max(0, (nowMs / 1000 - firstTs) / 86400)
    : 0;

  const spanDays = Math.max(1, (lastTs - firstTs) / 86400);
  const txCount  = txs.length;
  const txPerDay = txCount / spanDays;

  // naive burst score: max tx per day vs avg
  const countsByDay = new Map();
  for (const tx of txs) {
    const d = Math.floor((tx.timeStamp || firstTs) / 86400);
    countsByDay.set(d, (countsByDay.get(d) || 0) + 1);
  }
  const maxPerDay = Math.max(...countsByDay.values());
  const burstScore = txPerDay ? (maxPerDay / txPerDay) : 0;

  // counterparty mix
  const center = (txs[0].from || "").toLowerCase(); // heuristic; wallet address is passed separately anyway
  const cpCounts = new Map();
  for (const tx of txs) {
    const from = (tx.from || "").toLowerCase();
    const to   = (tx.to || "").toLowerCase();
    let cp = null;
    if (from === center && to) cp = to;
    else if (to === center && from) cp = from;
    if (!cp) continue;
    cpCounts.set(cp, (cpCounts.get(cp) || 0) + 1);
  }
  const uniqueCounterparties = cpCounts.size;
  let topCounterpartyShare = 0;
  if (uniqueCounterparties > 0) {
    const maxCount = Math.max(...cpCounts.values());
    topCounterpartyShare = maxCount / txCount;
  }

  return {
    ageDays,
    firstSeenMs: firstTs ? firstTs * 1000 : null,
    txCount,
    activeDays: spanDays,
    txPerDay,
    burstScore,
    uniqueCounterparties,
    topCounterpartyShare,
    isDormant: false,
    dormantDays: 0,
    resurrectedRecently: false,
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

/* ====================================================================== */
/* ========================= RISK MODEL ================================= */
/* ====================================================================== */

function computeRisk(feats, { ofacHit, inTornado, inScam }) {
  let baseScore = 15;
  let contribution = 0;
  const parts = {};

  // Age
  let ageImpact = 0;
  const age = feats.ageDays;
  let ageBucket = "unknown";
  if (age != null) {
    if (age < 7)        { ageImpact = +25; ageBucket = "< 1 week"; }
    else if (age < 30)  { ageImpact = +18; ageBucket = "1w–1m"; }
    else if (age < 180) { ageImpact = +10; ageBucket = "1m–6m"; }
    else if (age < 730) { ageImpact = +2;  ageBucket = "6m–2y"; }
    else                { ageImpact = -8;  ageBucket = "> 2 years"; }
  }
  contribution += ageImpact;
  parts.age = { id: "age", label: "Wallet age", impact: ageImpact, details: { ageDays: age, bucket: ageBucket } };

  // Velocity / bursts
  let velImpact = 0;
  if (feats.txPerDay > 25 || feats.burstScore > 3) velImpact = +22;
  else if (feats.txPerDay > 5 || feats.burstScore > 2) velImpact = +12;
  else if (feats.txPerDay > 1) velImpact = +4;
  contribution += velImpact;
  parts.velocity = {
    id: "velocity",
    label: "Transaction velocity & bursts",
    impact: velImpact,
    details: {
      txPerDay: feats.txPerDay,
      burstScore: feats.burstScore,
      bucket: velImpact >= 20 ? "extreme" : velImpact >= 10 ? "elevated" : "normal"
    }
  };

  // Mix / concentration
  let mixImpact = 0;
  if (feats.uniqueCounterparties <= 2 && feats.txCount > 20) mixImpact = +14;
  else if (feats.uniqueCounterparties <= 5 && feats.txCount > 50) mixImpact = +8;
  else if (feats.uniqueCounterparties >= 20 && feats.topCounterpartyShare < 0.2) mixImpact = -4;
  contribution += mixImpact;
  parts.mix = {
    id: "mix",
    label: "Counterparty mix & concentration",
    impact: mixImpact,
    details: {
      uniqueCounterparties: feats.uniqueCounterparties,
      topCounterpartyShare: feats.topCounterpartyShare,
      bucket: mixImpact > 0 ? "concentrated" : "diversified"
    }
  };

  // Neighbor / cluster (placeholder until true neighbor scoring)
  const neighborImpact = feats.uniqueCounterparties > 10 ? +3 : 0;
  contribution += neighborImpact;
  parts.neighbor = {
    id: "neighbor",
    label: "Neighbor & cluster risk",
    impact: neighborImpact,
    details: {
      neighborCount: feats.uniqueCounterparties,
      mixedCluster: neighborImpact > 0
    }
  };

  // Lists
  let listImpact = 0;
  const listDetails = {};
  if (ofacHit) {
    listImpact += 70;
    listDetails.ofac = true;
  }
  if (inTornado) {
    listImpact += 25;
    listDetails.tornado = true;
  }
  if (inScam) {
    listImpact += 25;
    listDetails.scamCluster = true;
  }
  contribution += listImpact;
  parts.lists = {
    id: "lists",
    label: "External fraud & platform signals",
    impact: listImpact,
    details: listDetails
  };

  parts.concentration = {
    id: "concentration",
    label: "Flow concentration (fan-in/out)",
    impact: 0,
    details: {}
  };
  parts.dormant = {
    id: "dormant",
    label: "Dormancy & resurrection patterns",
    impact: 0,
    details: {
      isDormant: feats.isDormant,
      dormantDays: feats.dormantDays,
      resurrectedRecently: feats.resurrectedRecently
    }
  };
  parts.governance = {
    id: "governance",
    label: "Governance / override",
    impact: 0,
    details: {}
  };

  const rawScore = baseScore + contribution;
  const score = clamp(rawScore, 0, 100);

  const reasons = [];
  if (parts.velocity.impact > 0) reasons.push("Transaction velocity & bursts");
  if (parts.age.impact > 0)      reasons.push("Wallet age");
  if (parts.neighbor.impact > 0) reasons.push("Neighbor & cluster risk");
  if (parts.mix.impact > 0)      reasons.push("Counterparty mix & concentration");
  if (ofacHit)                   reasons.push("OFAC / sanctions list match");
  if (inTornado)                 reasons.push("Mixer / Tornado Cash proximity");
  if (inScam)                    reasons.push("Known scam cluster exposure");
  if (!reasons.length)           reasons.push("Baseline risk");

  parts.baseScore = baseScore;
  parts.rawContribution = contribution;
  parts.confidence = 1;

  return { score, reasons, parts };
}

/* ====================================================================== */
/* ========================= UTILITIES ================================== */
/* ====================================================================== */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*"
    }
  });
}

function parseSet(str) {
  if (!str || typeof str !== "string") return new Set();
  const out = new Set();
  str
    .split(/[\r\n,]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .forEach(v => out.add(v));
  return out;
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function stubNeighbors(center, network) {
  const centerId = center.toLowerCase();
  const n = 10;
  const nodes = [{ id: centerId, address: centerId, network }];
  const links = [];
  for (let i = 0; i < n; i++) {
    const id = `0x${Math.random().toString(16).slice(2).padStart(40, "0").slice(0, 40)}`;
    nodes.push({ id, address: id, network });
    links.push({ a: centerId, b: id, weight: 1 });
  }
  return { nodes, links };
}
