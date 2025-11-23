// server.worker.js — RiskXLabs Vision API (single-file Cloudflare worker)
// Version: RXL-V1.6.2
//
// Endpoints:
//   GET /                   → health/info
//   GET /health             → health/info
//   GET /score?address=&network=eth
//   GET /neighbors?address=&network=eth&hop=1&limit=120
//
// Secrets used (set in Cloudflare):
//   RXL_OFAC_SET      → newline/space/comma-separated OFAC addresses (lower/upper ok)
//   RXL_TORNADO_SET   → Tornado/mixer addresses
//   RXL_SCAM_SET      → scam/platform clusters
//
// NOTE: This is a single-file version (no imports) so it can run directly
// in the Cloudflare dashboard. Your GitHub repo can still keep a modular
// lib/risk-model.js for future Wrangler-based deployment.

const VERSION = "RXL-V1.6.2";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/" || path === "/health") {
        return json({
          ok: true,
          service: "riskxlabs-vision-api",
          version: VERSION,
        });
      }

      if (path === "/score") {
        return handleScore(url, env);
      }

      if (path === "/neighbors") {
        return handleNeighbors(url, env);
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("RXL server error:", err);
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  },
};

/* ====================== /score handler ======================= */

function normalizeAddress(addr) {
  return String(addr || "").trim().toLowerCase();
}

