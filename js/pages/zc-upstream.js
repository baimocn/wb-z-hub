/* ─────────────────────────────────────────────────────────────
 * 页面：ZC 版本 —— 上游版本对齐 / WB versionfeed 指纹 / 官方包提示词 diff
 * 端点：zc.upstreamAnalysis · zc.upstreamPackageAnalysis · zc.versionCheck
 * 只读分析页：不提供手工改写版本号入口，版本对齐由 version_tracker
 * 受正文锁（PROMPT_ALIGNED_VERSION）约束自动执行；「检查更新」只是触发核验。
 * ───────────────────────────────────────────────────────────── */
(function(){
'use strict';

const KEY_ORDER=['desktop_intl','desktop_cn','desktop_cli','vscode_product','vscode_ide','cli','sdk','node'];
const KEY_LABEL={
  desktop_intl:'桌面国际版', desktop_cn:'桌面国内版', desktop_cli:'桌面 CLI',
  vscode_product:'VS Code 产品', vscode_ide:'VS Code 内核',
  cli:'CLI', sdk:'SDK', node:'Node'
};

function esc(v){ return HUB.ui.esc(v); }
function mono(v){ return '<span class="mono">'+esc(v==null?'—':v)+'</span>'; }
function pill(text, kind){ return HUB.ui.pill(text, kind); }

function parseVer(v){
  const s=String(v==null?'':v).trim().replace(/^v/i,'');
  const m=s.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m?[parseInt(m[1],10),parseInt(m[2],10),parseInt(m[3],10)]:null;
}
function cmpVer(a,b){
  const x=parseVer(a), y=parseVer(b);
  if(!x||!y) return null;
  for(let i=0;i<3;i++){ if(x[i]!==y[i]) return x[i]>y[i]?1:-1; }
  return 0;
}
function levelPill(level){
  if(level==='ok') return pill('正常','ok');
  if(level==='manual') return pill('人工处置','warn');
  if(level==='warn') return pill('注意','warn');
  return pill(level||'未知','mute');
}
function upstreamName(u){
  if(u==='zcode') return 'ZCODE';
  if(u==='workbuddy') return 'WORKBUDDY';
  return String(u||'—').toUpperCase();
}
/* 探测值 vs 静态默认：只做展示级比较，不参与任何写操作 */
function diffPill(probed, dflt, manual){
  let out='—';
  if(probed&&dflt){
    const c=cmpVer(probed,dflt);
    if(c===null) out=String(probed)===String(dflt)?pill('一致','ok'):pill('不同','warn');
    else if(c===0) out=pill('一致','ok');
    else out=c>0?pill('↑ 领先默认','warn'):pill('↓ 低于默认','warn');
  }else if(probed){
    out=pill('仅探测','info');
  }
  if(manual) out+=' '+pill('人工','info');
  return out;
}

HUB.register({
  route:'zc-upstream', group:'zc', title:'ZC 版本', order:85,
  async render(el, ctx){
    const U=HUB.ui, Z=HUB.api.zc;

    if(ctx.stale()) return;
    el.innerHTML=U.loadHtml('正在读取上游版本分析…');
    let analysis=null, loadErr=null;
    try{ analysis=await Z.upstreamAnalysis(); }
    catch(e){ loadErr=e; }
    if(ctx.stale()) return;
    if(loadErr||!analysis||analysis.ok===false){
      el.innerHTML=U.errHtml(loadErr||new Error((analysis&&analysis.error)||'上游分析接口返回 ok=false'));
      return;
    }

    let data=analysis.data||{};
    let pkg=null, pkgErr=null, pkgBusy=false;

    el.innerHTML=[
      '<h1>ZC 版本</h1>',
      '<p class="sub">ZCode 上游对齐：官方 manifest 最新版 / 网关伪装版 / 正文锁（PROMPT_ALIGNED_VERSION）；WORKBUDDY versionfeed 指纹联动；官方包内提示词逐行 diff。版本对齐由 version_tracker 受正文锁约束自动执行；本页只做核对与触发核验，不提供手工改写版本号入口。</p>',
      '<div class="toolbar">',
      '  <button class="btn pri" id="zc-check" type="button">检查更新</button>',
      '  <button class="btn" id="zc-refresh" type="button">刷新分析</button>',
      '  <span class="pill mute">manifest · 正文锁 · versionfeed</span>',
      '</div>',
      '<div id="zc-cards"></div>',
      '<div id="zc-actions"></div>',
      '<div id="zc-wb"></div>',
      '<h2>包内提示词指纹</h2>',
      '<p class="sub">只解官方包内的 <span class="mono">glm/zcode.cjs</span>，与 <span class="mono">app/zcode_system.json</span> 的 stableSections 逐行比对；分析对象为 manifest 最新版，同版本命中服务端缓存（首次需 Range 下载数 MB，最长约 90 秒）。</p>',
      '<div class="toolbar">',
      '  <button class="btn" id="zc-pkg-run" type="button">重新分析</button>',
      '  <span class="pill mute" id="zc-pkg-hint">准备分析…</span>',
      '</div>',
      '<div id="zc-pkg-body"></div>'
    ].join('');

    const cardsEl=el.querySelector('#zc-cards');
    const actionsEl=el.querySelector('#zc-actions');
    const wbEl=el.querySelector('#zc-wb');
    const pkgBody=el.querySelector('#zc-pkg-body');
    const pkgHint=el.querySelector('#zc-pkg-hint');
    const pkgBtn=el.querySelector('#zc-pkg-run');
    const checkBtn=el.querySelector('#zc-check');
    const refreshBtn=el.querySelector('#zc-refresh');

    /* ── 版本事实 + 动作建议 + WB 指纹 ───────────────────────── */
    function paintAnalysis(){
      if(ctx.stale()) return;
      const ups=data.upstreams||{};
      const zc=ups.zcode||{};
      const wb=ups.workbuddy||{};
      const actions=data.actions||[];
      const latest=zc.latest||'', client=zc.client||'', aligned=zc.prompt_aligned||'';
      const port=!!zc.prompt_port_required;
      const probed=wb.probed||{}, defaults=wb.identity_defaults||{}, manual=wb.manual_overrides||{};
      const pKeys=Object.keys(probed);
      const minutes=(wb.probed_minutes_ago===null||wb.probed_minutes_ago===undefined)?null:wb.probed_minutes_ago;
      const delta=(latest&&client)?cmpVer(latest,client):null;

      cardsEl.innerHTML='<div class="toolbar">'+
        (port?pill('正文需移植','warn'):pill('正文已对齐','ok'))+
        (pKeys.length?pill('wb 指纹 '+pKeys.length+' 项','info'):pill('wb 未探测','warn'))+
        pill('分析于 '+(data.generated_at?U.ts(data.generated_at):'—'),'mute')+
        '</div>'+
        U.cards([
          {k:'官方最新 · latest', v:esc(latest||'—'),
           n: port?'新于正文锁：禁止直接抬版本头':'与正文锁对齐，无需动作'},
          {k:'网关伪装 · client', v:esc(client||'—'),
           n: latest?(delta===1?'落后官方 '+esc(latest):delta===0?'与官方一致':'版本号无法比较'):'尚无官方版本记录'},
          {k:'正文锁 · prompt_aligned', v:esc(aligned||'—'),
           n: port?'先移植 prompt 正文，再抬 PROMPT_ALIGNED_VERSION':'闸门与官方一致'},
          {k:'WB 版本指纹', v:esc(String(pKeys.length)), vsmall:'项',
           n: minutes===null?'尚无 versionfeed 探测记录':'探测于 '+esc(String(minutes))+' 分钟前'}
        ]);

      const aRows=actions.map(function(a){
        return [levelPill(a.level), esc(upstreamName(a.upstream)), esc(a.action||'')];
      });
      actionsEl.innerHTML='<h2>动作建议</h2>'+
        '<p class="sub">按「先移植正文、后抬版本锁」的顺序执行；wb 指纹只读，缺失时先查探测循环与网络出口。</p>'+
        U.table(['级别','上游','建议动作'], aRows, {empty:'暂无建议'});

      const keys=[], seen={};
      pKeys.concat(Object.keys(defaults), Object.keys(manual)).forEach(function(k){
        if(!seen[k]){ seen[k]=1; keys.push(k); }
      });
      keys.sort(function(a,b){
        const ia=KEY_ORDER.indexOf(a), ib=KEY_ORDER.indexOf(b);
        if(ia<0&&ib<0) return a<b?-1:a>b?1:0;
        if(ia<0) return 1;
        if(ib<0) return -1;
        return ia-ib;
      });
      const wRows=keys.map(function(k){
        return [
          esc(KEY_LABEL[k]||k)+' <span class="mono dim">'+esc(k)+'</span>',
          probed[k]?mono(probed[k]):'—',
          defaults[k]?mono(defaults[k]):'—',
          manual[k]?mono(manual[k]):'—',
          diffPill(probed[k], defaults[k], manual[k])
        ];
      });
      wbEl.innerHTML='<h2>WB 版本探测</h2>'+
        '<p class="sub">差异为展示级比较：上游探测 vs wb_identity 静态默认；人工覆盖来自 settings.json 的 identity_versions。</p>'+
        '<div class="toolbar">'+
          pill(minutes===null?'探测时间未知':'探测于 '+minutes+' 分钟前', minutes===null?'warn':'mute')+
          (Object.keys(manual).length?pill('人工覆盖 '+Object.keys(manual).length+' 项','info'):pill('无人工覆盖','mute'))+
        '</div>'+
        U.table(['版本键','上游探测','静态默认','人工覆盖','差异'], wRows, {empty:'versionfeed 尚未产生任何版本指纹'});
    }

    /* ── 官方包提示词指纹 ───────────────────────────────────── */
    function setHint(text, kind){
      if(!pkgHint) return;
      pkgHint.textContent=text;
      pkgHint.className='pill '+(kind||'mute');
    }

    function paintPkg(){
      if(ctx.stale()||!pkgBody) return;
      if(pkgBusy){
        setHint('分析中…','warn');
        pkgBody.innerHTML=U.loadHtml('正在提取官方包并比对提示词指纹…（首次需 Range 下载数 MB，最长约 90 秒）');
        return;
      }
      if(pkgErr){
        setHint('分析失败','bad');
        pkgBody.innerHTML='<div class="empty">分析失败：'+esc(pkgErr)+'</div>';
        return;
      }
      if(!pkg){
        setHint('待分析','mute');
        pkgBody.innerHTML='<div class="empty">尚未分析。</div>';
        return;
      }
      const secs=pkg.sections||[];
      const hit=secs.filter(function(s){ return !!s.found; }).length;
      const miss=pkg.missing_sections||[];
      const hasMiss=miss.length>0;
      setHint(hasMiss?('正文已变 · '+miss.length+' 段'):'正文全文命中', hasMiss?'bad':'ok');

      const sRows=secs.map(function(s){
        const verdict=s.found?(s.partial>0?pill('片段命中','info'):pill('整行命中','ok')):pill('正文已变','bad');
        const more=(s.missing_lines&&s.missing_lines.length)
          ? '<button class="btn mini" type="button" data-sec="'+esc(s.index)+'">查看缺失行</button>'
          : '—';
        return [
          '<span class="mono">段 '+esc(s.index)+'</span>',
          '<span class="mono">'+esc(s.lines)+'</span>',
          '<span class="mono">'+esc(s.full)+'</span>',
          '<span class="mono">'+esc(s.partial)+'</span>',
          '<span class="mono">'+esc(s.missing_count)+'</span>',
          verdict,
          more
        ];
      });

      pkgBody.innerHTML='<div class="toolbar">'+
          U.pill('包内版本 '+(pkg.version||'—'),'mute')+
          U.pill(pkg.downloaded_now?'本次已下载':'命中缓存', pkg.downloaded_now?'info':'mute')+
          U.pill('耗时 '+(pkg.elapsed_s==null?'—':pkg.elapsed_s)+' 秒','mute')+
        '</div>'+
        U.cards([
          {k:'分析版本', v:esc(pkg.version||'—'), n:'成员 '+esc(pkg.member||'glm/zcode.cjs')},
          {k:'包内 APP_VERSION', v:esc(pkg.app_version_in_package||'—'), n:'从 zcode.cjs 提取'},
          {k:'本地正文锁', v:esc(pkg.local_prompt_aligned||'—'), n:'PROMPT_ALIGNED_VERSION'},
          {k:'段落命中', v:esc(String(hit)), vsmall:'/ '+secs.length,
           n: hasMiss?('缺失段 '+esc(miss.join(', '))):'全部段落逐行命中'},
          {k:'本次下载', v: pkg.downloaded_now?'是':'否',
           n: pkg.downloaded_now?'本次重新 Range 解包':'同版本命中服务端缓存'}
        ])+
        '<p class="sub">'+esc(pkg.recommendation||'')+'</p>'+
        U.table(['段','可指纹行','整行命中','片段命中','缺失行','判定','详情'], sRows,
          {empty:'包内未提取到可比对段落'})+
        (pkg.package_url
          ? '<p class="sub" style="word-break:break-all">包地址 <a class="mono" href="'+esc(pkg.package_url)+'" target="_blank" rel="noopener noreferrer">'+esc(pkg.package_url)+'</a></p>'
          : '');
    }

    function openSection(sec){
      const lines=sec.missing_lines||[];
      const rows=lines.map(function(m,i){
        return [
          '<span class="mono">'+(i+1)+'</span>',
          '<span class="mono">'+esc(m.line||'')+'</span>',
          '<span class="mono dim">'+esc((m.fragments||[]).join(' / ')||'—')+'</span>'
        ];
      });
      U.openModal({
        title:'段 '+sec.index+' · 缺失 '+sec.missing_count+' 行（展示前 '+lines.length+' 行）',
        wide:true,
        body:U.table(['#','本地行（截断 200 字）','官方包内未命中片段'], rows, {empty:'无缺失行明细'}),
        actions:[{label:'关闭'}]
      });
    }

    async function loadPkg(){
      if(pkgBusy||ctx.stale()) return;
      pkgBusy=true; pkgErr=null; paintPkg();
      if(pkgBtn) pkgBtn.disabled=true;
      try{
        const res=await Z.upstreamPackageAnalysis();
        if(ctx.stale()) return;
        if(!res||res.ok===false) throw new Error((res&&res.error)||'探针接口返回 ok=false');
        if(!res.data) throw new Error('探针接口返回缺少 data');
        pkg=res.data;
      }catch(e){
        const bodyErr=(e&&e.body&&typeof e.body.error==='string')?e.body.error:'';
        pkg=null;
        pkgErr=bodyErr||(e&&e.message)||String(e);
      }finally{
        pkgBusy=false;
        if(!ctx.stale()){
          paintPkg();
          if(pkgBtn) pkgBtn.disabled=false;
        }
      }
    }

    /* ── 检查更新（version_tracker 强制核验 + 回读分析） ───────── */
    function showCheckResult(res){
      res=res||{};
      const ok=res.ok!==false;
      const has=!!res.has_update;
      const port=!!res.prompt_port_required;
      const pills=[
        ok?U.pill('核验完成','ok'):U.pill('拉取失败','bad'),
        has?U.pill('发现新版本','warn'):U.pill('已是最新','ok'),
        port?U.pill('正文需移植','bad'):U.pill('正文已对齐','ok'),
        res.updated?U.pill('已自动对齐指纹','info'):U.pill('未改动伪装版本','mute')
      ].join(' ');
      const rows=[
        ['当前伪装版本', mono(res.current_version||'—')],
        ['官方最新版本', mono(res.latest_version||'—')],
        ['正文锁版本', mono(res.prompt_aligned_version||'—')],
        ['发布名称', esc(res.release_name||'—')],
        ['发布日期', esc(res.release_date||'—')],
        ['核验时间', esc(res.checked_at?U.ts(res.checked_at):'—')]
      ];
      const notes=res.release_notes
        ? ('<h2>官方更新日志</h2><pre class="raw">'+esc(res.release_notes)+'</pre>')
        : '';
      U.openModal({
        title:ok?'版本核验结果':'版本核验失败（沿用缓存值）',
        wide:true,
        body:'<div class="toolbar">'+pills+'</div>'+U.table(['项','值'],rows)+notes,
        actions:[{label:'关闭',kind:'pri'}]
      });
    }

    async function runCheck(){
      if(checkBtn.disabled) return;
      const label=checkBtn.textContent;
      checkBtn.disabled=true; checkBtn.textContent='核验中…';
      try{
        const res=await Z.versionCheck();
        if(ctx.stale()) return;
        showCheckResult(res);
        if(res&&res.ok===false) U.toast('官方 manifest 拉取失败，沿用上次缓存值','warn');
        try{
          const fresh=await Z.upstreamAnalysis();
          if(ctx.stale()) return;
          if(fresh&&fresh.ok!==false&&fresh.data){ data=fresh.data; paintAnalysis(); }
        }catch(e2){
          if(!ctx.stale()) U.toast('核验完成，但刷新分析失败：'+((e2&&e2.message)||e2),'warn');
        }
      }catch(e){
        if(!ctx.stale()) U.toast('核验失败：'+((e&&e.message)||e),'bad');
      }finally{
        checkBtn.disabled=false; checkBtn.textContent=label;
      }
    }

    async function refreshAnalysis(){
      if(refreshBtn.disabled) return;
      const label=refreshBtn.textContent;
      refreshBtn.disabled=true; refreshBtn.textContent='刷新中…';
      try{
        const res=await Z.upstreamAnalysis();
        if(ctx.stale()) return;
        if(!res||res.ok===false) throw new Error((res&&res.error)||'分析接口返回 ok=false');
        data=res.data||{};
        paintAnalysis();
        U.toast('分析已刷新','ok');
      }catch(e){
        if(!ctx.stale()) U.toast('刷新失败：'+((e&&e.message)||e),'bad');
      }finally{
        refreshBtn.disabled=false; refreshBtn.textContent=label;
      }
    }

    /* ── 事件绑定（静态骨架节点，重绘不失效） ─────────────────── */
    checkBtn.addEventListener('click', runCheck);
    refreshBtn.addEventListener('click', refreshAnalysis);
    if(pkgBtn) pkgBtn.addEventListener('click', loadPkg);
    pkgBody.addEventListener('click', function(e){
      const target=e.target;
      if(!target||!target.closest) return;
      const btn=target.closest('button[data-sec]');
      if(!btn) return;
      const idx=btn.getAttribute('data-sec');
      const secs=(pkg&&pkg.sections)||[];
      for(let i=0;i<secs.length;i++){
        if(String(secs[i].index)===String(idx)){ openSection(secs[i]); return; }
      }
    });

    paintAnalysis();
    loadPkg();
  }
});

})();
