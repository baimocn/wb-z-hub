/* ─────────────────────────────────────────────────────────────
 * 页面：ZC 监控（zc-monitor）—— 组件层重构版
 *
 * 覆盖端点（全部经 HUB.api.zc.*，无裸 fetch，与重构前一致）：
 *   GET  /admin/api/monitoring        → zc.monitoring()       环形日志快照（最新在前，含在途）
 *   POST /admin/api/monitoring/clear  → zc.monitoringClear()  清空环形日志（confirm 后执行）
 *
 * 结构：纯函数 / DataTable 列 → shell 布局（工具栏 = 筛选 + 刷新 + 清空）→ 渲染
 *       （statCards + dataTable + 状态条）→ 加载与轮询 → 行动作（详情 / 清空）→ 事件委托。
 * 契约：HUB.shell 管标题 / 工具栏 / 内容区 / 轮询 / 监听；表格 / 指标卡 / 筛选用 HUB.components；
 *       颜色只用 var(--…) 令牌；全中文文案；纯观测页不触碰账号与调度。
 * 已知：HUB.shell.poll 失效分支调用未定义的 stop()（components.js:48），浏览器里解析到
 *       window.stop（无副作用）但定时器不会被清除；轮询回调首行用 shell.alive 拦截。
 *       同理 router 不调用 shell.destroy()，onCleanup 当前不会触发；本页监听都挂在 el 上，随节点回收。
 * ───────────────────────────────────────────────────────────── */
