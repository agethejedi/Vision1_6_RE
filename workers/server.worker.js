// workers/server.worker.js
// RiskXLabs Vision – Cloudflare Worker risk engine v1.6.4
//
// Endpoints:
//   GET /score?address=0x...&network=eth
//   GET /neighbors?address=0x...&network=eth&hop=1&limit=120
//   GET /tx-debug?address=0x...  (diagnostics only)
//
// Uses:
//   ETHERSCAN_API_KEY (Secret)
//   ALCHEMY_API_KEY   (Secret)
//   OFAC_SET          (Plaintext – newline/CSV of hex addresses)
//   SCAM_CLUSTERS     (Plaintext – newline/CSV of hex addresses)
//   TORNADO_SET       (Plaintext – newline/CSV of hex addresses)
//   OFACLIST          (optional legacy list – ignored by this version)

const VERSION = "RXL-V1.6.4";

/* ========= Utilities ========= */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "Content-Type",
      "access-control-allow-methods": "GET,OPTIONS",
    },
  });

function badRequest(msg) {
  return json({ ok: false, error: msg }, 400);
}

function parseHexSet(raw) {
  if (!raw) return new Set();
  return new Set(
    String(raw)
      .split(/[\r\n,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.startsWith("0x") && s.length >= 6)
  );
}

function clamp(x, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, x));
}

/* ========= Tx providers ========= */

async function fetchEtherscanTxs(address, env) {
  const key = env.ETHERSCAN_API_KEY;
  if (!key) throw new Error("missing ETHERSCAN_API_KEY");
  const url =
    "https://api.etherscan.io/api?module=account&action=txlist" +
    `&address=${encodeURIComponent(address)}` +
    "&startblock=0&endblock=99999999&sort=asc" +
    `&apikey=${encodeURIComponent(key)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`etherscan bad status ${res.status}`);
  const body = await res.json();
  if (String(body.status) !== "1" || !Array.isArray(body.result)) {
    throw new Error("etherscan no tx");
  }
  return body.result.map((tx) => ({
    timeStamp: Number(tx.timeStamp) * 1000,
    hash: tx.hash,
    from: tx.from?.toLowerCase(),
    to: tx.to?.toLowerCase() || null,
    value: tx.value || "0",
  }));
}

// Minimal Alchemy fallback – uses getAssetTransfers in both directions
async function fetchAlchemyTxs(address, env) {
  const key = env.ALCHEMY_API_KEY;
  if (!key) throw new Error("missing ALCHEMY_API_KEY");
  const base = `https://eth-mainnet.g.alchemy.com/v2/${key}`;
  const addr = address.toLowerCase();

  async function oneDirection(direction) {
    const body = {
      id: 1,
      jsonrpc: "2.0",
      method: "alchemy_getAssetTransfers",
      params: [
        {
          category: ["external"],
          [direction === "from" ? "fromAddress" : "toAddress"]: addr,
          maxCount: "0x3e8", // 1000
          withMetadata: true,
        },
      ],
    };
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`alchemy bad status ${res.status}`);
    const json = await res.json();
    const txs = json?.result?.transfers || [];
    return txs.map((t) => ({
      timeStamp: Date.parse(t.metadata?.blockTimestamp || new Date().toISOString()),
      hash: t.hash,
      from: t.from?.toLowerCase(),
      to: t.to?.toLowerCase() || null,
      value: t.value || "0",
    }));
  }

  const [out, incoming] = await Promise.allSettled([
    oneDirection("from"),
    oneDirection("to"),
  ]);

  const merged = [];
  if (out.status === "fulfilled") merged.push(...out.value);
  if (incoming.status === "fulfilled") merged.push(...incoming.value);

  if (!merged.length) throw new Error("alchemy no tx");
  // sort oldest → newest
  merged.sort((a, b) => a.timeStamp - b.timeStamp);
  return merged;
}

// Try etherscan then alchemy; on total failure, synthetic stub
async function fetchTxHistory(address, env) {
  const providers = [
    { name: "etherscan", fn: () => fetchEtherscanTxs(address, env) },
    { name: "alchemy", fn: () => fetchAlchemyTxs(address, env) },
  ];

  const errors = [];
  for (const p of providers) {
    try {
      const txs = await p.fn();
      return { ok: true, provider: p.name, txs };
    } catch (e) {
      errors.push({ provider: p.name, error: String(e.message || e) });
    }
  }

  // Fallback synthetic history (one self-tx today) so engine always returns something
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    ok: false,
    provider: null,
    txs: [
      {
        timeStamp: nowSec * 1000,
        hash: "0xsynthetic",
        from: address,
        to: address,
        value: "0",
      },
    ],
    errors,
  };
}

