export class LRU {
  constructor(max=1000, ttlMs=20*60*1000){
    this.max=max; this.ttl=ttlMs; this.map=new Map();
  }
  _now(){ return Date.now(); }
  get(k){
    const v=this.map.get(k); if(!v) return null;
    if (this.ttl && (this._now()-v.t)>this.ttl){ this.map.delete(k); return null; }
    this.map.delete(k); this.map.set(k,v); return v.v;
  }
  set(k,v){
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k,{v,t:this._now()});
    if (this.map.size>this.max) this.map.delete(this.map.keys().next().value);
  }
  has(k){ return !!this.get(k); }
  clear(){ this.map.clear(); }
}
window.RiskCache = new LRU(5000, 20*60*1000);