(function(){
'use strict';

const U=HUB.ui, C=HUB.components, zc=HUB.api.zc;
const POLL_MS=5000;
const RESULT_OPTS=[
  {value:'all', label:'全部'},
  {value:'ok',  label:'成功'},
  {value:'fail',label:'失败'},
  {value:'live',label:'在途'}
];

/* ═══ 1. 纯函数（无 DOM、无状态） ═══ */

/* ok 三态：true=成功 / false=失败（含 499 断开）/ null=在途 */
function statusOf(e){
  if(e&&e.ok===true) return {label:'成功',kind:'ok'};
  if(e&&e.ok===false) return {label:'失败',kind:'bad'};
  return {label:'在途',kind:'warn'};
}
/* t_first / t_total 后端单位是秒（float） */
function dur(sec){
  if(sec==null||sec==='') return '—';
  const n=Number(sec);
  if(!isFinite(n)||n<0) return '—';
  const ms=Math.round(n*1000);
  return ms<1000? ms+' ms' : (ms/1000).toFixed(2)+' s';
}
function tok(n){
  if(n==null||n==='') return '—';
  const v=Number(n);
  return isFinite(v)? Math.round(v).toLocaleString('en-US') : '—';
}
function errText(e){
  const s=String((e&&e.message)||e||'未知错误');
  return s.length>160? s.slice(0,160)+'…' : s;
}
function matchFilter(e,f){
  if(f==='ok') return e.ok===true;
  if(f==='fail') return e.ok===false;
  if(f==='live') return e.ok==null;
  return true;
}

/* ═══ 2. 单元格 / DataTable 列定义（key 指向整条 entry，组合字段由 render 负责） ═══ */
function timeCell(e){ return '<span class="mono">'+U.esc(U.ts(e.ts))+'</span>'; }
function resultCell(e){
  const st=statusOf(e);
  return U.pill(st.label,st.kind)
    +(e.status==null? '' : ' <small class="mono dim">'+U.esc(String(e.status))+'</small>');
}
function modelCell(e){
  return '<div class="mono">'+U.esc(e.model||'—')+'</div><small class="dim mono">'
    +U.esc(e.endpoint||'—')+(e.stream?' · stream':'')+'</small>';
}
function accountCell(e){
  return e.account
    ? '<div>'+U.esc(e.account)+'</div>'+(e.mode?'<small class="dim mono">'+U.esc(e.mode)+'</small>':'')
    : '<span class="dim">—</span>';
}
function costCell(e){
  return '<span class="mono">'+U.esc(dur(e.t_total))+'</span>'
    +(e.t_first==null? '' : '<br><small class="dim mono">首字 '+U.esc(dur(e.t_first))+'</small>');
}
function tokenCell(e){
  if(e.input_tokens==null&&e.output_tokens==null) return '<span class="dim">—</span>';
  return '<span class="mono">'+U.esc(tok(e.input_tokens))+' / '+U.esc(tok(e.output_tokens))+'</span>';
}
function tailCell(e){
  if(e.error) return '<span class="mono" style="color:var(--danger)">'+U.esc(e.error)+'</span>';
  return e.preview? '<span class="dim">'+U.esc(e.preview)+'</span>' : '<span class="dim">—</span>';
}
const COLUMNS=[
  {key:'e', label:'时间', render:timeCell},
  {key:'e', label:'结果', render:resultCell},
  {key:'e', label:'模型', render:modelCell},
  {key:'e', label:'账号', render:accountCell},
  {key:'e', label:'耗时', align:'right', render:costCell},
  {key:'e', label:'tokens 入 / 出', align:'right', render:tokenCell},
  {key:'e', label:'预览 / 错误', render:tailCell}
];

HUB.register({
  route:'zc-monitor', group:'zc', title:'ZC 监控', order:80,
  async render(el, ctx){
    const shell=HUB.shell(el, ctx);

    /* ═══ 3. state：快照 + 筛选 + 状态条（页面唯一可变状态） ═══ */
    const state={result:'all', entries:[], keep:500, view:[], lastAt:null, err:''};
    let seq=0, clearing=false;
    let cardsBox=null, tableBox=null, metaEl=null, refreshBtn=null, clearBtn=null;

    /* ═══ 4. shell 布局（只建一次：标题 / 工具栏 / 内容区） ═══ */
    function buildLayout(){
      shell.setTitle('ZC 监控',
        'zcode 网关请求明细 · 数据源 GET /admin/api/monitoring · 内存环形日志（重启清零）· 最新在前');
      const bar=shell.toolbar();
      if(bar){
        bar.innerHTML='<div class="toolbar">'
          +'<span id="zcm-fbar" style="display:inline-flex;gap:var(--sp-2);align-items:center"></span>'
          +'<button class="btn" type="button" data-act="refresh">刷新</button>'
          +'<button class="btn danger" type="button" data-act="clear">清空记录</button>'
          +'<span class="pill mute" id="zcm-meta">—</span>'
          +'<span class="pill mute">每 '+(POLL_MS/1000)+' 秒自动刷新</span>'
          +'</div>';
        C.filterBar(bar.querySelector('#zcm-fbar'),
          [{key:'result', label:'结果过滤', options:RESULT_OPTS}], state,
          function(next){ state.result=next.result; paint(); });
      }
      const c=shell.content();
      if(!c) return;
      c.innerHTML='<div id="zcm-cards">'+U.loadHtml('统计中…')+'</div>'
        +'<h2>请求明细</h2>'
        +'<div id="zcm-table" style="overflow-x:auto">'+U.loadHtml('拉取中…')+'</div>';
      cardsBox=c.querySelector('#zcm-cards');
      tableBox=c.querySelector('#zcm-table');
      metaEl=bar? bar.querySelector('#zcm-meta') : null;
      refreshBtn=bar? bar.querySelector('[data-act="refresh"]') : null;
      clearBtn=bar? bar.querySelector('[data-act="clear"]') : null;
    }

    /* ═══ 5. 渲染：statCards / dataTable / 状态条 ═══ */
    function paint(){
      if(!shell.alive) return;
      paintCards();
      paintTable();
      paintMeta();
    }
    function paintCards(){
      if(!shell.alive||!cardsBox) return;
      let okN=0, failN=0, liveN=0, tSum=0, tN=0, tokens=0;
      state.entries.forEach(function(e){
        if(e.ok===true) okN++; else if(e.ok===false) failN++; else liveN++;
        if(e.t_total!=null&&isFinite(Number(e.t_total))){ tSum+=Number(e.t_total); tN++; }
        tokens+=(Number(e.input_tokens)||0)+(Number(e.output_tokens)||0);
      });
      const fin=okN+failN;
      C.statCards(cardsBox,[
        {label:'环内请求', value:String(state.entries.length), sub:U.esc('后端环形日志容量 '+state.keep)},
        {label:'成功', value:String(okN), sub:U.esc(fin? '占已完成 '+Math.round(okN/fin*100)+'%' : '尚无完成请求')},
        {label:'失败', value:String(failN), sub:U.esc(failN? '含客户端断开 / 上游错误' : '无失败')},
        {label:'在途', value:String(liveN), sub:U.esc(liveN? '等待上游首包或流式结束' : '当前无进行中请求')},
        {label:'成功率', value:fin? (okN/fin*100).toFixed(1)+'%' : '—', sub:U.esc('按已完成请求计（不含在途）')},
        {label:'平均耗时', value:dur(tN? tSum/tN : null), sub:U.esc('t_total 均值 · '+tN+' 条样本')},
        {label:'Tokens 合计', value:U.num(tokens), sub:U.esc('输入 + 输出（未回报记 0）')}
      ]);
    }
    function paintTable(){
      if(!shell.alive||!tableBox) return;
      state.view=state.entries.filter(function(e){ return matchFilter(e,state.result); });
      C.dataTable(tableBox,{
        columns:COLUMNS,
        rows:state.view.map(function(e,i){ return {k:String(i), e:e}; }),
        rowKey:'k',
        actions:function(r){
          return [{label:'详情', onClick:function(){ showDetail(r.e); }}];
        },
        emptyText:state.err? '拉取失败：'+state.err
          : state.result==='all'? '暂无请求记录（网关空闲或刚重启清零）' : '当前过滤条件下无请求'
      });
    }
    function paintMeta(){
      if(!metaEl) return;
      if(state.err){
        metaEl.className='pill bad';
        metaEl.textContent='拉取失败：'+state.err;
        return;
      }
      const at=state.lastAt? new Date(state.lastAt).toLocaleTimeString('zh-CN',{hour12:false}) : '—';
      metaEl.className='pill mute';
      metaEl.textContent='共 '+state.entries.length+' 条'
        +(state.result==='all'? '' : ' · 当前 '+state.view.length+' 条')
        +' · 环容量 '+state.keep+' · 更新于 '+at;
    }

    /* ═══ 6. 加载 / 轮询：请求序号守卫，旧响应不覆盖新结果（含清空后的回填） ═══ */
    async function load(notify){
      if(!shell.alive) return;
      const my=++seq;
      if(notify&&refreshBtn) refreshBtn.disabled=true;
      try{
        const data=await zc.monitoring();
        if(!shell.alive||my!==seq) return;
        state.entries=(data&&Array.isArray(data.entries))? data.entries : [];
        state.keep=Number(data&&data.keep)||500;
        state.lastAt=Date.now();
        state.err='';
        paint();
        if(notify) U.toast('已刷新：共 '+state.entries.length+' 条记录','ok');
      }catch(e){
        if(!shell.alive||my!==seq) return;
        state.err=errText(e);
        paint();   /* 保留旧快照；轮询失败不弹 toast，防每 5 秒刷屏 */
        if(notify) U.toast('拉取失败：'+state.err,'bad');
      }finally{
        if(refreshBtn&&shell.alive&&my===seq) refreshBtn.disabled=false;
      }
    }
    function pollTick(){
      if(!shell.alive||document.hidden) return;
      if(document.getElementById('hub-modal')) return;
      load(false);
    }

    /* ═══ 7. 行动作：行详情 / 清空（confirm） ═══ */
    function showDetail(e){
      if(!e||!shell.alive) return;
      U.openModal({
        title:'请求详情 · '+(e.req_id||'—'),
        body:'<pre class="raw">'+U.esc(JSON.stringify(e,null,2))+'</pre>',
        wide:true
      });
    }
    async function clearLog(){
      if(clearing||!shell.alive) return;
      if(!window.confirm('确定清空请求监控？将删除内存环形日志中的全部记录（含在途），不可恢复。')) return;
      clearing=true;
      if(clearBtn) clearBtn.disabled=true;
      try{
        await zc.monitoringClear();
        if(!shell.alive) return;
        seq++;   /* 作废清空前发出的在途快照，避免旧数据回填 */
        state.entries=[]; state.view=[]; state.lastAt=Date.now(); state.err='';
        paint();
        U.toast('请求监控已清空','ok');
        load(false);
      }catch(e){
        if(shell.alive) U.toast('清空失败：'+errText(e),'bad');
      }finally{
        clearing=false;
        if(clearBtn&&shell.alive) clearBtn.disabled=false;
      }
    }

    /* ═══ 8. 事件委托（shell.listen 统一清理）+ 首屏 ═══ */
    function onPageClick(ev){
      const t=ev.target;
      if(!t||!t.closest) return;
      const btn=t.closest('[data-act]');
      if(btn){
        const act=btn.getAttribute('data-act');
        if(act==='refresh'){ load(true); return; }
        if(act==='clear'){ clearLog(); return; }
      }
      /* 行点击 → 详情；按钮 / 链接 / 表单控件交给各自的处理器 */
      if(t.closest('button, a, input, select, textarea')) return;
      const tr=t.closest('tr');
      if(!tr||!tableBox||!tableBox.contains(tr)) return;
      const tbody=tr.parentElement;
      if(!tbody||tbody.tagName!=='TBODY') return;
      const entry=state.view[Array.prototype.indexOf.call(tbody.rows,tr)];
      if(entry) showDetail(entry);
    }

    buildLayout();
    if(!shell.alive) return;
    shell.listen(el,'click',onPageClick);
    shell.onCleanup(function(){ seq++; clearing=false; U.closeModal(); });

    await load(false);
    if(!shell.alive) return;
    shell.poll(pollTick,POLL_MS);
  }
});
})();
