import './ui/ScoreMeter.js?v=2025-11-02';     // provides window.ScoreMeter(...)
import './graph.js?v=2025-11-02';             // provides window.graph (on/setData/setHalo)

/* ================= RXL FLAGS (safe defaults) ==================== */
const RXL_FLAGS = Object.freeze({
  enableNarrative: true  // flip false to hide Narrative panel entirely
});

/* ================= Worker plumbing ============================== */
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
  // Prefer server risk_score (100 on OFAC), else fallback to res.score
  const serverScore = (typeof res.risk_score === 'number') ? res.risk_score : null;
  const score = (serverScore != null) ? serverScore : (typeof res.score === 'number' ? res.score : 0);

  // Blocked if server says block, or risk_score=100, or explicit sanction hit
  const blocked = !!(res.block || serverScore === 100 || res.sanctionHits);

  // Preserve upstream explain or create a shell
  const explain = res.explain && typeof res.explain === 'object'
    ? { ...res.explain }
    : { reasons: res.reasons || res.risk_factors || [] };

  // Robust OFAC boolean for UI/badges
  coerceOfacFlag(explain, res);

  // Wallet age risk (fallback from feats.ageDays → 0..1; younger = riskier)
  if (typeof explain.walletAgeRisk !== 'number') {
    const days = Number(res.feats?.ageDays ?? NaN);
    if (!Number.isNaN(days) && days >= 0) {
      explain.walletAgeRisk = clamp(1 - Math.min(1, days / (365 * 2)));
    }
  }

  // Map any neighbor proxies if native fields absent
  if (!explain.neighborsDormant && res.feats?.local?.riskyNeighborRatio != null) {
    const r = Number(res.feats.local.riskyNeighborRatio) || 0;
    explain.neighborsDormant = {
      inactiveRatio: clamp(r),
      avgInactiveAge: null,
      resurrected: 0,
      whitelistPct: 0,
      n: null
    };
  }
  if (!explain.neighborsAvgTxCount && res.feats?.local?.neighborAvgTx != null) {
    explain.neighborsAvgTxCount = { avgTx: Number(res.feats.local.neighborAvgTx) || 0, n: null };
  }
  if (!explain.neighborsAvgAge && res.feats?.local?.neighborAvgAgeDays != null) {
    explain.neighborsAvgAge = { avgDays: Number(res.feats.local.neighborAvgAgeDays) || 0, n: null };
  }

  return {
    ...res,
    score,
    explain,
    block: blocked,
    blocked
  };
}

/* ================== Init ======================================= */
async function init() {
  await post('INIT', {
    apiBase: (window.VisionConfig && window.VisionConfig.API_BASE) || "",
    cache: window.RiskCache,
    network: getNetwork(),
    ruleset: 'safesend-2025.10.1',
    concurrency: 8,
    flags: { graphSignals: true, streamBatch: true, neighborStats: true } // neighborStats is safe if worker ignores it
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
    const seed = document.getElementById('seedInput').value.trim();
    if (!seed) return;
    loadSeed(seed);
  });

  document.getElementById('networkSelect')?.addEventListener('change', async () => {
    await post('INIT', { network: getNetwork() });
    scoreVisible();
  });

  // Graph selection → score and render
  window.graph?.on('selectNode', (n) => {
    if (!n) return;
    setSelected(n.id);
    post('SCORE_ONE', { item: { type: 'address', id: n.id, network: getNetwork() } })
      .then(r => {
        const rr = normalizeResult(r);
        updateScorePanel(rr);
        renderNarrativePanelIfEnabled(rr);
      })
      .catch(() => {});
  });

  // Narrative UI actions (exist only if panel is present in index.html)
  const modeSel = document.getElementById('rxlMode');
  if (modeSel) {
    modeSel.addEventListener('change', () => {
      if (lastRenderResult) renderNarrativePanelIfEnabled(lastRenderResult);
    });
  }
  const copyBtn = document.getElementById('rxlCopy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const txt = document.getElementById('rxlNarrativeText')?.textContent || '';
      try {
        await navigator.clipboard.writeText(txt);
        flash(copyBtn, 'Copied!');
      } catch {}
    });
  }
  const exportBtn = document.getElementById('rxlExport');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      // Hook into your export util if desired:
      // exportRiskNarrativePDF({ result: lastRenderResult, narrative: document.getElementById('rxlNarrativeText')?.textContent || '' });
      flash(exportBtn, 'Queued');
    });
  }
}