/* ========= Feature extraction ========= */

function buildFeatures(address, txs, nowMs) {
  const addr = address.toLowerCase();
  const txList = Array.isArray(txs) ? txs : [];
  if (!txList.length) {
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
      scamPlatformExposure: 0,
      local: {
        riskyNeighborRatio: 0,
        neighborAvgTx: 0,
        neighborAvgAgeDays: 0,
        neighborCount: 0,
      },
    };
  }

  // Sort oldest → newest by timestamp
  txList.sort((a, b) => (a.timeStamp || 0) - (b.timeStamp || 0));

  const firstTs = txList[0].timeStamp || nowMs;
  const lastTs = txList[txList.length - 1].timeStamp || nowMs;
  const ageDays = (nowMs - firstTs) / (1000 * 60 * 60 * 24);
  const spanDays = Math.max(1, (lastTs - firstTs) / (1000 * 60 * 60 * 24));
  const txCount = txList.length;
  const txPerDay = txCount / spanDays;

  // Burst metric – crude: max tx/day / avg tx/day
  const perDay = new Map();
  for (const tx of txList) {
    const d = Math.floor((tx.timeStamp || nowMs) / (1000 * 60 * 60 * 24));
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  const maxPerDay = Math.max(...perDay.values());
  const burstScore = txPerDay > 0 ? clamp(maxPerDay / txPerDay, 0, 10) / 10 : 0;

  // Counterparty stats
  const cpCounts = new Map(); // other address → count
  for (const tx of txList) {
    const from = tx.from?.toLowerCase();
    const to = tx.to?.toLowerCase();
    let other = null;
    if (from === addr && to && to !== addr) other = to;
    else if (to === addr && from && from !== addr) other = from;
    if (other) cpCounts.set(other, (cpCounts.get(other) || 0) + 1);
  }

  const uniqueCounterparties = cpCounts.size;
  const totalCpTx = [...cpCounts.values()].reduce((a, b) => a + b, 0) || 1;
  const topCounterpartyShare = totalCpTx
    ? Math.max(...cpCounts.values(), 0) / totalCpTx
    : 0;

  // Dormancy – if no tx in last 90 days but age > 180d
  const daysSinceLast =
    (nowMs - (lastTs || nowMs)) / (1000 * 60 * 60 * 24);
  const isDormant = ageDays > 180 && daysSinceLast > 90;

  // Neighbor details – only basic for now
  const neighborCount = uniqueCounterparties;
  const local = {
    riskyNeighborRatio: 0,
    neighborAvgTx: uniqueCounterparties
      ? totalCpTx / uniqueCounterparties
      : 0,
    neighborAvgAgeDays: 0,
    neighborCount,
  };

  return {
    ageDays,
    firstSeenMs: firstTs,
    txCount,
    activeDays: Math.round(spanDays),
    txPerDay,
    burstScore,
    uniqueCounterparties,
    topCounterpartyShare,
    isDormant,
    dormantDays: daysSinceLast,
    resurrectedRecently: !isDormant && daysSinceLast < 14 && ageDays > 60,
    neighborCount,
    sanctionedNeighborRatio: 0,
    highRiskNeighborRatio: 0,
    dormantNeighborRatio: 0,
    mixerProximity: 0,
    custodianExposure: 0,
    scamPlatformExposure: 0,
    local,
  };
}

/* ========= Risk model (same logic as lib/risk-model.js) ========= */

