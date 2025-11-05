// app.js — Vision 1_4: dynamic factors + unified visuals + live neighbor replace
// -------------------------------------------------------------------------------
import './ui/ScoreMeter.js?v=2025-11-02';     // window.ScoreMeter(...)
import './graph.js?v=2025-11-02';             // window.graph (on/setData/getData/setHalo)

/* ================= Feature Flags ==================== */
const RXL_FLAGS = Object.freeze({
  enableNarrative: true,
  debounceViewportMs: 200,
});

/* ================= Worker plumbing ================== */
const worker = new Worker('./workers/visionRisk.worker.js', { type: 'module' });

const pending = new Map();
function post(type, payload) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

worker.onmessage = (e) => {
  const { id, type, data, error } = e.data || {};
  const req = pending.get(id);

  if (type === 'INIT_OK') {
    if (req) { req.resolve(true); pending.delete(id); }
    return;
  }

  if (type === 'RESULT_STREAM') {
    const r = normalizeResult(data);
    drawHalo(r);
    if (r.id === selectedNodeId) {
      updateScorePanel(r);
      applyVisualCohesion(r);
      renderNarrativePanelIfEnabled(r);
    }
    updateBatchStatus(`Scored: ${r.id.slice(0,8)}… → ${r.score}`);
    return;
  }

  if (type === 'RESULT') {
    const r = normalizeResult(data);
    drawHalo(r);
    if (r.id === selectedNodeId) {
      updateScorePanel(r);
      applyVisualCohesion(r);
      renderNarrativePanelIfEnabled(r);
    }
    if (req) { req.resolve(r); pending.delete(id); }
    return;
  }

  if (type === 'DONE') {
    if (req) { req.resolve(true); pending.delete(id); }
    updateBatchStatus('Batch: complete');
    return;
  }

  if (type === 'ERROR') {
    console.error(error);
    if (req) { req.reject(new Error(error)); pending.delete(id); }
    updateBatchStatus('Batch: error');
  }
};

/* ================ Result normalization ========================== */
function normalizeResult(res = {}) {
  // normalize id to lowercase so it matches graph ids
  const id = normId(res.id || res.address);

  const serverScore = (typeof res.risk_score === 'number') ? res.risk_score : null;
  const score = (serverScore != null) ? serverScore : (typeof res.score === 'number' ? res.score : 0);

  const blocked = !!(res.block || serverScore === 100 || res.sanctionHits);

  const explain = res.explain && typeof res.explain === 'object'
    ? { ...res.explain }
    : { reasons: res.reasons || res.risk_factors || [] };

  // OFAC boolean for visuals + badges
  coerceOfacFlag(explain, res);

  // Wallet-age risk fallback (younger → higher risk)
  if (typeof explain.walletAgeRisk !== 'number') {
    const days = Number(res.feats?.ageDays ?? NaN);
    if (!Number.isNaN(days) && days >= 0) {
      explain.walletAgeRisk = clamp(1 - Math.min(1, days / (365 * 2)));
    }
  }

  // Neighbor proxies if native explain missing
  if (!explain.neighborsDormant && res.feats?.local?.riskyNeighborRatio != null) {
    const r = Number(res.feats.local.riskyNeighborRatio) || 0;
    explain.neighborsDormant = { inactiveRatio: clamp(r), avgInactiveAge: null, resurrected: 0, whitelistPct: 0, n: null };
  }
  if (!explain.neighborsAvgTxCount && res.feats?.local?.neighborAvgTx != null) {
    explain.neighborsAvgTxCount = { avgTx: Number(res.feats.local.neighborAvgTx) || 0, n: null };
  }
  if (!explain.neighborsAvgAge && res.feats?.local?.neighborAvgAgeDays != null) {
    explain.neighborsAvgAge = { avgDays: Number(res.feats.local.neighborAvgAgeDays) || 0, n: null };
  }

  return { ...res, id, address: id, score, explain, block: blocked, blocked };
}

/* ================== Init ======================================= */
async function init() {
  await post('INIT', {
    apiBase: (window.VisionConfig && window.VisionConfig.API_BASE) || "",
    cache: window.RiskCache,
    network: getNetwork(),
    ruleset: 'safesend-2025.10.1',
    concurrency: 8,
    flags: { graphSignals: true, streamBatch: true, neighborStats: true }
  });

  bindUI();
  seedDemo();
}
init();

