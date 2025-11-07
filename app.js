// app.js — Vision 1_4_2 (neighbors instrumentation, spinner, stats stream, debounced UI)
import './ui/ScoreMeter.js?v=2025-11-02';
import './graph.js?v=2025-11-05';

const RXL_FLAGS = Object.freeze({
  enableNarrative: true,
  debounceMs: 180,            // re-renders while batches run
  labelThreshold: 150,
  defaultCap: 120,            // deterministic neighbor cap
  moreStep: 120               // "load more" increments
});

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
  const looksLikeGraph = data && typeof data === 'object' && Array.isArray(data.nodes) && Array.isArray(data.links);

  if (type === 'INIT_OK') {
    if (req) { req.resolve(true); pending.delete(id); }
    return;
  }

  if (type === 'RESULT_STREAM') {
    const r = normalizeResult(data);
    afterScore(r, { debounced:true });
    return;
  }

  if (type === 'RESULT') {
    if (looksLikeGraph) {
      // Received neighbors graph (already capped). Render & status.
      setGraphData(data);
      toggleLabelsByCount();
      setGraphStatus(`Neighbors loaded: ${(data.nodes?.length||0) - 1}${neighborOverflow > 0 ? ` (+${neighborOverflow} more)` : ''}`);
      if (req) { req.resolve(data); pending.delete(id); }
      return;
    }
    const r = normalizeResult(data || {});
    afterScore(r, { debounced:true });
    if (req) { req.resolve(r); pending.delete(id); }
    return;
  }

  if (type === 'NEIGHBOR_STATS') {
    // Merge worker-computed stats into local cache & re-render
    if (data?.id) {
      setNeighborStats(data.id, data); // cache
      if (selectedNodeId === data.id) {
        const cached = getScore(data.id);
        if (cached) {
          const merged = normalizeResult(cached);
          afterScore(merged, { force:true });
        }
      }
    }
    setGraphStatus(formatNeighborStatusLine(data));
    return;
  }

  if (type === 'DONE') {
    setGraphStatus('Neighbors scored.');
    if (req) { req.resolve(true); pending.delete(id); }
    return;
  }

  if (type === 'ERROR') {
    console.error('[worker ERROR]', error);
    setGraphStatus('Error loading neighbors');
    if (req) { req.reject(new Error(error)); pending.delete(id); }
    return;
  }
};

/* ================= State / helpers ================= */
function getNetwork(){ return document.getElementById('networkSelect')?.value || 'eth'; }
function normId(x){ return String(x||'').toLowerCase(); }
function clamp(x,a=0,b=1){ return Math.max(a, Math.min(b, x)); }
function fmtAgeDays(days){
  if(!(days > 0)) return '—';
  const totalMonths = Math.round(days / 30.44);
  const y = Math.floor(totalMonths/12), m = totalMonths % 12;
  if (y>0 && m>0) return `${y}y ${m}m`;
  if (y>0) return `${y}y`;
  return `${m}m`;
}
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
function updateBatchStatus(t){ const el = document.getElementById('batchStatus'); if (el) el.textContent = t; }

/* caches */
const scoreCache = new Map();           // `${network}:${id}` -> result
function keyFor(addr){ return `${getNetwork()}:${normId(addr)}`; }
function putScore(res){ scoreCache.set(keyFor(res.id), res); }
function getScore(addr){ return scoreCache.get(keyFor(addr)); }

const neighborStats = new Map();        // `${network}:${id}` -> stats from worker
function setNeighborStats(addr, stats){ neighborStats.set(keyFor(addr), stats); }
function getNeighborStats(addr){ return neighborStats.get(keyFor(addr)); }

/* selection & history */
let selectedNodeId = null;
function setSelected(id){ selectedNodeId = normId(id); }

const backStack = []; const fwdStack = [];
function pushHistory(id){ if (backStack.at(-1) !== id) backStack.push(id); fwdStack.length = 0; updateNavButtons(); }
function navBack(){ if (backStack.length <= 1) return; const cur = backStack.pop(); fwdStack.push(cur); focusAddress(backStack.at(-1), { fromHistory:true }); }
function navForward(){ if (!fwdStack.length) return; const next = fwdStack.pop(); backStack.push(next); focusAddress(next, { fromHistory:true }); }
function updateNavButtons(){
  document.getElementById('btnBack')?.toggleAttribute('disabled', backStack.length <= 1);
  document.getElementById('btnFwd')?.toggleAttribute('disabled', fwdStack.length === 0);
}

/* neighbor cap / load more */
let neighborCap = RXL_FLAGS.defaultCap;
let neighborOverflow = 0;

