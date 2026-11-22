/* 页面：用量 —— WB 网关请求账本（只读）
 *
 * 组件层重构结构：
 *   1) state     —— 6 个端点的结果与「按账号」筛选状态（单一事实源）
 *   2) StatCards —— HUB.components.statCards 渲染累计汇总指标（/usage + /usage/perf）
 *   3) bars      —— HUB.ui.bars 渲染时间序列柱状图（/usage/timeseries）
 *   4) DataTable —— HUB.components.dataTable 渲染分析明细 / 模型 / Key / 按账号 / 性能 / 剩余额度
 *   5) FilterBar —— HUB.components.filterBar 按「账号出口」筛选按账号表
 *   6) shell     —— HUB.shell 管理标题 / 工具栏 / 内容区 / 轮询 / 事件监听生命周期
 *
 * 覆盖 /usage 家族 6 个端点：
 *   /usage             累计快照（当前出口）
 *   /usage/analytics   分析明细（全部出口）
 *   /usage/by-account  按账号（全量账本）
 *   /usage/perf        性能分位（当前出口，日志尾部样本）
 *   /usage/remaining   剩余额度估算（全量账号池，24h 限额窗口）
 *   /usage/timeseries  时间序列（当前出口，最近 24h）
 * 页面只读，无删除 / 覆盖类操作。 */
