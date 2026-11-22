/* 页面：用量 —— WB 网关请求账本（只读）
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
    const U = HUB.ui;
    const W = HUB.api.wb;

    /* ── 本地格式化（一切数值最终走 U.num / .mono） ── */
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
      const d = new Date(Number(at)*1000);
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
      const r = realm ? String(realm) : 'all';
      if(r==='all') return U.pill('全部出口','mute');
      return U.pill(r+' 出口','info');
    }
    function errBox(label,r){
      const raw = r && r.e ? (r.e.message ? r.e.message : r.e) : '未知错误';
      return '<div class="empty">'+U.esc(label)+'加载失败：'+U.esc(String(raw).slice(0,240))+'</div>';
    }
    function res(r){ return r || {ok:false, e:'尚未加载'}; }
    function settle(p){
      return p.then(
        function(v){ return {ok:true, v:v}; },
        function(e){ return {ok:false, e:e}; }
      );
    }

    /* ── 头部 ── */
    function headHtml(realm, u){
      let pills = realmPill(realm);
      pills += U.pill('汇总 · 图表 · 性能：当前出口','mute');
      pills += U.pill('分析 · 账号 · 额度：全量账本','mute');
      if(u && u.since) pills += U.pill('账本自 '+String(u.since).slice(0,19),'mute');
      if(u && isNum(u.usd_cny)) pills += U.pill('1 USD ≈ ¥'+fx(u.usd_cny,2),'mute');
      pills += U.pill('自动刷新 15s','mute');
      pills += '<button class="btn mini" data-act="refresh">立即刷新</button>';
      return '<h1>用量</h1>'+
        '<p class="sub">WB 网关的请求账本（usage.jsonl）聚合：累计用量、模型 / Key 明细、账号分布、性能分位与剩余额度估算，全部只读。</p>'+
        '<div class="toolbar">'+pills+'</div>';
    }

    /* ── 累计汇总卡：/usage 快照 + /usage/perf 的延迟/速度 ── */
    function sectionCards(r, u, pf){
      if(!r.ok) return errBox('汇总快照', r);
      u = u || {};
      const acc = u.account || {};
      const totalReq = (Number(u.requests)||0) + (Number(u.errors)||0);
      const success = totalReq ? ((Number(u.requests)||0)*100/totalReq).toFixed(1)+'%' : '—';
      const hit = pctText(u.cached_tokens, u.prompt_tokens);
      const ratio = pctText(u.reasoning_tokens, u.completion_tokens);
      const tAvg = pf && pf.ttft_ms && isNum(pf.ttft_ms.avg) ? pf.ttft_ms.avg : null;
      const tP90 = pf && pf.ttft_ms && isNum(pf.ttft_ms.p90) ? pf.ttft_ms.p90 : null;
      const sAvg = pf && pf.tokens_per_sec && isNum(pf.tokens_per_sec.avg) ? pf.tokens_per_sec.avg : null;
      const sP50 = pf && pf.tokens_per_sec && isNum(pf.tokens_per_sec.p50) ? pf.tokens_per_sec.p50 : null;
      const items = [
        {k:'累计请求', v:nn(u.requests), n:'错误 '+nmon(u.errors)+' · 成功率 '+mon(success)},
        {k:'累计 Tokens', v:nn(u.total_tokens), n:'输入 '+nmon(u.prompt_tokens)+' · 输出 '+nmon(u.completion_tokens)},
        {k:'缓存 Tokens', v:nn(u.cached_tokens), n:'占输入 '+mon(hit)},
        {k:'推理 Tokens', v:nn(u.reasoning_tokens), n:'占输出 '+mon(ratio)},
        {k:'积分消耗', v:fx(u.credit,2), vsmall:'credits', n:'估算费用 '+mon(mny(u.cost_cny))},
        {k:'账号池', v:nn(acc.accounts), vsmall:'个账号', n:'就绪 '+nmon(acc.accounts_ready)+' · 全量池'},
        {k:'平均首字延迟', v:(tAvg===null?'—':String(Math.round(Number(tAvg)))),
          vsmall:(tAvg===null?'':'ms'),
          n:'P90 '+mon(tP90===null?'—':Math.round(Number(tP90))+' ms')+' · 当前出口'},
        {k:'平均生成速度', v:(sAvg===null?'—':fx(sAvg,1)),
          vsmall:(sAvg===null?'':'tok/s'),
          n:'P50 '+mon(sP50===null?'—':fx(sP50,1)+' tok/s')+' · 当前出口'}
      ];
      return '<h2>累计汇总</h2><div class="toolbar">'+
        U.pill('/usage','mute')+realmPill(u.realm)+U.pill('全部时间','mute')+
        '</div>'+U.cards(items);
    }

    /* ── 时间序列：HUB.ui.bars ── */
    function sectionSeries(r, ss){
      if(!r.ok) return errBox('时间序列', r);
      ss = ss || {};
      const list = Array.isArray(ss.series) ? ss.series : [];
      const step = Number(ss.bucket_seconds) || 3600;
      const head = '<h2>时间序列</h2><div class="toolbar">'+
        U.pill('/usage/timeseries','mute')+realmPill(ss.realm)+
        U.pill(bucketText(step),'mute')+U.pill(list.length+' 个桶','mute')+
        U.pill('窗口 '+(isNum(ss.since)?U.ts(ss.since):'—')+' → '+(isNum(ss.until)?U.ts(ss.until):'—'),'mute')+
        '</div>';
      if(!list.length) return head+'<div class="empty">最近 24 小时没有请求记录</div>';
      const labels = list.map(function(b){ return bucketLabel(b.at, step); });
      const toks = list.map(function(b){ return Number(b.total_tokens)||0; });
      const creds = list.map(function(b){ return Number(b.credit)||0; });
      let reqs = 0, errs = 0, creditSum = 0;
      list.forEach(function(b){
        reqs += Number(b.requests)||0;
        errs += Number(b.errors)||0;
        creditSum += Number(b.credit)||0;
      });
      const last = list[list.length-1];
      return head+
        '<p class="sub">每桶 Token 体量 · 合计 '+mon(nn(reqs))+' tokens / '+mon(nn(errs))+' 错误（悬停单柱看数值）</p>'+
        U.bars(toks, labels)+
        '<p class="sub" style="margin-top:var(--sp-3)">每桶积分消耗 · 合计 '+mon(fx(creditSum,2))+' credits</p>'+
        U.bars(creds, labels)+
        '<p class="sub" style="margin-top:var(--sp-3)">最新桶 '+mon(labels[labels.length-1])+'：'+
        mon(nn(last.total_tokens))+' tokens · '+mon(nn(last.requests))+' 请求 · '+mon(fx(last.credit,2))+' 积分</p>';
    }

    /* ── 分析明细：/usage/analytics（汇总 / 模型 / Key） ── */
    function sectionAnalytics(r, an){
      if(!r.ok) return errBox('分析明细', r);
      an = an || {};
      const sum = an.summary || {};
      const win = sum.window || {};
      const all = sum.all_time || {};
      const windowInfo = an.window || {};
      const ranged = isNum(windowInfo.since) || isNum(windowInfo.until);
      const left = ranged ? win : all;
      const defs = [
        ['请求（完成）', function(s){ return nmon(s.requests); }],
        ['错误', function(s){ return nmon(s.errors); }],
        ['完成率', function(s){
          const t = (Number(s.requests)||0) + (Number(s.errors)||0);
          return mon(t ? ((Number(s.requests)||0)*100/t).toFixed(1)+'%' : '—');
        }],
        ['输入 Tokens', function(s){ return nmon(s.prompt_tokens); }],
        ['输出 Tokens', function(s){ return nmon(s.completion_tokens); }],
        ['推理 Tokens', function(s){ return nmon(s.reasoning_tokens); }],
        ['缓存 Tokens', function(s){ return nmon(s.cached_tokens); }],
        ['总 Tokens', function(s){ return nmon(s.total_tokens); }],
        ['缓存命中率', function(s){ return mon(pct1(s.cache_hit_pct)); }],
        ['推理占比', function(s){ return mon(pct1(s.reasoning_ratio)); }],
        ['平均首字延迟', function(s){ return mon(msText(s.ttft_ms_avg)); }],
        ['平均总耗时', function(s){ return mon(msText(s.elapsed_ms_avg)); }],
        ['平均生成速度', function(s){ return mon(isNum(s.speed_avg) ? fx(s.speed_avg,1)+' tok/s' : '—'); }],
        ['积分', function(s){ return mon(fx(s.credit,2)); }],
        ['费用（估算）', function(s){ return mon(mny(s.cost_cny)); }]
      ];
      const headers = ranged ? ['指标','窗口','全部时间'] : ['指标','全部时间'];
      const rows = defs.map(function(d){
        const cells = [U.esc(d[0]), d[1](left)];
        if(ranged) cells.push(d[1](all));
        return cells;
      });
      const models = Array.isArray(an.models) ? an.models : [];
      const keys = Array.isArray(an.keys) ? an.keys : [];
      let h = '<h2>分析明细</h2><div class="toolbar">'+
        U.pill('/usage/analytics','mute')+realmPill(an.realm)+
        U.pill(ranged
          ? '窗口 '+U.ts(windowInfo.since)+' → '+(isNum(windowInfo.until)?U.ts(windowInfo.until):'现在')
          : '全部时间','mute')+
        U.pill('模型 '+models.length,'mute')+U.pill('Key '+keys.length,'mute')+'</div>';
      h += '<p class="sub">Token / 缓存 / 推理口径的聚合；'+
        (ranged ? '窗口列与全量列分开列出。' : '未指定时间范围，窗口与全量同源。')+
        '费用按价表估算（人民币）。</p>';
      h += U.table(headers, rows, {empty:'没有分析数据'});

      let totalTok = 0;
      models.forEach(function(m){
        const s = ranged ? (m.window||{}) : (m.all_time||{});
        totalTok += Number(s.total_tokens)||0;
      });
      const mrows = models.map(function(m){
        const s = ranged ? (m.window||{}) : (m.all_time||{});
        const share = totalTok>0 ? (Number(s.total_tokens)||0)*100/totalTok : 0;
        return [
          mon(U.esc(m.model||'?')),
          nmon(s.requests),
          nmon(s.errors),
          nmon(s.total_tokens),
          U.pct(share)+' '+mon(fx(share,1)+'%'),
          mon(pct1(s.cache_hit_pct)),
          mon(pct1(s.reasoning_ratio)),
          mon(msText(s.ttft_ms_avg)),
          mon(isNum(s.speed_avg) ? fx(s.speed_avg,1)+' tok/s' : '—'),
          mon(mny(s.cost_cny))
        ];
      });
      h += '<h2>模型明细</h2><p class="sub">按总 Tokens 排序 · '+(ranged?'窗口口径':'全部时间口径')+'。</p>'+
        U.table(['模型','请求','错误','总 Tokens','占比','缓存命中','推理占比','首字 TTFT','速度','费用'],
          mrows, {empty:'没有模型用量'});

      const krows = keys.map(function(k){
        const s = ranged ? (k.window||{}) : (k.all_time||{});
        const name = (k.name && k.name!==k.key)
          ? U.esc(k.name)
          : mon(U.esc(String(k.key||'').slice(0,14)));
        const flow = k.cross_realm ? U.pill('跨出口','warn')
          : (k.realm ? realmPill(k.realm) : U.pill('跟随模型','mute'));
        const state = k.enabled
          ? (k.source==='bucket' ? U.pill('历史','mute') : U.pill('启用','ok'))
          : U.pill('停用','mute');
        const modelsCell = (Array.isArray(k.models)?k.models:[]).slice(0,3).map(function(x){
          return U.pill((x.model||'?')+' ×'+(Number(x.requests)||0),'mute');
        }).join(' ');
        const other = k.models_other ? ' '+U.pill('其他 '+(k.models_other.models||0)+' 个','mute') : '';
        return [
          name, flow, state,
          nmon(s.requests), nmon(s.errors), nmon(s.total_tokens),
          mon(pct1(s.cache_hit_pct)),
          (isNum(k.last_at) && Number(k.last_at)>0) ? mon(U.ts(k.last_at)) : '—',
          (modelsCell+other) || '—'
        ];
      });
      h += '<h2>Key 明细</h2><p class="sub">按调用方 Key 折叠的同一笔花费；停用且本窗口无流量的 Key 不出现。</p>'+
        U.table(['Key','出口','状态','请求','错误','总 Tokens','缓存命中','最近使用','常用模型'],
          krows, {empty:'没有 Key 维度数据'});
      return h;
    }

    /* ── 按账号：/usage/by-account（全量账本） ── */
    function sectionByAccount(r, ba, u, an){
      if(!r.ok) return errBox('按账号统计', r);
      ba = ba || {};
      const list = Array.isArray(ba.accounts) ? ba.accounts : [];
      const head = '<h2>按账号</h2><div class="toolbar">'+
        U.pill('/usage/by-account','mute')+U.pill('账号 '+list.length,'mute')+'</div>';
      if(!list.length) return head+'<div class="empty">账本里还没有账号维度的请求</div>';
      const meta = {};
      if(u && u.accounts_map && typeof u.accounts_map==='object'){
        Object.keys(u.accounts_map).forEach(function(k){ meta[k] = u.accounts_map[k] || {}; });
      }
      if(an && Array.isArray(an.accounts)){
        an.accounts.forEach(function(a){
          if(a && a.uid && !meta[a.uid]) meta[a.uid] = {nickname:a.nickname, realm:a.realm};
        });
      }
      let total = 0;
      list.forEach(function(a){ total += Number(a.total_tokens)||0; });
      const rows = list.map(function(a){
        const uid = String(a.account||'');
        const m = meta[uid] || {};
        const label = m.nickname
          ? U.esc(m.nickname)+' '+mon(U.esc(uid.slice(0,8)))
          : mon(U.esc(uid||'—'));
        const share = total>0 ? (Number(a.total_tokens)||0)*100/total : 0;
        const modelsCell = (Array.isArray(a.models)?a.models:[]).slice(0,3).map(function(pair){
          if(Array.isArray(pair)) return U.pill(String(pair[0])+' ×'+pair[1],'mute');
          return U.pill(String(pair),'mute');
        }).join(' ');
        return [
          label,
          m.realm ? realmPill(m.realm) : U.pill('未知','mute'),
          nmon(a.requests),
          mon(nn(a.prompt_tokens)+' / '+nn(a.completion_tokens)),
          nmon(a.reasoning_tokens),
          nmon(a.cached_tokens),
          nmon(a.total_tokens),
          U.pct(share)+' '+mon(fx(share,1)+'%'),
          modelsCell || '—'
        ];
      });
      return head+'<p class="sub">全量账本口径；输入 / 输出为 prompt / completion tokens，常用模型取出现次数前三。</p>'+
        U.table(['账号','出口','请求','输入 / 输出','推理','缓存','总 Tokens','占比','常用模型'], rows);
    }

    /* ── 性能分位：/usage/perf ── */
    function sectionPerf(r, pf, u){
      if(!r.ok) return errBox('性能分位', r);
      pf = pf || {};
      function fmtBlock(v, kind){
        if(!isNum(v)) return '—';
        if(kind==='ms') return Math.round(Number(v))+' ms';
        if(kind==='pct') return Number(v).toFixed(1)+'%';
        return Number(v).toFixed(1)+' tok/s';
      }
      const blocks = [
        ['首字延迟 TTFT', pf.ttft_ms, 'ms'],
        ['生成耗时', pf.generation_ms, 'ms'],
        ['总耗时', pf.wall_ms, 'ms'],
        ['生成速度', pf.tokens_per_sec, 'rate'],
        ['缓存命中率', pf.cache_hit_pct, 'pct']
      ];
      const rows = blocks.map(function(b){
        const blk = b[1];
        if(!blk) return [b[0], '0', '—', '—', '—', '—', '—'];
        return [
          b[0], nmon(blk.samples),
          mon(fmtBlock(blk.avg,b[2])), mon(fmtBlock(blk.p50,b[2])),
          mon(fmtBlock(blk.p90,b[2])), mon(fmtBlock(blk.p99,b[2])),
          mon(fmtBlock(blk.max,b[2]))
        ];
      });
      let h = '<h2>性能分位</h2><div class="toolbar">'+
        U.pill('/usage/perf','mute')+realmPill(u ? u.realm : null)+
        U.pill('样本 '+nn(pf.sampled),'mute')+
        U.pill('成功 '+nn(pf.success),'ok')+
        U.pill('错误 '+nn(pf.errors), Number(pf.errors)>0?'bad':'mute')+
        U.pill('中止 '+nn(pf.client_aborted),'mute')+
        U.pill('成功率 '+(isNum(pf.success_rate_pct)?pct1(pf.success_rate_pct):'—'),'mute')+
        (pf.sample_capped ? U.pill('仅取日志尾部样本','warn') : '')+'</div>';
      h += '<p class="sub">分位从原始样本计算'+
        (isNum(pf.sample_from) ? ('；样本起于 '+U.ts(pf.sample_from)) : '')+
        '。中止 = 客户端断开，单列统计，不计入失败。</p>';
      h += U.table(['指标','样本','平均','P50','P90','P99','最大'], rows, {empty:'没有性能样本'});

      const bm = pf.by_model || {};
      const mids = Object.keys(bm).sort(function(a,b){
        return (Number(bm[b].requests)||0) - (Number(bm[a].requests)||0);
      });
      const mrows = mids.map(function(mid){
        const b = bm[mid] || {};
        return [
          mon(U.esc(mid)),
          nmon(b.requests),
          nmon(b.errors),
          mon(isNum(b.success_rate_pct) ? pct1(b.success_rate_pct) : '—'),
          mon(b.ttft_ms ? fmtBlock(b.ttft_ms.p50,'ms') : '—'),
          mon(b.ttft_ms ? fmtBlock(b.ttft_ms.p90,'ms') : '—'),
          mon(b.wall_ms ? fmtBlock(b.wall_ms.p90,'ms') : '—'),
          mon(b.tokens_per_sec ? fmtBlock(b.tokens_per_sec.avg,'rate') : '—')
        ];
      });
      h += '<h2>按模型性能</h2><p class="sub">按请求数排序；成功率 = 成功 /（成功 + 失败），客户端中止不计入。</p>'+
        U.table(['模型','请求','错误','成功率','TTFT P50','TTFT P90','总耗时 P90','生成速度'],
          mrows, {empty:'没有按模型的性能样本'});
      return h;
    }

    /* ── 剩余额度：/usage/remaining（估算） ── */
    function sectionRemaining(r, rm){
      if(!r.ok) return errBox('剩余额度', r);
      rm = rm || {};
      const list = Array.isArray(rm.rows) ? rm.rows : [];
      const models = Array.isArray(rm.models) ? rm.models : [];
      const winH = isNum(rm.window_seconds) ? Math.round(Number(rm.window_seconds)/3600)+'h' : '—';
      let cooling = 0, estimated = 0;
      list.forEach(function(x){
        if(x && x.cooling) cooling++;
        if(x && x.estimated) estimated++;
      });
      let h = '<h2>剩余额度（估算）</h2><div class="toolbar">'+
        U.pill('/usage/remaining','mute')+
        U.pill('限额窗口 '+winH,'mute')+
        U.pill('生成于 '+(isNum(rm.generated_at)?U.ts(rm.generated_at):'—'),'mute')+
        (isNum(rm.activity_floor) ? U.pill('起算 '+U.ts(rm.activity_floor),'mute') : '')+
        U.pill('组合 '+list.length,'mute')+
        U.pill('冷却 '+cooling, cooling?'bad':'mute')+
        U.pill('估算 '+estimated, estimated?'warn':'mute')+'</div>';
      h += '<p class="sub">剩余 = 预算均值 − 窗口已用；预算取自历史撞线（429 / 6004）样本，冷却中的组合记 0。估算行表示当前窗口起点未知，已用量只是下界。</p>';

      if(models.length){
        const mrows = models.map(function(m){
          const state = Number(m.cooling)>0 ? U.pill('冷却 '+m.cooling,'warn')
            : (Number(m.unknown)>0 ? U.pill('部分未知','mute') : U.pill('正常','ok'));
          return [
            m.realm ? realmPill(m.realm) : U.pill('未知','mute'),
            mon(U.esc(m.model||'?')),
            nmon(m.total_remaining),
            (isNum(m.budget) ? nmon(m.budget) : '—'),
            nmon(m.pairs),
            nmon(m.available),
            nmon(m.cooling),
            mon(nn(m.unknown)+' / '+nn(m.estimated)),
            state
          ];
        });
        h += '<h2>按模型汇总</h2>'+
          U.table(['出口','模型','剩余合计','预算(均值)','组合','可用','冷却','未知 / 估算','状态'],
            mrows, {empty:'没有可估算的模型'});
      }

      if(list.length){
        const shown = list.slice(0,60);
        const rows = shown.map(function(x){
          const state = x.cooling ? U.pill('冷却中','bad')
            : ((x.budget===null || x.budget===undefined || x.remaining===null || x.remaining===undefined)
              ? U.pill('无预算','mute')
              : (x.estimated ? U.pill('估算','warn') : U.pill('正常','ok')));
          const usedPct = isNum(x.used_pct) ? Number(x.used_pct) : null;
          return [
            mon(U.esc(String(x.uid||'').slice(0,8)))+' '+U.esc(x.nickname||''),
            x.realm ? realmPill(x.realm) : U.pill('未知','mute'),
            mon(U.esc(x.model||'?')),
            nmon(x.used),
            (isNum(x.budget) ? nmon(x.budget) : '—'),
            usedPct===null ? '—' : (U.pct(usedPct)+' '+mon(fx(usedPct,1)+'%')),
            (isNum(x.remaining) ? nmon(x.remaining) : '—'),
            (isNum(x.reset_at) ? mon(U.ts(x.reset_at)) : '—'),
            state,
            nmon(x.samples)
          ];
        });
        h += '<h2>按账号 · 模型</h2>'+
          (list.length>60 ? '<p class="sub">共 '+list.length+' 行，显示剩余最少的 60 行（无预算的排在最后）。</p>' : '')+
          U.table(['账号','出口','模型','已用','预算','使用率','剩余','重置','状态','样本'], rows);
      } else {
        h += '<div class="empty">最近 '+winH+' 内没有可用的限额事件或 429 记录，剩余额度无法估算。</div>';
      }
      return h;
    }

    /* ── 组装 ── */
    function build(){
      const st = state || {};
      const u = st.usage && st.usage.ok ? (st.usage.v || {}) : null;
      const an = st.analytics && st.analytics.ok ? (st.analytics.v || {}) : null;
      const ba = st.byAccount && st.byAccount.ok ? (st.byAccount.v || {}) : null;
      const pf = st.perf && st.perf.ok ? (st.perf.v || {}) : null;
      const rm = st.remaining && st.remaining.ok ? (st.remaining.v || {}) : null;
      const ss = st.series && st.series.ok ? (st.series.v || {}) : null;
      const realm = u ? u.realm : (ss ? ss.realm : '—');
      return headHtml(realm, u)+
        sectionCards(res(st.usage), u, pf)+
        sectionSeries(res(st.series), ss)+
        sectionAnalytics(res(st.analytics), an)+
        sectionByAccount(res(st.byAccount), ba, u, an)+
        sectionPerf(res(st.perf), pf, u)+
        sectionRemaining(res(st.remaining), rm)+
        '<p class="sub" style="margin-top:var(--sp-5)">数据来源：usage.jsonl 聚合。页面只读，不产生任何写操作。</p>';
    }

    let state = null;
    let busy = false;

    async function load(manual){
      if(busy) return;
      busy = true;
      try{
        const rs = await Promise.all([
          settle(W.usage()),
          settle(W.usageAnalytics()),
          settle(W.usageByAccount()),
          settle(W.usagePerf()),
          settle(W.usageRemaining()),
          settle(W.usageTimeseries())
        ]);
        if(ctx.stale()) return;
        state = {usage:rs[0], analytics:rs[1], byAccount:rs[2], perf:rs[3], remaining:rs[4], series:rs[5]};
        if(ctx.stale()) return;
        el.innerHTML = build();
        const btn = el.querySelector('[data-act="refresh"]');
        if(btn) btn.onclick = function(){ load(true); };
        if(manual){
          let bad = 0;
          rs.forEach(function(x){ if(!x.ok) bad++; });
          U.toast(bad ? ('刷新完成，'+bad+' 个接口失败') : '用量已刷新', bad ? 'bad' : 'ok');
        }
      } finally {
        busy = false;
      }
    }

    if(ctx.stale()) return;
    el.innerHTML = U.loadHtml('拉取用量数据…');
    await load(false);
    if(ctx.stale()) return;
    ctx.poll(function(){ load(false); }, 15000);
  }
});
