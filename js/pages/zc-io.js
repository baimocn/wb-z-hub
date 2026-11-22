/* ─────────────────────────────────────────────────────────────
 * 页面：备份恢复 —— ZCODE 账号池整包导出 / 导入
 * 端点：zc.exportData（POST /admin/api/export）
 *       zc.importData（POST /admin/api/import）
 * 数据范围以 docs/api-inventory.md §12 的两条导出 / 导入记录为准：
 * 导出文档按 providers 分组、含 name / mode / 凭据明文（Cache-Control:
 * no-store）；导入接受该文档，只并入账号池，不删除既有账号。
 * 安全：明文只在本页内存中停留，不写 localStorage，也不在 DOM 里展开
 * secret 字段；导入是写操作，必须二次确认。
 * ───────────────────────────────────────────────────────────── */
(function(){
'use strict';

var SECRET_KEYS=['secret','token','jwtToken','apiKey'];

function esc(v){ return HUB.ui.esc(v); }
function pill(t,k){ return HUB.ui.pill(t,k); }
function clip(e){ var s=String((e&&e.message)||e||''); return s.length>200?s.slice(0,200)+'…':s; }
function scalar(v){ return (v==null||typeof v==='object')?'—':v; }
function tsSafe(v){ var n=Number(v); return (isFinite(n)&&n>0)?HUB.ui.ts(n):'—'; }
function pad2(n){ return n<10?'0'+n:''+n; }
function stamp(d){
  d=d||new Date();
  return ''+d.getFullYear()+pad2(d.getMonth()+1)+pad2(d.getDate())+'-'+
    pad2(d.getHours())+pad2(d.getMinutes())+pad2(d.getSeconds());
}
function sizeText(bytes){
  var n=Number(bytes)||0;
  if(n<1024) return n+' B';
  if(n<1024*1024) return (n/1024).toFixed(1)+' KB';
  return (n/1024/1024).toFixed(2)+' MB';
}
function hasSecret(it){
  if(!it||typeof it!=='object') return false;
  for(var i=0;i<SECRET_KEYS.length;i++){ if(it[SECRET_KEYS[i]]) return true; }
  return false;
}
/* 只做结构与计数摘要，绝不把 secret 取出到视图层 */
function inspectDoc(doc){
  var providers=(doc&&typeof doc==='object')?doc.providers:null;
  var valid=!!providers&&typeof providers==='object'&&!Array.isArray(providers);
  var rows=[], total=0, usable=0;
  if(valid){
    Object.keys(providers).forEach(function(p){
      var items=Array.isArray(providers[p])?providers[p]:[];
      var modes={}, ok=0, missing=0;
      items.forEach(function(it){
        if(hasSecret(it)){
          ok++;
          var m=String((it&&it.mode)||'unknown');
          modes[m]=(modes[m]||0)+1;
        }else{
          missing++;
        }
      });
      total+=items.length; usable+=ok;
      rows.push({provider:p, items:items.length, usable:ok, missing:missing, modes:modes});
    });
  }
  return {
    valid:valid, rows:rows, total:total, usable:usable,
    version:(doc&&typeof doc==='object')?doc.version:null,
    exportedAt:(doc&&typeof doc==='object')?doc.exported_at:null
  };
}
function modeText(modes){
  var keys=Object.keys(modes||{});
  if(!keys.length) return '—';
  return keys.map(function(k){
    return esc(k)+' <span class="mono">'+esc(modes[k])+'</span>';
  }).join(' · ');
}
function statRows(st){
  return st.rows.map(function(r){
    return [
      '<span class="mono">'+esc(r.provider)+'</span>',
      '<span class="mono">'+esc(r.items)+'</span>',
      '<span class="mono">'+esc(r.usable)+'</span>',
      r.missing?pill(String(r.missing),'warn'):pill('0','ok'),
      modeText(r.modes)
    ];
  });
}

HUB.register({
  route:'zc-io', group:'zc', title:'备份恢复', order:90,
  async render(el, ctx){
    var U=HUB.ui, Z=HUB.api.zc;
    /* 状态跟随本次挂载的闭包：离开页面后 DOM 与监听器一起回收，
       明文不会留在模块级变量里 */
    var lastExport=null;   /* {doc,text,at,stats} 最近一次成功导出 */
    var exporting=false;
    var importing=false;

    if(ctx.stale()) return;
    el.innerHTML=[
      '<h1>备份恢复</h1>',
      '<p class="sub">ZCODE 账号池的整包导出与导入 · 文档含 <b class="mono">JWT / API Key</b> 明文，只在本页内存中停留 · 导出 <span class="mono">POST /admin/api/export</span> · 导入 <span class="mono">POST /admin/api/import</span></p>',
      '<div class="toolbar">',
      pill('范围：ZCODE 账号池','info'),
      pill('导入需二次确认','warn'),
      pill('不写 localStorage','mute'),
      '</div>',

      '<h2>导出</h2>',
      '<p class="sub" style="margin-bottom:8px">按 <span class="mono">providers</span> 分组导出当前账号池（每条含 name / mode / 凭据）。导出走 <span class="mono">POST</span>：凭据不会进入浏览器历史或 Referer，响应头为 <span class="mono">Cache-Control: no-store</span>。</p>',
      '<div class="toolbar">',
      '<button class="btn pri" id="io-export-btn" type="button">导出备份</button>',
      '<button class="btn" id="io-download-btn" type="button" disabled>下载 JSON</button>',
      '<span class="pill mute" id="io-export-state">尚未导出</span>',
      '</div>',
      '<div id="io-export-body"><div class="empty">尚未导出。点击「导出备份」从后端取回当前账号池。</div></div>',

      '<h2>导入</h2>',
      '<p class="sub" style="margin-bottom:8px">粘贴或选择导出的 JSON 文档。导入只做「并入」：同 token / 同 JWT uid 的账号由后端去重，不会新建重复行；<b>不会删除或禁用现有账号</b>。新增的 JWT 号会在后台跑安装序并自动领取。</p>',
      '<div class="toolbar">',
      '<input type="file" id="io-file" accept=".json,application/json">',
      '<span class="pill mute" id="io-parse-state">等待文档</span>',
      '<span class="dim" style="font-size:11px">建议先在账号池核对当前数量，导入后再核对一次</span>',
      '</div>',
      '<textarea id="io-text" rows="10" spellcheck="false" placeholder="在此粘贴导出文档 JSON…（含明文凭据，请勿发到聊天 / 工单）" style="width:100%;resize:vertical;font-family:var(--font-mono);font-size:11.5px"></textarea>',
      '<div class="toolbar" style="margin-top:8px">',
      '<button class="btn danger" id="io-import-btn" type="button" disabled>导入备份</button>',
      '<button class="btn" id="io-clear-btn" type="button">清空输入</button>',
      '<span class="pill mute" id="io-import-state">未导入</span>',
      '</div>',
      '<div id="io-import-body"></div>',

      '<h2>数据范围与边界</h2>',
      '<p class="sub">口径以 <span class="mono">docs/api-inventory.md</span> §12 的两条导出 / 导入记录为准；下表写清「包含 / 不包含」，避免把备份当成整机快照。</p>',
      U.table(['项','口径'],[
        ['导出载荷','账号导出文档：按 <span class="mono">providers</span> 分组，每条含 <span class="mono">name</span> / <span class="mono">mode</span> / <span class="mono">secret</span>（JWT 或 API Key 明文）；响应头 <span class="mono">Cache-Control: no-store</span>'],
        ['导入载荷','导出文档（任意 JSON 对象）；返回 <span class="mono">{count}</span>；新 JWT 号后台安装 + 自动领取'],
        ['不包含','设置、请求监控环形日志、额度快照与调用统计 —— 清单未记载在导出文档内，这些数据各有独立端点'],
        ['WB 侧账号','不在本文档内：WORKBUDDY 账号池走 wb 侧 <span class="mono">GET /accounts/export</span>（清单 §1），与 ZCODE 账号池互不相通'],
        ['去重口径','同 token、同 JWT uid 的条目由后端入池逻辑去重（不新建行）；<span class="mono">count</span> 是本次处理条目数，不等于新增行数']
      ]),

      '<h2>安全须知</h2>',
      '<div class="toolbar">'+pill('明文凭据','bad')+pill('仅内存持有','ok')+pill('导入二次确认','warn')+'</div>',
      '<p class="sub" style="margin-top:8px">导出文档等同于账号池的完整控制权：不要提交到 Git、不要发到聊天 / 工单 / 截图；下载后请加密保存，导入完成后删除临时文件。本页不把文档写入 <span class="mono">localStorage</span>，也不在界面上展开 <span class="mono">secret</span> 字段。</p>'
    ].join('');

    var exportBtn=el.querySelector('#io-export-btn');
    var downloadBtn=el.querySelector('#io-download-btn');
    var exportState=el.querySelector('#io-export-state');
    var exportBody=el.querySelector('#io-export-body');
    var fileInput=el.querySelector('#io-file');
    var textArea=el.querySelector('#io-text');
    var parseState=el.querySelector('#io-parse-state');
    var importBtn=el.querySelector('#io-import-btn');
    var clearBtn=el.querySelector('#io-clear-btn');
    var importState=el.querySelector('#io-import-state');
    var importBody=el.querySelector('#io-import-body');

    function setExportState(text, kind){
      if(!exportState) return;
      exportState.textContent=text;
      exportState.className='pill '+(kind||'mute');
    }
    function setParseState(text, kind, canImport){
      if(parseState){
        parseState.textContent=text;
        parseState.className='pill '+(kind||'mute');
      }
      if(importBtn) importBtn.disabled=!canImport||importing;
    }

    /* ── 导出 ─────────────────────────────────────────────── */
    function paintExport(res, bytes){
      if(ctx.stale()) return;
      lastExport=res;
      if(downloadBtn) downloadBtn.disabled=false;
      var st=res.stats;
      if(!st.valid){
        setExportState('文档结构异常','bad');
        exportBody.innerHTML='<div class="empty">导出返回的文档里没有 <span class="mono">providers</span> 对象，请核对后端版本；文档已留在内存，可点「下载 JSON」原样保存。</div>';
        return;
      }
      setExportState('已导出 · '+st.usable+' 条','ok');
      exportBody.innerHTML=
        '<div class="toolbar">'+
          pill('文档版本 '+scalar(st.version),'mute')+
          pill('导出时间 '+tsSafe(st.exportedAt),'mute')+
          pill('文档大小 '+sizeText(bytes),'mute')+
        '</div>'+
        U.cards([
          {k:'账号条目', v:esc(String(st.total)), vsmall:'条',
           n: st.usable<st.total?('其中 '+esc(String(st.total-st.usable))+' 条缺凭据，导入时跳过'):'全部条目含凭据'},
          {k:'含凭据条目', v:esc(String(st.usable)), vsmall:'条',
           n:'按 secret / token / jwtToken / apiKey 判定'},
          {k:'Provider', v:esc(String(st.rows.length)), vsmall:'个',
           n: st.rows.length?st.rows.map(function(r){ return esc(r.provider)+' '+esc(r.usable); }).join(' · '):'—'}
        ])+
        U.table(['Provider','条目','含凭据','缺凭据','模式分布'], statRows(st), {empty:'导出文档为空'})+
        '<p class="sub" style="margin-top:8px">明文只保留在本页内存（最近一次导出），切换页面即丢弃。下载文件名为 <span class="mono">zcode-backup-YYYYMMDD-HHmmss.json</span>。</p>';
    }

    function paintExportError(e){
      if(ctx.stale()) return;
      setExportState('导出失败','bad');
      exportBody.innerHTML='<div class="empty">导出失败：'+esc(clip(e))+'</div>';
    }

    async function doExport(){
      if(exporting) return;
      exporting=true;
      if(exportBtn){ exportBtn.disabled=true; exportBtn.textContent='导出中…'; }
      setExportState('正在读取账号池…','warn');
      if(ctx.stale()){ exporting=false; return; }
      exportBody.innerHTML=U.loadHtml('正在生成导出文档…');
      try{
        var doc=await Z.exportData({});
        if(ctx.stale()) return;
        var text=JSON.stringify(doc==null?{}:doc, null, 2);
        var bytes=new Blob([text]).size;
        var stats=inspectDoc(doc);
        paintExport({doc:doc, text:text, at:new Date(), stats:stats}, bytes);
        U.toast('导出完成：'+stats.usable+' 条含凭据条目','ok');
      }catch(e){
        if(ctx.stale()) return;
        paintExportError(e);
        U.toast('导出失败：'+clip(e),'bad');
      }finally{
        exporting=false;
        if(!ctx.stale()&&exportBtn){
          exportBtn.disabled=false;
          exportBtn.textContent='导出备份';
        }
      }
    }

    function downloadExport(){
      if(!lastExport||!lastExport.text) return;
      var blob=new Blob([lastExport.text], {type:'application/json;charset=utf-8'});
      var url=URL.createObjectURL(blob);
      var a=document.createElement('a');
      a.href=url;
      a.download='zcode-backup-'+stamp(lastExport.at)+'.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function(){ try{ URL.revokeObjectURL(url); }catch(e){} }, 5000);
      U.toast('已开始下载（文件含明文凭据，请加密保存）','warn');
    }

    /* ── 导入预览 ─────────────────────────────────────────── */
    function previewImport(text){
      if(ctx.stale()) return;
      var raw=String(text==null?'':text).trim();
      if(!raw){
        setParseState('等待文档','mute',false);
        importBody.innerHTML='';
        return;
      }
      var doc;
      try{ doc=JSON.parse(raw); }
      catch(e){
        setParseState('JSON 解析失败','bad',false);
        importBody.innerHTML='<div class="empty">JSON 解析失败：'+esc(clip(e))+'</div>';
        return;
      }
      if(!doc||typeof doc!=='object'||Array.isArray(doc)){
        setParseState('根节点必须是对象','bad',false);
        importBody.innerHTML='<div class="empty">导入文档的根节点必须是 JSON 对象（与 <span class="mono">/admin/api/export</span> 的输出一致）。</div>';
        return;
      }
      var st=inspectDoc(doc);
      if(!st.valid){
        setParseState('缺少 providers','warn',true);
        importBody.innerHTML='<div class="empty">没有识别到 <span class="mono">providers</span> 对象（根节点字段：<span class="mono">'+
          esc(Object.keys(doc).slice(0,10).join(', ')||'空对象')+'</span>）。后端导入会按 0 条处理，确认要提交可继续。</div>';
        return;
      }
      setParseState('可导入 · '+st.usable+' 条','ok',true);
      importBody.innerHTML=
        '<div class="toolbar">'+
          pill('版本 '+scalar(st.version),'mute')+
          pill('导出时间 '+tsSafe(st.exportedAt),'mute')+
          pill('待处理 '+st.usable+' 条','info')+
        '</div>'+
        U.table(['Provider','条目','含凭据','缺凭据','模式分布'], statRows(st), {empty:'文档中没有条目'});
    }

    function readFile(file){
      if(!file) return;
      if(file.size>4*1024*1024){
        U.toast('文件超过 4 MB，已拒绝读取（导出文档通常很小）','bad');
        return;
      }
      var fr=new FileReader();
      fr.onload=function(){
        if(ctx.stale()) return;
        if(textArea) textArea.value=String(fr.result||'');
        previewImport(textArea?textArea.value:'');
        U.toast('已读取 '+file.name,'info');
      };
      fr.onerror=function(){ if(!ctx.stale()) U.toast('读取文件失败','bad'); };
      fr.readAsText(file,'utf-8');
    }

    /* ── 导入（二次确认 + 写操作） ─────────────────────────── */
    async function runImport(doc){
      if(importing) throw new Error('导入进行中，请勿重复提交');
      importing=true;
      if(importBtn) importBtn.disabled=true;
      if(importState){ importState.textContent='导入中…'; importState.className='pill warn'; }
      if(ctx.stale()){ importing=false; return false; }
      importBody.innerHTML=U.loadHtml('正在提交到 /admin/api/import…');
      try{
        var res=await Z.importData(doc);
        if(ctx.stale()) return false;
        var count=res&&res.count;
        if(importState){
          importState.textContent='已提交 · 处理 '+scalar(count)+' 条';
          importState.className='pill ok';
        }
        importBody.innerHTML=
          '<div class="toolbar">'+pill('导入完成','ok')+pill('返回 count='+scalar(count),'info')+'</div>'+
          U.table(['项','结果'],[
            ['后端返回 count','<span class="mono">'+esc(scalar(count))+'</span>'],
            ['口径','本次处理条目数（含去重跳过）；不是新增行数'],
            ['后续动作','新 JWT 号后台安装 + 自动领取（幂等，重复 token 不新增）'],
            ['下一步','<a href="#/zc-accounts">前往 ZC 账号池核对</a>']
          ])+
          '<p class="sub" style="margin-top:8px">导入文档仍留在输入框；核对无误后请点「清空输入」并删除本地临时文件。</p>';
        U.toast('导入完成：处理 '+scalar(count)+' 条','ok');
        return false;
      }catch(e){
        if(!ctx.stale()){
          if(importState){ importState.textContent='导入失败'; importState.className='pill bad'; }
          importBody.innerHTML='<div class="empty">导入失败：'+esc(clip(e))+'</div>';
        }
        throw e;  /* 交给 openModal 统一 toast，模态保持打开便于重试 */
      }finally{
        importing=false;
        if(!ctx.stale()&&importBtn) importBtn.disabled=false;
      }
    }

    function askImport(){
      if(importing) return;
      var text=textArea?textArea.value:'';
      if(!text.trim()){ U.toast('请先粘贴或选择备份文档','warn'); return; }
      var doc;
      try{ doc=JSON.parse(text); }
      catch(e){
        U.toast('JSON 解析失败：'+clip(e),'bad');
        previewImport(text);
        return;
      }
      if(!doc||typeof doc!=='object'||Array.isArray(doc)){
        U.toast('导入文档的根节点必须是 JSON 对象','bad');
        previewImport(text);
        return;
      }
      var st=inspectDoc(doc);
      var lead=st.valid
        ? ('确认后会把 <span class="mono">'+esc(String(st.usable))+'</span> 条含凭据条目提交到 <span class="mono">POST /admin/api/import</span>。')
        : '文档里没有识别到 <span class="mono">providers</span>；后端会按 0 条处理。';
      U.openModal({
        title:'确认导入备份',
        wide:true,
        body:
          '<div class="toolbar">'+pill('写操作','bad')+pill('只并入，不删除','ok')+pill('明文凭据','warn')+'</div>'+
          '<p class="sub" style="margin-top:8px">'+lead+' 同 token / 同 JWT uid 的账号由后端去重（不新建行）；新增的 JWT 号会在后台跑安装序并自动领取。导入不会删除或禁用任何现有账号。</p>'+
          (st.valid
            ? U.table(['Provider','条目','含凭据','缺凭据'], st.rows.map(function(r){
                return [
                  '<span class="mono">'+esc(r.provider)+'</span>',
                  '<span class="mono">'+esc(r.items)+'</span>',
                  '<span class="mono">'+esc(r.usable)+'</span>',
                  r.missing?pill(String(r.missing),'warn'):pill('0','ok')
                ];
              }))
            : '<div class="empty">未识别到 <span class="mono">providers</span> 对象。</div>'),
        actions:[
          {label:'取消'},
          {label:'确认导入', kind:'danger', onClick:function(){ return runImport(doc); }}
        ]
      });
    }

    function clearInput(){
      if(textArea) textArea.value='';
      if(fileInput) fileInput.value='';
      previewImport('');
      if(importState){ importState.textContent='未导入'; importState.className='pill mute'; }
      if(ctx.stale()) return;
      importBody.innerHTML='';
      U.toast('输入已清空','info');
    }

    if(exportBtn) exportBtn.addEventListener('click', doExport);
    if(downloadBtn) downloadBtn.addEventListener('click', downloadExport);
    if(importBtn) importBtn.addEventListener('click', askImport);
    if(clearBtn) clearBtn.addEventListener('click', clearInput);
    if(textArea) textArea.addEventListener('input', function(){ previewImport(textArea.value); });
    if(fileInput) fileInput.addEventListener('change', function(){
      var f=fileInput.files&&fileInput.files[0];
      if(f) readFile(f);
    });

    previewImport('');
  }
});

})();