/* debounce */
let rerenderTimer = null;
function debouncedRender(fn){
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(fn, RXL_FLAGS.debounceMs);
}

/* ================= Normalize + post-score ================= */
function normalizeResult(res = {}) {
  const id = normId(res.id || res.address);
  const serverScore = (typeof res.risk_score === 'number') ? res.risk_score : null;
  const score = (serverScore != null) ? serverScore : (typeof res.score === 'number' ? res.score : 0);
  const blocked = !!(res.block || serverScore === 100 || res.sanctionHits);

  const explain = res.explain && typeof res.explain === 'object'
    ? { ...res.explain }
    : { reasons: res.reasons || res.risk_factors || [] };

  coerceOfacFlag(explain, res);

  if (typeof explain.walletAgeRisk !== 'number') {
    const days = Number(res.feats?.ageDays ?? NaN);
    if (!Number.isNaN(days) && days >= 0) explain.walletAgeRisk = clamp(1 - Math.min(1, days / (365 * 2)));
  }

  const ns = getNeighborStats(id);
  if (ns) {
    explain.neighborsDormant   = { inactiveRatio: ns.inactiveRatio, n: ns.n, avgInactiveAge: ns.avgInactiveAge ?? null };
    if (ns.avgTx != null)  explain.neighborsAvgTxCount = { avgTx: ns.avgTx, n: ns.n };
    if (ns.avgDays != null) explain.neighborsAvgAge     = { avgDays: ns.avgDays, n: ns.n };
    explain.sparseNeighborhood = !!ns.sparseNeighborhood;
  }

  return { ...res, id, address:id, score, explain, block: blocked, blocked };
}

function afterScore(r, { debounced=false, force=false } = {}){
  putScore(r);
  if (r.id !== selectedNodeId) return;
  const doRender = () => {
    updateScorePanel(r);
    applyVisualCohesion(r);
    renderNarrativePanelIfEnabled(r);
  };
  if (force) doRender();
  else if (debounced) debouncedRender(doRender);
  else doRender();
}

/* ================= Init & UI ================= */
async function init(){
  await post('INIT', {
    apiBase: (window.VisionConfig && window.VisionConfig.API_BASE) || "",
    network: getNetwork(), concurrency: 8,
    flags: { graphSignals:true, streamBatch:true, neighborStats:true }
  });

  bindUI();
  buildGraphControls();
  seedDemo();
}
init();

function bindUI(){
  document.getElementById('refreshBtn')?.addEventListener('click', scoreVisible);
  document.getElementById('clearBtn')?.addEventListener('click', () => {
    window.graph?.setData({ nodes:[], links:[] });
    setSelected(null); hideNarrativePanel(); updateBatchStatus('Idle');
    setGraphStatus('Idle');
  });
  document.getElementById('networkSelect')?.addEventListener('change', async () => {
    await post('INIT', { network:getNetwork() });
    scoreCache.clear(); neighborStats.clear();
    scoreVisible();
  });
  document.getElementById('loadSeedBtn')?.addEventListener('click', () => {
    const seed = normId(document.getElementById('seedInput').value.trim());
    if (!seed) return;
    focusAddress(seed);
  });

  const g = window.graph;
  if (g && typeof g.on === 'function') {
    g.on('selectNode', (n) => { if (!n) return; const id = normId(n.id); debouncedRender(() => focusAddress(id)); });
    g.on('hoverNode', (n) => { if (!n) { hideTooltip(); return; } showTooltip(n); });
    g.on('dataChanged', () => toggleLabelsByCount());
  }
}

/* ================= Graph controls & status ================= */
function buildGraphControls(){
  const host = document.getElementById('graph'); if (!host) return;
  const box = document.createElement('div');
  box.className = 'graph-controls';
  box.innerHTML = `
    <button id="btnBack" class="btn btn-ghost" disabled>◀</button>
    <button id="btnFwd"  class="btn btn-ghost" disabled>▶</button>
    <span style="flex:1"></span>
    <button id="btnReset" class="btn btn-ghost">Reset</button>
    <button id="btnFit"   class="btn">Zoom Fit</button>`;
  host.appendChild(box);
  box.querySelector('#btnBack').addEventListener('click', navBack);
  box.querySelector('#btnFwd').addEventListener('click', navForward);
  box.querySelector('#btnReset').addEventListener('click', () => window.graph?.resetView());
  box.querySelector('#btnFit').addEventListener('click', () => window.graph?.zoomFit());

  // Status line + spinner + "Load more"
  const status = document.createElement('div');
  status.id = 'graphStatus';
  status.style.cssText = 'position:absolute;left:12px;bottom:10px;right:12px;font-size:12px;color:#8aa3a0;display:flex;gap:8px;align-items:center;pointer-events:none;';
  status.innerHTML = `<span id="graphSpin" style="display:none">⏳</span><span id="graphStatusText">Idle</span><span style="flex:1"></span><button id="btnMore" class="btn btn-ghost" style="pointer-events:auto;display:none">Load more</button>`;
  host.appendChild(status);
  document.getElementById('btnMore')?.addEventListener('click', () => {
    neighborCap += RXL_FLAGS.moreStep;
    if (selectedNodeId) refreshGraphFromLive(selectedNodeId, { cap: neighborCap });
  });

  const st = document.createElement('style');
  st.textContent = `
    #graph{ position:relative }
    .graph-controls{ position:absolute; top:8px; right:8px; left:8px; display:flex; gap:6px; align-items:center; z-index:3; }
  `;
  document.head.appendChild(st);
}