function scoreWithLists(address, network, feats, lists) {
  const addr = address.toLowerCase();
  const {
    ofacSet,
    scamSet,
    tornadoSet,
  } = lists;

  const parts = {};
  const notes = [];
  const baseScore = 15;

  /* ---- Age ---- */
  const d = feats.ageDays;
  let ageImpact = 0;
  let ageBucket = "unknown";
  if (d <= 7) {
    ageImpact = 25;
    ageBucket = "< 1 week";
  } else if (d <= 180) {
    ageImpact = 10;
    ageBucket = "1w–6m";
  } else if (d <= 730) {
    ageImpact = 2;
    ageBucket = "6m–2y";
  } else if (d > 730) {
    ageImpact = -10;
    ageBucket = "> 2y";
  }
  parts.age = {
    id: "age",
    label: "Wallet age",
    impact: ageImpact,
    details: { ageDays: d, bucket: ageBucket },
  };

  /* ---- Velocity ---- */
  const { txPerDay, burstScore } = feats;
  let velImpact = 0;
  let velBucket = "normal";
  if (txPerDay > 50 || burstScore > 0.8) {
    velImpact = 22;
    velBucket = "extreme";
  } else if (txPerDay > 10 || burstScore > 0.6) {
    velImpact = 14;
    velBucket = "high";
  } else if (txPerDay >= 1 || burstScore > 0.4) {
    velImpact = 4;
    velBucket = "mild";
  }
  parts.velocity = {
    id: "velocity",
    label: "Transaction velocity & bursts",
    impact: velImpact,
    details: { txPerDay, burstScore, bucket: velBucket },
  };

  /* ---- Mix / concentration ---- */
  const { uniqueCounterparties, topCounterpartyShare } = feats;
  let mixImpact = 0;
  let mixBucket = "balanced";
  if (uniqueCounterparties <= 2 && topCounterpartyShare > 0.8) {
    mixImpact = 14;
    mixBucket = "concentrated";
  } else if (uniqueCounterparties >= 8 && topCounterpartyShare < 0.3) {
    mixImpact = -2;
    mixBucket = "diversified";
  }
  parts.mix = {
    id: "mix",
    label: "Counterparty mix & concentration",
    impact: mixImpact,
    details: {
      uniqueCounterparties,
      topCounterpartyShare,
      bucket: mixBucket,
    },
  };

  /* ---- Neighbor risk (placeholder – no sanctions on neighbors yet) ---- */
  let neighborImpact = 0;
  const neighborCount = feats.neighborCount || 0;
  if (neighborCount >= 30) neighborImpact = 6;
  else if (neighborCount >= 10) neighborImpact = 3;

  parts.neighbor = {
    id: "neighbor",
    label: "Neighbor & cluster risk",
    impact: neighborImpact,
    details: {
      neighborCount,
      sanctionedNeighborRatio: feats.sanctionedNeighborRatio,
      highRiskNeighborRatio: feats.highRiskNeighborRatio,
      mixedCluster: false,
    },
  };

  /* ---- Dormancy patterns ---- */
  let dormantImpact = 0;
  if (feats.isDormant && feats.ageDays > 365) {
    dormantImpact = 4;
  }
  parts.dormant = {
    id: "dormant",
    label: "Dormancy & resurrection patterns",
    impact: dormantImpact,
    details: {
      isDormant: feats.isDormant,
      dormantDays: feats.dormantDays,
      resurrectedRecently: feats.resurrectedRecently,
    },
  };

  /* ---- Lists: OFAC, scam clusters, mixer (Tornado) ---- */
  let listsImpact = 0;
  const listDetails = {};

  const ofacHit = ofacSet.has(addr);
  if (ofacHit) {
    listsImpact += 70;
    listDetails.ofac = true;
    notes.push("OFAC / sanctions list match");
  }

  if (scamSet.has(addr)) {
    // Stronger hit – we want standalone scam cluster ~75–85
    listsImpact += 55;
    listDetails.scamCluster = true;
  }

  if (tornadoSet.has(addr)) {
    // Mixer proximity – moderate by itself
    listsImpact += 30;
    listDetails.tornado = true;
  }

  // Combo bonus: Tornado + Sketchy cluster
  if (listDetails.tornado && listDetails.scamCluster) {
    listsImpact += 35; // pushes into 80–95 band
  }

  parts.lists = {
    id: "lists",
    label: "External fraud & platform signals",
    impact: listsImpact,
    details: listDetails,
  };

  /* ---- Concentration placeholder ---- */
  parts.concentration = {
    id: "concentration",
    label: "Flow concentration (fan-in/out)",
    impact: 0,
    details: {},
  };

  const governanceImpact = 0;
  parts.governance = {
    id: "governance",
    label: "Governance / override",
    impact: governanceImpact,
    details: {},
  };

  const rawContribution =
    ageImpact +
    velImpact +
    mixImpact +
    neighborImpact +
    dormantImpact +
    listsImpact +
    governanceImpact;

  let score = clamp(baseScore + rawContribution, 0, 100);

  const signals = {
    ofacHit,
    chainabuse: false,
    caFraud: false,
    scamPlatform: !!listDetails.scamCluster,
    mixer: !!listDetails.tornado,
    custodian: false,
    unifiedSanctions: null,
    chainalysis: null,
    scorechain: null,
  };

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
    signals,
    notes,
  };

  // Flags for UI badges / narrative
  explain.ofacHit = ofacHit;
  explain.mixerLink = !!listDetails.tornado;
  explain.scamHit = !!listDetails.scamCluster;
  explain.sketchyCluster = !!listDetails.scamCluster;

  explain.factorImpacts = [
    { id: "age", label: "Wallet age", delta: ageImpact },
    {
      id: "velocity",
      label: "Transaction velocity & bursts",
      delta: velImpact,
    },
    {
      id: "mix",
      label: "Counterparty mix & concentration",
      delta: mixImpact,
    },
    {
      id: "neighbor",
      label: "Neighbor & cluster risk",
      delta: neighborImpact,
    },
    {
      id: "dormant",
      label: "Dormancy & resurrection patterns",
      delta: dormantImpact,
    },
    {
      id: "lists",
      label: "External fraud & platform signals",
      delta: listsImpact,
    },
  ];

  const reasons = [];
  if (ageImpact > 0) reasons.push("Wallet age");
  if (velImpact > 0) reasons.push("Transaction velocity & bursts");
  if (mixImpact > 0) reasons.push("Counterparty mix & concentration");
  if (neighborImpact > 0) reasons.push("Neighbor & cluster risk");
  if (listsImpact > 0 && ofacHit) reasons.push("OFAC / sanctions list match");
  if (listsImpact > 0 && listDetails.scamCluster && !ofacHit)
    reasons.push("Sketchy / scam cluster pattern");
  if (listsImpact > 0 && listDetails.tornado && !ofacHit)
    reasons.push("Mixer proximity pattern");

  const block = !!(ofacHit || score >= 95);
  const sanctionHits = ofacHit ? 1 : 0;

  return {
    address: addr,
    network,
    risk_score: score,
    reasons,
    risk_factors: reasons,
    block,
    sanctionHits,
    feats,
    explain,
    score,
  };
}

