// server.worker.js — RiskXLabs Vision API v1.6.0
// Endpoints:
//   GET /                      -> health
//   GET /score?address&network -> risk score (core engine)
//   GET /check?address&network -> alias for /score
//   GET /txs?address&network   -> stub tx list (for ageDays)
//   GET /neighbors?address&network -> stub neighbor graph
//
// NOTE: This is a self-contained stubbed engine suitable for dev.
//       Real data adapters can be wired into the riskModel later.

const VERSION = "RXL-V1.6.0";

/* ====================== CORS HELPERS ====================== */

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",         // or lock down to your origin
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: corsHeaders({
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    }),
  });
}

function textResponse(text, status = 200, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: corsHeaders({
      "content-type": "text/plain; charset=utf-8",
      ...extraHeaders,
    }),
  });
}

function handleOptions() {
  // CORS preflight
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

/* ====================== RISK MODEL (stub) ====================== */

// Simple clamp utility
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

function makeStubFeats(address, network) {
  // Deterministic-feeling stub: fixed profile for now
  // You can later swap this out for real feature fetchers.
  const ageDays = 1309; // ~3.6 years
  const txCount = 809;
  const activeDays = 30;
  const txPerDay = txCount / activeDays; // ~26.97
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

  return {
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
      neighborAvgAgeDays: ageDays,
    },
  };
}

// Age factor
function agePart(feats) {
  const ageDays = feats.ageDays ?? 0;
  let impact = 0;
  let bucket = "unknown";

  if (ageDays <= 0) {
    impact = 0;
    bucket = "unknown";
  } else if (ageDays < 90) {
    impact = 10;
    bucket = "< 3 months";
  } else if (ageDays < 365 * 2) {
    impact = 0;
    bucket = "3–24 months";
  } else {
    impact = -10;
    bucket = "> 2 years";
  }

  return {
    id: "age",
    label: "Wallet age",
    impact,
    details: { ageDays, bucket },
  };
}

// Velocity factor
function velocityPart(feats) {
  const txPerDay = feats.txPerDay ?? 0;
  const burstScore = feats.burstScore ?? 0;
  let impact = 0;
  let bucket = "low";

  if (txPerDay > 20 || burstScore > 0.5) {
    impact = 20;
    bucket = "extreme";
  } else if (txPerDay > 5) {
    impact = 10;
    bucket = "elevated";
  } else if (txPerDay > 1) {
    impact = 5;
    bucket = "moderate";
  }

  return {
    id: "velocity",
    label: "Transaction velocity & bursts",
    impact,
    details: { txPerDay, burstScore, bucket },
  };
}

// Counterparty mix
function mixPart(feats) {
  const uniqueCounterparties = feats.uniqueCounterparties ?? 0;
  const topShare = feats.topCounterpartyShare ?? 0;
  let impact = 0;
  let bucket = "unknown";

  if (uniqueCounterparties === 0) {
    impact = 0;
    bucket = "unknown";
  } else if (uniqueCounterparties >= 20 && topShare < 0.2) {
    impact = -5;
    bucket = "highly diversified";
  } else if (uniqueCounterparties >= 8 && topShare < 0.4) {
    impact = -2;
    bucket = "diversified";
  } else if (topShare > 0.7) {
    impact = 10;
    bucket = "highly concentrated";
  } else {
    impact = 0;
    bucket = "mixed";
  }

  return {
    id: "mix",
    label: "Counterparty mix & concentration",
    impact,
    details: { uniqueCounterparties, topCounterpartyShare: topShare, bucket },
  };
}

// Flow concentration (fan-in/out) — stubbed neutral for now
function concentrationPart(/* feats */) {
  return {
    id: "concentration",
    label: "Flow concentration (fan-in/out)",
    impact: 0,
    details: {},
  };
}

// Dormant / resurrection — stubbed neutral
function dormantPart(feats) {
  return {
    id: "dormant",
    label: "Dormancy & resurrection patterns",
    impact: 0,
    details: {
      isDormant: !!feats.isDormant,
      dormantDays: feats.dormantDays ?? 0,
      resurrectedRecently: !!feats.resurrectedRecently,
    },
  };
}