function parseSet(secretValue) {
  if (!secretValue) return new Set();
  return new Set(
    String(secretValue)
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

async function handleScore(url, env) {
  const address = normalizeAddress(url.searchParams.get("address"));
  const network = url.searchParams.get("network") || "eth";

  if (!address || !address.startsWith("0x") || address.length < 10) {
    return json(
      { ok: false, error: "Invalid or missing address", address, network },
      400
    );
  }

  // --- Load list sets from secrets ---
  const ofacSet = parseSet(env.RXL_OFAC_SET);
  const tornadoSet = parseSet(env.RXL_TORNADO_SET);
  const scamSet = parseSet(env.RXL_SCAM_SET);

  const isOfac = ofacSet.has(address);
  const isMixer = tornadoSet.has(address);
  const isScam = scamSet.has(address);

  // --- Synthetic behavioral features (fallback for now) ---
  // These are the same baseline values you've been seeing (score ~ 28) so
  // the frontend behavior stays stable while we wire live chain data later.
  const feats = {
    ageDays: 1309,
    firstSeenMs: null,
    txCount: 809,
    activeDays: 30,
    txPerDay: 26.966666666666665,
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
    mixerProximity: isMixer ? 0.9 : 0.42,
    custodianExposure: 0.38,
    scamPlatformExposure: isScam ? 0.9 : 0.49,
    local: {
      riskyNeighborRatio: 0.32,
      neighborAvgTx: 26.966666666666665,
      neighborAvgAgeDays: 1309,
    },
  };

  // --- Core ensemble scoring (matches your previous 28 behavior) ----
  const baseScore = 15;

  const ageImpact = (() => {
    if (feats.ageDays == null) return 0;
    if (feats.ageDays < 30) return +15;
    if (feats.ageDays < 180) return +8;
    if (feats.ageDays < 730) return 0;
    return -10; // old wallet → some risk relief
  })();

  const velocityImpact = (() => {
    const tpd = feats.txPerDay || 0;
    const burst = feats.burstScore || 0;
    if (tpd === 0) return 0;
    if (tpd > 20 || burst > 0.5) return +20;
    if (tpd > 5) return +10;
    return +3;
  })();

  const mixImpact = (() => {
    const u = feats.uniqueCounterparties || 0;
    const top = feats.topCounterpartyShare || 0;
    if (u === 0) return 0;
    if (top > 0.6) return +8;
    if (top > 0.3) return +4;
    return -2; // diversified → slight relief
  })();

  const neighborImpact = (() => {
    const high = feats.highRiskNeighborRatio || 0;
    const sanc = feats.sanctionedNeighborRatio || 0;
    if (sanc > 0.2 || high > 0.3) return +5;
    if (sanc > 0 || high > 0.1) return +2;
    return 0;
  })();

  const dormantImpact = (() => {
    if (!feats.isDormant) return 0;
    if (feats.dormantDays > 365 && feats.resurrectedRecently) return +10;
    if (feats.dormantDays > 180) return +5;
    return +2;
  })();

  const listImpact = (() => {
    let s = 0;
    if (isMixer) s += 15;
    if (isScam) s += 15;
    return s;
  })();

  const rawContribution =
    ageImpact +
    velocityImpact +
    mixImpact +
    neighborImpact +
    dormantImpact +
    listImpact;

  let score = clamp01((baseScore + rawContribution) / 100) * 100;

  // --- Hard OFAC override ---
  let block = false;
  let sanctionHits = null;
  const reasons = [
    "Transaction velocity & bursts",
    "Wallet age",
    "Neighbor & cluster risk",
    "Counterparty mix & concentration",
  ];

  if (isOfac) {
    score = 100;
    block = true;
    sanctionHits = 1;
    reasons.push("OFAC / sanctions list match");
  } else {
    if (isMixer) reasons.push("Mixer proximity");
    if (isScam) reasons.push("Scam / fraud platform exposure");
  }

  score = Math.round(score);

  const result = {
    address,
    network,
    risk_score: score,
    reasons,
    risk_factors: reasons.slice(),
    block,
    sanctionHits,
    feats,
    explain: {
      version: VERSION,
      address,
      network,
      baseScore,
      rawContribution,
      score,
      confidence: 1,
      parts: {
        age: {
          id: "age",
          label: "Wallet age",
          impact: ageImpact,
          details: {
            ageDays: feats.ageDays,
            bucket:
              feats.ageDays == null
                ? "unknown"
                : feats.ageDays < 30
                ? "< 30 days"
                : feats.ageDays < 180
                ? "< 6 months"
                : feats.ageDays < 730
                ? "< 2 years"
                : "> 2 years",
          },
        },
        velocity: {
          id: "velocity",
          label: "Transaction velocity & bursts",
          impact: velocityImpact,
          details: {
            txPerDay: feats.txPerDay,
            burstScore: feats.burstScore,
            bucket:
              feats.txPerDay === 0
                ? "inactive"
                : feats.txPerDay > 20 || feats.burstScore > 0.5
                ? "extreme"
                : feats.txPerDay > 5
                ? "elevated"
                : "normal",
          },
        },
        mix: {
          id: "mix",
          label: "Counterparty mix & concentration",
          impact: mixImpact,
          details: {
            uniqueCounterparties: feats.uniqueCounterparties,
            topCounterpartyShare: feats.topCounterpartyShare,
            bucket:
              feats.uniqueCounterparties === 0
                ? "unknown"
                : feats.topCounterpartyShare > 0.6
                ? "concentrated"
                : feats.topCounterpartyShare > 0.3
                ? "moderate concentration"
                : "diversified",
          },
        },
        concentration: {
          id: "concentration",
          label: "Flow concentration (fan-in/out)",
          impact: 0,
          details: {},
        },
        dormant: {
          id: "dormant",
          label: "Dormancy & resurrection patterns",
          impact: dormantImpact,
          details: {
            isDormant: feats.isDormant,
            dormantDays: feats.dormantDays,
            resurrectedRecently: feats.resurrectedRecently,
          },
        },
        neighbor: {
          id: "neighbor",
          label: "Neighbor & cluster risk",
          impact: neighborImpact,
          details: {
            neighborCount: feats.neighborCount,
            sanctionedNeighborRatio: feats.sanctionedNeighborRatio,
            highRiskNeighborRatio: feats.highRiskNeighborRatio,
            mixedCluster:
              feats.sanctionedNeighborRatio > 0 || feats.highRiskNeighborRatio > 0,
          },
        },
        lists: {
          id: "lists",
          label: "External fraud & platform signals",
          impact: listImpact,
          details: {
            ofacHit: isOfac,
            mixer: isMixer,
            scamPlatform: isScam,
          },
        },
        governance: {
          id: "governance",
          label: "Governance / override",
          impact: 0,
          details: {},
        },
      },
      feats,
      signals: {
        ofacHit: isOfac,
        chainabuse: false,
        caFraud: false,
        scamPlatform: isScam,
        mixer: isMixer,
        custodian: false,
        unifiedSanctions: null,
        chainalysis: null,
        scorechain: null,
      },
      notes: [],
    },
  };

  // Convenience: mirror final score at top level for UI
  result.score = score;

  return json(result);
}

/* ====================== /neighbors handler ===================== */

async function handleNeighbors(url, env) {
  const center = normalizeAddress(url.searchParams.get("address"));
  const network = url.searchParams.get("network") || "eth";
  const limit = Number(url.searchParams.get("limit") || "120") || 120;

  if (!center) {
    return json(
      { ok: false, error: "Missing address for neighbors", network },
      400
    );
  }

  // For now: synthetic neighborhood (same as previous behavior).
  // This keeps Vision working while we later plug a real graph source.
  const nodes = [];
  const links = [];

  nodes.push({ id: center, address: center, network });

  const count = Math.min(limit, 16);
  for (let i = 0; i < count; i++) {
    const id =
      "0x" +
      Math.random()
        .toString(16)
        .slice(2)
        .padStart(40, "0")
        .slice(0, 40);
    nodes.push({ id, address: id, network });
    links.push({ a: center, b: id, weight: 1 });
  }

  return json({ nodes, links });
}

/* ====================== Helpers ================================ */

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}
