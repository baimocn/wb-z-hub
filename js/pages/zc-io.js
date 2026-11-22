/* ─────────────────────────────────────────────────────────────
 * 页面：备份恢复（zc-io）—— 组件层重构版
 *
 * 覆盖端点（全部经 HUB.api.zc.*，无裸 fetch）：
 *   zc.exportData(payload) → POST /admin/api/export  账号池整包导出（含明文，no-store）
 *   zc.importData(doc)     → POST /admin/api/import  导出文档并入账号池，返回 {count}
 *
 * 结构：
 *   1) 常量 / state              2) 纯格式化工具（导出文档结构摘要）
 *   3) shell 布局 + 指标卡        4) 说明区台账（filterBar + dataTable）
 *   5) 导出表单 Modal            6) 导入表单 Modal（读取 / 预览 / 二次确认 / 提交）
 *   7) 事件委托 + 首屏
 *
 * 契约：HUB.shell 管理标题 / 工具栏 / 内容区 / 监听 / 清理；表格 / 指标卡 / 筛选用
 *       HUB.components；颜色只用 var(--…) 令牌；明文只在本页闭包里停留，不写
 *       localStorage，切页时 closeModal 并清空引用。
 * ───────────────────────────────────────────────────────────── */
HUB.register({
  route:'zc-io', group:'zc', title:'备份恢复', order:90,
  async render(el, ctx){
    const U=HUB.ui, C=HUB.components, zc=HUB.api.zc;
    const shell=HUB.shell(el, ctx);
    const esc=U.esc;

    /* ═══ 1. 常量 / state（state 是本页唯一事实源） ═══ */
    const SECRET_KEYS=['secret','token','jwtToken','apiKey'];
    const CAT_OPTS=[
      {value:'all',label:'全部类别'},
      {value:'export',label:'导出'},
      {value:'import',label:'导入'},
      {value:'boundary',label:'边界'},
      {value:'secure',label:'安全'}
    ];
    const CAT_LABEL={export:'导出',import:'导入',boundary:'边界',secure:'安全'};
    const CAT_KIND={export:'info',import:'warn',boundary:'mute',secure:'bad'};

    /* 说明区台账：一行一条口径，cat 供 filterBar 筛选 */
    const DOC_ROWS=[
      {item:'导出载荷', cat:'export',
       scope:'账号导出文档：按 providers 分组，每条含 name / mode / secret（JWT 或 API Key 明文）；响应头 Cache-Control: no-store，不落浏览器缓存。'},
      {item:'导出传输', cat:'export',
       scope:'只走 POST /admin/api/export：凭据不进入浏览器历史或 Referer；下载文件名为 zcode-backup-YYYYMMDD-HHmmss.json。'},
      {item:'导入载荷', cat:'import',
       scope:'导出文档（任意 JSON 对象）；返回 {count}。count 是本次处理条目数，不是新增行数。'},
      {item:'导入去重', cat:'import',
       scope:'同 token、同 JWT uid 的条目由后端入池逻辑去重（不新建行）；新增的 JWT 号后台跑安装序并自动领取（幂等）。'},
      {item:'不包含', cat:'boundary',
       scope:'设置、请求监控环形日志、额度快照与调用统计 —— 清单未记载在导出文档内，这些数据各有独立端点。'},
      {item:'WB 侧账号', cat:'boundary',
       scope:'不在本文档内：WORKBUDDY 账号池走 wb 侧 GET /accounts/export（清单 §1），与 ZCODE 账号池互不相通。'},
      {item:'Provider 白名单', cat:'boundary',
       scope:'后端只导入其支持的 provider；未知 provider 的条目会被跳过，不计入 count。'},
      {item:'凭据处置', cat:'secure',
       scope:'明文只在本页内存中停留：不写 localStorage、不在界面展开 secret 字段、切页即丢弃；导出文件请加密保存，导入后删除临时文件。'}
    ];

    /* 导出结果 / 导入预览 / 导入确认三处共用同一张 provider 摘要表 */
    const PROVIDER_COLUMNS=[
      {key:'provider', label:'Provider', render:v=>'<span class="mono">'+esc(v)+'</span>'},
      {key:'items', label:'条目', align:'right'},
      {key:'usable', label:'含凭据', align:'right'},
      {key:'missing', label:'缺凭据', align:'right', render:v=>v?U.pill(String(v),'warn'):U.pill('0','ok')},
      {key:'modes', label:'模式分布', render:v=>modeText(v)}
    ];
    const DOC_COLUMNS=[
      {key:'item', label:'项', render:v=>'<span class="mono">'+esc(v)+'</span>'},
      {key:'cat', label:'类别', render:v=>U.pill(CAT_LABEL[v]||v, CAT_KIND[v]||'mute')},
      {key:'scope', label:'口径', render:v=>esc(v)}
    ];

    const state={cat:'all', exporting:false, importing:false};
    let lastExport=null;   /* {doc,text,at,stats,bytes} 最近一次成功导出（只在本页内存） */
    let lastImport=null;   /* {count,at} 最近一次成功导入 */
    let exportErr=null;    /* 最近一次导出失败的 Error，供弹窗渲染失败态 */
    let draft='';          /* 导入输入框草稿：关闭弹窗再打开不丢，切页即清 */
    let reader=null;       /* 正在读取的 FileReader，切页时 abort */
    let dlUrl=null, dlTimer=null;
    let cardsBox=null, docFbar=null, docTable=null, docCount=null;

    /* ═══ 2. 纯格式化工具（不含 DOM 写入） ═══ */
    function clip(e){
      const s=String((e&&e.message)||e||'');
      return s.length>200? s.slice(0,200)+'…' : s;
    }
    function scalar(v){ return (v===null||v===undefined||typeof v==='object')? '—' : v; }
    function pad2(n){ return n<10? '0'+n : ''+n; }
    function stamp(d){
      return ''+d.getFullYear()+pad2(d.getMonth()+1)+pad2(d.getDate())+'-'+
        pad2(d.getHours())+pad2(d.getMinutes())+pad2(d.getSeconds());
    }
    function sizeText(bytes){
      const n=Number(bytes)||0;
      if(n<1024) return n+' B';
      if(n<1024*1024) return (n/1024).toFixed(1)+' KB';
      return (n/1024/1024).toFixed(2)+' MB';
    }
    /* epoch 秒（后端 time.time()）→ 本地时间；非数字返回 — */
    function tsSafe(v){ const n=Number(v); return (isFinite(n)&&n>0)? U.ts(n) : '—'; }
    function hasSecret(it){
      if(!it||typeof it!=='object') return false;
      for(let i=0;i<SECRET_KEYS.length;i++){ if(it[SECRET_KEYS[i]]) return true; }
      return false;
    }
    /* 只做结构与计数摘要，绝不把 secret 取出到视图层 */
    function inspectDoc(doc){
      const providers=(doc&&typeof doc==='object')? doc.providers : null;
      const valid=!!providers&&typeof providers==='object'&&!Array.isArray(providers);
      const rows=[];
      let total=0, usable=0;
      if(valid){
        Object.keys(providers).forEach(function(p){
          const items=Array.isArray(providers[p])? providers[p] : [];
          const modes={};
          let ok=0, missing=0;
          items.forEach(function(it){
            if(hasSecret(it)){
              ok++;
              const m=String((it&&it.mode)||'unknown');
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
        version:(doc&&typeof doc==='object')? doc.version : null,
        exportedAt:(doc&&typeof doc==='object')? doc.exported_at : null
      };
    }
    function modeText(modes){
      const keys=Object.keys(modes||{});
      if(!keys.length) return '—';
      return keys.map(function(k){
        return esc(k)+' <span class="mono">'+esc(modes[k])+'</span>';
      }).join(' · ');
    }
    function readOnlyField(label, value){
      return '<label style="display:block;margin-bottom:var(--sp-2)">'
        +'<span style="display:block;color:var(--ink-3);font-size:11.5px;margin-bottom:4px">'+label+'</span>'
        +'<input value="'+esc(value)+'" readonly style="width:100%"></label>';
    }

    /* ═══ 3. shell 布局（标题 / 工具栏 / 内容区骨架只建一次） ═══ */
    function buildLayout(){
      shell.toolbar().innerHTML=
        '<div class="toolbar">'
        +'<button class="btn pri" data-act="open-export">导出备份</button>'
        +'<button class="btn" data-act="open-import">导入备份</button>'
        +U.pill('范围：ZCODE 账号池','info')
        +U.pill('明文凭据','bad')
        +U.pill('导入需二次确认','warn')
        +'<span style="flex:1"></span>'
        +'<span class="dim" style="font-size:11px">导出 / 导入表单都在弹窗内打开</span>'
        +'</div>';
      const c=shell.content();
      c.innerHTML=
        '<div id="zi-cards"></div>'
        +'<h2>说明 · 数据范围与边界</h2>'
        +'<p class="sub" style="margin-bottom:var(--sp-2)">口径以 <b class="mono">docs/api-inventory.md</b> §12 的两条导出 / 导入记录为准；下表写清「包含 / 不包含」，避免把备份当成整机快照。</p>'
        +'<div class="toolbar"><span id="zi-doc-fbar"></span><span class="pill mute" id="zi-doc-count"></span></div>'
        +'<div id="zi-doc-table" style="overflow-x:auto"></div>'
        +'<h2>安全须知</h2>'
        +'<div class="toolbar">'+U.pill('明文凭据','bad')+U.pill('仅内存持有','ok')+U.pill('导入二次确认','warn')+'</div>'
        +'<p class="sub" style="margin-top:var(--sp-2)">导出文档等同于账号池的完整控制权：不要提交到 Git、不要发到聊天 / 工单 / 截图；下载后请加密保存，导入完成后删除临时文件。本页不把文档写入 <b class="mono">localStorage</b>，也不在界面上展开 <b class="mono">secret</b> 字段。</p>';
      cardsBox=c.querySelector('#zi-cards');
      docFbar=c.querySelector('#zi-doc-fbar');
      docTable=c.querySelector('#zi-doc-table');
      docCount=c.querySelector('#zi-doc-count');
      C.filterBar(docFbar,[{key:'cat',label:'类别',options:CAT_OPTS}], state, function(){ paintDoc(); });
      paintCards();
      paintDoc();
    }
    /* 指标卡：本次挂载的导出 / 导入快照（无数据时显示 —，不编造） */
    function paintCards(){
      if(!shell.alive||!cardsBox) return;
      const e=lastExport, i=lastImport;
      C.statCards(cardsBox,[
        {label:'最近导出 · 条目', value:e? String(e.stats.total) : '—',
         sub:e? esc('含凭据 '+e.stats.usable+' 条 · provider '+e.stats.rows.length+' 个') : '尚未导出'},
        {label:'导出文档大小', value:e? sizeText(e.bytes) : '—',
         sub:e? esc('版本 '+scalar(e.stats.version)+' · 导出时间 '+tsSafe(e.stats.exportedAt)) : '导出后显示'},
        {label:'最近导入 · count', value:i? String(scalar(i.count)) : '—',
         sub:i? esc('提交时间 '+U.ts(i.at.getTime()/1000)+' · 口径为处理条目数') : '尚未导入'},
        {label:'凭据驻留', value:'仅内存',
         sub:'不写 localStorage · 切页即丢弃'}
      ]);
    }
    /* 说明区台账：按类别筛选 */
    function paintDoc(){
      if(!shell.alive||!docTable) return;
      const rows=state.cat==='all'? DOC_ROWS : DOC_ROWS.filter(function(r){ return r.cat===state.cat; });
      C.dataTable(docTable,{columns:DOC_COLUMNS, rows:rows, emptyText:'该类别没有条目'});
      if(docCount) docCount.textContent='显示 '+rows.length+' / '+DOC_ROWS.length+' 条';
    }

    /* ═══ 4. 导出表单 Modal（POST /admin/api/export） ═══ */
    function openExportModal(){
      const m=U.openModal({
        title:'导出备份 · POST /admin/api/export',
        wide:true,
        body:
          '<p class="sub" style="margin-top:0">按 <b class="mono">providers</b> 分组导出当前账号池（每条含 name / mode / 凭据）。端点无参数；导出走 POST，凭据不会进入浏览器历史或 Referer，响应头为 <b class="mono">Cache-Control: no-store</b>。</p>'
          +'<h2 style="margin-top:0">请求参数（只读）</h2>'
          +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-2)">'
          +readOnlyField('端点','POST /admin/api/export')
          +readOnlyField('请求载荷','{}（无参数）')
          +readOnlyField('凭据','含 JWT / API Key 明文')
          +readOnlyField('缓存','no-store（禁止中间缓存）')
          +'</div>'
          +'<div class="toolbar" style="margin-top:var(--sp-2)">'
          +'<button class="btn" id="zi-dl" disabled>下载 JSON</button>'
          +'<span class="pill mute" id="zi-estate">尚未导出</span>'
          +'<span style="flex:1"></span>'
          +'<span class="dim" style="font-size:11px">明文只保留在本页内存（最近一次导出），切页即丢弃</span>'
          +'</div>'
          +'<div id="zi-elive"></div>'
          +'<p class="sub" style="margin-top:var(--sp-2)">下载文件名为 <b class="mono">zcode-backup-YYYYMMDD-HHmmss.json</b>；文件含明文凭据，请加密保存。</p>',
        actions:[{label:'关闭'},{label:'导出备份', kind:'pri', onClick:function(){ return runExport(m); }}]
      });
      const dl=m.querySelector('#zi-dl');
      shell.listen(dl,'click',downloadExport);
      paintExport(m);
    }
    /* 导出区唯一视图入口：空闲 / 生成中 / 失败 / 结果 四态都从这里渲染 */
    function paintExport(m){
      const st=m.querySelector('#zi-estate'), live=m.querySelector('#zi-elive'), dl=m.querySelector('#zi-dl');
      if(!st||!live) return;
      if(dl) dl.disabled=!lastExport;
      if(state.exporting){
        st.className='pill warn'; st.textContent='正在读取账号池…';
        live.innerHTML=U.loadHtml('正在生成导出文档…');
        return;
      }
      if(exportErr){
        st.className='pill bad'; st.textContent='导出失败';
        live.innerHTML='<div class="empty">导出失败：'+esc(clip(exportErr))
          +(lastExport? '（上一次成功导出的文档仍在内存，可点「下载 JSON」保存）':'')+'</div>';
        return;
      }
      if(!lastExport){
        st.className='pill mute'; st.textContent='尚未导出';
        live.innerHTML='';
        return;
      }
      const s=lastExport.stats;
      if(!s.valid){
        st.className='pill bad'; st.textContent='文档结构异常';
        live.innerHTML='<div class="empty">导出返回的文档里没有 <b class="mono">providers</b> 对象，请核对后端版本；文档已留在内存，可点「下载 JSON」原样保存。</div>';
        return;
      }
      st.className='pill ok'; st.textContent='已导出 · '+s.usable+' 条';
      live.innerHTML='<div id="zi-ecards"></div><div id="zi-etable" style="overflow-x:auto"></div>';
      C.statCards(live.querySelector('#zi-ecards'),[
        {label:'账号条目', value:String(s.total), unit:'条',
         sub:s.usable<s.total? esc('其中 '+(s.total-s.usable)+' 条缺凭据，导入时跳过') : '全部条目含凭据'},
        {label:'含凭据条目', value:String(s.usable), unit:'条',
         sub:'按 secret / token / jwtToken / apiKey 判定'},
        {label:'Provider', value:String(s.rows.length), unit:'个',
         sub:s.rows.length? esc(s.rows.map(function(r){ return r.provider+' '+r.usable; }).join(' · ')) : '—'},
        {label:'文档大小', value:sizeText(lastExport.bytes),
         sub:esc('版本 '+scalar(s.version)+' · 导出时间 '+tsSafe(s.exportedAt))}
      ]);
      C.dataTable(live.querySelector('#zi-etable'),{columns:PROVIDER_COLUMNS, rows:s.rows, emptyText:'导出文档为空'});
    }
    async function runExport(m){
      if(state.exporting){ U.toast('导出进行中，请勿重复点击','warn'); return true; }
      state.exporting=true; exportErr=null;
      paintExport(m);
      try{
        const doc=await zc.exportData({});
        if(!shell.alive) return true;
        const text=JSON.stringify(doc==null? {} : doc, null, 2);
        lastExport={doc:doc, text:text, at:new Date(), stats:inspectDoc(doc), bytes:new Blob([text]).size};
      }catch(e){
        exportErr=e;
      }finally{
        state.exporting=false;
      }
      if(!shell.alive) return true;
      paintCards();
      if(m.isConnected) paintExport(m);
      if(exportErr) U.toast('导出失败：'+clip(exportErr),'bad');
      else U.toast('导出完成：'+lastExport.stats.usable+' 条含凭据条目','ok');
      return true;
    }
    function downloadExport(){
      if(!lastExport||!lastExport.text){ U.toast('还没有可下载的导出文档','warn'); return; }
      const blob=new Blob([lastExport.text],{type:'application/json;charset=utf-8'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;
      a.download='zcode-backup-'+stamp(lastExport.at)+'.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      if(dlTimer){ clearTimeout(dlTimer); dlTimer=null; }
      if(dlUrl){ try{ URL.revokeObjectURL(dlUrl); }catch(e){} }
      dlUrl=url;
      dlTimer=setTimeout(function(){
        try{ URL.revokeObjectURL(url); }catch(e){}
        if(dlUrl===url) dlUrl=null;
        dlTimer=null;
      },5000);
      U.toast('已开始下载（文件含明文凭据，请加密保存）','warn');
    }

    /* ═══ 5. 导入表单 Modal（POST /admin/api/import） ═══ */
    function setParse(m, text, kind){
      const p=m.querySelector('#zi-parse');
      if(!p) return;
      p.className='pill '+(kind||'mute');
      p.textContent=text;
    }
    function openImportModal(){
      const m=U.openModal({
        title:'导入备份 · POST /admin/api/import',
        wide:true,
        body:
          '<p class="sub" style="margin-top:0">粘贴或选择导出的 JSON 文档。导入只做「并入」：同 token / 同 JWT uid 的账号由后端去重，不会新建重复行；<b>不会删除或禁用现有账号</b>。新增的 JWT 号会在后台跑安装序并自动领取。</p>'
          +'<div class="toolbar">'
          +'<input type="file" id="zi-file" accept=".json,application/json">'
          +'<span class="pill mute" id="zi-parse">等待文档</span>'
          +'<span style="flex:1"></span>'
          +'<span class="dim" style="font-size:11px">建议先核对账号池数量，导入后再核对一次</span>'
          +'</div>'
          +'<textarea id="zi-text" rows="10" spellcheck="false" placeholder="在此粘贴导出文档 JSON…（含明文凭据，请勿发到聊天 / 工单）" style="width:100%;resize:vertical;font-family:var(--font-mono);font-size:11.5px"></textarea>'
          +'<div id="zi-preview"></div>'
          +'<div id="zi-confirm"></div>'
          +'<div id="zi-result"></div>',
        actions:[
          {label:'关闭'},
          {label:'清空输入', onClick:function(){ clearInput(m); return true; }},
          {label:'导入备份', kind:'danger', onClick:function(){ askConfirm(m); return true; }}
        ]
      });
      const file=m.querySelector('#zi-file'), ta=m.querySelector('#zi-text');
      if(ta&&draft) ta.value=draft;
      shell.listen(file,'change',function(){
        const f=file.files&&file.files[0];
        if(f) readFile(f,m);
      });
      shell.listen(ta,'input',function(){
        draft=ta.value;
        const cb=m.querySelector('#zi-confirm'); if(cb) cb.innerHTML='';
        const rs=m.querySelector('#zi-result'); if(rs) rs.innerHTML='';
        previewImport(m);
      });
      if(draft) previewImport(m);
    }
    /* 解析输入框文本：成功返回 {doc,stats}；失败把原因写进预览区并返回 null（同一次解析供预览与确认复用） */
    function parseInput(m){
      const ta=m.querySelector('#zi-text'), box=m.querySelector('#zi-preview');
      const raw=String((ta&&ta.value)||'').trim();
      if(!raw){
        setParse(m,'等待文档','mute');
        if(box) box.innerHTML='';
        return null;
      }
      let doc;
      try{ doc=JSON.parse(raw); }
      catch(e){
        setParse(m,'JSON 解析失败','bad');
        if(box) box.innerHTML='<div class="empty">JSON 解析失败：'+esc(clip(e))+'</div>';
        return null;
      }
      if(!doc||typeof doc!=='object'||Array.isArray(doc)){
        setParse(m,'根节点必须是对象','bad');
        if(box) box.innerHTML='<div class="empty">导入文档的根节点必须是 JSON 对象（与 <b class="mono">/admin/api/export</b> 的输出一致）。</div>';
        return null;
      }
      return {doc:doc, stats:inspectDoc(doc)};
    }
    /* 边输入边解析：只读结构，不展开 secret */
    function previewImport(m){
      const box=m.querySelector('#zi-preview');
      if(!box) return;
      const p=parseInput(m);
      if(!p) return;
      const st=p.stats;
      if(!st.valid){
        setParse(m,'缺少 providers','warn');
        box.innerHTML='<div class="empty">没有识别到 <b class="mono">providers</b> 对象（根节点字段：<b class="mono">'
          +esc(Object.keys(p.doc).slice(0,10).join(', ')||'空对象')+'</b>）。后端导入会按 0 条处理，确认要提交可继续。</div>';
        return;
      }
      setParse(m,'可导入 · '+st.usable+' 条','ok');
      box.innerHTML='<div class="toolbar">'
        +U.pill('版本 '+scalar(st.version),'mute')
        +U.pill('导出时间 '+tsSafe(st.exportedAt),'mute')
        +U.pill('含凭据 '+st.usable+' 条','info')
        +U.pill('缺凭据 '+st.rows.reduce(function(s,r){ return s+r.missing; },0)+' 条','warn')
        +'</div><div id="zi-ptable" style="overflow-x:auto"></div>';
      C.dataTable(box.querySelector('#zi-ptable'),{
        columns:PROVIDER_COLUMNS, rows:st.rows, emptyText:'文档中没有条目'
      });
    }
    function readFile(file, m){
      if(file.size>4*1024*1024){
        U.toast('文件超过 4 MB，已拒绝读取（导出文档通常很小）','bad');
        return;
      }
      if(reader){ try{ reader.abort(); }catch(e){} }
      const fr=new FileReader();
      reader=fr;
      fr.onload=function(){
        reader=null;
        if(!shell.alive||!m.isConnected) return;
        const ta=m.querySelector('#zi-text');
        if(ta){ ta.value=String(fr.result||''); draft=ta.value; }
        const cb=m.querySelector('#zi-confirm'); if(cb) cb.innerHTML='';
        const rs=m.querySelector('#zi-result'); if(rs) rs.innerHTML='';
        previewImport(m);
        U.toast('已读取 '+file.name,'info');
      };
      fr.onerror=function(){ reader=null; if(shell.alive) U.toast('读取文件失败','bad'); };
      fr.readAsText(file,'utf-8');
    }
    /* 二次确认：渲染在同一个弹窗内，取消不丢输入 */
    function askConfirm(m){
      const ta=m.querySelector('#zi-text');
      if(!String((ta&&ta.value)||'').trim()){ U.toast('请先粘贴或选择备份文档','warn'); return; }
      const box=m.querySelector('#zi-confirm');
      if(!box) return;
      const p=parseInput(m);
      if(!p){ U.toast('文档还不满足导入条件，请先修正上方提示','bad'); return; }
      const st=p.stats, doc=p.doc;
      const rs=m.querySelector('#zi-result'); if(rs) rs.innerHTML='';
      const lead=st.valid
        ? ('确认后会把 <b class="mono">'+esc(String(st.usable))+'</b> 条含凭据条目提交到 <b class="mono">POST /admin/api/import</b>。')
        : ('文档里没有识别到 <b class="mono">providers</b>；后端会按 0 条处理。');
      box.innerHTML=
        '<div class="toolbar" style="margin-top:var(--sp-3)">'
        +U.pill('写操作','bad')+U.pill('只并入，不删除','ok')+U.pill('明文凭据','warn')
        +'</div>'
        +'<p class="sub">'+lead+' 同 token / 同 JWT uid 的账号由后端去重（不新建行）；导入不会删除或禁用任何现有账号。</p>'
        +(st.valid? '<div id="zi-ctable" style="overflow-x:auto"></div>' : '')
        +'<div class="toolbar"><button class="btn danger" id="zi-commit">确认导入</button>'
        +'<button class="btn" id="zi-cancel">取消</button></div>';
      if(st.valid){
        C.dataTable(box.querySelector('#zi-ctable'),{
          columns:PROVIDER_COLUMNS, rows:st.rows, emptyText:'文档中没有条目'
        });
      }
      shell.listen(box.querySelector('#zi-commit'),'click',function(){ runImport(m,doc); });
      shell.listen(box.querySelector('#zi-cancel'),'click',function(){ box.innerHTML=''; });
    }
    async function runImport(m, doc){
      if(state.importing){ U.toast('导入进行中，请勿重复提交','warn'); return; }
      state.importing=true;
      const commit=m.querySelector('#zi-commit'), out=m.querySelector('#zi-result');
      if(commit){ commit.disabled=true; commit.textContent='导入中…'; }
      if(out) out.innerHTML=U.loadHtml('正在提交到 /admin/api/import…');
      try{
        const res=await zc.importData(doc);
        if(!m.isConnected||!shell.alive) return;
        const count=(res&&res.count!==undefined&&res.count!==null)? res.count : null;
        lastImport={count:count, at:new Date()};
        const cb=m.querySelector('#zi-confirm'); if(cb) cb.innerHTML='';
        if(out){
          out.innerHTML=
            '<div class="toolbar">'+U.pill('导入完成','ok')+U.pill('返回 count='+scalar(count),'info')+'</div>'
            +'<div id="zi-rtable" style="overflow-x:auto"></div>'
            +'<p class="sub" style="margin-top:var(--sp-2)">导入文档仍留在输入框；核对无误后请点「清空输入」并删除本地临时文件。</p>';
          C.dataTable(out.querySelector('#zi-rtable'),{
            columns:[{key:'k',label:'项'},{key:'v',label:'结果',render:function(v){ return v; }}],
            rows:[
              {k:'后端返回 count', v:'<b class="mono">'+esc(scalar(count))+'</b>'},
              {k:'口径', v:'本次处理条目数（含去重跳过）；不是新增行数'},
              {k:'后续动作', v:'新 JWT 号后台安装 + 自动领取（幂等，重复 token 不新增）'},
              {k:'下一步', v:'<a href="#/zc-accounts">前往 ZC 账号池核对</a>'}
            ],
            emptyText:'—'
          });
        }
        setParse(m,'已导入 · '+scalar(count)+' 条','ok');
        paintCards();
        U.toast('导入完成：处理 '+scalar(count)+' 条','ok');
      }catch(e){
        if(m.isConnected&&shell.alive){
          setParse(m,'导入失败','bad');
          if(out) out.innerHTML='<div class="empty">导入失败：'+esc(clip(e))+'</div>';
        }
        U.toast('导入失败：'+clip(e),'bad');
      }finally{
        state.importing=false;
        if(m.isConnected){
          const c2=m.querySelector('#zi-commit');
          if(c2){ c2.disabled=false; c2.textContent='确认导入'; }
        }
      }
    }
    function clearInput(m){
      draft='';
      const ta=m.querySelector('#zi-text'); if(ta) ta.value='';
      const f=m.querySelector('#zi-file'); if(f) f.value='';
      const pv=m.querySelector('#zi-preview'); if(pv) pv.innerHTML='';
      const cb=m.querySelector('#zi-confirm'); if(cb) cb.innerHTML='';
      const rs=m.querySelector('#zi-result'); if(rs) rs.innerHTML='';
      setParse(m,'等待文档','mute');
      U.toast('输入已清空','info');
    }

    /* ═══ 6. 事件委托 + 首屏装配 ═══ */
    function onPageClick(ev){
      const btn=(ev.target&&ev.target.closest)? ev.target.closest('[data-act]') : null;
      if(!btn||!el.contains(btn)) return;
      const act=btn.getAttribute('data-act');
      if(act==='open-export'){ openExportModal(); return; }
      if(act==='open-import'){ openImportModal(); }
    }

    shell.setTitle('备份恢复',
      'ZCODE 账号池的整包导出与导入 · 文档含 JWT / API Key 明文，只在本页内存中停留 · 导出 POST /admin/api/export · 导入 POST /admin/api/import');
    buildLayout();
    shell.listen(el,'click',onPageClick);
    /* 弹窗挂在 body 上（不在 el 里），而 router 目前不调用 shell.destroy()：
       用自停哨兵兜底，切走页面后关掉弹窗，避免明文输入框盖住新页面。 */
    const staleWatch=setInterval(function(){
      if(ctx.stale()){ clearInterval(staleWatch); U.closeModal(); }
    },300);
    shell.onCleanup(function(){
      clearInterval(staleWatch);
      if(reader){ try{ reader.abort(); }catch(e){} reader=null; }
      if(dlTimer){ clearTimeout(dlTimer); dlTimer=null; }
      if(dlUrl){ try{ URL.revokeObjectURL(dlUrl); }catch(e){} dlUrl=null; }
      lastExport=null; lastImport=null; exportErr=null; draft='';
      U.closeModal();
    });
  }
});