// Neighbor & cluster risk
function neighborPart(feats) {
  const sancRatio = feats.sanctionedNeighborRatio ?? 0;
  const highRiskRatio = feats.highRiskNeighborRatio ?? 0;
  const mixedCluster =
    highRiskRatio > 0.25 || sancRatio > 0.1 || feats.neighborCount > 0;

  let impact = 0;
  if (mixedCluster) impact = 5;

  return {
    id: "neighbor",
    label: "Neighbor & cluster risk",
    impact,
    details: {
      neighborCount: feats.neighborCount ?? 0,
      sanctionedNeighborRatio: sancRatio,
      highRiskNeighborRatio: highRiskRatio,
      mixedCluster,
    },
  };
}

// Lists / external signals — currently stubbed
function listsPart(/* feats, signals */) {
  return {
    id: "lists",
    label: "External fraud & platform signals",
    impact: 0,
    details: {},
  };
}

// Governance / override — stubbed
function governancePart(/* feats, signals */) {
  return {
    id: "governance",
    label: "Governance / override",
    impact: 0,
    details: {},
  };
}

// Main risk model
function scoreAddress(address, network) {
  const addr = (address || "").toLowerCase();
  const net = (network || "eth").toLowerCase();

  const feats = makeStubFeats(addr, net);

  // Build parts
  const parts = {
    age: agePart(feats),
    velocity: velocityPart(feats),
    mix: mixPart(feats),
    concentration: concentrationPart(feats),
    dormant: dormantPart(feats),
    neighbor: neighborPart(feats),
    lists: listsPart(feats),
    governance: governancePart(feats),
  };

  const partList = Object.values(parts);

  const baseScore = 15;
  const rawContribution = partList.reduce((sum, p) => sum + (p.impact || 0), 0);
  const score = clamp(baseScore + rawContribution, 0, 100);

  // Build reasons: nonzero impacts, sorted by absolute impact desc
  const reasons = partList
    .filter((p) => (p.impact || 0) !== 0)
    .sort((a, b) => Math.abs(b.impact || 0) - Math.abs(a.impact || 0))
    .map((p) => p.label);

  const explain = {
    version: VERSION,
    address: addr,
    network: net,
    baseScore,
    rawContribution,
    score,
    confidence: 1,
    parts,
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
      scorechain: null,
    },
    notes: [],
  };

  const payload = {
    address: addr,
    network: net,
    risk_score: score,
    reasons,
    risk_factors: reasons,
    block: false,
    sanctionHits: null,
    feats,
    explain,
  };

  return payload;
}

/* ====================== STUB DATA ENDPOINTS ====================== */

function stubTxs(address, network) {
  // Very small stub: earliest tx at ~ageDays ago
  const feats = makeStubFeats(address, network);
  const now = Date.now();
  const msAgo = (feats.ageDays ?? 0) * 86400000;
  const tsMs = now - msAgo;

  return {
    result: [
      {
        hash: "0xstubtx" + address.slice(2, 10),
        raw: {
          metadata: {
            blockTimestamp: new Date(tsMs).toISOString(),
          },
        },
        timeStamp: Math.floor(tsMs / 1000),
      },
    ],
  };
}

function stubNeighbors(address, network) {
  const center = (address || "").toLowerCase();
  const n = 10;
  const nodes = [{ id: center, address: center, network }];
  const links = [];

  for (let i = 0; i < n; i++) {
    const id =
      "0x" + Math.random().toString(16).slice(2).padStart(40, "0").slice(0, 40);
    nodes.push({ id, address: id, network });
    links.push({ a: center, b: id, weight: 1 });
  }

  return { nodes, links };
}

/* ====================== WORKER ROUTER ====================== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    if (request.method === "OPTIONS") {
      return handleOptions();
    }

    // Health
    if (pathname === "/" || pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "riskxlabs-vision-api",
        version: VERSION,
      });
    }

    if (pathname === "/score" || pathname === "/check") {
      const address = searchParams.get("address") || "";
      const network = searchParams.get("network") || "eth";
      if (!address) {
        return jsonResponse(
          { ok: false, error: "Missing address" },
          400
        );
      }
      const payload = scoreAddress(address, network);
      return jsonResponse(payload);
    }

    if (pathname === "/txs") {
      const address = searchParams.get("address") || "";
      const network = searchParams.get("network") || "eth";
      const data = stubTxs(address, network);
      return jsonResponse(data);
    }

    if (pathname === "/neighbors") {
      const address = searchParams.get("address") || "";
      const network = searchParams.get("network") || "eth";
      const data = stubNeighbors(address, network);
      return jsonResponse(data);
    }

    return textResponse("Not found", 404);
  },
};