/* ================== UI wiring ================================== */
function bindUI() {
  document.getElementById('refreshBtn')?.addEventListener('click', () => {
    scoreVisible();
  });

  document.getElementById('clearBtn')?.addEventListener('click', () => {
    window.graph?.setData({ nodes: [], links: [] });
    updateBatchStatus('Idle');
    setSelected(null);
    hideNarrativePanel();
  });

  document.getElementById('loadSeedBtn')?.addEventListener('click', () => {
    const seedRaw = document.getElementById('seedInput').value.trim();
    if (!seedRaw) return;
    const seed = normId(seedRaw);

    // Replace canvas with a single seed while we fetch live data
    setGraphData({ nodes:[{ id: seed, address: seed, network: getNetwork() }], links:[] });
    setSelected(seed);

    // Score + then pull live neighborhood
    post('SCORE_ONE', { item: { type:'address', id: seed, network: getNetwork() } })
      .then(r => {
        const rr = normalizeResult(r);
        updateScorePanel(rr);
        applyVisualCohesion(rr);
        renderNarrativePanelIfEnabled(rr);
      })
      .catch(()=>{});

    refreshGraphFromLive(seed).catch(()=>{});
  });

  document.getElementById('networkSelect')?.addEventListener('change', async () => {
    await post('INIT', { network: getNetwork() });
    scoreVisible();
  });

  // Node selection → rescore + refresh context + replace with live neighbors
  window.graph?.on('selectNode', (n) => {
    if (!n) return;
    const id = normId(n.id);
    setSelected(id);

    post('SCORE_ONE', { item: { type: 'address', id, network: getNetwork() } })
      .then(r => {
        const rr = normalizeResult(r);
        updateScorePanel(rr);
        applyVisualCohesion(rr);
        renderNarrativePanelIfEnabled(rr);
      })
      .catch(() => {});

    refreshGraphFromLive(id).catch(()=>{});
  });

  // Optional: rescore visible when viewport changes (if graph emits it)
  if (typeof window.graph?.on === 'function') {
    window.graph.on('viewportChanged', () => {
      clearTimeout(window.__RXL_VP_T__);
      window.__RXL_VP_T__ = setTimeout(scoreVisible, RXL_FLAGS.debounceViewportMs);
    });
  }

  // Narrative UI
  const modeSel = document.getElementById('rxlMode');
  if (modeSel) modeSel.addEventListener('change', () => lastRenderResult && renderNarrativePanelIfEnabled(lastRenderResult));
  const copyBtn = document.getElementById('rxlCopy');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const txt = document.getElementById('rxlNarrativeText')?.textContent || '';
    try { await navigator.clipboard.writeText(txt); flash(copyBtn, 'Copied!'); } catch {}
  });
  const exportBtn = document.getElementById('rxlExport');
  if (exportBtn) exportBtn.addEventListener('click', () => { /* exportRiskNarrativePDF(...) */ flash(exportBtn, 'Queued'); });
}

function getNetwork() { return document.getElementById('networkSelect')?.value || 'eth'; }
function normId(id){ return String(id||'').toLowerCase(); }

let selectedNodeId = null;
function setSelected(id) { selectedNodeId = normId(id); }

/* ================= Factor Weights + Builder ===================== */
const FACTOR_WEIGHTS = {
  'OFAC': 40,
  'OFAC/sanctions list match': 40,
  'sanctioned Counterparty': 40,
  'fan In High': 9,
  'shortest Path To Sanctioned': 6,
  'burst Anomaly': 0,
  'known Mixer Proximity': 0,
};

function computeBreakdownFrom(res){
  if (Array.isArray(res.breakdown) && res.breakdown.length) return res.breakdown;
  const src = res.reasons || res.risk_factors || [];
  if (!Array.isArray(src) || !src.length) return [];
  const list = src.map(label => ({ label: String(label), delta: FACTOR_WEIGHTS[label] ?? 0 }));
  const hasSanctionRef = list.some(x => /sanction|ofac/i.test(x.label));
  if ((res.block || res.blocked || res.risk_score === 100) && !hasSanctionRef) {
    list.unshift({ label: 'sanctioned Counterparty', delta: 40 });
  }
  return list.sort((a,b)=> (b.delta||0)-(a.delta||0));
}

/* ================= Score panel instance ========================= */
const scorePanel = (window.ScoreMeter && window.ScoreMeter('#scorePanel')) || {
  setSummary(){}, setScore(){}, setBlocked(){}, setReasons(){}, getScore(){ return 0; }
};

