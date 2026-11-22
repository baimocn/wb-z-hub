/* 页面：WB 设置（高级）—— 声明式字段表单 / 全量字段清单 / 风控与设备 Token 运维
 *
 * 组件层结构：
 *   1) shell      —— HUB.shell 管理标题 / 工具栏 / 内容区 / 轮询 / 事件监听与清理
 *   2) 表单       —— WS_FIELD_GROUPS 声明式字段规格（type / label / hint / min / max），
 *                    渲染时写入 data-set，保存时按同一张表回读、校验并组装 payload
 *   3) StatCards  —— HUB.components.statCards 汇总生效开关、媒体限额、风控冻结、设备 Token
 *   4) FilterBar  —— HUB.components.filterBar 按范围 / 类型筛选全量字段清单
 *   5) DataTable  —— HUB.components.dataTable 渲染全量字段（键 / 类型 / 当前值 / 范围）
 *
 * 覆盖端点（HUB.api.wb）：
 *   GET  /wb/settings                     全量设置视图（只读）
 *   POST /wb/settings/save                保存本页字段（扁平键 + media 嵌套补丁）
 *   POST /wb/settings/restriction/reset   立即解除风控连坐暂停
 *   POST /wb/settings/device-token/reload 重载设备 Token
 *
 * 轮询只重画只读区（指标卡 / 全量字段 / 原始 JSON）；表单存在未保存改动时保持原样，
 * 避免把用户正在编辑的值冲掉。
 */

/* ═══ 1. 常量与声明式字段规格（渲染 / 回读 / 校验共用这一个事实源） ═══ */

/* 与后端 wb_settings.MAX_RESTRICTION_HOLD_SECONDS 对齐（7 天） */
const WS_HOLD_MAX=86400*7;

const WS_FIELD_GROUPS=[
  {title:'自动化', fields:[
    {key:'daily_activity', type:'bool', label:'国际版每日活跃打卡', hint:'每日向上游上报活跃，维持账号权重'},
    {key:'daily_chat_web', type:'bool', label:'每日对话保号', hint:'按调度窗口对账号执行网页对话'},
    {key:'daily_chat_budget', type:'int', label:'每日对话预算（秒）', hint:'单账号当日累计对话时长上限；0 = 不限', min:0, max:7200},
    {key:'remaining_priority_enabled', type:'bool', label:'剩余用量优先调度', hint:'剩余额度多的账号优先接请求'}
  ]},
  {title:'稳定性', fields:[
    {key:'affinity_stable_key_enabled', type:'bool', label:'更稳的会话粘滞键', hint:'同会话稳定路由同账号（上游缓存依赖）'},
    {key:'restriction_hold_seconds', type:'int', label:'风控连坐暂停（秒）', hint:'同域多号被限时触发全池暂停；0 = 关闭', min:0, max:WS_HOLD_MAX},
    {key:'account_max_concurrent', type:'int', label:'单账号并发上限', hint:'0 = 不限；1 至 10', min:0, max:10}
  ]},
  {title:'媒体限制', fields:[
    {key:'media.image_max_per_minute', type:'int', label:'生图 / 分钟', hint:'每个 Key 每分钟最多提交几次生图', min:1, max:60},
    {key:'media.video_max_seconds', type:'int', label:'视频最长秒数', hint:'与上游目录的时长上限取较小值', min:1, max:60},
    {key:'media.video_concurrency', type:'int', label:'视频并发', hint:'超出后排队，不提交上游、不扣费', min:1, max:8},
    {key:'media.daily_credits_per_key', type:'int', label:'单 Key 日积分上限', hint:'0 = 不限', min:0, max:100000}
  ]},
  {title:'日志与模型', fields:[
    {key:'log_db_enabled', type:'bool', label:'日志落库', hint:'请求日志写入本地库'},
    {key:'pricing_enabled', type:'bool', label:'价格估算', hint:'按上游定价折算成本'},
    {key:'enable_anthropic_messages', type:'bool', label:'启用 Anthropic Messages 通道', hint:'/v1/messages 走官方形态'},
    {key:'models_only_available', type:'bool', label:'只列出可用模型', hint:'模型列表过滤掉当前不可用的'}
  ]}
];