HUB.register({
  route:'wb-usage', group:'wb', title:'用量', order:20,
  async render(el, ctx){
    const U=HUB.ui, C=HUB.components, W=HUB.api.wb;
    const shell=HUB.shell(el, ctx);

    /* ═══ 1. state：端点结果与筛选（单一事实源） ═══ */
    const state={
      usage:{ok:false,e:'尚未加载'}, analytics:{ok:false,e:'尚未加载'},
      byAccount:{ok:false,e:'尚未加载'}, perf:{ok:false,e:'尚未加载'},
      remaining:{ok:false,e:'尚未加载'}, series:{ok:false,e:'尚未加载'},
      acctRealm:'all', busy:false
    };
    let headPills=null, cardsBox=null, secSeries=null, secAnalytics=null;
    let baHead=null, baTable=null, secPerf=null, secRemaining=null;

    /* ═══ 2. 常量：筛选选项与 DataTable 列定义 ═══ */
    const ACCT_REALM_OPTS=[
      {value:'all',label:'全部出口'},{value:'cn',label:'国内 cn'},{value:'intl',label:'国际 intl'}
    ];
    const MODEL_COLS=[
      {key:'model',label:'模型',render:v=>v},
      {key:'req',label:'请求',align:'right',render:v=>v},
      {key:'err',label:'错误',align:'right',render:v=>v},
      {key:'tok',label:'总 Tokens',align:'right',render:v=>v},
      {key:'share',label:'占比',align:'right',render:v=>v},
      {key:'hit',label:'缓存命中',align:'right',render:v=>v},
      {key:'ratio',label:'推理占比',align:'right',render:v=>v},
      {key:'ttft',label:'首字 TTFT',align:'right',render:v=>v},
      {key:'speed',label:'速度',align:'right',render:v=>v},
      {key:'cost',label:'费用',align:'right',render:v=>v}
    ];
    const KEY_COLS=[
      {key:'key',label:'Key',render:v=>v},
      {key:'realm',label:'出口',render:v=>v},
      {key:'st',label:'状态',render:v=>v},
      {key:'req',label:'请求',align:'right',render:v=>v},
      {key:'err',label:'错误',align:'right',render:v=>v},
      {key:'tok',label:'总 Tokens',align:'right',render:v=>v},
      {key:'hit',label:'缓存命中',align:'right',render:v=>v},
      {key:'last',label:'最近使用',align:'right',render:v=>v},
      {key:'models',label:'常用模型',render:v=>v}
    ];
    const BA_COLS=[
      {key:'acct',label:'账号',render:v=>v},
      {key:'realm',label:'出口',render:v=>v},
      {key:'req',label:'请求',align:'right',render:v=>v},
      {key:'io',label:'输入 / 输出',align:'right',render:v=>v},
      {key:'reasoning',label:'推理',align:'right',render:v=>v},
      {key:'cached',label:'缓存',align:'right',render:v=>v},
      {key:'total',label:'总 Tokens',align:'right',render:v=>v},
      {key:'share',label:'占比',align:'right',render:v=>v},
      {key:'models',label:'常用模型',render:v=>v}
    ];
    const PF_COLS=[
      {key:'metric',label:'指标',render:v=>v},
      {key:'samples',label:'样本',align:'right',render:v=>v},
      {key:'avg',label:'平均',align:'right',render:v=>v},
      {key:'p50',label:'P50',align:'right',render:v=>v},
      {key:'p90',label:'P90',align:'right',render:v=>v},
      {key:'p99',label:'P99',align:'right',render:v=>v},
      {key:'max',label:'最大',align:'right',render:v=>v}
    ];
    const PF_MODEL_COLS=[
      {key:'model',label:'模型',render:v=>v},
      {key:'req',label:'请求',align:'right',render:v=>v},
      {key:'err',label:'错误',align:'right',render:v=>v},
      {key:'rate',label:'成功率',align:'right',render:v=>v},
      {key:'tp50',label:'TTFT P50',align:'right',render:v=>v},
      {key:'tp90',label:'TTFT P90',align:'right',render:v=>v},
      {key:'wp90',label:'总耗时 P90',align:'right',render:v=>v},
      {key:'speed',label:'生成速度',align:'right',render:v=>v}
    ];
    const RM_MODEL_COLS=[
      {key:'realm',label:'出口',render:v=>v},
      {key:'model',label:'模型',render:v=>v},
      {key:'remain',label:'剩余合计',align:'right',render:v=>v},
      {key:'budget',label:'预算(均值)',align:'right',render:v=>v},
      {key:'pairs',label:'组合',align:'right',render:v=>v},
      {key:'available',label:'可用',align:'right',render:v=>v},
      {key:'cooling',label:'冷却',align:'right',render:v=>v},
      {key:'unknown',label:'未知 / 估算',align:'right',render:v=>v},
      {key:'st',label:'状态',render:v=>v}
    ];
    const RM_COLS=[
      {key:'acct',label:'账号',render:v=>v},
      {key:'realm',label:'出口',render:v=>v},
      {key:'model',label:'模型',render:v=>v},
      {key:'used',label:'已用',align:'right',render:v=>v},
      {key:'budget',label:'预算',align:'right',render:v=>v},
      {key:'usedPct',label:'使用率',align:'right',render:v=>v},
      {key:'remain',label:'剩余',align:'right',render:v=>v},
      {key:'reset',label:'重置',align:'right',render:v=>v},
      {key:'st',label:'状态',render:v=>v},
      {key:'samples',label:'样本',align:'right',render:v=>v}
    ];

    /* ═══ 3. 本地格式化（一切数值最终走 U.num / .mono） ═══ */
    function isNum(v){ return v!==null && v!==undefined && v!=='' && isFinite(Number(v)); }
    function nn(v){ return isNum(v) ? U.num(Number(v)) : '—'; }
    function mon(v){ return '<span class="mono">'+v+'</span>'; }
    function nmon(v){ return mon(nn(v)); }
    function fx(v,d){ return isNum(v) ? Number(v).toFixed(d===undefined?1:d) : '—'; }
    function pct1(v){ return isNum(v) ? Number(v).toFixed(1)+'%' : '—'; }
    function pctText(part,total){
      return isNum(part) && isNum(total) && Number(total)>0
        ? (Number(part)*100/Number(total)).toFixed(1)+'%' : '—';
    }
    function msText(v){ return isNum(v) ? Math.round(Number(v))+' ms' : '—'; }
    function mny(v){ return isNum(v) ? '¥'+Number(v).toFixed(2) : '—'; }
    function pad2(v){ return (v<10?'0':'')+v; }
    function bucketLabel(at,step){
      const d=new Date(Number(at)*1000);
      if(!isFinite(d.getTime())) return '—';
      if(step>=86400) return pad2(d.getMonth()+1)+'-'+pad2(d.getDate());
      if(step>=3600) return pad2(d.getHours())+':00';
      return pad2(d.getHours())+':'+pad2(d.getMinutes());
    }
    function bucketText(step){
      if(step>=86400) return '每天一桶';
      if(step>=3600) return '每小时一桶';
      return '每分钟一桶';
    }
    function realmPill(realm){
      const r=realm?String(realm):'all';
      if(r==='all') return U.pill('全部出口','mute');
      return U.pill(r+' 出口','info');
    }
    function errMsg(e){ return String(e&&e.message?e.message:e); }
    function errBox(label,r){
      const raw=r&&r.e?errMsg(r.e):'未知错误';
      return '<div class="empty">'+U.esc(label)+'加载失败：'+U.esc(raw.slice(0,240))+'</div>';
    }
    function settle(p){ return p.then(v=>({ok:true,v:v}), e=>({ok:false,e:e})); }

    /* ═══ 4. 布局（shell 结构只建一次；后续只更新各分区盒子） ═══ */
    function buildLayout(){
      shell.setTitle('用量','WB 网关的请求账本（usage.jsonl）聚合：累计用量、模型 / Key 明细、账号分布、性能分位与剩余额度估算，全部只读。');
      const bar=shell.toolbar();
      bar.innerHTML='<div class="toolbar">'+
        '<span id="wbu-headpills"></span>'+
        '<button class="btn mini" data-act="refresh">立即刷新</button>'+
        '</div>';
      const c=shell.content();
      c.innerHTML=
        '<div id="wbu-cards"></div>'+
        '<div id="wbu-series"></div>'+
        '<div id="wbu-analytics"></div>'+
        '<h2>按账号</h2>'+
        '<div class="toolbar" id="wbu-ba-head"></div>'+
        '<p class="sub">全量账本口径；输入 / 输出为 prompt / completion tokens，常用模型取出现次数前三。</p>'+
        '<div class="toolbar" id="wbu-ba-fbar"></div>'+
        '<div id="wbu-ba-table" style="overflow-x:auto"></div>'+
        '<div id="wbu-perf"></div>'+
        '<div id="wbu-remaining"></div>'+
        '<p class="sub" style="margin-top:var(--sp-5)">数据来源：usage.jsonl 聚合。页面只读，不产生任何写操作。</p>';
      headPills=bar.querySelector('#wbu-headpills');
      cardsBox=c.querySelector('#wbu-cards');
      secSeries=c.querySelector('#wbu-series');
      secAnalytics=c.querySelector('#wbu-analytics');
      baHead=c.querySelector('#wbu-ba-head');
      baTable=c.querySelector('#wbu-ba-table');
      secPerf=c.querySelector('#wbu-perf');
      secRemaining=c.querySelector('#wbu-remaining');
      /* FilterBar：按出口筛选「按账号」表（挂载一次，选择值由 state 驱动） */
      C.filterBar(c.querySelector('#wbu-ba-fbar'),[
        {key:'acctRealm',label:'账号出口',options:ACCT_REALM_OPTS}
      ],state,()=>paintByAccount());
      cardsBox.innerHTML=U.loadHtml('拉取用量数据…');
    }

    /* ═══ 5. 头部工具栏 pills ═══ */
    function paintHead(){
      if(!shell.alive||!headPills) return;
      const u=state.usage.ok?(state.usage.v||{}):null;
      const ss=state.series.ok?(state.series.v||{}):null;
      const realm=u?u.realm:(ss?ss.realm:null);
      let pills=realmPill(realm);
      pills+=U.pill('汇总 · 图表 · 性能：当前出口','mute');
      pills+=U.pill('分析 · 账号 · 额度：全量账本','mute');
      if(u&&u.since) pills+=U.pill('账本自 '+String(u.since).slice(0,19),'mute');
      if(u&&isNum(u.usd_cny)) pills+=U.pill('1 USD ≈ ¥'+fx(u.usd_cny,2),'mute');
      pills+=U.pill('自动刷新 15s','mute');
      headPills.innerHTML=pills;
    }

    /* ═══ 6. 累计汇总卡：/usage 快照 + /usage/perf 的延迟 / 速度 ═══ */
    function paintCards(){
      if(!shell.alive||!cardsBox) return;
      const r=state.usage;
      if(!r.ok){ cardsBox.innerHTML='<h2>累计汇总</h2>'+errBox('汇总快照',r); return; }
      const u=r.v||{}, acc=u.account||{};
      const totalReq=(Number(u.requests)||0)+(Number(u.errors)||0);
      const success=totalReq?((Number(u.requests)||0)*100/totalReq).toFixed(1)+'%':'—';
      const hit=pctText(u.cached_tokens,u.prompt_tokens);
      const ratio=pctText(u.reasoning_tokens,u.completion_tokens);
      const pf=state.perf.ok?(state.perf.v||{}):null;
      const tAvg=pf&&pf.ttft_ms&&isNum(pf.ttft_ms.avg)?pf.ttft_ms.avg:null;
      const tP90=pf&&pf.ttft_ms&&isNum(pf.ttft_ms.p90)?pf.ttft_ms.p90:null;
      const sAvg=pf&&pf.tokens_per_sec&&isNum(pf.tokens_per_sec.avg)?pf.tokens_per_sec.avg:null;
      const sP50=pf&&pf.tokens_per_sec&&isNum(pf.tokens_per_sec.p50)?pf.tokens_per_sec.p50:null;
      cardsBox.innerHTML='<h2>累计汇总</h2><div class="toolbar">'+
        U.pill('/usage','mute')+realmPill(u.realm)+U.pill('全部时间','mute')+
        '</div><div id="wbu-cards-grid"></div>';
      C.statCards(cardsBox.querySelector('#wbu-cards-grid'),[
        {label:'累计请求', value:nn(u.requests), sub:'错误 '+nmon(u.errors)+' · 成功率 '+mon(success)},
        {label:'累计 Tokens', value:nn(u.total_tokens), sub:'输入 '+nmon(u.prompt_tokens)+' · 输出 '+nmon(u.completion_tokens)},
        {label:'缓存 Tokens', value:nn(u.cached_tokens), sub:'占输入 '+mon(hit)},
        {label:'推理 Tokens', value:nn(u.reasoning_tokens), sub:'占输出 '+mon(ratio)},
        {label:'积分消耗', value:fx(u.credit,2), unit:'credits', sub:'估算费用 '+mon(mny(u.cost_cny))},
        {label:'账号池', value:nn(acc.accounts), unit:'个账号', sub:'就绪 '+nmon(acc.accounts_ready)+' · 全量池'},
        {label:'平均首字延迟', value:(tAvg===null?'—':String(Math.round(Number(tAvg)))),
          unit:(tAvg===null?'':'ms'),
          sub:'P90 '+mon(tP90===null?'—':Math.round(Number(tP90))+' ms')+' · 当前出口'},
        {label:'平均生成速度', value:(sAvg===null?'—':fx(sAvg,1)),
          unit:(sAvg===null?'':'tok/s'),
          sub:'P50 '+mon(sP50===null?'—':fx(sP50,1)+' tok/s')+' · 当前出口'}
      ]);
    }

    /* ═══ 7. 时间序列：HUB.ui.bars 两幅柱状图 ═══ */
    function paintSeries(){
      if(!shell.alive||!secSeries) return;
      const r=state.series;
      if(!r.ok){ secSeries.innerHTML='<h2>时间序列</h2>'+errBox('时间序列',r); return; }
      const ss=r.v||{};
      const list=Array.isArray(ss.series)?ss.series:[];
      const step=Number(ss.bucket_seconds)||3600;
      const head='<h2>时间序列</h2><div class="toolbar">'+
        U.pill('/usage/timeseries','mute')+realmPill(ss.realm)+
        U.pill(bucketText(step),'mute')+U.pill(list.length+' 个桶','mute')+
        U.pill('窗口 '+(isNum(ss.since)?U.ts(ss.since):'—')+' → '+(isNum(ss.until)?U.ts(ss.until):'—'),'mute')+
        '</div>';
      if(!list.length){ secSeries.innerHTML=head+'<div class="empty">最近 24 小时没有请求记录</div>'; return; }
      const labels=list.map(b=>bucketLabel(b.at,step));
      const toks=list.map(b=>Number(b.total_tokens)||0);
      const creds=list.map(b=>Number(b.credit)||0);
      let reqs=0, errs=0, creditSum=0;
      list.forEach(b=>{
        reqs+=Number(b.requests)||0;
        errs+=Number(b.errors)||0;
        creditSum+=Number(b.credit)||0;
      });
      const last=list[list.length-1];
      secSeries.innerHTML=head+
        '<p class="sub">每桶 Token 体量 · 合计 '+mon(nn(reqs))+' tokens / '+mon(nn(errs))+' 错误（悬停单柱看数值）</p>'+
        U.bars(toks,labels)+
        '<p class="sub" style="margin-top:var(--sp-3)">每桶积分消耗 · 合计 '+mon(fx(creditSum,2))+' credits</p>'+
        U.bars(creds,labels)+
        '<p class="sub" style="margin-top:var(--sp-3)">最新桶 '+mon(labels[labels.length-1])+'：'+
        mon(nn(last.total_tokens))+' tokens · '+mon(nn(last.requests))+' 请求 · '+mon(fx(last.credit,2))+' 积分</p>';
    }

    /* ═══ 8. 分析明细：/usage/analytics（汇总 / 模型 / Key 三张表） ═══ */
    function paintAnalytics(){
      if(!shell.alive||!secAnalytics) return;
      const r=state.analytics;
      if(!r.ok){ secAnalytics.innerHTML='<h2>分析明细</h2>'+errBox('分析明细',r); return; }
      const an=r.v||{};
      const sum=an.summary||{};
      const win=sum.window||{};
      const all=sum.all_time||{};
      const windowInfo=an.window||{};
      const ranged=isNum(windowInfo.since)||isNum(windowInfo.until);
      const left=ranged?win:all;
      const defs=[
        ['请求（完成）', s=>nmon(s.requests)],
        ['错误', s=>nmon(s.errors)],
        ['完成率', s=>{
          const t=(Number(s.requests)||0)+(Number(s.errors)||0);
          return mon(t?((Number(s.requests)||0)*100/t).toFixed(1)+'%':'—');
        }],
        ['输入 Tokens', s=>nmon(s.prompt_tokens)],
        ['输出 Tokens', s=>nmon(s.completion_tokens)],
        ['推理 Tokens', s=>nmon(s.reasoning_tokens)],
        ['缓存 Tokens', s=>nmon(s.cached_tokens)],
        ['总 Tokens', s=>nmon(s.total_tokens)],
        ['缓存命中率', s=>mon(pct1(s.cache_hit_pct))],
        ['推理占比', s=>mon(pct1(s.reasoning_ratio))],
        ['平均首字延迟', s=>mon(msText(s.ttft_ms_avg))],
        ['平均总耗时', s=>mon(msText(s.elapsed_ms_avg))],
        ['平均生成速度', s=>mon(isNum(s.speed_avg)?fx(s.speed_avg,1)+' tok/s':'—')],
        ['积分', s=>mon(fx(s.credit,2))],
        ['费用（估算）', s=>mon(mny(s.cost_cny))]
      ];
      const sumRows=defs.map(d=>{
        const row={k:U.esc(d[0]), a:d[1](all)};
        if(ranged) row.w=d[1](left);
        return row;
      });
      const sumCols=ranged?
        [{key:'k',label:'指标',render:v=>v},
         {key:'w',label:'窗口',align:'right',render:v=>v},
         {key:'a',label:'全部时间',align:'right',render:v=>v}]:
        [{key:'k',label:'指标',render:v=>v},
         {key:'a',label:'全部时间',align:'right',render:v=>v}];
      const models=Array.isArray(an.models)?an.models:[];
      const keys=Array.isArray(an.keys)?an.keys:[];
      let totalTok=0;
      models.forEach(m=>{
        const s=ranged?(m.window||{}):(m.all_time||{});
        totalTok+=Number(s.total_tokens)||0;
      });
      const modelRows=models.map(m=>{
        const s=ranged?(m.window||{}):(m.all_time||{});
        const share=totalTok>0?(Number(s.total_tokens)||0)*100/totalTok:0;
        return {
          model:mon(U.esc(m.model||'?')),
          req:nmon(s.requests), err:nmon(s.errors), tok:nmon(s.total_tokens),
          share:U.pct(share)+' '+mon(fx(share,1)+'%'),
          hit:mon(pct1(s.cache_hit_pct)), ratio:mon(pct1(s.reasoning_ratio)),
          ttft:mon(msText(s.ttft_ms_avg)),
          speed:mon(isNum(s.speed_avg)?fx(s.speed_avg,1)+' tok/s':'—'),
          cost:mon(mny(s.cost_cny))
        };
      });
      const keyRows=keys.map(k=>{
        const s=ranged?(k.window||{}):(k.all_time||{});
        const modelsCell=((Array.isArray(k.models)?k.models:[]).slice(0,3).map(x=>{
          return U.pill((x.model||'?')+' ×'+(Number(x.requests)||0),'mute');
        }).join(' ')+(k.models_other?' '+U.pill('其他 '+(k.models_other.models||0)+' 个','mute'):''))||'—';
        return {
          key:(k.name&&k.name!==k.key)?U.esc(k.name):mon(U.esc(String(k.key||'').slice(0,14))),
          realm:k.cross_realm?U.pill('跨出口','warn'):(k.realm?realmPill(k.realm):U.pill('跟随模型','mute')),
          st:k.enabled?(k.source==='bucket'?U.pill('历史','mute'):U.pill('启用','ok')):U.pill('停用','mute'),
          req:nmon(s.requests), err:nmon(s.errors), tok:nmon(s.total_tokens),
          hit:mon(pct1(s.cache_hit_pct)),
          last:(isNum(k.last_at)&&Number(k.last_at)>0)?mon(U.ts(k.last_at)):'—',
          models:modelsCell
        };
      });
      secAnalytics.innerHTML='<h2>分析明细</h2><div class="toolbar">'+
        U.pill('/usage/analytics','mute')+realmPill(an.realm)+
        U.pill(ranged
          ?'窗口 '+U.ts(windowInfo.since)+' → '+(isNum(windowInfo.until)?U.ts(windowInfo.until):'现在')
          :'全部时间','mute')+
        U.pill('模型 '+models.length,'mute')+U.pill('Key '+keys.length,'mute')+'</div>'+
        '<p class="sub">Token / 缓存 / 推理口径的聚合；'+
        (ranged?'窗口列与全量列分开列出。':'未指定时间范围，窗口与全量同源。')+
        '费用按价表估算（人民币）。</p>'+
        '<div id="wbu-an-sum" style="overflow-x:auto"></div>'+
        '<h2>模型明细</h2><p class="sub">按总 Tokens 排序 · '+(ranged?'窗口口径':'全部时间口径')+'。</p>'+
        '<div id="wbu-an-models" style="overflow-x:auto"></div>'+
        '<h2>Key 明细</h2><p class="sub">按调用方 Key 折叠的同一笔花费；停用且本窗口无流量的 Key 不出现。</p>'+
        '<div id="wbu-an-keys" style="overflow-x:auto"></div>';
      C.dataTable(secAnalytics.querySelector('#wbu-an-sum'),{columns:sumCols,rows:sumRows,emptyText:'没有分析数据'});
      C.dataTable(secAnalytics.querySelector('#wbu-an-models'),{columns:MODEL_COLS,rows:modelRows,emptyText:'没有模型用量'});
      C.dataTable(secAnalytics.querySelector('#wbu-an-keys'),{columns:KEY_COLS,rows:keyRows,emptyText:'没有 Key 维度数据'});
    }

    /* ═══ 9. 按账号：/usage/by-account（全量账本 + FilterBar 出口筛选） ═══ */
    function paintByAccount(){
      if(!shell.alive||!baHead||!baTable) return;
      const r=state.byAccount;
      if(!r.ok){ baHead.innerHTML=''; baTable.innerHTML=errBox('按账号统计',r); return; }
      const ba=r.v||{};
      const list=Array.isArray(ba.accounts)?ba.accounts:[];
      const u=state.usage.ok?(state.usage.v||{}):null;
      const an=state.analytics.ok?(state.analytics.v||{}):null;
      const meta={};
      if(u&&u.accounts_map&&typeof u.accounts_map==='object'){
        Object.keys(u.accounts_map).forEach(k=>{ meta[k]=u.accounts_map[k]||{}; });
      }
      if(an&&Array.isArray(an.accounts)){
        an.accounts.forEach(a=>{
          if(a&&a.uid&&!meta[a.uid]) meta[a.uid]={nickname:a.nickname,realm:a.realm};
        });
      }
      let total=0;
      list.forEach(a=>{ total+=Number(a.total_tokens)||0; });
      const want=state.acctRealm;
      const rows=list.filter(a=>{
        if(want==='all') return true;
        const m=meta[String(a.account||'')]||{};
        return m.realm===want;
      }).map(a=>{
        const uid=String(a.account||'');
        const m=meta[uid]||{};
        const share=total>0?(Number(a.total_tokens)||0)*100/total:0;
        const modelsCell=(Array.isArray(a.models)?a.models:[]).slice(0,3).map(pair=>{
          if(Array.isArray(pair)) return U.pill(String(pair[0])+' ×'+pair[1],'mute');
          return U.pill(String(pair),'mute');
        }).join(' ');
        return {
          key:uid,
          acct:m.nickname?U.esc(m.nickname)+' '+mon(U.esc(uid.slice(0,8))):mon(U.esc(uid||'—')),
          realm:m.realm?realmPill(m.realm):U.pill('未知','mute'),
          req:nmon(a.requests),
          io:mon(nn(a.prompt_tokens)+' / '+nn(a.completion_tokens)),
          reasoning:nmon(a.reasoning_tokens),
          cached:nmon(a.cached_tokens),
          total:nmon(a.total_tokens),
          share:U.pct(share)+' '+mon(fx(share,1)+'%'),
          models:modelsCell||'—'
        };
      });
      baHead.innerHTML=U.pill('/usage/by-account','mute')+U.pill('账号 '+list.length,'mute')+
        (rows.length!==list.length?U.pill('筛选后 '+rows.length,'info'):'');
      C.dataTable(baTable,{columns:BA_COLS,rows:rows,rowKey:'key',
        emptyText:list.length?'没有匹配当前出口的账号':'账本里还没有账号维度的请求'});
    }

    /* ═══ 10. 性能分位：/usage/perf（总表 + 按模型） ═══ */
    function paintPerf(){
      if(!shell.alive||!secPerf) return;
      const r=state.perf;
      if(!r.ok){ secPerf.innerHTML='<h2>性能分位</h2>'+errBox('性能分位',r); return; }
      const pf=r.v||{};
      const u=state.usage.ok?(state.usage.v||{}):null;
      function fmtBlock(v,kind){
        if(!isNum(v)) return '—';
        if(kind==='ms') return Math.round(Number(v))+' ms';
        if(kind==='pct') return Number(v).toFixed(1)+'%';
        return Number(v).toFixed(1)+' tok/s';
      }
      const blocks=[
        ['首字延迟 TTFT',pf.ttft_ms,'ms'],
        ['生成耗时',pf.generation_ms,'ms'],
        ['总耗时',pf.wall_ms,'ms'],
        ['生成速度',pf.tokens_per_sec,'rate'],
        ['缓存命中率',pf.cache_hit_pct,'pct']
      ];
      const rows=blocks.map(b=>{
        const blk=b[1];
        if(!blk) return {metric:U.esc(b[0]),samples:'0',avg:'—',p50:'—',p90:'—',p99:'—',max:'—'};
        return {
          metric:U.esc(b[0]), samples:nmon(blk.samples),
          avg:mon(fmtBlock(blk.avg,b[2])), p50:mon(fmtBlock(blk.p50,b[2])),
          p90:mon(fmtBlock(blk.p90,b[2])), p99:mon(fmtBlock(blk.p99,b[2])),
          max:mon(fmtBlock(blk.max,b[2]))
        };
      });
      const bm=pf.by_model||{};
      const mids=Object.keys(bm).sort((a,b)=>(Number(bm[b].requests)||0)-(Number(bm[a].requests)||0));
      const mrows=mids.map(mid=>{
        const b=bm[mid]||{};
        return {
          model:mon(U.esc(mid)),
          req:nmon(b.requests), err:nmon(b.errors),
          rate:mon(isNum(b.success_rate_pct)?pct1(b.success_rate_pct):'—'),
          tp50:mon(b.ttft_ms?fmtBlock(b.ttft_ms.p50,'ms'):'—'),
          tp90:mon(b.ttft_ms?fmtBlock(b.ttft_ms.p90,'ms'):'—'),
          wp90:mon(b.wall_ms?fmtBlock(b.wall_ms.p90,'ms'):'—'),
          speed:mon(b.tokens_per_sec?fmtBlock(b.tokens_per_sec.avg,'rate'):'—')
        };
      });
      secPerf.innerHTML='<h2>性能分位</h2><div class="toolbar">'+
        U.pill('/usage/perf','mute')+realmPill(u?u.realm:null)+
        U.pill('样本 '+nn(pf.sampled),'mute')+
        U.pill('成功 '+nn(pf.success),'ok')+
        U.pill('错误 '+nn(pf.errors),Number(pf.errors)>0?'bad':'mute')+
        U.pill('中止 '+nn(pf.client_aborted),'mute')+
        U.pill('成功率 '+(isNum(pf.success_rate_pct)?pct1(pf.success_rate_pct):'—'),'mute')+
        (pf.sample_capped?U.pill('仅取日志尾部样本','warn'):'')+'</div>'+
        '<p class="sub">分位从原始样本计算'+
        (isNum(pf.sample_from)?('；样本起于 '+U.ts(pf.sample_from)):'')+
        '。中止 = 客户端断开，单列统计，不计入失败。</p>'+
        '<div id="wbu-pf-main" style="overflow-x:auto"></div>'+
        '<h2>按模型性能</h2><p class="sub">按请求数排序；成功率 = 成功 /（成功 + 失败），客户端中止不计入。</p>'+
        '<div id="wbu-pf-models" style="overflow-x:auto"></div>';
      C.dataTable(secPerf.querySelector('#wbu-pf-main'),{columns:PF_COLS,rows:rows,emptyText:'没有性能样本'});
      C.dataTable(secPerf.querySelector('#wbu-pf-models'),{columns:PF_MODEL_COLS,rows:mrows,emptyText:'没有按模型的性能样本'});
    }

    /* ═══ 11. 剩余额度：/usage/remaining（估算） ═══ */
    function paintRemaining(){
      if(!shell.alive||!secRemaining) return;
      const r=state.remaining;
      if(!r.ok){ secRemaining.innerHTML='<h2>剩余额度（估算）</h2>'+errBox('剩余额度',r); return; }
      const rm=r.v||{};
      const list=Array.isArray(rm.rows)?rm.rows:[];
      const models=Array.isArray(rm.models)?rm.models:[];
      const winH=isNum(rm.window_seconds)?Math.round(Number(rm.window_seconds)/3600)+'h':'—';
      let cooling=0, estimated=0;
      list.forEach(x=>{
        if(x&&x.cooling) cooling++;
        if(x&&x.estimated) estimated++;
      });
      const head='<h2>剩余额度（估算）</h2><div class="toolbar">'+
        U.pill('/usage/remaining','mute')+
        U.pill('限额窗口 '+winH,'mute')+
        U.pill('生成于 '+(isNum(rm.generated_at)?U.ts(rm.generated_at):'—'),'mute')+
        (isNum(rm.activity_floor)?U.pill('起算 '+U.ts(rm.activity_floor),'mute'):'')+
        U.pill('组合 '+list.length,'mute')+
        U.pill('冷却 '+cooling,cooling?'bad':'mute')+
        U.pill('估算 '+estimated,estimated?'warn':'mute')+'</div>'+
        '<p class="sub">剩余 = 预算均值 − 窗口已用；预算取自历史撞线（429 / 6004）样本，冷却中的组合记 0。估算行表示当前窗口起点未知，已用量只是下界。</p>';
      let html=head;
      const mrows=models.map(m=>{
        const st=Number(m.cooling)>0?U.pill('冷却 '+m.cooling,'warn')
          :(Number(m.unknown)>0?U.pill('部分未知','mute'):U.pill('正常','ok'));
        return {
          realm:m.realm?realmPill(m.realm):U.pill('未知','mute'),
          model:mon(U.esc(m.model||'?')),
          remain:nmon(m.total_remaining),
          budget:isNum(m.budget)?nmon(m.budget):'—',
          pairs:nmon(m.pairs), available:nmon(m.available), cooling:nmon(m.cooling),
          unknown:mon(nn(m.unknown)+' / '+nn(m.estimated)),
          st:st
        };
      });
      const rows=list.slice(0,60).map(x=>{
        const st=x.cooling?U.pill('冷却中','bad')
          :((x.budget===null||x.budget===undefined||x.remaining===null||x.remaining===undefined)
            ?U.pill('无预算','mute'):(x.estimated?U.pill('估算','warn'):U.pill('正常','ok')));
        const usedPct=isNum(x.used_pct)?Number(x.used_pct):null;
        return {
          acct:mon(U.esc(String(x.uid||'').slice(0,8)))+' '+U.esc(x.nickname||''),
          realm:x.realm?realmPill(x.realm):U.pill('未知','mute'),
          model:mon(U.esc(x.model||'?')),
          used:nmon(x.used),
          budget:isNum(x.budget)?nmon(x.budget):'—',
          usedPct:usedPct===null?'—':(U.pct(usedPct)+' '+mon(fx(usedPct,1)+'%')),
          remain:isNum(x.remaining)?nmon(x.remaining):'—',
          reset:isNum(x.reset_at)?mon(U.ts(x.reset_at)):'—',
          st:st, samples:nmon(x.samples)
        };
      });
      if(models.length){
        html+='<h2>按模型汇总</h2><div id="wbu-rm-models" style="overflow-x:auto"></div>';
      }
      if(list.length){
        html+='<h2>按账号 · 模型</h2>'+
          (list.length>60?'<p class="sub">共 '+list.length+' 行，显示剩余最少的 60 行（无预算的排在最后）。</p>':'')+
          '<div id="wbu-rm-rows" style="overflow-x:auto"></div>';
      } else {
        html+='<div class="empty">最近 '+winH+' 内没有可用的限额事件或 429 记录，剩余额度无法估算。</div>';
      }
      secRemaining.innerHTML=html;
      if(models.length){
        C.dataTable(secRemaining.querySelector('#wbu-rm-models'),{columns:RM_MODEL_COLS,rows:mrows,emptyText:'没有可估算的模型'});
      }
      if(list.length){
        C.dataTable(secRemaining.querySelector('#wbu-rm-rows'),{columns:RM_COLS,rows:rows,emptyText:'没有额度组合'});
      }
    }

    /* ═══ 12. 数据加载：6 个端点并发，单端点失败不阻塞其余分区 ═══ */
    async function load(manual){
      if(state.busy) return;
      state.busy=true;
      try{
        const rs=await Promise.all([
          settle(W.usage()),
          settle(W.usageAnalytics()),
          settle(W.usageByAccount()),
          settle(W.usagePerf()),
          settle(W.usageRemaining()),
          settle(W.usageTimeseries())
        ]);
        if(ctx.stale()) return;
        state.usage=rs[0]; state.analytics=rs[1]; state.byAccount=rs[2];
        state.perf=rs[3]; state.remaining=rs[4]; state.series=rs[5];
        if(ctx.stale()) return;
        paintAll();
        if(manual){
          let bad=0;
          rs.forEach(x=>{ if(!x.ok) bad++; });
          U.toast(bad?('刷新完成，'+bad+' 个接口失败'):'用量已刷新', bad?'bad':'ok');
        }
      } finally {
        state.busy=false;
      }
    }
    function paintAll(){
      paintHead(); paintCards(); paintSeries(); paintAnalytics();
      paintByAccount(); paintPerf(); paintRemaining();
    }

    /* ═══ 13. 事件与生命周期（shell 统一管理，自动清理） ═══ */
    if(ctx.stale()) return;
    buildLayout();
    shell.listen(el,'click',ev=>{
      const btn=ev.target.closest('[data-act]');
      if(!btn||!el.contains(btn)) return;
      if(btn.dataset.act==='refresh') load(true);
    });
    await load(false);
    if(ctx.stale()) return;
    shell.poll(()=>{ load(false); },15000);
    shell.onCleanup(()=>{ state.busy=false; });
  }
});