function setGraphStatus(txt, { loading=false, overflow=0 } = {}){
  const spin = document.getElementById('graphSpin');
  const t = document.getElementById('graphStatusText');
  const moreBtn = document.getElementById('btnMore');
  if (spin) spin.style.display = loading ? 'inline' : 'none';
  if (t) t.textContent = txt || '';
  if (moreBtn) moreBtn.style.display = overflow > 0 ? 'inline-block' : 'none';
}

function formatNeighborStatusLine(s){
  if (!s) return 'Neighbors: (waiting on stats…)';
  const pct = typeof s.inactiveRatio === 'number' ? `, inactive ${(s.inactiveRatio*100).toFixed(1)}%` : '';
  const n = s.n ?? 0;
  const extra = s.overflow > 0 ? ` (+${s.overflow} more)` : '';
  const lim = s.sparseNeighborhood ? ' — Limited neighbor data—metrics may be conservative.' : '';
  neighborOverflow = s.overflow || 0;
  return `Neighbors: ${n}${extra}${pct}${lim}`;
}

/* ================= Focus / navigate ================= */
async function focusAddress(addr, opts = {}){
  const id = normId(addr);
  setSelected(id);
  if (!opts.fromHistory) pushHistory(id);

  window.graph?.flashHalo(id);

  const cached = getScore(id);
  if (cached) {
    afterScore(normalizeResult(cached));
  } else {
    post('SCORE_ONE', { item:{ type:'address', id, network:getNetwork() } })
      .then(r => afterScore(normalizeResult(r), { debounced:true }))
      .catch(()=>{});
  }

  setGraphStatus('Loading neighbors…', { loading:true, overflow:0 });
  neighborCap = RXL_FLAGS.defaultCap;
  await refreshGraphFromLive(id, { cap: neighborCap });
  window.graph?.centerOn(id, { animate:true });
  window.graph?.zoomFit();
}

/* ================= Tooltip ================= */
function showTooltip(n){
  const addr = normId(n.id);
  const cached = getScore(addr);
  const ns = getNeighborStats(addr);
  const ofac = !!cached?.explain?.ofacHit;
  const ageDays = cached?.feats?.ageDays ?? null;
  const niceAge = ageDays ? fmtAgeDays(ageDays) : '—';
  const neighCount = ns?.n ?? ((window.graph?.getData()?.nodes?.length || 1) - 1);

  const tip = document.getElementById('rxlTooltip');
  if (!tip) return;
  tip.innerHTML = `
    <div style="opacity:.8;">${addr.slice(0,10)}…${addr.slice(-6)}</div>
    <div>Age: <b>${niceAge}</b></div>
    <div>Neighbors: <b>${neighCount}</b></div>
    <div>Badges: ${ofac ? '<span class="badge badge-risk">OFAC</span>' : '<span class="badge badge-safe">No OFAC</span>'}</div>`;
  tip.style.display = 'block';
  tip.style.left = (n.__px + 12) + 'px';
  tip.style.top  = (n.__py + 12) + 'px';
}
function hideTooltip(){ const tip = document.getElementById('rxlTooltip'); if (tip) tip.style.display = 'none'; }

/* ================= Batch scoring ================= */
function scoreVisible(){
  const vs = (graphGetData().nodes || []).map(n => ({ type:'address', id:normId(n.id), network:getNetwork() }));
  if (!vs.length) return updateBatchStatus('No nodes in view');
  updateBatchStatus(`Batch: ${vs.length} nodes`);
  const items = vs.filter(v => !getScore(v.id));
  if (items.length) post('SCORE_BATCH', { items }).catch(()=>{});
}

