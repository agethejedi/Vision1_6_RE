import { graph } from './graph.js';

const worker = new Worker('../workers/visionRisk.worker.js', { type:'module' });

const pending = new Map();
function post(type, payload, onChunk){
  return new Promise((resolve,reject)=>{
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject, onChunk });
    worker.postMessage({ id, type, payload });
  });
}

worker.onmessage = (e) => {
  const { id, type, data, error } = e.data || {};
  const req = pending.get(id);
  if (type === 'INIT_OK') { if(req){ req.resolve(true); pending.delete(id);} return; }
  if (type === 'RESULT_STREAM') {
    drawHalo(data);
    if (data.id === selectedNodeId) updateScorePanel(data);
    updateBatchStatus(`Scored: ${data.id.slice(0,8)}… => ${data.score}`);
    return;
  }
  if (type === 'RESULT') {
    drawHalo(data);
    if (data.id === selectedNodeId) updateScorePanel(data);
    if (req){ req.resolve(data); pending.delete(id); }
    return;
  }
  if (type === 'DONE') {
    if (req){ req.resolve(true); pending.delete(id); }
    updateBatchStatus('Batch: complete');
    return;
  }
  if (type === 'ERROR') {
    console.error(error);
    if (req){ req.reject(new Error(error)); pending.delete(id); }
    updateBatchStatus('Batch: error');
  }
};

async function init(){
  await post('INIT', {
    adapters: { evm: window.RiskAdapters.evm },
    cache: window.RiskCache,
    network: getNetwork(),
    ruleset: 'safesend-2025.10.1',
    concurrency: 8,
    flags: { graphSignals: true, streamBatch: true }
  });

  bindUI();
  seedDemo();
}
init();

function bindUI(){
  document.getElementById('refreshBtn').addEventListener('click', ()=> {
    scoreVisible();
  });
  document.getElementById('clearBtn').addEventListener('click', ()=> {
    graph.setData({nodes:[],links:[]});
    updateBatchStatus('Idle'); setSelected(null);
  });
  document.getElementById('loadSeedBtn').addEventListener('click', ()=> {
    const seed = document.getElementById('seedInput').value.trim();
    if (!seed) return;
    loadSeed(seed);
  });
  document.getElementById('networkSelect').addEventListener('change', async ()=> {
    await post('INIT', { network: getNetwork() });
    scoreVisible();
  });

  graph.on('selectNode', (n)=>{
    if (!n) return;
    setSelected(n.id);
    post('SCORE_ONE', { item: { type:'address', id:n.id, network:getNetwork() }})
      .then(updateScorePanel)
      .catch(()=>{});
  });
}

function getNetwork(){ return document.getElementById('networkSelect').value; }

let selectedNodeId = null;
function setSelected(id){ selectedNodeId = id; }

function updateScorePanel(res){
  const sp = document.getElementById('scorePanel');
  sp.setScore(res.score, res.explain);
  const feats = res.feats || {};
  document.getElementById('entityMeta').innerHTML = `
    <div>Address: <b>${res.id}</b></div>
    <div>Network: <b>${res.network}</b></div>
    <div>Age (days): <b>${feats.ageDays ?? '—'}</b></div>
    <div>Mixer taint: <b>${Math.round((feats.mixerTaint??0)*100)}%</b></div>
    <div>Neighbors flagged: <b>${Math.round((feats.local?.riskyNeighborRatio??0)*100)}%</b></div>
  `;
}

function drawHalo(res){
  const color = res.score>=80 ? '#ff3b3b' :
                res.score>=60 ? '#ffb020' :
                res.score>=40 ? '#ffc857' :
                res.score>=20 ? '#22d37b' : '#00eec3';
  graph.setHalo(res.id, { intensity: res.score/100, color, tooltip: res.label });
}

function updateBatchStatus(text){ document.getElementById('batchStatus').textContent = text; }

function scoreVisible(){
  const viewNodes = getVisibleNodes();
  if (!viewNodes.length){ updateBatchStatus('No nodes in view'); return; }
  updateBatchStatus(`Batch: ${viewNodes.length} nodes`);
  const items = viewNodes.map(n => ({ type:'address', id:n.id, network:getNetwork() }));
  post('SCORE_BATCH', { items }).catch(err => console.error(err));
}

function getVisibleNodes(){
  const sample = window.__VISION_NODES__ || [];
  return sample;
}

function seedDemo(){
  const seed = '0xDEMOSEED00000000000000000000000000000001';
  loadSeed(seed);
}

function loadSeed(seed){
  const n = 14, nodes=[], links=[];
  for (let i=0;i<n;i++){
    const a = '0x' + Math.random().toString(16).slice(2).padStart(40,'0').slice(0,40);
    nodes.push({ id:a, address:a, network:getNetwork() });
    links.push({ a:seed, b:a, weight:1 });
  }
  nodes.unshift({ id:seed, address:seed, network:getNetwork() });
  window.__VISION_NODES__ = nodes;
  graph.setData({ nodes, links });
  setSelected(seed);
  scoreVisible();
}