const WS_KIND_CN={
  boolean:'布尔', number:'数值', string:'文本',
  array:'列表', object:'对象', null:'空值', undefined:'空值'
};

const WS_FILTERS=[
  {key:'scope', label:'范围', options:[
    {value:'all', label:'全部字段'},
    {value:'edit', label:'本页可编辑'},
    {value:'readonly', label:'只读字段'}
  ]},
  {key:'kind', label:'类型', options:[
    {value:'all', label:'全部类型'},
    {value:'boolean', label:'布尔'},
    {value:'number', label:'数值'},
    {value:'string', label:'文本'},
    {value:'array', label:'列表'},
    {value:'object', label:'对象'},
    {value:'null', label:'空值'}
  ]}
];

/* 表单里可编辑的字段路径集合，用于给全量字段清单标「本页可编辑 / 只读」 */
const WS_EDITABLE=(function(){
  const set=new Set();
  WS_FIELD_GROUPS.forEach(function(group){
    group.fields.forEach(function(f){ set.add(f.key); });
  });
  return set;
})();

/* ═══ 2. 纯工具（无 DOM 依赖，便于单独验证） ═══ */

function wsPick(obj, path){
  let cur=obj;
  const parts=String(path).split('.');
  for(let i=0;i<parts.length;i++){
    if(cur===null||cur===undefined||typeof cur!=='object') return undefined;
    cur=cur[parts[i]];
  }
  return cur;
}

function wsPut(root, path, value){
  const parts=String(path).split('.');
  let cur=root;
  for(let i=0;i<parts.length-1;i++){
    const key=parts[i];
    if(!cur[key]||typeof cur[key]!=='object') cur[key]={};
    cur=cur[key];
  }
  cur[parts[parts.length-1]]=value;
  return root;
}

function wsKind(value){
  if(value===null) return 'null';
  if(Array.isArray(value)) return 'array';
  return typeof value;
}

function wsValueText(value){
  if(value===null||value===undefined) return '—';
  if(Array.isArray(value)) return value.length+' 项';
  if(typeof value==='boolean') return value?'开启':'关闭';
  if(typeof value==='object') return Object.keys(value).length+' 个字段';
  const text=String(value);
  return text.length>90 ? text.slice(0,90)+'…' : text;
}

/* 数值边界：优先采用 /settings 返回的服务端范围，规格里的 min / max 只是兜底 */
function wsBounds(field, settings){
  const num=function(v){ const n=Number(v); return Number.isFinite(n)?n:null; };
  let min=num(field.min);
  let max=num(field.max);
  const src=settings||{};
  if(field.key==='daily_chat_budget'){
    const m=num(src.daily_chat_budget_max); if(m!==null) max=m;
  }
  if(field.key==='account_max_concurrent'){
    const m=num(src.account_max_concurrent_max); if(m!==null) max=m;
  }
  if(field.key.indexOf('media.')===0){
    const k=field.key.slice(6);
    const mins=src.media_minimums||{};
    const maxs=src.media_limits||{};
    const a=num(mins[k]); const b=num(maxs[k]);
    if(a!==null) min=a;
    if(b!==null) max=b;
  }
  return {min:min===null?0:min, max:max===null?99999:max};
}

/* 设置对象 → 扁平行（对象递归，数组当叶子，深度上限 3 防止异常结构爆表） */
function wsFlatten(obj){
  const rows=[];
  function walk(node, prefix, depth){
    Object.keys(node).forEach(function(k){
      const path=prefix?prefix+'.'+k:k;
      const value=node[k];
      if(value&&typeof value==='object'&&!Array.isArray(value)&&depth<3){
        walk(value,path,depth+1);
        return;
      }
      rows.push({
        path:path,
        kind:wsKind(value),
        value:value,
        text:wsValueText(value),
        editable:WS_EDITABLE.has(path)
      });
    });
  }
  if(obj&&typeof obj==='object') walk(obj,'',0);
  return rows.sort(function(a,b){ return a.path.localeCompare(b.path,'en'); });
}

