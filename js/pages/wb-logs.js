/* ─────────────────────────────────────────────────────────────
 * 页面：日志（wb-logs）
 * 上半：实时运行日志 —— 级别 / 标签 / 搜索前端过滤 + since_id 增量轮询 + 暂停 / 跟随
 * 下半：活动历史 —— /activity/history 的签到 / 打卡记录表
 *
 * 组件层重构结构（契约同 wb-accounts.js）：
 *   1) 常量 / 工具   —— 级别、时间范围、任务标签与格式化函数
 *   2) state        —— 日志缓冲 / 筛选 / 活动历史的单一事实源（render 闭包内，随页面销毁）
 *   3) shell        —— HUB.shell 管理标题 / 工具栏 / 内容区 / 轮询 / 事件监听生命周期
 *   4) StatCards    —— HUB.components.statCards 渲染日志运行指标与活动统计
 *   5) FilterBar    —— HUB.components.filterBar 渲染级别/标签、范围、任务/结果筛选
 *   6) DataTable    —— HUB.components.dataTable 渲染活动历史表
 *   7) 日志流       —— 自绘 logline 面板（实时追加语义，非表格），样式已迁至
 *                      styles/components.css（本文件零 <style> 注入、零硬编码颜色）
 *
 * 调用（全部经 js/core/api.js 的 HUB.api，无裸 fetch）：
 *   HUB.api.wb.logs(limit, sinceId)        日志快照 / since_id 增量
 *   HUB.api.wb.activityHistory(range, n)   活动历史
 *   HUB.api.GET('/wb/logs/export')         导出（api.js 未封装）
 *   HUB.api.POST('/wb/logs/clear')         清空（同上，二次确认）
 *
 * 注：/logs/export 与 /logs/clear 在 docs/api-inventory.md 里归属 wb-logs，
 * 但 js/core/api.js 只封装了 wb.logs，本模块不能改共享文件，故经 HUB.api
 * 的低层 GET/POST 调用（仍走统一的 req()，带同样的错误归一）。同理 /logs 的
 * level/tag/search 查询参数未被 wb.logs 暴露，级别与搜索在本页做前端过滤
 * （窗口 = 最近 300 条快照 + 全部增量，内存上限 1500 条，单次渲染 800 行）。
 * ───────────────────────────────────────────────────────────── */