function getNetwork() {
  return document.getElementById('networkSelect')?.value || 'eth';
}

let selectedNodeId = null;
function setSelected(id) { selectedNodeId = id; }

/* ================= Score panel instance ========================= */
const scorePanel = (window.ScoreMeter && window.ScoreMeter('#scorePanel')) || {
  setSummary(){}, setScore(){}, setBlocked(){}, setReasons(){}, getScore(){ return 0; }
};

function updateScorePanel(res) {
  // Ensure SafeSend badge
  res.parity = (typeof res.parity === 'string' || res.parity === true)
    ? res.parity
    : 'SafeSend parity';

  // ----- AGE (convert from days → years + months) -----
  const feats = res.feats || {};
  const ageDays = Number(feats.ageDays ?? 0);
  let ageDisplay = '—';
  if (ageDays > 0) {
    ageDisplay = fmtAgeDays(ageDays);
  }

  // ----- Inject default factor weights if none provided -----
  const defaultBreakdown = [
    { label: 'sanctioned Counterparty', delta: 40 },
    { label: 'fan In High', delta: 9 },
    { label: 'shortest Path To Sanctioned', delta: 6 },
    { label: 'burst Anomaly', delta: 0 },
    { label: 'known Mixer Proximity', delta: 0 }
  ];
  if (!Array.isArray(res.breakdown) || res.breakdown.length === 0) {
    res.breakdown = defaultBreakdown;
  }

  // ----- Keep numeric score even when blocked -----
  const blocked = !!(res.block || res.risk_score === 100 || res.sanctionHits);
  res.blocked = blocked;

  // Render the new unified card
  scorePanel.setSummary(res);

  // ----- Meta summary section -----
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

/* ================= Graph halo ================================== */
function drawHalo(res) {
  // “blocked = red” handled inside graph.setHalo(res) if your graph module honors blocked
  window.graph?.setHalo(res);

  // If you still want custom ring color by score for non-blocked cases, keep this as reference
  // const color = res.score >= 80 ? '#ff3b3b'
  //            : res.score >= 60 ? '#ffb020'
  //            : res.score >= 40 ? '#ffc857'
  //            : res.score >= 20 ? '#22d37b'
  //            : '#00eec3';
  // window.graph?.setHalo(res.id, { intensity: res.score / 100, color, tooltip: res.label });
}

function updateBatchStatus(text) {
  const el = document.getElementById('batchStatus');
  if (el) el.textContent = text;
}

/* ================= Scoring pipeline ============================= */
function scoreVisible() {
  const viewNodes = getVisibleNodes();
  if (!viewNodes.length) { updateBatchStatus('No nodes in view'); return; }
  updateBatchStatus(`Batch: ${viewNodes.length} nodes`);
  const items = viewNodes.map(n => ({ type: 'address', id: n.id, network: getNetwork() }));
  post('SCORE_BATCH', { items }).catch(err => console.error(err));
}

// Replace this with your real graph viewport nodes when ready
function getVisibleNodes() {
  const sample = window.__VISION_NODES__ || [];
  return sample;
}

/* ================= Demo seed graph ============================== */
function seedDemo() {
  const seed = '0xDEMOSEED00000000000000000000000000000001';
  loadSeed(seed);
}

function loadSeed(seed) {
  const n = 14, nodes = [], links = [];
  for (let i = 0; i < n; i++) {
    const a = '0x' + Math.random().toString(16).slice(2).padStart(40, '0').slice(0, 40);
    nodes.push({ id: a, address: a, network: getNetwork() });
    links.push({ a: seed, b: a, weight: 1 });
  }
  nodes.unshift({ id: seed, address: seed, network: getNetwork() });
  window.__VISION_NODES__ = nodes;
  window.graph?.setData({ nodes, links });
  setSelected(seed);
  scoreVisible();
}

/* ================= Narrative Engine v1 =========================== */
let lastRenderResult = null;

function narrativeFromExplain(expl, mode = 'analyst') {
  const parts = [];

  // Nice age for phrasing (use last render result feats if available)
  const daysForNice = typeof lastRenderResult?.feats?.ageDays === 'number'
    ? lastRenderResult.feats.ageDays : null;
  const niceAge = daysForNice != null ? fmtAgeDays(daysForNice) : null;

  // Age posture
  const ageRisk = Number(expl.walletAgeRisk ?? NaN);
  if (!Number.isNaN(ageRisk)) {
    if (ageRisk >= 0.6) parts.push(niceAge ? `newly created (${niceAge})` : 'newly created');
    else if (ageRisk <= 0.2) parts.push(niceAge ? `long-standing (${niceAge})` : 'long-standing');
  }

  // Dormant neighbors
  const dorm = expl.neighborsDormant || {};
  if (typeof dorm.inactiveRatio === 'number' && dorm.inactiveRatio >= 0.6) {
    let bit = 'connected to multiple dormant aged wallets';
    if ((dorm.resurrected || 0) > 0) bit += ' (including recently re-activated addresses)';
    parts.push(bit);
  }

  // High counterparty activity among neighbors
  const nc = expl.neighborsAvgTxCount || {};
  if (typeof nc.avgTx === 'number' && nc.avgTx >= 200) {
    parts.push('in a high-volume counterparty cluster');
  }

  // Mixer adjacency (if present)
  if (expl.mixerLink) parts.push('with adjacency to mixer infrastructure');

  // Compose
  let text = 'This wallet is ' + (parts.length ? parts.join(', ') : 'under assessment') + '.';
  if (!expl.ofacHit) text += ' No direct OFAC link was found.';

  // Consumer tone (shorter)
  if (mode === 'consumer') {
    text = text
      .replace('This wallet is', 'Unusual pattern: this wallet')
      .replace(' No direct OFAC link was found.', '');
  }

  // Badges
  const badges = [];
  const push = (label, level='warn') => badges.push({ label, level });
  if (typeof dorm.inactiveRatio === 'number' && dorm.inactiveRatio >= 0.6) push('Dormant Cluster', 'risk');
  if (!Number.isNaN(ageRisk) && ageRisk >= 0.6) push('Young Wallet', 'warn');
  if (typeof nc.avgTx === 'number' && nc.avgTx >= 200) push('High Counterparty Volume', 'warn');
  push(expl.ofacHit ? 'OFAC' : 'No OFAC', expl.ofacHit ? 'risk' : 'safe');

  // Factors (use upstream deltas if present)
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

  // Backfill neighbors from feats if needed (so v1 works before worker upgrade)
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
  const { text, badges, factors } = narrativeFromExplain(expl, mode);

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
      return days != null ? fmtAgeDays(days) : '—'; // match Details format
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

function flash(btn, msg){
  const keep = btn.textContent;
  btn.textContent = msg;
  setTimeout(()=>btn.textContent = keep, 900);
}

function hasReason(res, kw){
  const arr = res.reasons || res.risk_factors || [];
  const txt = Array.isArray(arr) ? JSON.stringify(arr).toLowerCase() : String(arr).toLowerCase();
  return txt.includes(kw);
}
function coerceOfacFlag(explain, res){
  const hit = !!(
    res.sanctionHits || res.sanctioned || res.ofac ||
    hasReason(res, 'ofac') || hasReason(res, 'sanction')
  );
  explain.ofacHit = hit;
  return hit;
}
