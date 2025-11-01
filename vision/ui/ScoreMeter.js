// Animated circular risk score (SafeSend parity)
const STYLE = `
:host{display:block;font-family:Inter,ui-sans-serif,system-ui,Arial}
.wrapper{position:relative;display:grid;gap:12px;background:#0c1820;border:1px solid #1a2a33;border-radius:14px;padding:14px;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.header{display:flex;align-items:center;justify-content:space-between}
.title{color:#e7f7f2;font-weight:600;letter-spacing:.3px}
.badge{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid #253a45;background:#0f1d27;color:#8aa3a0}
.gauge{position:relative;display:flex;align-items:center;justify-content:center}
svg{overflow:visible}
.scoreText{font-weight:800;fill:#e7f7f2;font-variant-numeric:tabular-nums}
.label{font-size:12px;color:#8aa3a0;text-align:center;margin-top:-6px}
.pulse{position:absolute;inset:0;border-radius:50%;filter:blur(14px);opacity:.25;transition:background 240ms}
.breakdown{border-top:1px solid #17242d;padding-top:8px;display:grid;gap:6px}
.item{display:flex;justify-content:space-between;gap:10px}
.item .k{color:#8aa3a0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60%}
.item .v{color:#e7f7f2;font-size:12px}
`;
export class RxScore extends HTMLElement{
  static get observedAttributes(){ return ['size']; }
  constructor(){
    super(); this._size = Number(this.getAttribute('size')||180);
    this._r = this.attachShadow({mode:'open'});
    this._r.innerHTML = `
      <style>${STYLE}</style>
      <div class="wrapper">
        <div class="header"><div class="title">Risk Score</div><div class="badge">SafeSend parity</div></div>
        <div class="gauge">
          <div class="pulse" id="pulse"></div>
          <svg id="svg" width="${this._size}" height="${this._size}" viewBox="0 0 ${this._size} ${this._size}">
            <defs>
              <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stop-color="#00eec3"/><stop offset="50%" stop-color="#22d37b"/>
                <stop offset="75%" stop-color="#ffb020"/><stop offset="100%" stop-color="#ff3b3b"/>
              </linearGradient>
            </defs>
            ${this._ring()}
            <text id="t" class="scoreText" x="${this._size/2}" y="${this._size/2+6}" text-anchor="middle" font-size="${this._size*0.22}">0</text>
          </svg>
        </div>
        <div class="label" id="label">Minimal</div>
        <div class="breakdown" id="bd"></div>
      </div>`;
    this._fg = this._r.getElementById('fg');
    this._t = this._r.getElementById('t');
    this._label = this._r.getElementById('label');
    this._pulse = this._r.getElementById('pulse');
    this._bd = this._r.getElementById('bd');
    this._curr = 0; this._anim = null;
  }
  _ring(){
    const cx=this._size/2, cy=this._size/2, r=this._size*0.38, thick=this._size*0.10, len=2*Math.PI*r;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" stroke="#0f1d27" stroke-width="${thick}" fill="none"/>
            <circle id="fg" cx="${cx}" cy="${cy}" r="${r}" stroke="url(#grad)" stroke-linecap="round"
                    stroke-width="${thick}" fill="none" transform="rotate(-90 ${cx} ${cy})"
                    stroke-dasharray="${len}" stroke-dashoffset="${len}"/>`;
  }
  setScore(score, explain){
    score = Math.max(0, Math.min(100, Number(score)||0));
    this._animateTo(score);
    this._label.textContent = label(score);
    this._colorize(score);
    this._renderExplain(explain);
  }
  _animateTo(end){
    const r=this._size*0.38, len=2*Math.PI*r;
    const start=this._curr, t0=performance.now(), dur=650;
    const step=(t)=>{
      const p=Math.min(1,(t-t0)/dur), e=1-Math.pow(1-p,3), v=start+(end-start)*e;
      this._curr=v; this._fg.setAttribute('stroke-dashoffset', String(len*(1-v/100)));
      this._t.textContent = Math.round(v);
      this._pulse.style.background = `radial-gradient(circle, ${pulse(v)} 0%, transparent 60%)`;
      if(p<1) this._anim=requestAnimationFrame(step); else this._anim=null;
    };
    if(this._anim) cancelAnimationFrame(this._anim);
    this._anim=requestAnimationFrame(step);
  }
  _colorize(s){
    const b=this._r.querySelector('.badge');
    const c = s>=80?'#ff3b3b': s>=60?'#ffb020': s>=40?'#ffc857': s>=20?'#22d37b':'#00eec3';
    b.style.borderColor = rgba(c,.35); b.style.color = c;
  }
  _renderExplain(ex){
    const list = ex?.topReasons || ex?.contributions || [];
    const top = list.slice().sort((a,b)=>(b.add??0)-(a.add??0)).slice(0,5);
    this._bd.innerHTML = top.map(it=>`<div class="item"><div class="k">${pretty(it.key)}</div><div class="v">+${Math.round(it.add||0)}</div></div>`).join('');
  }
}
function label(s){ return s>=80?'High': s>=60?'Elevated': s>=40?'Moderate': s>=20?'Low':'Minimal'; }
function rgba(hex,a){ const m=/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex); if(!m)return hex;
  const r=parseInt(m[1],16),g=parseInt(m[2],16),b=parseInt(m[3],16); return `rgba(${r},${g},${b},${a})`; }
function pulse(s){ return s>=80?'rgba(255,59,59,.55)': s>=60?'rgba(255,176,32,.45)': s>=40?'rgba(255,200,87,.35)': s>=20?'rgba(34,211,123,.28)':'rgba(0,238,195,.25)'; }
function pretty(k){ return (k||'').replace(/([A-Z])/g,' $1').replace(/_/g,' ').replace(/\s+/g,' ').trim(); }
customElements.define('rx-score', RxScore);