function updateScorePanel(res) {
  res.parity = (typeof res.parity === 'string' || res.parity === true) ? res.parity : 'SafeSend parity';

  const feats = res.feats || {};
  const ageDays = Number(feats.ageDays ?? 0);
  const ageDisplay = (ageDays > 0) ? fmtAgeDays(ageDays) : '—';

  // Dynamic factor list (no static defaults)
  res.breakdown = computeBreakdownFrom(res);

  // Visual blocked is stricter: any OFAC/sanction signal forces red
  const blocked = isBlockedVisual(res);
  res.blocked = blocked;

  scorePanel.setSummary(res);

  const mixerPct = Math.round((feats.mixerTaint ?? 0) * 100) + '%';
  const neighPct = Math.round((feats.local?.riskyNeighborRatio ?? 0) * 100) + '%';

  document.getElementById('entityMeta').innerHTML = `
    <div>Address: <b>${res.id}</b></div>
    <div>Network: <b>${res.network}</b></div>
    <div>Age: <b>${ageDisplay}</b></div>
    <div>Mixer taint: <b>${mixerPct}</b></div>
    <div>Neighbors flagged: <b>${neighPct}</b></div>
  `;
}

/* ================= Unified visuals (halo + ring) ================ */
function isBlockedVisual(res){
  return !!(res.block || res.blocked || res.risk_score === 100 ||
            res.sanctionHits || res.explain?.ofacHit || res.ofac === true);
}
function colorForScore(score, blocked){
  if (blocked) return '#ef4444';
  if (score >= 80) return '#ff3b3b';
  if (score >= 60) return '#ffb020';
  if (score >= 40) return '#ffc857';
  if (score >= 20) return '#22d37b';
  return '#00eec3';
}
function applyVisualCohesion(res){
  const blocked = isBlockedVisual(res);
  const color = colorForScore(res.score || 0, blocked);

  window.graph?.setHalo({
    id: res.id,
    blocked,
    color,
    pulse: blocked ? 'red' : 'auto',
    intensity: Math.max(0.25, (res.score||0)/100),
    tooltip: res.label
  });

  const panel = document.getElementById('scorePanel');
  if (panel) panel.style.setProperty('--ring-color', color);
}

/* ================= Graph halo (single source) =================== */
function drawHalo(res) { applyVisualCohesion(res); }

/* ================= Status line (Batch Status) =================== */
function updateBatchStatus(text) {
  const el = document.getElementById('batchStatus');
  if (el) el.textContent = text;
}

/* ================= Scoring pipeline ============================= */
function scoreVisible() {
  const viewNodes = getVisibleNodes();
  if (!viewNodes.length) { updateBatchStatus('No nodes in view'); return; }
  updateBatchStatus(`Batch: ${viewNodes.length} nodes`);
  const items = viewNodes.map(n => ({ type: 'address', id: normId(n.id), network: getNetwork() }));
  post('SCORE_BATCH', { items }).catch(err => console.error(err));
}

function getVisibleNodes() {
  const data = graphGetData();
  return data.nodes || [];
}

/* ================= Graph data helpers =========================== */
function graphGetData(){
  const g = window.graph;
  if (g && typeof g.getData === 'function') return g.getData();
  return { nodes: window.__VISION_NODES__ || [], links: window.__VISION_LINKS__ || [] };
}
function setGraphData({nodes, links}){
  window.__VISION_NODES__ = nodes || [];
  window.__VISION_LINKS__ = links || [];
  window.graph?.setData({ nodes: window.__VISION_NODES__, links: window.__VISION_LINKS__ });
}

/* ================= Demo seed graph ============================== */
function seedDemo() {
  // Single seed node only; we now replace with live neighbors on load/select
  const seed = '0xdemoseed00000000000000000000000000000001';
  setGraphData({ nodes:[{ id: seed, address: seed, network: getNetwork() }], links:[] });
  setSelected(seed);
}

/* ================= Neighbors (fetch/replace/highlight) ========= */
async function getNeighborsLive(centerId){
  try {
    const res = await post('NEIGHBORS', { id: centerId, network: getNetwork(), hop: 1, limit: 250 });
    if (res && Array.isArray(res.nodes) && Array.isArray(res.links)) return res;
  } catch {}
  return { nodes: [], links: [] };
}