/* ================= Graph helpers ================= */
function graphGetData(){
  const g = window.graph;
  if (g && typeof g.getData === 'function') return g.getData();
  return { nodes: window.__VISION_NODES__||[], links: window.__VISION_LINKS__||[] };
}
function setGraphData({nodes, links}){
  window.__VISION_NODES__ = nodes || [];
  window.__VISION_LINKS__ = links || [];
  window.__SHOW_LABELS_BELOW__ = RXL_FLAGS.labelThreshold;
  window.graph?.setData({ nodes: window.__VISION_NODES__, links: window.__VISION_LINKS__ });
}
function toggleLabelsByCount(){
  const count = (graphGetData().nodes || []).length;
  window.graph?.setLabelVisibility(count <= RXL_FLAGS.labelThreshold);
}

/* ================= Demo seed ================= */
function seedDemo(){
  const seed = '0xdemoseed00000000000000000000000000000001';
  setGraphData({ nodes:[{ id:seed, address:seed, network:getNetwork() }], links:[] });
  setSelected(seed);
}

/* ================= Neighbors ================= */
async function getNeighborsLive(centerId, { cap }){
  try {
    const res = await post('NEIGHBORS', { id: centerId, network: getNetwork(), hop: 1, limit: cap, cap });
    if (res && Array.isArray(res.nodes) && Array.isArray(res.links)) return res;
  } catch {}
  return { nodes: [], links: [] };
}

async function refreshGraphFromLive(centerId, { cap }){
  const { nodes, links } = await getNeighborsLive(centerId, { cap });
  if (!nodes.length && !links.length) {
    setGraphStatus('No neighbors found.');
    return;
  }
  // RESULT handler already setData; here just update status while worker scores/stat streams
  setGraphStatus(`Neighbors loaded: ${(nodes.length||0)-1}${neighborOverflow>0?` (+${neighborOverflow} more)`:''}`, { loading:true, overflow: neighborOverflow });
}

/* ================= Score panel / visuals / narrative ================= */
const FACTOR_WEIGHTS = {
  'OFAC': 40, 'OFAC/sanctions list match': 40, 'sanctioned Counterparty': 40,
  'fan In High': 9, 'shortest Path To Sanctioned': 6, 'burst Anomaly': 0, 'known Mixer Proximity': 0,
};
const scorePanel = (window.ScoreMeter && window.ScoreMeter('#scorePanel')) || {
  setSummary(){}, setScore(){}, setBlocked(){}, setReasons(){}, getScore(){ return 0; }
};
function computeBreakdownFrom(res){
  if (Array.isArray(res.breakdown) && res.breakdown.length) return res.breakdown;
  const src = res.reasons || res.risk_factors || [];
  if (!Array.isArray(src) || !src.length) return [];
  const list = src.map(label => ({ label: String(label), delta: FACTOR_WEIGHTS[label] ?? 0 }));
  const hasSanctionRef = list.some(x => /sanction|ofac/i.test(x.label));
  if ((res.block || res.blocked || res.risk_score === 100) && !hasSanctionRef) list.unshift({ label:'sanctioned Counterparty', delta:40 });
  return list.sort((a,b)=> (b.delta||0)-(a.delta||0));
}
function isBlockedVisual(res){ return !!(res.block || res.blocked || res.risk_score === 100 || res.sanctionHits || res.explain?.ofacHit || res.ofac === true); }
function colorForScore(score, blocked){
  if (blocked) return '#ef4444';
  if (score >= 80) return '#ff3b3b';
  if (score >= 60) return '#ffb020';
  if (score >= 40) return '#ffc857';
  if (score >= 20) return '#22d37b';
  return '#00eec3';
}
function updateScorePanel(res){
  res.parity = (typeof res.parity === 'string' || res.parity === true) ? res.parity : 'SafeSend parity';
  const feats = res.feats || {};
  const ageDays = Number(feats.ageDays ?? 0);
  const ageDisplay = (ageDays > 0) ? fmtAgeDays(ageDays) : '—';
  res.breakdown = computeBreakdownFrom(res);
  res.blocked = isBlockedVisual(res);
  scorePanel.setSummary(res);

  // Tiny neighbor summary line (under meter)
  const ns = getNeighborStats(res.id);
  const nStr = ns?.n != null ? `${ns.n}` : '—';
  const avgAge = ns?.avgDays != null ? fmtAgeDays(ns.avgDays) : '—';
  const inact = ns?.inactiveRatio != null ? `${Math.round(ns.inactiveRatio*100)}%` : '—';
  const sparse = ns?.sparseNeighborhood ? ' (limited data)' : '';

  const mixerPct = Math.round((feats.mixerTaint ?? 0) * 100) + '%';
  const neighPct = Math.round((res.explain?.neighborsDormant?.inactiveRatio ?? res.feats?.local?.riskyNeighborRatio ?? 0) * 100) + '%';
  const meta = document.getElementById('entityMeta');
  if (meta) {
    meta.innerHTML = `
      <div>Address: <b>${res.id}</b></div>
      <div>Network: <b>${res.network}</b></div>
      <div>Age: <b>${ageDisplay}</b></div>
      <div>Mixer taint: <b>${mixerPct}</b></div>
      <div>Neighbors flagged: <b>${neighPct}</b></div>
      <div class="muted">Neighbors: <b>${nStr}</b> • Avg age <b>${avgAge}</b> • Inactive <b>${inact}</b>${sparse}</div>
    `;
  }
}
function applyVisualCohesion(res){
  const blocked = isBlockedVisual(res);
  const color = colorForScore(res.score || 0, blocked);
  window.graph?.setHalo({ id:res.id, blocked, color, pulse: blocked ? 'red' : 'auto', intensity: Math.max(0.25, (res.score||0)/100), tooltip: res.label });
  const panel = document.getElementById('scorePanel');
  if (panel) panel.style.setProperty('--ring-color', color);
}