function wsClock(ms){
  return new Date(ms).toLocaleTimeString('zh-CN',{hour12:false});
}

/* ═══ 3. 页面模块 ═══ */
HUB.register({
  route:'wb-settings', group:'wb', title:'WB 设置', order:70,
  async render(el, ctx){
    const U=HUB.ui, C=HUB.components, A=HUB.api.wb;
    const shell=HUB.shell(el, ctx);

    const state={
      settings:null,      /* GET /wb/settings 的最近一次成功结果 */
      error:null,         /* 最近一次读取错误（有旧数据时只提示，不清空视图） */
      readAt:0,           /* 最近一次成功读取的时间戳（毫秒） */
      filter:{scope:'all', kind:'all'},
      snapshot:'',        /* 表单上次与服务端对齐时的序列化值，用于脏检查 */
      busy:false
    };
    let boxes={};
    let loadSeq=0;

    /* ─── 3.1 布局：静态骨架只建一次，所有动态内容都写进盒子 ─── */
    function buildLayout(){
      shell.setTitle('WB 设置','常用开关即时保存 · 全量字段清单 · 风控与设备 Token 运维');
      const bar=shell.toolbar();
      if(bar){
        bar.innerHTML='<div class="toolbar">'
          +'<button class="btn mini pri" data-act="save">保存修改</button>'
          +'<button class="btn mini" data-act="reload">重新读取</button>'
          +'<span class="pill mute" id="ws-readat">尚未加载</span>'
          +'<span class="pill mute" id="ws-dirty">—</span>'
          +'<span class="pill mute">只读区每 30 秒自动刷新</span>'
          +'</div>';
      }
      const content=shell.content();
      if(!content) return;
      content.innerHTML=
        '<div id="ws-cards"></div>'
        +'<h2>常用设置</h2>'
        +'<p class="sub">改动后点「保存修改」即时生效（POST /wb/settings/save）；保存后会重新读取服务端值。</p>'
        +'<div id="ws-form"></div>'
        +'<div class="toolbar">'
          +'<button class="btn pri" data-act="save">保存以上字段</button>'
          +'<button class="btn" data-act="unhold">解除风控连坐暂停</button>'
          +'<button class="btn" data-act="device">重载设备 Token</button>'
          +'<span class="dim" style="font-size:var(--fs-xs)">保存只提交本页字段，其他配置不受影响</span>'
        +'</div>'
        +'<h2>全量字段</h2>'
        +'<p class="sub">GET /wb/settings 的扁平视图；完整嵌套结构见底部原始 JSON。</p>'
        +'<div class="toolbar" id="ws-filters"></div>'
        +'<div id="ws-table" style="overflow-x:auto"></div>'
        +'<details style="margin-top:var(--sp-4)">'
          +'<summary style="cursor:pointer;color:var(--ink-3)">原始 JSON（只读，最多 20000 字符）</summary>'
          +'<pre class="raw" id="ws-json" style="max-height:360px"></pre>'
        +'</details>';
      boxes={
        cards:content.querySelector('#ws-cards'),
        form:content.querySelector('#ws-form'),
        filters:content.querySelector('#ws-filters'),
        table:content.querySelector('#ws-table'),
        json:content.querySelector('#ws-json'),
        readAt:bar?bar.querySelector('#ws-readat'):null,
        dirty:bar?bar.querySelector('#ws-dirty'):null
      };
      C.filterBar(boxes.filters, WS_FILTERS, state.filter, function(){ paintTable(); });
      if(boxes.cards) boxes.cards.innerHTML=U.loadHtml('拉取设置中…');
      if(boxes.form) boxes.form.innerHTML=U.loadHtml('拉取设置中…');
      if(boxes.table) boxes.table.innerHTML=U.loadHtml('拉取设置中…');
    }

    /* ─── 3.2 表单：按声明式规格渲染，data-set 承载字段路径 ─── */
    function fieldHtml(field, settings){
      const raw=wsPick(settings, field.key);
      if(field.type==='bool'){
        return '<label style="display:flex;gap:var(--sp-2);align-items:flex-start;cursor:pointer;margin:0 0 var(--sp-3)">'
          +'<input type="checkbox" data-set="'+U.esc(field.key)+'"'+(raw===true?' checked':'')+'>'
          +'<span><b>'+U.esc(field.label)+'</b>'
          +(field.hint?'<div class="dim" style="font-size:var(--fs-xs);margin-top:2px">'+U.esc(field.hint)+'</div>':'')
          +'</span></label>';
      }
      const bound=wsBounds(field, settings);
      return '<div style="margin-bottom:var(--sp-3)">'
        +'<label style="display:block;margin-bottom:var(--sp-1)"><b>'+U.esc(field.label)+'</b></label>'
        +'<input type="number" data-set="'+U.esc(field.key)+'" step="1" style="width:140px"'
        +' min="'+U.esc(String(bound.min))+'" max="'+U.esc(String(bound.max))+'"'
        +' value="'+U.esc(raw===undefined||raw===null?'':String(raw))+'">'
        +(field.hint?'<div class="dim" style="font-size:var(--fs-xs);margin-top:2px">'+U.esc(field.hint)+'</div>':'')
        +'</div>';
    }

    function paintForm(){
      if(!boxes.form) return;
      const settings=state.settings||{};
      boxes.form.innerHTML='<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">'
        +WS_FIELD_GROUPS.map(function(group){
          return '<div class="card"><div class="k">'+U.esc(group.title)+'</div>'
            +group.fields.map(function(f){ return fieldHtml(f,settings); }).join('')
            +'</div>';
        }).join('')
        +'</div>';
      state.snapshot=JSON.stringify(collect(false));
      paintDirty();
    }

    function inputFor(key){
      if(!boxes.form) return null;
      return boxes.form.querySelector('[data-set="'+key+'"]');
    }

    /* 按规格回读表单：collect(true) 会做数字 / 整数 / 范围校验，collect(false) 只取快照 */
    function collect(validate){
      const payload={};
      const settings=state.settings||{};
      WS_FIELD_GROUPS.forEach(function(group){
        group.fields.forEach(function(field){
          const input=inputFor(field.key);
          if(!input) return;
          if(field.type==='bool'){
            wsPut(payload, field.key, !!input.checked);
            return;
          }
          const value=Number(input.value);
          if(validate){
            if(String(input.value).trim()===''||!Number.isFinite(value)){
              throw new Error('「'+field.label+'」需要填写数字');
            }
            if(!Number.isInteger(value)){
              throw new Error('「'+field.label+'」需要填写整数');
            }
            const bound=wsBounds(field, settings);
            if(value<bound.min||value>bound.max){
              throw new Error('「'+field.label+'」需在 '+bound.min+' 至 '+bound.max+' 之间');
            }
          }
          wsPut(payload, field.key, value);
        });
      });
      return payload;
    }

    function isDirty(){
      if(!boxes.form||!boxes.form.querySelector('[data-set]')) return false;
      try{ return JSON.stringify(collect(false))!==state.snapshot; }
      catch(e){ return true; }
    }

    function paintDirty(){
      const pill=boxes.dirty;
      if(!pill) return;
      const dirty=isDirty();
      pill.className='pill '+(dirty?'warn':'ok');
      pill.textContent=dirty?'有未保存修改':'已同步';
    }

    function paintStatus(){
      const pill=boxes.readAt;
      if(!pill) return;
      if(state.error){
        pill.className='pill bad';
        pill.textContent=state.readAt
          ?('刷新失败 · 上次读数 '+wsClock(state.readAt))
          :'读取失败';
        return;
      }
      pill.className='pill mute';
      pill.textContent=state.readAt?('读数 '+wsClock(state.readAt)):'尚未加载';
    }

    /* ─── 3.3 指标卡：全部由 /settings 结果派生 ─── */
    function paintCards(){
      if(!boxes.cards) return;
      const settings=state.settings;
      if(!settings){ boxes.cards.innerHTML=U.loadHtml('拉取设置中…'); return; }
      const holds=(settings.restriction_holds&&typeof settings.restriction_holds==='object')
        ? settings.restriction_holds : {};
      const holdKeys=Object.keys(holds);
      let on=0, total=0;
      const perGroup=WS_FIELD_GROUPS.map(function(group){
        let groupOn=0, groupTotal=0;
        group.fields.forEach(function(field){
          if(field.type!=='bool') return;
          groupTotal++;
          if(wsPick(settings, field.key)===true) groupOn++;
        });
        on+=groupOn; total+=groupTotal;
        return group.title+' '+groupOn+'/'+groupTotal;
      });
      const media=settings.media||{};
      const dev=settings.device_token_status||{};
      const show=function(v){ return v===undefined||v===null?'—':String(v); };
      const credits=media.daily_credits_per_key;
      C.statCards(boxes.cards,[
        {label:'生效开关', value:on+' / '+total, unit:'项', sub:U.esc(perGroup.join(' · '))},
        {label:'媒体限额', value:show(media.image_max_per_minute), unit:'张/分',
          sub:'视频 '+U.esc(show(media.video_max_seconds))+'s · 并发 '+U.esc(show(media.video_concurrency))
            +' · 单 Key 日积分 '+(credits===undefined||credits===null?'—':(credits===0?'不限':U.esc(String(credits))))},
        {label:'风控连坐', value:holdKeys.length, unit:'个域',
          sub:holdKeys.length
            ? holdKeys.map(function(k){ return U.esc(k)+' 剩余 '+U.esc(String(holds[k]))+'s'; }).join(' · ')
            : '当前无冻结'},
        {label:'设备 Token', value:dev.loaded?'已加载':'未加载',
          sub:'来源 '+U.esc(dev.source||'—')+(dev.length?(' · 长度 '+U.esc(String(dev.length))):'')}
      ]);
    }

    /* ─── 3.4 全量字段清单：FilterBar 控制 DataTable ─── */
    function paintTable(){
      if(!boxes.table) return;
      if(!state.settings){ boxes.table.innerHTML=U.loadHtml('拉取设置中…'); return; }
      const rows=wsFlatten(state.settings).filter(function(row){
        const f=state.filter;
        if(f.scope==='edit'&&!row.editable) return false;
        if(f.scope==='readonly'&&row.editable) return false;
        if(f.kind!=='all'&&row.kind!==f.kind) return false;
        return true;
      });
      C.dataTable(boxes.table,{
        columns:[
          {key:'path', label:'键', render:function(v){
            return '<span class="mono">'+U.esc(v)+'</span>';
          }},
          {key:'kind', label:'类型', render:function(v){
            return U.pill(WS_KIND_CN[v]||v,'mute');
          }},
          {key:'value', label:'当前值', render:function(v,row){
            if(row.kind==='boolean') return U.pill(v?'开启':'关闭', v?'ok':'mute');
            if(row.kind==='null'||row.kind==='undefined') return '<span class="dim">—</span>';
            return '<span class="mono">'+U.esc(row.text)+'</span>';
          }},
          {key:'editable', label:'范围', render:function(v){
            return v?U.pill('本页可编辑','ok'):U.pill('只读','mute');
          }}
        ],
        rows:rows,
        rowKey:'path',
        emptyText:'当前筛选下没有字段'
      });
    }

    function paintJson(){
      if(!boxes.json) return;
      boxes.json.textContent=state.settings
        ? JSON.stringify(state.settings,null,2).slice(0,20000)
        : '';
    }

    /* ─── 3.5 失败视图：从未成功读取时铺满提示，否则保留上次成功视图 ─── */
    function failBox(title, e, hint){
      const msg=(e&&e.message)||String(e||'未知错误');
      const status=e&&e.status?('HTTP '+e.status+' · '):'';
      return '<div class="empty"><b>'+U.esc(title)+'</b> · '+U.esc(status+msg)
        +(hint?'<div class="dim">'+U.esc(hint)+'</div>':'')+'</div>';
    }

    function paintError(e){
      const hint='面板会话过期或网关未启动都会走到这里；重试前先确认服务在线。';
      const box=failBox('读取设置失败', e, hint);
      if(boxes.cards) boxes.cards.innerHTML=box;
      if(boxes.form) boxes.form.innerHTML=box
        +'<div class="toolbar"><button class="btn" data-act="reload">重试</button></div>';
      if(boxes.table) boxes.table.innerHTML='';
      if(boxes.json) boxes.json.textContent='';
      if(boxes.dirty){ boxes.dirty.className='pill mute'; boxes.dirty.textContent='未加载'; }
      paintStatus();
    }

    /* ─── 3.6 数据读取与动作 ─── */
    let loading=false;
    async function load(opts){
      const o=opts||{};
      const my=++loadSeq;
      loading=true;
      try{
        const data=await A.settings();
        if(my!==loadSeq||ctx.stale()||!shell.alive) return;
        state.settings=data||{};
        state.error=null;
        state.readAt=Date.now();
        paintStatus();
        paintCards();
        paintJson();
        paintTable();
        if(o.form===true||(o.form!==false&&!isDirty())) paintForm();
        else paintDirty();
        if(o.ok) U.toast(o.ok,'ok');
      }catch(e){
        if(my!==loadSeq||ctx.stale()||!shell.alive) return;
        state.error=e;
        if(state.settings) paintStatus();
        else paintError(e);
        if(o.ok) U.toast('读取设置失败：'+e.message,'bad');
      }finally{
        if(my===loadSeq) loading=false;
      }
    }

    function setBusy(btn, busy){
      if(!btn) return;
      if(busy){
        btn.dataset.label=btn.textContent;
        btn.disabled=true;
        btn.textContent='处理中…';
        return;
      }
      btn.disabled=false;
      if(btn.dataset.label) btn.textContent=btn.dataset.label;
    }

    function guard(){
      if(state.busy){ U.toast('上一次操作尚未完成','warn'); return false; }
      state.busy=true;
      return true;
    }

    async function save(btn){
      if(!guard()) return;
      setBusy(btn,true);
      try{
        const payload=collect(true);
        await A.settingsSave(payload);
        await load({form:true, ok:'设置已保存'});
      }catch(e){
        U.toast('保存失败：'+e.message,'bad');
      }finally{
        setBusy(btn,false);
        state.busy=false;
      }
    }

    async function unhold(btn){
      if(!guard()) return;
      setBusy(btn,true);
      try{
        await A.restrictionReset();
        /* 不强制重画表单：用户可能有未保存的字段改动，只刷新只读区 */
        await load({ok:'风控连坐暂停已解除'});
      }catch(e){
        U.toast('解除失败：'+e.message,'bad');
      }finally{
        setBusy(btn,false);
        state.busy=false;
      }
    }

    async function deviceReload(btn){
      if(!guard()) return;
      setBusy(btn,true);
      try{
        await A.deviceTokenReload();
        /* 同上：保留未保存的表单改动，只刷新只读区 */
        await load({ok:'设备 Token 已重载'});
      }catch(e){
        U.toast('重载失败：'+e.message,'bad');
      }finally{
        setBusy(btn,false);
        state.busy=false;
      }
    }

    /* 事件委托：监听器挂在 shell 根节点上，命中的按钮必然在本页内 */
    function onAction(ev){
      const target=ev.target;
      const btn=target&&target.closest?target.closest('[data-act]'):null;
      if(!btn) return;
      const act=btn.getAttribute('data-act');
      if(act==='save'){ save(btn); return; }
      if(act==='unhold'){ unhold(btn); return; }
      if(act==='device'){ deviceReload(btn); return; }
      if(act==='reload'){
        if(state.busy) return;
        const dirty=isDirty();
        load({form:true, ok:dirty?'已丢弃未保存改动并重新读取':'设置已重新读取'});
      }
    }

    /* ─── 3.7 启动 ─── */
    if(ctx.stale()) return;
    buildLayout();
    shell.listen(el,'click',onAction);
    shell.listen(el,'input',function(){ paintDirty(); });
    await load({form:true});
    if(ctx.stale()) return;
    shell.poll(function(){
      if(!document.hidden&&!loading&&!state.busy) load({});
    },30000);
    shell.onCleanup(function(){ loadSeq++; });
  }
});
