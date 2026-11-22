/* ───────── UI 工具：DOM 构造 / 格式化 / 模态 / Toast / 图形 ─────────
 * 页面模块只准用这里的方法构建视图，保证观感统一。 */
(function(){
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=n=>{ n=Number(n)||0; if(Math.abs(n)>=1e8) return (n/1e8).toFixed(2)+' 亿'; if(Math.abs(n)>=1e4) return (n/1e4).toFixed(1)+' 万'; return String(n); };
const ts=t=>t?new Date(t*1000).toLocaleString('zh-CN',{hour12:false}):'—';
const pct=p=>{ p=Math.max(0,Math.min(100,Number(p)||0)); const cls=p>=90?'bad':p>=70?'warn':''; return `<span class="bar"><i class="${cls}" style="width:${p}%"></i></span>`; };
const pill=(text,kind='mute')=>`<span class="pill ${kind}">${esc(text)}</span>`;
const statePill=(ok,warn,bad)=> bad?pill(bad,'bad') : warn?pill(warn,'warn') : pill(ok||'正常','ok');

let toastEl=null, toastTimer=null;
function toast(msg,kind='info'){
  if(!toastEl) toastEl=document.getElementById('toast');
  toastEl.textContent=msg; toastEl.classList.add('show');
  toastEl.style.borderLeftColor = kind==='bad'?'var(--danger)':kind==='ok'?'var(--ok)':kind==='warn'?'var(--accent)':'var(--accent)';
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>toastEl.classList.remove('show'),3800);
}

/* 模态：openModal({title, body, actions:[{label,kind,onClick}]}) */
function openModal({title, body, actions, wide}){
  closeModal();
  const back=document.createElement('div'); back.className='modal-back show'; back.id='hub-modal';
  const m=document.createElement('div'); m.className='modal'; if(wide) m.style.width='min(920px,94vw)';
  m.innerHTML=`<h3>${esc(title)}</h3><div class="modal-body">${body||''}</div><div class="foot"></div>`;
  const foot=m.querySelector('.foot');
  (actions||[{label:'关闭'}]).forEach(a=>{
    const b=document.createElement('button'); b.className='btn'+(a.kind==='pri'?' pri':a.kind==='danger'?' danger':'');
    b.textContent=a.label; b.onclick=async()=>{ try{ const keep=await a.onClick&&a.onClick(); if(!keep) closeModal(); }catch(e){ toast(e.message,'bad'); } };
    foot.appendChild(b);
  });
  back.appendChild(m); document.body.appendChild(back);
  back.addEventListener('click',e=>{ if(e.target===back) closeModal(); });
  return m;
}
function closeModal(){ const m=document.getElementById('hub-modal'); if(m) m.remove(); }

/* 简易 SVG 柱状图（timeseries / by-account 用） */
function bars(values, labels, opts={}){
  if(!values||!values.length) return '<div class="empty">无数据</div>';
  const w=opts.width||860, h=opts.height||160, gap=2;
  const max=Math.max(...values.map(v=>Math.abs(Number(v)||0)),1);
  const bw=(w-gap*(values.length-1))/values.length;
  let svg=`<svg viewBox="0 0 ${w} ${h+18}" style="width:100%;background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius-m)">`;
  values.forEach((v,i)=>{
    const vh=Math.abs(Number(v)||0)/max*h;
    const y=h-vh;
    svg+=`<rect x="${(bw+gap)*i}" y="${y}" width="${bw}" height="${vh}" fill="var(--accent)" rx="1"><title>${labels?esc(labels[i]):i}：${v}</title></rect>`;
  });
  if(labels&&labels.length<=16){
    labels.forEach((l,i)=>{ svg+=`<text x="${(bw+gap)*i+bw/2}" y="${h+14}" font-size="9" fill="var(--ink-4)" text-anchor="middle">${esc(String(l).slice(-6))}</text>`; });
  }
  svg+='</svg>';
  return svg;
}

/* 表格构造：headers[], rows[][]（每格可为 HTML 字符串） */
function table(headers, rows, opts={}){
  if(!rows.length) return '<div class="empty">'+esc(opts.empty||'暂无数据')+'</div>';
  return `<table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr><tbody>`+
    rows.map(r=>`<tr>${r.map(c=>`<td>${c??'—'}</td>`).join('')}</tr>`).join('')+`</tbody></table>`;
}
/* 卡片网格 */
function cards(items){ return `<div class="grid">${items.map(c=>`<div class="card"><div class="k">${c.k}</div><div class="v">${c.v}${c.vsmall?`<small> ${esc(c.vsmall)}</small>`:''}</div>${c.n?`<div class="n">${c.n}</div>`:''}</div>`).join('')}</div>`; }
function loadHtml(msg){ return `<div class="load">${esc(msg||'拉取中…')}</div>`; }
function errHtml(e){ return `<h1>加载失败</h1><pre class="raw">${esc(String((e&&e.message)||e))}</pre><p class="sub"><a class="ext" href="javascript:location.reload()">重试</a></p>`; }

window.HUB=window.HUB||{};
HUB.ui={esc,num,ts,pct,pill,statePill,toast,openModal,closeModal,bars,table,cards,loadHtml,errHtml};
})();
