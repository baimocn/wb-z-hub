/* ───────── 路由 + 页面注册表 ─────────
 * 页面模块通过 HUB.register({route, title, group, order, render}) 自注册。
 * render(el, ctx)：ctx = {seq}；render 内的每次 DOM 写入前先检查 HUB.stale(seq)。 */
(function(){
const REG={};
let NAV=0, pollTimer=null, main=null;

function register(def){ REG[def.route]=def; }

function stopPoll(){ if(pollTimer){ clearInterval(pollTimer); pollTimer=null; } }
function poll(fn,ms){ stopPoll(); pollTimer=setInterval(()=>{ if(document.getElementById('main')) fn(); },ms); }
const stale=s=>s!==NAV;

async function route(){
  stopPoll();
  const _s=++NAV;
  const r=(location.hash||'#/overview').replace(/^#\//,'');
  const def=REG[r]||REG['overview'];
  document.querySelectorAll('#nav a').forEach(a=>a.classList.toggle('cur',a.dataset.r===r));
  main.innerHTML='';
  const el=document.createElement('div'); main.appendChild(el);
  try{ await def.render(el,{seq:_s,stale:()=>stale(_s),poll,toast:HUB.ui.toast}); }
  catch(e){ el.innerHTML=HUB.ui.errHtml(e); }
}

function buildNav(){
  const defs=Object.values(REG).sort((a,b)=>(a.order||99)-(b.order||99));
  const nav=document.getElementById('nav');
  let html=`<a href="#/overview" data-r="overview">概览</a>`;
  let lastGroup=null;
  for(const d of defs){
    if(d.group==='system') html+=`<span class="grp">全局</span>`;
    else if(d.group!==lastGroup){ html+=`<span class="grp"><span class="dot ${d.group==='zc'?'zc':'wb'}">●</span>${d.group==='zc'?'ZCODE':'WORKBUDDY'}</span>`; lastGroup=d.group; }
    if(d.route==='overview') continue;
    html+=`<a href="#/${d.route}" data-r="${d.route}">${d.title}</a>`;
  }
  html+=`<span class="grp">全局</span><a href="#/settings" data-r="settings">设置</a>`;
  nav.innerHTML=html;
}

window.addEventListener('hashchange',route);
window.HUB=window.HUB||{};
HUB.register=register;
HUB.stale=stale;
HUB.boot=function(){
  main=document.getElementById('main');
  buildNav();
  route();
};
})();
