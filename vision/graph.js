// Graph renderer with pulsing halos
export const graph = (() => {
  const canvas = document.getElementById('graphCanvas');
  const ctx = canvas.getContext('2d');
  const DPR = Math.max(1, window.devicePixelRatio || 1);
  canvas.width *= DPR; canvas.height *= DPR; ctx.scale(DPR, DPR);

  let nodes = [];
  let links = [];
  let transform = {x:0,y:0,k:1};
  let onSelect = ()=>{};
  let raf = null;

  function layout() {
    const cx = canvas.clientWidth/2, cy = canvas.clientHeight/2;
    const r = Math.min(cx, cy) - 50;
    const n = nodes.length || 1;
    nodes.forEach((node,i) => {
      const ang = (i / Math.max(1,n)) * Math.PI*2;
      node.x = cx + Math.cos(ang) * (r * (0.55 + 0.25*Math.random()));
      node.y = cy + Math.sin(ang) * (r * (0.55 + 0.25*Math.random()));
      if (!node._halo) node._halo = { intensity:0, color:'#00eec3', phase: Math.random()*Math.PI*2 };
    });
  }

  function setData({nodes:newNodes, links:newLinks}) {
    nodes = newNodes.map(n => ({...n}));
    links = newLinks || [];
    layout();
    tick();
  }

  function getNode(id){ return nodes.find(n => n.id === id); }

  function setHalo(id, {intensity,color}) {
    const node = getNode(id);
    if (!node) return;
    node._halo = node._halo || { intensity:0, color:'#00eec3', phase: Math.random()*Math.PI*2 };
    node._halo.intensity = Math.max(0, Math.min(1, intensity || 0));
    node._halo.color = color || node._halo.color;
  }

  function selectNode(id){
    nodes.forEach(n=> n.selected = (n.id === id));
    render(0);
    onSelect(getNode(id));
  }

  // Interaction
  let dragging=false, last={x:0,y:0};
  canvas.addEventListener('mousedown', e => { dragging=true; last={x:e.offsetX,y:e.offsetY}; });
  window.addEventListener('mouseup', ()=> dragging=false);
  canvas.addEventListener('mousemove', e => {
    if (!dragging) return;
    transform.x += (e.offsetX - last.x); transform.y += (e.offsetY - last.y); last={x:e.offsetX,y:e.offsetY};
    render(0);
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const k = Math.max(.3, Math.min(3, transform.k * (e.deltaY > 0 ? 0.9 : 1.1)));
    transform.k = k; render(0);
  }, {passive:false});
  canvas.addEventListener('click', e => {
    const p = invScreen(e.offsetX, e.offsetY);
    const hit = nodes.find(n => dist(n.x,n.y,p.x,p.y) < 14);
    if (hit) selectNode(hit.id);
  });

  function invScreen(x,y){ return { x:(x - transform.x)/transform.k, y:(y - transform.y)/transform.k }; }
  function dist(x1,y1,x2,y2){ const dx=x1-x2, dy=y1-y2; return Math.sqrt(dx*dx+dy*dy); }

  function tick(ts=performance.now()){
    render(ts);
    raf = requestAnimationFrame(tick);
  }

  function render(ts){
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.save();
    ctx.clearRect(0,0,w,h);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    // links
    ctx.strokeStyle = '#12303a'; ctx.lineWidth = 1;
    links.forEach(l => {
      const a = getNode(l.a), b = getNode(l.b); if (!a||!b) return;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });

    // halos (pulsing)
    nodes.forEach(n => {
      const h = n._halo; if (!h) return;
      const t = ts/1000 + (h.phase||0);
      const pulse = 0.65 + 0.35*Math.sin(t*1.8);
      const radius = 26 + 24*(h.intensity||0.25) * pulse;
      ctx.beginPath(); ctx.arc(n.x, n.y, radius, 0, Math.PI*2);
      ctx.fillStyle = hexA(h.color || '#00eec3', 0.12 + 0.08*pulse);
      ctx.fill();
    });

    // nodes
    nodes.forEach(n => {
      ctx.beginPath(); ctx.arc(n.x, n.y, 8, 0, Math.PI*2);
      ctx.fillStyle = n.selected ? '#7ee3ff' : '#e7f7f2';
      ctx.fill();
      if (n.selected) {
        ctx.strokeStyle = '#7ee3ff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(n.x, n.y, 12, 0, Math.PI*2); ctx.stroke();
      }
    });

    ctx.restore();
  }

  function hexA(hex, a){
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if(!m) return hex; const r=parseInt(m[1],16), g=parseInt(m[2],16), b=parseInt(m[3],16);
    return `rgba(${r},${g},${b},${a})`;
  }

  return {
    setData, setHalo, getNode, selectNode,
    on(event, fn){ if (event==='selectNode') onSelect = fn; }
  };
})();