async function refreshGraphFromLive(centerId){
  const { nodes, links } = await getNeighborsLive(centerId);
  if (!nodes.length && !links.length) return; // backend not ready → leave as-is

  const center = { id: normId(centerId), address: normId(centerId), network: getNetwork() };
  const nn = nodes.map(n => ({ ...n, id: normId(n.id || n.address) }));
  const ll = links.map(L => ({ a: normId(L.a || L.source || L.idA), b: normId(L.b || L.target || L.idB), weight: L.weight || 1 }));

  let haveCenter = nn.some(n => n.id === center.id);
  const finalNodes = haveCenter ? nn : [center, ...nn];

  // Ensure center connects to neighbors (defensive in case API omits some links)
  const knownNeighbors = new Set();
  for (const L of ll) {
    if (L.a === center.id) knownNeighbors.add(L.b);
    if (L.b === center.id) knownNeighbors.add(L.a);
  }
  for (const n of nn) {
    if (!knownNeighbors.has(n.id)) ll.push({ a: center.id, b: n.id, weight: 1 });
  }

  setGraphData({ nodes: finalNodes, links: ll });

  // Soft highlight neighbors, strong for center
  for (const n of finalNodes) {
    if (n.id !== center.id) window.graph?.setHalo({ id: n.id, color:'#22d37b', intensity:.5 });
  }
  window.graph?.setHalo({ id: center.id, intensity:.9 });
}

/* ================= Narrative Engine v1 =========================== */
let lastRenderResult = null;

function narrativeFromExplain(expl, mode = 'analyst') {
  const parts = [];

  const daysForNice = typeof lastRenderResult?.feats?.ageDays === 'number'
    ? lastRenderResult.feats.ageDays : null;
  const niceAge = daysForNice != null ? fmtAgeDays(daysForNice) : null;

  const ageRisk = Number(expl.walletAgeRisk ?? NaN);
  if (!Number.isNaN(ageRisk)) {
    if (ageRisk >= 0.6) parts.push(niceAge ? `newly created (${niceAge})` : 'newly created');
    else if (ageRisk <= 0.2) parts.push(niceAge ? `long-standing (${niceAge})` : 'long-standing');
  }

  const dorm = expl.neighborsDormant || {};
  if (typeof dorm.inactiveRatio === 'number' && dorm.inactiveRatio >= 0.6) {
    let bit = 'connected to multiple dormant aged wallets';
    if ((dorm.resurrected || 0) > 0) bit += ' (including recently re-activated addresses)';
    parts.push(bit);
  }

  const nc = expl.neighborsAvgTxCount || {};
  if (typeof nc.avgTx === 'number' && nc.avgTx >= 200) {
    parts.push('in a high-volume counterparty cluster');
  }

  if (expl.mixerLink) parts.push('with adjacency to mixer infrastructure');

  let text = 'This wallet is ' + (parts.length ? parts.join(', ') : 'under assessment') + '.';
  if (!expl.ofacHit) text += ' No direct OFAC link was found.';

  if (mode === 'consumer') {
    text = text.replace('This wallet is', 'Unusual pattern: this wallet')
               .replace(' No direct OFAC link was found.', '');
  }

  const badges = [];
  const push = (label, level='warn') => badges.push({ label, level });
  if (typeof dorm.inactiveRatio === 'number' && dorm.inactiveRatio >= 0.6) push('Dormant Cluster', 'risk');
  if (!Number.isNaN(ageRisk) && ageRisk >= 0.6) push('Young Wallet', 'warn');
  if (typeof nc.avgTx === 'number' && nc.avgTx >= 200) push('High Counterparty Volume', 'warn');
  push(expl.ofacHit ? 'OFAC' : 'No OFAC', expl.ofacHit ? 'risk' : 'safe');

  const factors = Array.isArray(expl.factorImpacts)
    ? [...expl.factorImpacts].sort((a,b)=>(b.delta||0)-(a.delta||0)).slice(0,5)
    : [];

  return { text, badges, factors };
}

