/* 页面：更新 —— 版本 DataTable / 本地备份列表 / 检查与安装按钮
 *
 * 组件层重构结构：
 *   1) state      —— 版本状态 / 备份快照 / 筛选条件的单一事实源
 *   2) StatCards  —— HUB.components.statCards 渲染版本与备份指标
 *   3) DataTable  —— HUB.components.dataTable 渲染可用版本表（含安装动作）与本地备份表
 *   4) FilterBar  —— HUB.components.filterBar 渲染版本视图、备份完整性与来源筛选
 *   5) shell      —— HUB.shell 管理标题 / 工具栏 / 内容区 / 轮询 / 事件监听生命周期
 * 契约：只经 HUB.api.wb.* 取数（禁止裸 fetch）；颜色只用 var(--…) 令牌；全量中文文案。
 */
(function(){
const U=HUB.ui;

/* 安装任务状态（与后端 wb_update_request.VISIBLE_STATES 对齐） */
const INSTALL_STATES={
  idle:['空闲','mute'],
  queued:['已排队','warn'],
  downloading:['下载中','warn'],
  verifying:['校验中','warn'],
  backing_up:['备份中','warn'],
  stopping:['停止服务','warn'],
  applying:['写入中','warn'],
  restoring:['恢复中','warn'],
  restarting:['重启中','warn'],
  checking:['检查中','warn'],
  rolling_back:['回退中','warn'],
  succeeded:['安装成功','ok'],
  restored:['回退完成','ok'],
  rolled_back:['已回退','ok'],
  failed:['失败','bad'],
  unavailable:['状态不可用','bad']
};
const ACTIVE_STATES=['queued','downloading','verifying','backing_up','stopping',
  'applying','restoring','restarting','checking','rolling_back'];

/* 版本筛选：全部 / 当前运行 / 稳定版 */
const VERSION_FILTERS=[
  {key:'verView', label:'版本视图', options:[
    {value:'all', label:'全部'},
    {value:'current', label:'当前运行'},
    {value:'stable', label:'稳定版'}
  ]}
];
/* 备份筛选：完整性 + 来源 */
const BACKUP_FILTERS=[
  {key:'bkIntegrity', label:'完整性', options:[
    {value:'all', label:'全部'},
    {value:'complete', label:'完整'},
    {value:'incomplete', label:'不完整'}
  ]},
  {key:'bkSource', label:'来源', options:[
    {value:'all', label:'全部'},
    {value:'systemd', label:'系统服务'},
    {value:'local', label:'本地目录'},
    {value:'unknown', label:'未注册'}
  ]}
];

function isActive(inst){
  return !!(inst && ACTIVE_STATES.indexOf(String(inst.state||''))>=0);
}
function stateLabel(inst){
  if(!inst) return '空闲';
  const hit=INSTALL_STATES[String(inst.state||'idle')];
  return hit?hit[0]:String(inst.state||'未知');
}
function statePill(inst){
  if(!inst) return U.pill('无状态','mute');
  const hit=INSTALL_STATES[String(inst.state||'idle')];
  return hit?U.pill(hit[0],hit[1]):U.pill(String(inst.state||'未知'),'mute');
}
/* 后端时间有两种形状：Unix 秒 / 已格式化的本地串 / ISO 串 */
function fmtTime(v){
  if(v===null||v===undefined||v==='') return '';
  const s=String(v);
  if(/^\d+$/.test(s)) return U.ts(Number(s));
  return s.replace('T',' ').slice(0,19);
}
function safeUrl(u){
  const s=String(u||'');
  return /^https?:\/\//i.test(s)?s:'';
}
function errText(e){ return (e&&e.message)?String(e.message):String(e||'未知错误'); }
function sourceKey(s){ return (s==='systemd'||s==='local')?s:'unknown'; }
function sourceLabel(s){
  if(s==='systemd') return '系统服务';
  if(s==='local') return '本地目录';
  return '未注册';
}
function keepText(v){ return (v===null||v===undefined)?'—':String(v); }
function clock(){
  try{ return new Date().toLocaleTimeString('zh-CN',{hour12:false}); }
  catch(e){ return ''; }
}

/* 版本表列：当前行与稳定版行共用 */
const VERSION_COLUMNS=[
  {key:'version', label:'版本', render:function(v){
    return v?('<span class="mono">v'+U.esc(v)+'</span>'):'<span class="mono">—</span>';
  }},
  {key:'channel', label:'通道', render:function(v){ return U.esc(v||'—'); }},
  {key:'tag', label:'标签', render:function(v){
    return '<span class="mono">'+U.esc(v||'—')+'</span>';
  }},
  {key:'published', label:'发布时间', render:function(v){ return U.esc(v||'—'); }},
  {key:'release', label:'发布页', render:function(v){
    return v?('<a href="'+U.esc(v)+'" target="_blank" rel="noopener">发布页 ↗</a>'):'<span class="dim">—</span>';
  }},
  {key:'statusHtml', label:'说明', render:function(v){ return v; }}
];

/* 备份表列 */
const BACKUP_COLUMNS=[
  {key:'version', label:'版本', render:function(v){
    return v?('<span class="mono">v'+U.esc(v)+'</span>'):'<span class="mono">—</span>';
  }},
  {key:'size_mb', label:'大小', align:'right', render:function(v){
    return '<span class="mono">'+(Number(v)||0).toFixed(1)+' MB</span>';
  }},
  {key:'files', label:'文件数', align:'right', render:function(v){
    return '<span class="mono">'+U.esc(v||0)+'</span>';
  }},
  {key:'created_at', label:'创建时间', render:function(v){
    return U.esc(fmtTime(v)||'—');
  }},
  {key:'complete', label:'完整性', render:function(v,r){
    if(r.complete) return U.pill('完整','ok');
    return U.pill('不完整','bad')+(r.reason?(' <span class="dim">'+U.esc(r.reason)+'</span>'):'');
  }},
  {key:'source', label:'来源', render:function(v){ return U.esc(sourceLabel(v)); }}
];

HUB.register({
  route:'wb-updates', group:'wb', title:'更新', order:75,
  async render(el, ctx){
    const C=HUB.components, wb=HUB.api.wb;
    const shell=HUB.shell(el, ctx);

    /* ═══ 1. state：版本 / 备份 / 筛选 ═══ */
    const state={
      status:null, backups:null,
      statusErr:null, backupsErr:null,
      verView:'all', bkIntegrity:'all', bkSource:'all',
      busy:false, again:false, lastSync:''
    };
    let cardsBox=null, pillsBox=null, timesBox=null;
    let verBar=null, verCount=null, verBox=null;
    let installBox=null;
    let bkMeta=null, bkBar=null, bkCount=null, bkBox=null;

    /* ═══ 2. 数据形状辅助 ═══ */
    function installation(){
      const st=state.status;
      return (st&&st.installation)?st.installation:null;
    }
    function rawBackups(){
      const list=state.backups&&state.backups.backups;
      return Array.isArray(list)?list:[];
    }
    function backupRows(){
      const fallback=sourceKey(state.backups&&state.backups.source);
      const out=[];
      rawBackups().forEach(function(b,i){
        if(!b||typeof b!=='object') return;
        out.push({
          id:'bk-'+i+'-'+String(b.version||''),
          version:b.version?String(b.version):'',
          size_mb:Number(b.size_mb)||0,
          files:Number(b.files)||0,
          created_at:b.created_at?String(b.created_at):'',
          complete:b.complete===true,
          reason:b.reason?String(b.reason):'',
          source:sourceKey(b.source||fallback)
        });
      });
      return out;
    }
    function installBlock(st,inst){
      if(!st) return '状态不可用';
      if(st.last_error) return '请先成功检查更新';
      if(st.checking) return '检查进行中';
      if(!st.update_available) return '已是最新版本';
      if(!st.latest_tag) return '缺少候选版本标签';
      if(!st.release_url) return '缺少发布页地址';
      if(st.install_enabled===false) return '安装执行器未配置';
      if(isActive(inst)) return '已有任务在运行';
      return '';
    }
    function versionRows(){
      const st=state.status, inst=installation();
      const curRaw=(st&&st.current_version)?String(st.current_version):'';
      const latestV=(st&&st.latest_version)?String(st.latest_version):'';
      const latestTag=(st&&st.latest_tag)?String(st.latest_tag):'';
      const published=fmtTime(st&&st.published_at);
      const url=safeUrl(st&&st.release_url);
      const rows=[{
        id:'current', version:curRaw, channel:'当前运行',
        tag:'', published:'', release:'',
        statusHtml:U.pill('当前','info'), installable:false
      }];
      if(latestV||latestTag){
        const block=installBlock(st,inst);
        rows.push({
          id:'latest', version:latestV, channel:'稳定版',
          tag:latestTag, published:published, release:url,
          statusHtml:block?('<span class="dim">'+U.esc(block)+'</span>'):U.pill('可安装','ok'),
          installable:!block
        });
      }else{
        rows.push({
          id:'stable-none', version:'', channel:'稳定版',
          tag:'', published:'', release:'',
          statusHtml:U.pill('尚未检查','mute'), installable:false
        });
      }
      return rows;
    }
    function filteredVersions(rows){
      if(state.verView==='current') return rows.filter(function(r){ return r.id==='current'; });
      if(state.verView==='stable') return rows.filter(function(r){ return r.id!=='current'; });
      return rows;
    }
    function filteredBackups(rows){
      return rows.filter(function(b){
        if(state.bkIntegrity==='complete'&&!b.complete) return false;
        if(state.bkIntegrity==='incomplete'&&b.complete) return false;
        if(state.bkSource!=='all'&&b.source!==state.bkSource) return false;
        return true;
      });
    }

    /* ═══ 3. 视图渲染 ═══ */
    function paintCards(){
      const st=state.status, bk=state.backups, inst=installation();
      const backups=rawBackups();
      const complete=backups.filter(function(b){ return b.complete===true; }).length;
      const curRaw=(st&&st.current_version)?String(st.current_version):'';
      const latestV=(st&&st.latest_version)?String(st.latest_version):'';
      const latestTag=(st&&st.latest_tag)?String(st.latest_tag):'';
      const published=fmtTime(st&&st.published_at);
      const keepMax=(bk&&bk.keep_backups_max!==null&&bk.keep_backups_max!==undefined)?String(bk.keep_backups_max):'';
      C.statCards(cardsBox,[
        {label:'当前版本', value:curRaw?('v'+curRaw):'—', sub:'运行中的网关构建'},
        {label:'最新版本', value:latestV?('v'+latestV):'—',
         sub:published?('发布 '+U.esc(published)):(latestV?'':'尚无检查结果')},
        {label:'更新可用',
         value:st?(st.update_available?'是':'否'):'—',
         sub:latestTag?('候选 '+U.esc(latestTag)):'无候选版本'},
        {label:'本地备份', value:bk?String(backups.length):'—', unit:bk?'份':'',
         sub:bk?('完整 '+complete+' 份'+(keepMax?(' · 上限 '+U.esc(keepMax)):'')):'备份列表不可用'},
        {label:'安装任务', value:st?stateLabel(inst):'—',
         sub:(inst&&inst.version)?('目标 v'+U.esc(String(inst.version))):'无排队任务'}
      ]);
    }
    function paintPills(){
      const st=state.status, inst=installation();
      const latestV=(st&&st.latest_version)?String(st.latest_version):'';
      const latestTag=(st&&st.latest_tag)?String(st.latest_tag):'';
      let html='';
      if(st){
        html+=U.pill(st.enabled?'自动检查 开':'自动检查 关', st.enabled?'ok':'mute');
        html+=U.pill(st.install_enabled?'安装执行器 就绪':'安装执行器 未配置', st.install_enabled?'ok':'warn');
        if(st.checking) html+=U.pill('检查进行中','warn');
        if(st.last_error) html+=U.pill('最近检查失败','bad');
        if(latestV){
          html+=st.update_available?U.pill('可升级 '+(latestTag||('v'+latestV)),'warn'):U.pill('已是最新','ok');
        }else{
          html+=U.pill('尚未检查到版本','mute');
        }
        if(isActive(inst)) html+=U.pill('任务进行中','info');
      }else{
        html+=U.pill('版本状态不可用','bad');
      }
      if(state.lastSync) html+=U.pill('同步于 '+state.lastSync,'mute');
      pillsBox.innerHTML=html;
    }
    function paintTimes(){
      const st=state.status;
      if(!st){
        timesBox.innerHTML='版本状态读取失败：<span class="mono">'+U.esc(errText(state.statusErr))+'</span>';
        return;
      }
      let html='最近检查 <span class="mono">'+U.esc(fmtTime(st.last_attempt)||'—')+'</span>'+
        ' · 最近成功 <span class="mono">'+U.esc(fmtTime(st.last_success)||'—')+'</span>';
      if(st.last_error) html+=' · 最近错误 <span class="mono">'+U.esc(st.last_error)+'</span>';
      if(st.msg) html+=' · '+U.esc(st.msg);
      timesBox.innerHTML=html;
    }
    function paintVersions(){
      if(!verBox) return;
      if(!state.status){
        verBox.innerHTML='<div class="empty">版本状态读取失败：'+U.esc(errText(state.statusErr))+'</div>';
        if(verCount) verCount.textContent='';
        return;
      }
      const all=versionRows();
      const rows=filteredVersions(all);
      C.dataTable(verBox,{
        columns:VERSION_COLUMNS, rows:rows, rowKey:'id',
        actions:function(r){
          if(!r.installable) return [];
          return [{
            label:'安装',
            onClick:function(){ confirmInstall(r.tag||('v'+r.version), r.version); }
          }];
        },
        emptyText:'当前视图没有版本信息'
      });
      if(verCount) verCount.textContent='显示 '+rows.length+' / 共 '+all.length+' 个版本';
    }
    function paintInstall(){
      if(!installBox) return;
      const st=state.status, inst=installation();
      if(!st){
        installBox.innerHTML='<div class="empty">暂无安装任务状态</div>';
        return;
      }
      const active=isActive(inst);
      let html='<div class="toolbar">'+statePill(inst)+
        U.pill('目标 '+((inst&&inst.version)?('v'+inst.version):'—'),'mute')+
        U.pill(st.install_enabled?'执行器就绪':'执行器未配置', st.install_enabled?'ok':'warn')+
        (active?U.pill('进行中','info'):'')+'</div>';
      if(inst&&inst.message){
        html+='<p class="sub">'+U.esc(inst.message)+
          (inst.updated_at?(' · 更新于 <span class="mono">'+U.esc(String(inst.updated_at))+'</span>'):'')+'</p>';
      }
      if(active){
        html+='<p class="sub">任务进行中，本页每 5 秒自动刷新；服务重启期间接口可能短暂失败。</p>';
      }else{
        html+='<p class="sub">安装由服务端执行器完成；安装目标锁定为最近一次成功检查命中的稳定版。</p>';
      }
      installBox.innerHTML=html;
    }
    function paintBackups(){
      if(!bkBox) return;
      const bk=state.backups;
      if(!bk){
        if(bkMeta) bkMeta.textContent='';
        bkBox.innerHTML='<div class="empty">备份列表读取失败：'+U.esc(errText(state.backupsErr))+'</div>';
        if(bkCount) bkCount.textContent='';
        return;
      }
      const all=backupRows();
      const rows=filteredBackups(all);
      if(bkMeta){
        bkMeta.innerHTML='保留 <span class="mono">'+U.esc(keepText(bk.keep_backups))+
          '</span> / 上限 <span class="mono">'+U.esc(keepText(bk.keep_backups_max))+
          '</span> 份 · 来源 '+U.esc(sourceLabel(bk.source))+
          ' · 回退执行器 '+(bk.rollback_enabled?U.pill('就绪','ok'):U.pill('未启用','warn'))+
          ' · 回退需在服务端执行（面板不发起写操作）';
      }
      C.dataTable(bkBox,{
        columns:BACKUP_COLUMNS, rows:rows, rowKey:'id',
        emptyText:'没有符合筛选条件的本地备份'
      });
      if(bkCount) bkCount.textContent='显示 '+rows.length+' / 共 '+all.length+' 份备份';
    }
    function paint(){
      if(!shell.alive||!cardsBox) return;
      paintCards();
      paintPills();
      paintTimes();
      paintVersions();
      paintInstall();
      paintBackups();
    }

    /* ═══ 4. 取数 ═══ */
    async function grab(fn){
      try{ return {value:await fn()}; }
      catch(e){ return {error:e}; }
    }
    async function load(){
      if(state.busy){ state.again=true; return; }
      state.busy=true;
      const res=await Promise.all([grab(wb.updates), grab(wb.updatesBackups)]);
      state.busy=false;
      if(!shell.alive) return;
      state.status=res[0].value||null;
      state.statusErr=res[0].error||null;
      state.backups=res[1].value||null;
      state.backupsErr=res[1].error||null;
      state.lastSync=clock();
      paint();
      if(state.again){ state.again=false; await load(); }
    }
    function pollTick(){
      if(state.busy) return;
      if(isActive(installation())) load();
    }

    /* ═══ 5. 动作：检查 / 安装 ═══ */
    async function checkNow(btn){
      if(btn&&btn.disabled) return;
      if(btn){ btn.disabled=true; btn.textContent='检查中…'; }
      let msg='检查完成', kind='ok';
      try{
        const r=await wb.updatesCheck();
        if(r&&r.ok===false){
          msg=(r.msg||'检查失败'); kind='warn';
        }else if(r&&r.skipped){
          msg='检查跳过：'+r.skipped; kind='warn';
        }else if(r&&r.update_available){
          msg='发现新版本 '+(r.latest_tag||('v'+r.latest_version));
        }else{
          msg='已是最新版本';
        }
      }catch(e){
        msg='检查失败：'+errText(e); kind='bad';
      }
      if(btn){ btn.disabled=false; btn.textContent='检查更新'; }
      if(!shell.alive) return;
      U.toast(msg,kind);
      await load();
    }
    function confirmInstall(tag, version){
      const shown=tag||(version?('v'+version):'最新稳定版');
      U.openModal({
        title:'确认安装更新',
        body:'<p class="sub">即将把网关更新到 <b class="mono">'+U.esc(shown)+'</b>。</p>'+
          '<p class="sub">安装期间网关会停止服务并重启，进行中的请求会中断；执行器会先做整份本地备份，完成后可在下方备份列表看到。</p>'+
          '<p class="sub">安装目标由后端锁定为最近一次成功检查命中的稳定版，请求里的版本标签不参与决策。</p>',
        actions:[
          {label:'取消'},
          {label:'确认安装', kind:'danger', onClick:async function(){
            try{
              const r=await wb.updatesInstall(tag);
              if(!shell.alive) return;
              U.toast((r&&r.message)||'更新任务已排队','ok');
            }catch(e){
              if(!shell.alive) return;
              U.toast('安装失败：'+errText(e),'bad');
            }
            await load();
          }}
        ]
      });
    }

    /* ═══ 6. 布局（shell 结构，只建一次；后续只更新持久盒子） ═══ */
    function buildLayout(){
      const bar=shell.toolbar();
      bar.innerHTML='<div class="toolbar">'+
        '<button class="btn pri" type="button" data-act="check">检查更新</button>'+
        '<button class="btn" type="button" data-act="reload">刷新</button>'+
        '<span id="upd-pills" style="display:flex;gap:var(--sp-2);flex-wrap:wrap;align-items:center"></span>'+
      '</div>';
      const c=shell.content();
      c.innerHTML=
        '<div id="upd-cards"></div>'+
        '<p class="sub" id="upd-times"></p>'+
        '<h2>可用版本</h2>'+
        '<p class="sub">后端只评估最新稳定版，安装目标由最近一次成功检查的结果锁定；「安装」按钮只负责排队，真正的写入由服务端执行器完成。</p>'+
        '<div class="toolbar">'+
          '<span id="upd-ver-filter"></span>'+
          '<span class="dim" id="upd-ver-count" style="font-size:var(--fs-xs)"></span>'+
        '</div>'+
        '<div id="upd-versions"></div>'+
        '<h2>安装任务</h2>'+
        '<div id="upd-install"></div>'+
        '<h2>本地备份</h2>'+
        '<p class="sub" id="upd-bk-meta"></p>'+
        '<div class="toolbar">'+
          '<span id="upd-bk-filter"></span>'+
          '<span class="dim" id="upd-bk-count" style="font-size:var(--fs-xs)"></span>'+
        '</div>'+
        '<div id="upd-backups"></div>';
      cardsBox=c.querySelector('#upd-cards');
      timesBox=c.querySelector('#upd-times');
      verBar=c.querySelector('#upd-ver-filter');
      verCount=c.querySelector('#upd-ver-count');
      verBox=c.querySelector('#upd-versions');
      installBox=c.querySelector('#upd-install');
      bkMeta=c.querySelector('#upd-bk-meta');
      bkBar=c.querySelector('#upd-bk-filter');
      bkCount=c.querySelector('#upd-bk-count');
      bkBox=c.querySelector('#upd-backups');
      pillsBox=bar.querySelector('#upd-pills');
      C.filterBar(verBar,VERSION_FILTERS,state,function(){ paintVersions(); });
      C.filterBar(bkBar,BACKUP_FILTERS,state,function(){ paintBackups(); });
    }

    /* ═══ 7. 事件（shell.listen 委托，自动清理） ═══ */
    function onClick(ev){
      const t=ev.target.closest('[data-act]');
      if(!t||!el.contains(t)) return;
      const act=t.getAttribute('data-act');
      if(act==='check'){ checkNow(t); return; }
      if(act==='reload'){ load(); }
    }

    /* ═══ 8. 首屏：拉取 → shell 布局 → 挂组件 → 轮询 ═══ */
    shell.setTitle('更新','正在读取版本与备份…');
    await load();
    if(!shell.alive) return;
    shell.setTitle('更新','版本检查 / 安装队列 / 本地备份 · 只安装最近一次成功检查命中的稳定版');
    buildLayout();
    shell.listen(el,'click',onClick);
    shell.onCleanup(function(){ state.busy=false; state.again=false; });
    paint();
    shell.poll(pollTick,5000);
  }
});
})();