HUB.register({
  route:'wb-logs', group:'wb', title:'日志', order:65,
  async render(el, ctx){
    const U=HUB.ui, C=HUB.components, wb=HUB.api.wb;
    const shell=HUB.shell(el, ctx);

    /* ═══ 1. 常量 ═══ */
    const POLL_MS=3000;    /* 增量轮询间隔 */
    const INIT_LIMIT=300;  /* 首次快照条数 */
    const PULL_LIMIT=400;  /* 增量请求条数（since_id>0 时后端忽略 limit，仅作语义标注） */
    const BUF_CAP=1500;    /* 内存缓冲上限，超出丢最旧 */
    const VIEW_CAP=800;    /* 单次渲染行数上限 */
    const ACT_LIMIT=200;   /* 活动历史拉取条数 */
    const LEVEL_OPTS=[
      {value:'',label:'全部'},{value:'INFO',label:'INFO'},
      {value:'WARN',label:'WARN'},{value:'ERROR',label:'ERROR'}
    ];
    const RANGE_OPTS=[
      {value:'today',label:'今日'},{value:'1d',label:'近 24 小时'},{value:'7d',label:'近 7 天'},
      {value:'30d',label:'近 30 天'},{value:'90d',label:'近 90 天'},{value:'all',label:'全部'}
    ];
    const TASK_OPTS=[{value:'',label:'全部'},{value:'checkin',label:'签到'},{value:'daily_chat',label:'打卡'}];
    const RESULT_OPTS=[{value:'',label:'全部'},{value:'ok',label:'成功'},{value:'failed',label:'失败'}];
    const TASK_LABEL={checkin:'签到', daily_chat:'打卡'};
    const TRIGGER_LABEL={scheduler:'调度器', manual:'手动', account_add:'新增账号', account_import:'导入', unknown:'未知'};

    /* ═══ 2. 状态（render 闭包内，路由切走后随闭包一并丢弃） ═══ */
    const S={
      logs:[], seen:{}, maxId:0,
      level:'', tag:'', q:'',
      mode:'', stored:0, dbBytes:0,
      paused:false, follow:true, ticks:0,
      logLoading:true, logErr:'', lastAt:0, pollErr:'',
      act:{ range:'7d', limit:ACT_LIMIT, rows:[], total:0, task:'', result:'', q:'', busy:false, err:'', reqId:0 }
    };
    let tagSig='';   /* 标签下拉签名，避免每次轮询重建 FilterBar */
    let logQT=null, actQT=null;
    let boxes={};    /* 持久 DOM 引用（标题下工具栏 + 内容区内的固定盒子） */

    /* ═══ 3. 工具 ═══ */
    function clipMsg(e){
      const m=String((e&&e.message)||e||'未知错误');
      return m.length>140?m.slice(0,140)+'…':m;
    }
    function clip(s,n){
      s=String(s==null?'':s);
      return s.length>n?s.slice(0,n)+'…':s;
    }
    function bytes(n){
      n=Number(n)||0;
      if(n>=1048576) return (n/1048576).toFixed(1)+' MB';
      if(n>=1024) return (n/1024).toFixed(1)+' KB';
      return n+' B';
    }
    function stamp(){
      const d=new Date(), p=n=>(n<10?'0':'')+n;
      return ''+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds());
    }
    /* 活动历史的时间戳是带偏移的 ISO 串，不是 epoch：先转 epoch 再交给 U.ts 统一格式化 */
    function fmtTs(v){
      if(!v) return '—';
      const d=new Date(v);
      if(!isNaN(d.getTime())) return U.ts(Math.floor(d.getTime()/1000));
      return String(v).slice(0,19).replace('T',' ');
    }
    function isOk(r){ return !!r&&(r.ok===true||r.ok==='true'||r.ok===1); }
    function rangeLabel(){
      const o=RANGE_OPTS.find(x=>x.value===S.act.range);
      return o?o.label:String(S.act.range);
    }

    /* ═══ 4. 日志过滤与行渲染（级别 / 标签 / 搜索全部前端过滤） ═══ */
    function matchLevel(level){
      if(!S.level) return true;
      const n=String(level||'INFO').toUpperCase();
      if(S.level==='WARN') return n.indexOf('WARN')===0;   /* 兼容 WARNING */
      if(S.level==='INFO') return n==='INFO';
      return n.indexOf(S.level)===0;
    }
    function matchLog(it){
      if(!matchLevel(it.level)) return false;
      if(S.tag&&String(it.tag||'')!==S.tag) return false;
      if(S.q){
        const n=S.q.toLowerCase();
        const hay=(String(it.msg||'')+' '+String(it.tag||'')+' '+String(it.level||'')).toLowerCase();
        if(hay.indexOf(n)<0) return false;
      }
      return true;
    }
    function lineInner(it){
      const lv=String(it.level||'INFO').toUpperCase();
      const cls=lv.indexOf('ERROR')===0?'ERROR'
        :lv.indexOf('WARN')===0?'WARN'
        :(lv.indexOf('DEBUG')===0||lv.indexOf('TRACE')===0)?'DEBUG'
        :'INFO';
      const t=it.time||String(it.ts||'').slice(11,19)||'—';
      return '<span class="t" title="'+U.esc(it.ts||'')+'">'+U.esc(t)+'</span>'
        +'<span class="lv '+cls+'">'+U.esc(lv)+'</span>'
        +'<span class="tag">'+U.esc(it.tag||'—')+'</span>'
        +'<span class="m">'+U.esc(it.msg||'')+'</span>';
    }
    function hasTag(tag){ return S.logs.some(it=>String(it&&it.tag||'')===tag); }
    function tagNames(){
      const set={};
      S.logs.forEach(it=>{ const t=it&&it.tag; if(t) set[t]=1; });
      return Object.keys(set).sort();
    }

    /* ═══ 5. 布局（shell 结构，只建一次；后续只更新持久盒子） ═══ */
    function buildLayout(){
      const bar=shell.toolbar();
      bar.innerHTML=
        '<div class="toolbar">'
        +'<span id="wblog-filter"></span>'
        +'<input id="wblog-q" placeholder="搜索消息 / 标签" autocomplete="off" style="width:200px">'
        +'<button class="btn" id="wblog-pause" data-act="pause">暂停</button>'
        +'<button class="btn" id="wblog-follow" data-act="follow">跟随最新：开</button>'
        +'<span class="spacer"></span>'
        +'<button class="btn" data-act="export">导出日志</button>'
        +'<button class="btn danger" data-act="clear">清空</button>'
        +'</div>';
      const c=shell.content();
      c.innerHTML=
        '<div id="wblog-cards"></div>'
        +'<div class="logpanel"><div class="logbody" id="wblog-body"></div><div class="logfoot" id="wblog-foot"></div></div>'
        +'<h2>活动历史 <span class="pill mute">签到 / 打卡</span></h2>'
        +'<p class="sub">账号每日签到 / 打卡的真实尝试记录，按时间范围拉取；任务 / 结果 / 关键词为前端过滤。</p>'
        +'<div class="toolbar">'
        +'<span id="wblog-act-range"></span>'
        +'<span id="wblog-act-filter"></span>'
        +'<input id="wblog-act-q" placeholder="筛选昵称 / uid / 说明" autocomplete="off" style="width:200px">'
        +'<button class="btn" data-act="act-reload">刷新</button>'
        +'<span class="spacer"></span>'
        +'<span class="pill mute">/wb/activity/history</span>'
        +'</div>'
        +'<div id="wblog-act-cards"></div>'
        +'<div id="wblog-act-table"></div>';
      boxes={
        filter:bar.querySelector('#wblog-filter'),
        logQ:bar.querySelector('#wblog-q'),
        pause:bar.querySelector('#wblog-pause'),
        follow:bar.querySelector('#wblog-follow'),
        cards:c.querySelector('#wblog-cards'),
        body:c.querySelector('#wblog-body'),
        foot:c.querySelector('#wblog-foot'),
        actRange:c.querySelector('#wblog-act-range'),
        actFilter:c.querySelector('#wblog-act-filter'),
        actQ:c.querySelector('#wblog-act-q'),
        actCards:c.querySelector('#wblog-act-cards'),
        actTable:c.querySelector('#wblog-act-table')
      };
    }
    function logFilters(){
      return [
        {key:'level', label:'级别', options:LEVEL_OPTS},
        {key:'tag', label:'标签', options:[{value:'',label:'全部标签'}].concat(tagNames().map(t=>({value:t,label:t})))}
      ];
    }
    function onLogFilterChange(){ paintLogs(); }
    function onActRangeChange(){ loadActivity(); }
    function onActFilterChange(){ paintActivity(); }
    /* FilterBar 装配：标签集合变化时才重建（签名比对），select 值始终由 state 驱动 */
    function mountFilterBars(){
      C.filterBar(boxes.filter, logFilters(), S, onLogFilterChange);
      tagSig=tagNames().join('\n');
      C.filterBar(boxes.actRange, [{key:'range',label:'时间范围',options:RANGE_OPTS}], S.act, onActRangeChange);
      C.filterBar(boxes.actFilter, [{key:'task',label:'任务',options:TASK_OPTS},{key:'result',label:'结果',options:RESULT_OPTS}], S.act, onActFilterChange);
    }
    function syncTagFilter(){
      if(S.tag&&!hasTag(S.tag)) S.tag='';   /* 标签已随缓冲裁剪 / 清空消失 */
      const sig=tagNames().join('\n');
      if(sig===tagSig) return;
      tagSig=sig;
      C.filterBar(boxes.filter, logFilters(), S, onLogFilterChange);
    }

    /* ═══ 6. 视图渲染：指标卡 / 日志流 / 页脚 ═══ */
    function paintLogCards(){
      if(!shell.alive||!boxes.cards) return;
      const shown=S.logs.filter(matchLog).length;
      const db=S.mode==='db';
      C.statCards(boxes.cards,[
        {label:'存储模式', value:db?'落库':(S.mode?'内存':'—'),
          sub:db?U.esc('库 '+U.num(S.stored)+' 行 · '+bytes(S.dbBytes)):'内存环形缓冲，重启即清'},
        {label:'日志缓冲', value:U.num(S.logs.length), sub:U.esc('筛选后显示 '+U.num(shown)+' 条 · 上限 '+BUF_CAP)},
        {label:'实时状态', value:S.paused?'已暂停':'每 '+(POLL_MS/1000)+'s', sub:S.follow?'跟随最新行':'自由滚动'},
        {label:'增量游标 max_id', value:String(S.maxId||0), sub:'since_id 增量拉取'}
      ]);
    }
    function paintLogFoot(){
      if(!shell.alive||!boxes.foot) return;
      const shown=S.logs.filter(matchLog).length;
      const last=S.lastAt?new Date(S.lastAt).toLocaleTimeString('zh-CN',{hour12:false}):'—';
      boxes.foot.innerHTML='<span>显示 <b class="mono">'+U.num(shown)+'</b> / 缓冲 <b class="mono">'+U.num(S.logs.length)+'</b></span>'
        +'<span>最近更新 <b class="mono">'+U.esc(last)+'</b></span>'
        +'<span>级别 / 标签 / 搜索为前端过滤</span>'
        +(S.logErr?'<span class="err">'+U.esc(S.logErr)+'</span>':'');
    }
    function paintLogs(){
      if(!shell.alive||!boxes.body) return;
      syncTagFilter();
      const list=S.logs.filter(matchLog).slice(-VIEW_CAP);
      if(!list.length){
        const msg=S.logErr?('拉取失败：'+S.logErr):(S.logLoading?'拉取中…':'暂无匹配日志');
        boxes.body.innerHTML='<div class="logempty">'+U.esc(msg)+'</div>';
      }else{
        boxes.body.innerHTML=list.map(it=>'<div class="logline">'+lineInner(it)+'</div>').join('');
      }
      if(S.follow) boxes.body.scrollTop=boxes.body.scrollHeight;
      paintLogFoot();
      paintLogCards();
    }
    /* 增量追加：不动已有行，超出 VIEW_CAP 从头部裁剪 */
    function appendLogs(items){
      if(!shell.alive||!boxes.body||!items.length) return;
      const box=boxes.body;
      if(box.querySelector('.logempty')) box.innerHTML='';
      const frag=document.createDocumentFragment();
      for(const it of items){
        const d=document.createElement('div');
        d.className='logline';
        d.innerHTML=lineInner(it);   /* lineInner 内部全部经 U.esc */
        frag.appendChild(d);
      }
      box.appendChild(frag);
      while(box.children.length>VIEW_CAP&&box.firstChild) box.removeChild(box.firstChild);
      if(S.follow) box.scrollTop=box.scrollHeight;
      syncTagFilter();
      paintLogFoot();
      paintLogCards();
    }
    function syncPause(){
      if(!boxes.pause) return;
      boxes.pause.textContent=S.paused?'继续实时':'暂停';
      boxes.pause.classList.toggle('pri',!!S.paused);
    }
    function syncFollow(){
      if(!boxes.follow) return;
      boxes.follow.textContent='跟随最新：'+(S.follow?'开':'关');
    }

    /* ═══ 7. 日志数据：since_id 增量合并（保留原有去重 / 裁剪逻辑） ═══ */
    function merge(list){
      if(list.length>BUF_CAP) list=list.slice(-BUF_CAP);
      const fresh=[];
      for(const raw of list){
        const it=raw||{}, id=Number(it.id)||0;
        if(id&&S.seen[id]) continue;
        if(id) S.seen[id]=1;
        S.logs.push(it);
        fresh.push(it);
        if(id>S.maxId) S.maxId=id;
      }
      if(S.logs.length>BUF_CAP){
        const drop=S.logs.splice(0,S.logs.length-BUF_CAP);
        drop.forEach(d=>{ const id=Number(d.id)||0; if(id) delete S.seen[id]; });
      }
      return fresh;
    }
    function applyMeta(d){
      if(!d) return;
      if(typeof d.mode==='string'&&d.mode) S.mode=d.mode;
      if(typeof d.stored==='number') S.stored=d.stored;
      if(typeof d.db_bytes==='number') S.dbBytes=d.db_bytes;
      S.lastAt=Date.now();
    }
    async function pullLogs(reset){
      if(reset) S.logLoading=true;
      const since=reset?0:(S.maxId||0);
      let d;
      try{ d=await wb.logs(reset?INIT_LIMIT:PULL_LIMIT, since>0?since:undefined); }
      catch(e){
        if(!shell.alive) return {ok:false};
        S.logLoading=false;
        S.logErr=clipMsg(e);
        if(reset) paintLogs(); else paintLogFoot();
        return {ok:false, error:S.logErr};
      }
      if(!shell.alive) return {ok:false};
      S.logLoading=false;
      S.logErr='';
      applyMeta(d);
      const fresh=merge(Array.isArray(d&&d.logs)?d.logs:[]);
      if(reset) paintLogs();
      else if(fresh.length) appendLogs(fresh);
      else paintLogFoot();
      return {ok:true, added:fresh.length};
    }
    async function tick(){
      if(S.paused) return;
      S.ticks++;
      const r=await pullLogs(false);
      if(!shell.alive) return;
      if(r&&r.ok) S.pollErr='';
      else if(r&&r.error&&r.error!==S.pollErr){
        S.pollErr=r.error;
        U.toast('日志拉取失败：'+r.error,'bad');
      }
      if(S.ticks%20===0&&!S.act.busy) loadActivity();   /* 活动历史约每分钟跟一次，签到结果不停留旧值 */
    }

    /* ═══ 8. 活动历史：FilterBar 筛选 + DataTable 展示 ═══ */
    const ACT_COLUMNS=[
      {key:'ts', label:'时间', render:(v,r)=>'<span class="mono">'+U.esc(fmtTs(r.ts))+'</span>'},
      {key:'nickname', label:'账号', render:(v,r)=>'<b>'+U.esc(r.nickname||'未命名')+'</b>'
        +'<div class="dim mono">'+U.esc(r.uid?String(r.uid).slice(0,8):'—')+'</div>'},
      {key:'realm', label:'区域', render:(v,r)=>r.realm==='cn'?U.pill('国内','warn')
        :r.realm==='intl'?U.pill('国际','info'):'—'},
      {key:'task', label:'任务', render:(v,r)=>r.task?U.pill(TASK_LABEL[r.task]||r.task, r.task==='checkin'?'info':'mute'):'—'},
      {key:'trigger', label:'来源', render:(v,r)=>U.esc(TRIGGER_LABEL[r.trigger]||r.trigger||'—')},
      {key:'ok', label:'结果', render:(v,r)=>isOk(r)?U.pill('成功','ok'):U.pill('失败','bad')},
      {key:'message', label:'说明', render:(v,r)=>'<span class="dim" title="'+U.esc(r.message||'')+'">'+U.esc(clip(r.message,90))+'</span>'}
    ];
    function actMatch(r){
      const a=S.act;
      if(a.task&&r.task!==a.task) return false;
      if(a.result==='ok'&&!isOk(r)) return false;
      if(a.result==='failed'&&isOk(r)) return false;
      if(a.q){
        const n=a.q.toLowerCase();
        const hay=(String(r.nickname||'')+' '+String(r.uid||'')+' '+String(r.message||'')+' '+String(TASK_LABEL[r.task]||'')).toLowerCase();
        if(hay.indexOf(n)<0) return false;
      }
      return true;
    }
    function paintActivity(){
      if(!shell.alive||!boxes.actTable) return;
      const a=S.act;
      const shown=a.rows.filter(actMatch);
      let okN=0, ck=0, dc=0;
      shown.forEach(r=>{
        if(isOk(r)) okN++;
        if(r.task==='checkin') ck++;
        else if(r.task==='daily_chat') dc++;
      });
      C.statCards(boxes.actCards,[
        {label:'显示记录', value:U.num(shown.length),
          sub:U.esc(a.err?('拉取失败：'+a.err):(a.busy?'刷新中…':'共 '+U.num(a.total)+' 条 · '+rangeLabel()))},
        {label:'成功', value:U.num(okN), sub:'签到 / 打卡成功次数'},
        {label:'失败', value:U.num(shown.length-okN), sub:'含上游拒绝与异常'},
        {label:'签到', value:U.num(ck), sub:TASK_LABEL.checkin+'任务'},
        {label:'打卡', value:U.num(dc), sub:TASK_LABEL.daily_chat+'任务'}
      ]);
      if(a.busy&&!a.rows.length){ boxes.actTable.innerHTML=U.loadHtml('拉取活动历史…'); return; }
      if(a.err&&!a.rows.length){
        boxes.actTable.innerHTML='<div class="empty">活动历史拉取失败：'+U.esc(a.err)
          +'<div style="margin-top:var(--sp-2)"><button class="btn mini" data-act="act-reload">重试</button></div></div>';
        return;
      }
      C.dataTable(boxes.actTable,{
        columns:ACT_COLUMNS, rows:shown, rowKey:'ts',
        emptyText:'该区间暂无签到 / 打卡记录'
      });
    }
    async function loadActivity(){
      const a=S.act;
      a.busy=true;
      a.reqId++;
      const rid=a.reqId;
      paintActivity();
      let d;
      try{ d=await wb.activityHistory(a.range, a.limit); }
      catch(e){
        if(!shell.alive||rid!==a.reqId) return;
        a.busy=false;
        a.err=clipMsg(e);
        paintActivity();
        U.toast('活动历史拉取失败：'+a.err,'bad');
        return;
      }
      if(!shell.alive||rid!==a.reqId) return;
      a.busy=false;
      a.err='';
      a.rows=Array.isArray(d&&d.rows)?d.rows:[];
      const total=Number(d&&d.total);
      a.total=isNaN(total)?a.rows.length:total;
      paintActivity();
    }

    /* ═══ 9. 导出 / 清空（api.js 未封装的低层端点，经 HUB.api.GET/POST） ═══ */
    async function exportLogs(){
      try{
        const text=await HUB.api.GET('/wb/logs/export');
        const body=typeof text==='string'?text:JSON.stringify(text,null,2);
        const blob=new Blob([body],{type:'text/plain;charset=utf-8'});
        const url=URL.createObjectURL(blob);
        const a=document.createElement('a');
        a.href=url;
        a.download='wb-proxy-'+stamp()+'.log';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(()=>{ try{ URL.revokeObjectURL(url); }catch(e){} },5000);
        U.toast('已导出最近 5000 行（出口已脱敏）','ok');
      }catch(e){
        U.toast('导出失败：'+clipMsg(e),'bad');
      }
    }
    function askClear(){
      U.openModal({
        title:'清空运行日志',
        body:'<p class="sub" style="margin:0 0 var(--sp-2)">将清空内存缓冲与日志库中的全部历史，无法恢复。</p>'
          +'<p class="sub" style="margin:0">日志 id 继续单调递增，增量轮询（since_id）不受影响；清空后新产生的日志会继续出现在这里。</p>',
        actions:[
          {label:'取消'},
          {label:'确认清空', kind:'danger', onClick:async()=>{
            await HUB.api.POST('/wb/logs/clear',{});
            S.logs=[];
            S.seen={};
            S.logErr='';
            S.logLoading=false;
            paintLogs();
            U.toast('日志已清空','ok');
          }}
        ]
      });
    }

    /* ═══ 10. 事件（shell.listen 委托，自动清理） ═══ */
    shell.listen(el,'click',ev=>{
      const b=ev.target.closest?ev.target.closest('[data-act]'):null;
      if(!b||!el.contains(b)) return;
      const act=b.getAttribute('data-act');
      if(act==='export') exportLogs();
      else if(act==='clear') askClear();
      else if(act==='pause'){
        S.paused=!S.paused;
        syncPause();
        paintLogCards();
        if(!S.paused) tick();
      }else if(act==='follow'){
        S.follow=!S.follow;
        syncFollow();
        paintLogCards();
        if(S.follow&&boxes.body) boxes.body.scrollTop=boxes.body.scrollHeight;
      }else if(act==='act-reload') loadActivity();
    });
    shell.listen(el,'input',ev=>{
      if(ev.target===boxes.logQ){
        clearTimeout(logQT);
        logQT=setTimeout(()=>{
          if(!shell.alive) return;
          S.q=boxes.logQ.value||'';
          paintLogs();
        },180);
      }else if(ev.target===boxes.actQ){
        clearTimeout(actQT);
        actQT=setTimeout(()=>{
          if(!shell.alive) return;
          S.act.q=boxes.actQ.value||'';
          paintActivity();
        },180);
      }
    });
    /* 滚动到底 = 跟随最新，离底 = 自由滚动 */
    shell.listen(boxes.body,'scroll',()=>{
      if(!shell.alive||!boxes.body) return;
      const at=boxes.body.scrollHeight-boxes.body.scrollTop-boxes.body.clientHeight<24;
      if(at!==S.follow){
        S.follow=at;
        syncFollow();
        paintLogCards();
      }
    });
    shell.onCleanup(()=>{ clearTimeout(logQT); clearTimeout(actQT); });

    /* ═══ 11. 首屏：shell 布局 → 挂组件 → 轮询 → 首次拉取 ═══ */
    shell.setTitle('日志','网关运行日志实时流（since_id 增量拉取）· 账号每日签到 / 打卡历史');
    buildLayout();
    syncPause();
    syncFollow();
    mountFilterBars();
    paintLogs();
    paintActivity();
    shell.poll(tick, POLL_MS);
    await Promise.all([pullLogs(true), loadActivity()]);
  }
});