function renderNarrativePanelIfEnabled(res) {
  lastRenderResult = res;
  if (!RXL_FLAGS.enableNarrative) return;
  const panel = document.getElementById('narrativePanel');
  if (!panel) return;

  const expl = res.explain || {};

  if (!expl.neighborsDormant && res.feats?.local?.riskyNeighborRatio != null) {
    const r = Number(res.feats.local.riskyNeighborRatio) || 0;
    expl.neighborsDormant = { inactiveRatio: clamp(r), avgInactiveAge: null, resurrected: 0, whitelistPct: 0, n: null };
  }
  if (!expl.neighborsAvgTxCount && res.feats?.local?.neighborAvgTx != null) {
    expl.neighborsAvgTxCount = { avgTx: Number(res.feats.local.neighborAvgTx) || 0, n: null };
  }
  if (typeof expl.walletAgeRisk !== 'number' && typeof res.feats?.ageDays === 'number') {
    const d = res.feats.ageDays;
    expl.walletAgeRisk = clamp(1 - Math.min(1, d / (365 * 2)));
  }

  const modeSel = document.getElementById('rxlMode');
  const mode = modeSel ? modeSel.value : 'analyst';
  let { text, badges, factors } = narrativeFromExplain(expl, mode);

  if ((!factors || !factors.length) && Array.isArray(res.breakdown)) {
    factors = res.breakdown.slice(0,5).map(x => ({ label: x.label, delta: x.delta, sourceKey: 'breakdown' }));
  }

  panel.hidden = false;

  const textEl = document.getElementById('rxlNarrativeText');
  if (textEl) textEl.textContent = text;

  const badgesEl = document.getElementById('rxlBadges');
  if (badgesEl) {
    badgesEl.innerHTML = '';
    badges.forEach(b => {
      const span = document.createElement('span');
      span.className = `badge ${badgeClass(b.level)}`;
      span.textContent = b.label;
      badgesEl.appendChild(span);
    });
  }

  const tbody = document.querySelector('#rxlFactors tbody');
  if (tbody) {
    tbody.innerHTML = '';
    const rows = (factors && factors.length) ? factors : defaultFactorRowsFrom(res);
    rows.forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${row.label}</td>
        <td>${row.metrics || deriveMetrics(res, row.sourceKey)}</td>
        <td style="text-align:right;">${row.delta != null ? ('+' + row.delta) : '—'}</td>
        <td><code>${row.sourceKey || 'derived'}</code></td>
      `;
      tbody.appendChild(tr);
    });
  }
}

function hideNarrativePanel(){
  const panel = document.getElementById('narrativePanel');
  if (panel) panel.hidden = true;
}

function defaultFactorRowsFrom(res){
  return [
    { label: 'Dormant neighbors', sourceKey:'neighborsDormant' },
    { label: 'Neighbors avg tx',  sourceKey:'neighborsAvgTxCount' },
    { label: 'Neighbors avg age', sourceKey:'neighborsAvgAge' },
    { label: 'Wallet age',        sourceKey:'walletAgeRisk' },
    { label: 'OFAC',              sourceKey:'ofacHit' }
  ];
}

function deriveMetrics(res, key){
  const e = res.explain || {};
  switch (key) {
    case 'neighborsDormant': {
      const d = e.neighborsDormant || {};
      if (typeof d.inactiveRatio === 'number') {
        return `inactiveRatio ${(d.inactiveRatio*100).toFixed(1)}%` +
               (d.avgInactiveAge ? `, avgAge ${Math.round(d.avgInactiveAge)}d` : '');
      }
      const r = res.feats?.local?.riskyNeighborRatio;
      return (typeof r === 'number') ? `proxyRatio ${(r*100).toFixed(1)}%` : '—';
    }
    case 'neighborsAvgTxCount': {
      const v = e.neighborsAvgTxCount?.avgTx ?? res.feats?.local?.neighborAvgTx;
      return (typeof v === 'number') ? `avgTx ${Math.round(v)}` : '—';
    }
    case 'neighborsAvgAge': {
      const v = e.neighborsAvgAge?.avgDays ?? res.feats?.local?.neighborAvgAgeDays;
      return (typeof v === 'number') ? `avgDays ${Math.round(v)}` : '—';
    }
    case 'walletAgeRisk': {
      const days = typeof res.feats?.ageDays === 'number' ? res.feats.ageDays : null;
      return days != null ? fmtAgeDays(days) : '—';
    }
    case 'ofacHit':
      return (res.sanctionHits || e.ofacHit) ? 'hit' : 'none';
    default:
      return '—';
  }
}

function badgeClass(level){
  switch(level){
    case 'risk': return 'badge-risk';
    case 'safe': return 'badge-safe';
    default:     return 'badge-warn';
  }
}

/* ================= Utilities ==================================== */
function clamp(x, a=0, b=1){ return Math.max(a, Math.min(b, x)); }
function fmtAgeDays(days){
  if(!(days > 0)) return '—';
  const totalMonths = Math.round(days / 30.44);
  const y = Math.floor(totalMonths / 12);
  const m = totalMonths % 12;
  if (y > 0 && m > 0) return `${y}y ${m}m`;
  if (y > 0) return `${y}y`;
  return `${m}m`;
}
function flash(btn, msg){ const keep = btn.textContent; btn.textContent = msg; setTimeout(()=>btn.textContent = keep, 900); }
function hasReason(res, kw){
  const arr = res.reasons || res.risk_factors || [];
  const txt = Array.isArray(arr) ? JSON.stringify(arr).toLowerCase() : String(arr).toLowerCase();
  return txt.includes(kw);
}
function coerceOfacFlag(explain, res){
  const hit = !!(res.sanctionHits || res.sanctioned || res.ofac || hasReason(res, 'ofac') || hasReason(res, 'sanction'));
  explain.ofacHit = hit;
  return hit;
}