/* ================= Narrative render ================= */
function renderNarrativePanelIfEnabled(res) {
  if (!RXL_FLAGS.enableNarrative) return;
  const panel = document.getElementById('narrativePanel');
  if (!panel) return;

  const expl = res.explain || {};
  const ofac = !!expl.ofacHit;
  const ns   = getNeighborStats(res.id) || {};
  const avgTx = ns.avgTx ?? null;
  const avgDays = ns.avgDays ?? null;

  const bits = [];
  if (ofac) bits.push('direct OFAC match');
  if (typeof res.feats?.ageDays === 'number') {
    const k = res.explain?.walletAgeRisk ?? 0;
    bits.push(k >= 0.6 ? `newly created (${fmtAgeDays(res.feats.ageDays)})` : `long-standing (${fmtAgeDays(res.feats.ageDays)})`);
  }
  if (typeof ns.inactiveRatio === 'number' && ns.inactiveRatio >= 0.6) bits.push('connected to a dormant cluster');
  if (typeof avgTx === 'number' && avgTx >= 200) bits.push('high-volume counterparty cluster');
  if (ns.sparseNeighborhood) bits.push('limited neighbor data—metrics may be conservative');

  const txt = bits.length
    ? 'This wallet is ' + bits.join(', ') + (ofac ? '.' : '. No direct OFAC link was found.')
    : (ofac ? 'OFAC match detected.' : 'No direct OFAC link was found.');

  const textEl = document.getElementById('rxlNarrativeText');
  if (textEl) textEl.textContent = txt;

  const badgesEl = document.getElementById('rxlBadges');
  if (badgesEl) {
    badgesEl.innerHTML = '';
    const mk = (label, cls='') => { const s=document.createElement('span'); s.className=`badge ${cls}`; s.textContent=label; return s; };
    badgesEl.appendChild(mk(ofac ? 'OFAC' : 'No OFAC', ofac ? 'badge-risk' : 'badge-safe'));
    if (typeof ns.inactiveRatio === 'number' && ns.inactiveRatio >= 0.6) badgesEl.appendChild(mk('Dormant Cluster','badge-warn'));
    if (typeof avgTx === 'number' && avgTx >= 200) badgesEl.appendChild(mk('High Counterparty Volume','badge-warn'));
    if (ns.sparseNeighborhood) badgesEl.appendChild(mk('Limited Data','badge-warn'));
  }

  // Factors table stays as-is (we already render breakdown elsewhere)
  panel.hidden = false;
}

function hideNarrativePanel(){ const panel = document.getElementById('narrativePanel'); if (panel) panel.hidden = true; }

/* ================= Exports / Diags ================= */
window.__RXL__ = Object.assign(window.__RXL__ || {}, {
  focusAddress,
  diags(){
    const cfg = (window.VisionConfig && window.VisionConfig.API_BASE) || '(none)';
    const g = window.graph && window.graph.getData ? window.graph.getData() : {nodes:[],links:[]};
    console.table([
      { key:'API_BASE', value: cfg },
      { key:'network',  value: (document.getElementById('networkSelect')?.value || 'eth') },
      { key:'selected', value: (typeof selectedNodeId === 'string' ? selectedNodeId : '(none)') },
      { key:'nodes',    value: (g.nodes||[]).length },
      { key:'links',    value: (g.links||[]).length }
    ]);
    return { cfg, g };
  }
});
