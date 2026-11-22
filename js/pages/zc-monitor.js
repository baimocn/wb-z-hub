/* 页面：ZC 监控 —— zcode 网关请求环形日志
 * 数据源：GET  /admin/api/monitoring       （reqlog 快照，最新在前，字段见 zcode2api/app/reqlog.py）
 * 清空：  POST /admin/api/monitoring/clear （危险操作，confirm 后执行）
 * 纯观测页：只读快照 + 清空，不触碰账号与调度。 */
HUB.register({
  route:'zc-monitor', group:'zc', title:'ZC 监控', order:80,
  async render(el, ctx){
    const {zc}=HUB.api;
    const U=HUB.ui;
    const POLL_MS=5000;
    const HEADERS=['时间','结果','模型','账号','耗时','tokens 入 / 出','预览 / 错误'];
    const state={entries:[], keep:500, filter:'all', view:[], lastAt:null, err:''};

    if(ctx.stale()) return;
    el.innerHTML=`
    <h1>ZC 监控</h1>
    <p class="sub">zcode 网关请求明细 · 数据源 <span class="mono">GET /admin/api/monitoring</span> · 内存环形日志（重启清零）· 最新在前</p>
    <div id="zcm-cards">${U.loadHtml('统计中…')}</div>
    <div class="toolbar">
      <label for="zcm-filter">结果过滤</label>
      <select id="zcm-filter">
        <option value="all">全部</option>
        <option value="ok">成功</option>
        <option value="fail">失败</option>
        <option value="live">在途</option>
      </select>
      <button class="btn" id="zcm-refresh" type="button">刷新</button>
      <button class="btn danger" id="zcm-clear" type="button">清空记录</button>
      <span class="pill mute" id="zcm-meta">—</span>
      <span class="pill mute">每 ${POLL_MS/1000} 秒自动刷新</span>
    </div>
    <div id="zcm-table">${U.loadHtml('拉取中…')}</div>`;

    const cardsEl=el.querySelector('#zcm-cards');
    const tableEl=el.querySelector('#zcm-table');
    const metaEl=el.querySelector('#zcm-meta');
    const filterEl=el.querySelector('#zcm-filter');
    const refreshBtn=el.querySelector('#zcm-refresh');
    const clearBtn=el.querySelector('#zcm-clear');

    /* ok 三态：true=成功 / false=失败（含 499 断开）/ null=在途 */
    function statusOf(e){
      if(e.ok===true) return {label:'成功', kind:'ok'};
      if(e.ok===false) return {label:'失败', kind:'bad'};
      return {label:'在途', kind:'warn'};
    }
    /* t_first / t_total 后端单位是秒（float） */
    function dur(sec){
      if(sec==null) return '—';
      const n=Number(sec);
      if(!isFinite(n)) return '—';
      const ms=Math.round(n*1000);
      if(ms<1000) return ms+' ms';
      return (ms/1000).toFixed(2)+' s';
    }
    function tok(n){
      if(n==null) return '—';
      const v=Number(n);
      if(!isFinite(v)) return '—';
      return Math.round(v).toLocaleString('en-US');
    }
    function matches(e){
      if(state.filter==='ok') return e.ok===true;
      if(state.filter==='fail') return e.ok===false;
      if(state.filter==='live') return e.ok==null;
      return true;
    }
    /* 行详情：完整条目（含 req_id / status / 错误原文），只读展示 */
    function showDetail(e){
      U.openModal({
        title:'请求详情 · '+(e.req_id||'—'),
        body:'<pre class="raw">'+U.esc(JSON.stringify(e,null,2))+'</pre>',
        wide:true
      });
    }

    function paint(){
      if(ctx.stale()) return;
      const all=state.entries;
      const okN=all.filter(e=>e.ok===true).length;
      const failN=all.filter(e=>e.ok===false).length;
      const liveN=all.filter(e=>e.ok==null).length;
      const fin=okN+failN;
      const rate=fin?(okN/fin*100).toFixed(1)+'%':'—';
      let tSum=0, tN=0, tokens=0;
      all.forEach(e=>{
        if(e.t_total!=null&&isFinite(Number(e.t_total))){ tSum+=Number(e.t_total); tN++; }
        tokens+=(Number(e.input_tokens)||0)+(Number(e.output_tokens)||0);
      });
      const avg=tN?tSum/tN:null;
      state.view=all.filter(matches);

      cardsEl.innerHTML=U.cards([
        {k:'环内请求', v:U.esc(String(all.length)), vsmall:'/ '+state.keep, n:'后端环形日志快照'},
        {k:'成功', v:U.esc(String(okN)), n:fin?('占已完成 '+Math.round(okN/fin*100)+'%'):'尚无完成请求'},
        {k:'失败', v:U.esc(String(failN)), n:failN?'含客户端断开 / 上游错误':'无失败'},
        {k:'在途', v:U.esc(String(liveN)), n:liveN?'等待上游首包或流式结束':'当前无进行中请求'},
        {k:'成功率', v:U.esc(rate), n:'按已完成请求计（不含在途）'},
        {k:'平均耗时', v:U.esc(dur(avg)), n:'t_total 均值 · '+tN+' 条样本'},
        {k:'Tokens 合计', v:U.esc(U.num(tokens)), n:'输入 + 输出（未回报记 0）'}
      ]);

      const at=state.lastAt?new Date(state.lastAt).toLocaleTimeString('zh-CN',{hour12:false}):'—';
      if(state.err){
        metaEl.className='pill bad';
        metaEl.textContent='拉取失败：'+state.err;
      }else{
        metaEl.className='pill mute';
        metaEl.textContent='共 '+all.length+' 条'+(state.filter==='all'?'':' · 当前 '+state.view.length+' 条')+
          ' · 环容量 '+state.keep+' · 更新于 '+at;
      }

      if(state.err&&!all.length){
        tableEl.innerHTML='<div class="empty">拉取失败：'+U.esc(state.err)+'</div>';
        return;
      }

      const rows=state.view.map(function(e){
        const st=statusOf(e);
        const time='<span class="mono">'+U.esc(U.ts(e.ts))+'</span>';
        const result=U.pill(st.label,st.kind)+
          (e.status!=null?' <small class="mono dim">'+U.esc(String(e.status))+'</small>':'');
        const model='<div class="mono">'+U.esc(e.model||'—')+'</div>'+
          '<small class="dim mono">'+U.esc(e.endpoint||'—')+(e.stream?' · stream':'')+'</small>';
        const acct=e.account
          ? '<div>'+U.esc(e.account)+'</div>'+(e.mode?'<small class="dim mono">'+U.esc(e.mode)+'</small>':'')
          : '<span class="dim">—</span>';
        const cost='<span class="mono">'+U.esc(dur(e.t_total))+'</span>'+
          (e.t_first!=null?'<br><small class="dim mono">首字 '+U.esc(dur(e.t_first))+'</small>':'');
        const tk=(e.input_tokens==null&&e.output_tokens==null)
          ? '<span class="dim">—</span>'
          : '<span class="mono">'+tok(e.input_tokens)+' / '+tok(e.output_tokens)+'</span>';
        const tail=e.error
          ? '<span class="mono" style="color:var(--danger)">'+U.esc(e.error)+'</span>'
          : (e.preview?'<span class="dim">'+U.esc(e.preview)+'</span>':'<span class="dim">—</span>');
        return [time,result,model,acct,cost,tk,tail];
      });
      tableEl.innerHTML=U.table(HEADERS,rows,{
        empty:state.filter==='all'?'暂无请求记录（网关空闲或刚重启清零）':'当前过滤条件下无请求'
      });

      const tb=tableEl.querySelector('tbody');
      if(tb){
        Array.prototype.forEach.call(tb.rows,function(tr,i){
          tr.dataset.i=String(i);
          tr.title='点击查看请求详情';
          tr.style.cursor='pointer';
        });
        tb.addEventListener('click',function(ev){
          const tr=ev.target&&ev.target.closest?ev.target.closest('tr'):null;
          if(!tr||tr.dataset.i==null) return;
          const e=state.view[Number(tr.dataset.i)];
          if(e) showDetail(e);
        });
      }
    }

    let busy=false;
    async function load(notify){
      if(busy) return;
      busy=true;
      if(notify) refreshBtn.disabled=true;
      try{
        const data=await zc.monitoring();
        if(ctx.stale()) return;
        state.entries=(data&&Array.isArray(data.entries))?data.entries:[];
        state.keep=Number(data&&data.keep)||500;
        state.lastAt=Date.now();
        state.err='';
        paint();
        if(notify) U.toast('已刷新：共 '+state.entries.length+' 条记录','ok');
      }catch(err){
        if(ctx.stale()) return;
        state.err=String((err&&err.message)||err).slice(0,120);
        paint();  /* 保留上一次数据，仅把状态条标红；轮询失败不弹 toast 防刷屏 */
        if(notify) U.toast('拉取失败：'+state.err,'bad');
      }finally{
        busy=false;
        if(!ctx.stale()) refreshBtn.disabled=false;
      }
    }

    filterEl.addEventListener('change',function(){
      state.filter=filterEl.value;
      paint();
    });
    refreshBtn.addEventListener('click',function(){ load(true); });
    clearBtn.addEventListener('click',async function(){
      if(!window.confirm('确定清空请求监控？将删除内存环形日志中的全部记录（含在途），不可恢复。')) return;
      clearBtn.disabled=true;
      try{
        await zc.monitoringClear();
        if(ctx.stale()) return;
        U.toast('请求监控已清空','ok');
        await load(false);
      }catch(err){
        if(!ctx.stale()) U.toast('清空失败：'+String((err&&err.message)||err),'bad');
      }finally{
        if(!ctx.stale()) clearBtn.disabled=false;
      }
    });

    await load(false);
    if(ctx.stale()) return;
    ctx.poll(function(){ load(false); },POLL_MS);
  }
});