/* ========= Neighbors graph ========= */

function buildNeighborGraph(address, txs, network, limit = 120) {
  const addr = address.toLowerCase();
  const cpCounts = new Map();

  for (const tx of txs) {
    const from = tx.from?.toLowerCase();
    const to = tx.to?.toLowerCase();
    let other = null;
    if (from === addr && to && to !== addr) other = to;
    else if (to === addr && from && from !== addr) other = from;
    if (other) cpCounts.set(other, (cpCounts.get(other) || 0) + 1);
  }

  const nodes = [{ id: addr, address: addr, network }];
  const links = [];

  const entries = [...cpCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  for (const [cp, weight] of entries) {
    nodes.push({ id: cp, address: cp, network });
    links.push({ a: addr, b: cp, weight });
  }

  if (nodes.length === 1) {
    // sparse – only center
    return { nodes, links };
  }
  return { nodes, links };
}

/* ========= Fetch handler ========= */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "Content-Type",
          "access-control-allow-methods": "GET,OPTIONS",
        },
      });
    }

    if (request.method !== "GET") {
      return badRequest("Only GET supported");
    }

    const lists = {
      ofacSet: parseHexSet(env.OFAC_SET),
      scamSet: parseHexSet(env.SCAM_CLUSTERS),
      tornadoSet: parseHexSet(env.TORNADO_SET),
    };

    if (pathname === "/tx-debug") {
      const address = searchParams.get("address")?.toLowerCase();
      if (!address || !address.startsWith("0x")) {
        return badRequest("Missing or invalid address");
      }
      const hist = await fetchTxHistory(address, env);
      return json(hist);
    }

    if (pathname === "/score") {
      const address = searchParams.get("address")?.toLowerCase();
      const network = (searchParams.get("network") || "eth").toLowerCase();

      if (!address || !address.startsWith("0x")) {
        return badRequest("Missing or invalid address");
      }

      const nowMs = Date.now();
      const hist = await fetchTxHistory(address, env);
      const feats = buildFeatures(address, hist.txs, nowMs);
      const scored = scoreWithLists(address, network, feats, lists);

      return json(scored);
    }

    if (pathname === "/neighbors") {
      const address = searchParams.get("address")?.toLowerCase();
      const network = (searchParams.get("network") || "eth").toLowerCase();
      const limit = Number(searchParams.get("limit") || "120") || 120;

      if (!address || !address.startsWith("0x")) {
        return badRequest("Missing or invalid address");
      }

      const hist = await fetchTxHistory(address, env);
      const graph = buildNeighborGraph(address, hist.txs, network, limit);
      return json(graph);
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};
