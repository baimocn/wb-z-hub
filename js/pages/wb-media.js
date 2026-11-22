/* 页面：媒体 —— 生图 / 图生图 / 生视频 + 模型目录 + 任务轮询
 * 结构：state 单一事实源；StatCards 指标；FilterBar 能力筛选；DataTable 模型表与任务表（含行动作）；
 *       生图 / 图生图 / 生视频三个表单收进 Modal；shell 管理标题 / 工具栏 / 内容区 / 轮询 / 监听生命周期。
 * 端点：wb.mediaModels · wb.mediaTasks · wb.imageGenerate · wb.imageEdit · wb.videoSubmit · wb.video · wb.videoCancel
 * 计费：真实提交扣账号积分（生图按张、生视频提交即计费）；轮询每 5s 只刷任务区与统计卡，不重绘模型表。
 * 契约：只经 HUB.api.wb.* 取数（禁止裸 fetch）；颜色只用 var(--…) 令牌；全量中文文案。 */
HUB.register({
  route:'wb-media', group:'wb', title:'媒体', order:30,
  async render(el, ctx){
    const U=HUB.ui, C=HUB.components, wb=HUB.api.wb;
    const shell=HUB.shell(el, ctx);
    const esc=U.esc;

    /* ═══ 1. state：目录 / 任务 / 筛选的单一事实源 ═══ */
    const state={ tag:'', models:[], tasks:[], stats:{}, realm:'', modelsErr:null };
    let fbar=null, countEl=null, cardsBox=null, modelsNote=null, modelsBox=null,
        tasksHead=null, tasksNote=null, tasksBox=null;

    /* ═══ 2. 常量 ═══ */
    /* 图像尺寸候选（后端按总像素 ≤ 4MP 校验，2560x1600 = 4.10MP 在限内） */
    const SIZES=['1024x1024','1536x1024','1024x1536','2048x2048',
                 '2560x1440','1440x2560','2560x1600','1600x2560'];
    const TAG_LABEL={'text-to-image':'文生图','image-to-image':'图生图',
                     'text-to-video':'文生视频','image-to-video':'图生视频'};
    const TAG_OPTS=[{value:'',label:'全部能力'},{value:'text-to-image',label:'文生图'},
      {value:'image-to-image',label:'图生图'},{value:'text-to-video',label:'文生视频'},
      {value:'image-to-video',label:'图生视频'}];
    const STATUS_MAP={queued:['排队中','warn'],in_progress:['生成中','info'],
                      completed:['已完成','ok'],failed:['失败','bad']};
    const KV_COLUMNS=[{key:'k',label:'字段',render:v=>U.esc(v)},{key:'v',label:'值',render:v=>v}];

    /* ═══ 3. 数据工具 ═══ */
    function hasTag(m,t){ return (m&&m.tags||[]).indexOf(t)>=0; }
    function money(v){ const n=Number(v); return isFinite(n)?String(Math.round(n*100)/100):'—'; }
    function isSize(s){ return s==='auto'||/^\d{2,5}x\d{2,5}$/.test(s); }
    function dlHref(url){
      if(!url) return '';
      if(url.indexOf('http://')===0||url.indexOf('https://')===0||url.indexOf('/wb/')===0) return url;
      return '/wb'+url;
    }
    function modelById(id){
      if(!id) return null;
      for(let i=0;i<state.models.length;i++){ if(state.models[i].id===id) return state.models[i]; }
      return null;
    }
    const imgGen=()=>state.models.filter(m=>hasTag(m,'text-to-image'));
    const imgEdit=()=>state.models.filter(m=>hasTag(m,'image-to-image'));
    const vidAll=()=>state.models.filter(m=>hasTag(m,'text-to-video')||hasTag(m,'image-to-video'));
    const filteredModels=()=>state.tag?state.models.filter(m=>hasTag(m,state.tag)):state.models;

    /* ═══ 4. 单元格渲染（动态值一律 esc） ═══ */
    function statusPill(s){ const hit=STATUS_MAP[s]||[s||'未知','mute']; return U.pill(hit[0],hit[1]); }
    function statusCell(t){
      let html=statusPill(t.status);
      const code=t.error&&t.error.code;
      if(code) html+='<div class="mono dim" style="font-size:10.5px;margin-top:2px">'+esc(code)+'</div>';
      return html;
    }
    function downloadLink(t){
      if(!t.url) return '<span class="dim">—</span>';
      return '<a href="'+esc(dlHref(t.url))+'" target="_blank" rel="noopener">下载</a>';
    }
    function creditCell(m){
      const isVideo=hasTag(m,'text-to-video')||hasTag(m,'image-to-video');
      if(!isVideo){
        if(m.creditPerImage===null||m.creditPerImage===undefined) return '<span class="dim">未测得</span>';
        return '<span class="mono">'+esc(money(m.creditPerImage))+'</span> 积分/张'
          +(m.creditPerImageMeasured?'':' <span class="dim">（估算）</span>');
      }
      const map=m.creditsPerSecond, parts=[];
      if(map&&typeof map==='object'&&!Array.isArray(map)){
        Object.keys(map).forEach(k=>{ parts.push(esc(k)+' <span class="mono">'+esc(money(map[k]))+'</span>'); });
      }else if(typeof map==='number'){ parts.push('<span class="mono">'+esc(money(map))+'</span>'); }
      if(!parts.length){
        if(m.creditPerSecondCeiling!==null&&m.creditPerSecondCeiling!==undefined){
          return '≤ <span class="mono">'+esc(money(m.creditPerSecondCeiling))
            +'</span> 积分/秒 <span class="dim">（上界估算）</span>';
        }
        return '<span class="dim">未测得</span>';
      }
      let out='积分/秒：'+parts.join(' · ');
      if(m.creditsPerSecondWithReference) out+=' <span class="dim">（带参考素材另计）</span>';
      return out;
    }
    function constraintCell(m){
      const g=m.videoGeneration||{}, li=[];
      if(hasTag(m,'text-to-video')||hasTag(m,'image-to-video')){
        if(g.minSeconds!==null&&g.minSeconds!==undefined&&g.maxSeconds!==null&&g.maxSeconds!==undefined){
          li.push(esc(g.minSeconds+'–'+g.maxSeconds)+' 秒');
        }else if(g.defaultSeconds!==null&&g.defaultSeconds!==undefined){ li.push('默认 '+esc(g.defaultSeconds)+' 秒'); }
        if(g.resolutions&&g.resolutions.length) li.push(esc(g.resolutions.join(' / ')));
        else if(g.defaultResolution) li.push('默认 '+esc(g.defaultResolution));
        if(hasTag(m,'text-to-video')){
          li.push(esc(((g.aspectRatios&&g.aspectRatios.length)?g.aspectRatios:['16:9','9:16','1:1']).join(' / ')));
        }else{ li.push('比例随首帧图'); }
        if(g.maxPromptLength!==null&&g.maxPromptLength!==undefined) li.push('prompt ≤ '+esc(g.maxPromptLength));
        const refs=[];
        if(g.maxReferenceImages) refs.push('图 '+g.maxReferenceImages);
        if(g.maxReferenceVideos) refs.push('视频 '+g.maxReferenceVideos);
        if(g.maxReferenceAudios) refs.push('音频 '+g.maxReferenceAudios);
        if(refs.length) li.push('参考素材：'+esc(refs.join(' · ')));
        if(g.supportsFirstFrame) li.push('支持首帧');
        if(g.supportsFirstLastFrame) li.push('支持首尾帧');
      }else{
        li.push('单张计费 · n=1','size ≤ 4.00 MP');
      }
      if(!li.length) return '<span class="dim">—</span>';
      return '<span class="dim" style="font-size:11px;line-height:1.65">'+li.join(' · ')+'</span>';
    }
    function capabilityCell(m){
      const tags=m.tags||[];
      if(!tags.length) return '<span class="dim">—</span>';
      return tags.map(t=>U.pill(TAG_LABEL[t]||t,
        TAG_LABEL[t]?((t.indexOf('video')>=0)?'warn':'info'):'mute')).join(' ');
    }
    function billingBanner(){
      return '<div style="display:flex;gap:10px;align-items:flex-start;background:var(--danger-soft);'
        +'border:1px solid var(--danger);border-radius:var(--card-radius);padding:12px 14px;margin:0 0 var(--sp-4)">'
        +'<span class="pill bad">扣积分</span>'
        +'<div style="font-size:12px;line-height:1.7;color:var(--ink-2)">'
        +'<b style="color:var(--danger)">真实提交会扣账号积分。</b> 生图按张计费；生视频在<b>提交时即计费</b>，'
        +'并发已满时先本地排队（未提交上游、不扣费）。取消只对排队中的任务生效：排队中取消不扣费，'
        +'上游已受理后取消仅停止本地轮询、照常计费。<span class="dim">单价见下方模型表，未实测的档位不编造数字。</span>'
        +'</div></div>';
    }

    /* ═══ 5. 列定义与视图渲染（statCards / dataTable，只更新持久盒子） ═══ */
    const MODEL_COLUMNS=[
      {key:'name', label:'模型', render:(v,m)=>{
        let html='<b>'+esc(m.name||m.id)+'</b>';
        if(m.name&&m.name!==m.id) html+='<div class="mono dim" style="font-size:11px">'+esc(m.id)+'</div>';
        return html;
      }},
      {key:'tags', label:'能力', render:(v,m)=>capabilityCell(m)},
      {key:'billing', label:'计费', render:(v,m)=>creditCell(m)},
      {key:'limits', label:'约束', render:(v,m)=>constraintCell(m)}
    ];
    const TASK_COLUMNS=[
      {key:'created_at', label:'时间', render:v=>'<span class="mono" style="font-size:11px">'+esc(U.ts(v))+'</span>'},
      {key:'id', label:'任务 id', render:v=>'<span class="mono" title="'+esc(v||'')
        +'" style="font-size:11px">'+esc(String(v||'—').slice(0,12))+'</span>'},
      {key:'model', label:'模型', render:v=>'<span class="mono" style="font-size:11px">'+esc(v||'—')+'</span>'},
      {key:'status', label:'状态', render:(v,t)=>statusCell(t)},
      {key:'seconds', label:'时长 / 分辨率', render:(v,t)=>'<span class="mono" style="font-size:11px">'
        +(t.seconds?esc(t.seconds)+'s':'—')+(t.resolution?' · '+esc(t.resolution):'')+'</span>'},
      {key:'credit', label:'积分', render:(v,t)=>(t.credit!==null&&t.credit!==undefined)
        ?'<span class="mono">'+esc(money(t.credit))+'</span>':'<span class="dim">—</span>'},
      {key:'url', label:'下载', render:(v,t)=>downloadLink(t)}
    ];
    function taskActions(t){
      const acts=[{label:'详情', onClick:()=>showDetail(t.id||'')}];
      if(t.status==='queued') acts.push({label:'取消', kind:'danger', onClick:()=>askCancel(t.id||'')});
      return acts;
    }
    function paintCount(){ if(countEl) countEl.textContent=filteredModels().length+' / '+state.models.length+' 个模型'; }
    function paintModelsNote(){
      if(!modelsNote) return;
      modelsNote.innerHTML=state.modelsErr
        ?'<div class="toolbar"><span class="pill bad">模型清单加载失败</span>'
          +'<span class="dim" style="font-size:11.5px">'+esc(state.modelsErr.message||String(state.modelsErr))+'</span></div>'
          +'<p class="sub">表单仍可提交：model 留空时由后端在目录中自动选择。</p>'
        :'';
    }
    function paintModels(){
      if(!modelsBox||!shell.alive) return;
      C.dataTable(modelsBox,{columns:MODEL_COLUMNS, rows:filteredModels(), rowKey:'id',
        emptyText:'该区目录里没有匹配的媒体模型'});
    }
    function paintCards(){
      if(!cardsBox||!shell.alive) return;
      const st=state.stats||{}, by=st.by_status||{};
      const total=(st.total!==null&&st.total!==undefined)?st.total:state.tasks.length;
      C.statCards(cardsBox,[
        {label:'媒体出口', value:state.realm||'自动', sub:'媒体号池出口，模型目录按该区返回'},
        {label:'可用媒体模型', value:String(state.models.length),
         sub:'生图 '+imgGen().length+' · 图生图 '+imgEdit().length+' · 视频 '+vidAll().length},
        {label:'排队（未扣费）', value:String(st.waiting||0),
         sub:'队列深度 '+(st.queue_depth||0)+' · 排队中取消不扣费'},
        {label:'并发生视频', value:(st.active||0)+' / '+(st.concurrency||0),
         sub:'占用媒体账号 '+(st.busy_accounts||0)},
        {label:'任务总数', value:String(total),
         sub:'已完成 '+String(by.completed||0)+' · 失败 '+String(by.failed||0)}
      ]);
    }
    function paintTasksHead(){
      if(!tasksHead||!shell.alive) return;
      const st=state.stats||{}, by=st.by_status||{};
      const total=(st.total!==null&&st.total!==undefined)?st.total:state.tasks.length;
      tasksHead.innerHTML=
        '<span class="pill mute">共 '+esc(total)+'</span>'
        +'<span class="pill '+(st.waiting?'warn':'mute')+'">排队 '+esc(st.waiting||0)+'</span>'
        +'<span class="pill mute">并发 '+esc((st.active||0)+'/'+(st.concurrency||0))+'</span>'
        +'<span class="pill '+(by.failed?'bad':'mute')+'">失败 '+esc(by.failed||0)+'</span>'
        +'<span class="dim" style="font-size:11px">每 5s 自动刷新</span>';
    }
    function paintTasksNote(e, title){
      if(!tasksNote||!shell.alive) return;
      tasksNote.innerHTML='<div class="toolbar"><span class="pill bad">'+esc(title||'任务列表加载失败')+'</span>'
        +'<span class="dim" style="font-size:11.5px">'+esc(e&&e.message||String(e))+'</span>'
        +'<button class="btn mini" data-act="m-refresh" style="margin-left:auto">重试</button></div>';
    }
    function paintTasks(){
      if(!tasksBox||!shell.alive) return;
      C.dataTable(tasksBox,{columns:TASK_COLUMNS, rows:state.tasks, rowKey:'id',
        actions:taskActions, emptyText:'暂无任务；提交后会出现在这里'});
    }

    /* ═══ 6. 弹窗：键值表 / 三个提交表单 / 详情 / 取消 ═══ */
    function kvTable(box, rows){ C.dataTable(box,{columns:KV_COLUMNS, rows:rows, emptyText:'—'}); }
    function imageOut(r){
      const item=(r&&r.data&&r.data[0])||{};
      const src=item.url||(item.b64_json?('data:image/png;base64,'+item.b64_json):'');
      return '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start">'
        +(src?'<img src="'+esc(src)+'" alt="生成结果" style="width:168px;height:168px;object-fit:cover;'
          +'border:1px solid var(--line);border-radius:var(--radius-m);background:var(--surface-2)">':'')
        +'<div style="font-size:11.5px;line-height:1.75;color:var(--ink-3)">'
        +'<div>模型 <b class="mono" style="color:var(--ink-2)">'+esc(r&&r.model||'—')+'</b>'
        +' · 模式 <span class="mono">'+esc(r&&r.mode||'—')+'</span></div>'
        +((r&&r.credit!==null&&r.credit!==undefined)
          ?'<div>本次扣费 <b class="mono" style="color:var(--accent)">'+esc(money(r.credit))+'</b> 积分</div>':'')
        +(item.url?'<div><a href="'+esc(dlHref(item.url))+'" target="_blank" rel="noopener">打开原图</a></div>':'')
        +(item.b64_json?'<div class="dim">已返回 b64_json（内嵌 base64）</div>':'')
        +(r&&r.hint?'<div class="dim">'+esc(r.hint)+'</div>':'')
        +'</div></div>';
    }
    function taskBrief(t){
      return [
        {k:'任务 id', v:'<span class="mono">'+esc(t&&t.id||'—')+'</span>'},
        {k:'状态', v:statusCell(t||{})},
        {k:'模型', v:'<span class="mono">'+esc(t&&t.model||'—')+'</span>'},
        {k:'积分', v:(t&&t.credit!==null&&t.credit!==undefined)
          ?'<span class="mono">'+esc(money(t.credit))+'</span>':'<span class="dim">未扣（排队中）</span>'},
        {k:'排队位', v:(t&&t.queue_position!==null&&t.queue_position!==undefined)
          ?'<span class="mono">'+esc(t.queue_position)+'</span>':'—'},
        {k:'提示', v:(t&&t.hint)?esc(t.hint):'—'}
      ];
    }
    function detailRows(t){
      const err=(t.error&&t.error.message)?t.error.message:'—';
      return [
        {k:'id', v:'<span class="mono">'+esc(t.id||'—')+'</span>'},
        {k:'object', v:'<span class="mono">'+esc(t.object||'video')+'</span>'},
        {k:'状态', v:statusCell(t)},
        {k:'模型', v:'<span class="mono">'+esc(t.model||'—')+'</span>'},
        {k:'创建时间', v:'<span class="mono">'+esc(U.ts(t.created_at))+'</span>'},
        {k:'完成时间', v:'<span class="mono">'+esc(t.completed_at?U.ts(t.completed_at):'—')+'</span>'},
        {k:'时长', v:t.seconds?'<span class="mono">'+esc(t.seconds)+' 秒</span>':'—'},
        {k:'分辨率', v:'<span class="mono">'+esc(t.resolution||'—')+'</span>'},
        {k:'积分', v:(t.credit!==null&&t.credit!==undefined)
          ?'<span class="mono">'+esc(money(t.credit))+'</span>':'<span class="dim">未扣 / 未知</span>'},
        {k:'错误', v:err!=='—'?'<span style="color:var(--danger)">'+esc(err)+'</span>':'—'},
        {k:'下载', v:downloadLink(t)}
      ];
    }
    /* 表单控件：label + control + hint（文案均为页面常量，动态值已 esc） */
    function field(label, control, hint){
      return '<label style="display:block;margin-bottom:var(--sp-2)">'
        +'<span style="display:block;color:var(--ink-3);font-size:11.5px;margin-bottom:4px">'+label+'</span>'
        +control
        +(hint?'<span class="dim" style="display:block;font-size:10.5px;margin-top:3px">'+hint+'</span>':'')
        +'</label>';
    }
    function modelOptions(list, autoLabel){
      let html='<option value="">'+esc(autoLabel)+'</option>';
      list.forEach(m=>{
        const label=(m.name&&m.name!==m.id)?(m.name+' · '+m.id):m.id;
        html+='<option value="'+esc(m.id)+'">'+esc(label)+'</option>';
      });
      return html;
    }
    function videoOptions(){
      return '<option value="">自动（按是否给首帧图选择）</option>'+vidAll().map(m=>{
        const label=(m.name&&m.name!==m.id)?(m.name+' · '+m.id):m.id;
        const suffix=hasTag(m,'text-to-video')?'':'（图生视频，需首帧图）';
        return '<option value="'+esc(m.id)+'">'+esc(label+suffix)+'</option>';
      }).join('');
    }
    /* 本地图片 → data URL（监听经 shell.listen，切页自动清理） */
    function bindFilePicker(fileInput, targetInput, noteEl){
      if(!fileInput||!targetInput) return;
      shell.listen(fileInput,'change',()=>{
        const f=fileInput.files&&fileInput.files[0];
        if(!f) return;
        if(f.size>8*1024*1024){
          U.toast('图片不能超过 8MB（base64 会膨胀，网关请求体上限 24MB）','bad');
          fileInput.value='';
          return;
        }
        const fr=new FileReader();
        fr.onload=()=>{
          targetInput.value=String(fr.result||'');
          if(noteEl) noteEl.textContent='已读入 '+f.name+'（'+(f.size/1048576).toFixed(2)+' MB）';
          U.toast('已转为 data URL','ok');
        };
        fr.onerror=()=>U.toast('读取文件失败','bad');
        fr.readAsDataURL(f);
      });
    }
    function paintImagePrice(sel, label){
      if(!sel||!label) return;
      const mod=modelById(sel.value);
      const note='真实提交会扣账号积分；成功后即计费，失败会换号重试。';
      if(!mod){ label.textContent='价格随目录首选模型，以实际扣费为准。'+note; return; }
      label.textContent=(mod.creditPerImage!==null&&mod.creditPerImage!==undefined)
        ?('预估约 '+money(mod.creditPerImage)+' 积分/张'+(mod.creditPerImageMeasured?'（估算）':'')+'。'+note)
        :('单价未测得，以实际扣费为准。'+note);
    }
    function videoGenConfig(modelId){
      const mod=modelById(modelId);
      if(mod) return mod.videoGeneration||{};
      const res=[], ars=[];
      vidAll().forEach(x=>{
        const g=x.videoGeneration||{};
        (g.resolutions||[]).forEach(r=>{ if(res.indexOf(r)<0) res.push(r); });
        ((g.aspectRatios&&g.aspectRatios.length)?g.aspectRatios:['16:9','9:16','1:1'])
          .forEach(r=>{ if(ars.indexOf(r)<0) ars.push(r); });
      });
      return {resolutions:res, aspectRatios:ars};
    }
    function paintVidPrice(m){
      const priceEl=m.querySelector('#mwc-vid-price');
      if(!priceEl) return;
      const mod=modelById(m.querySelector('#mwc-vid-model').value);
      const sec=Number(m.querySelector('#mwc-vid-seconds').value)||0;
      const res=m.querySelector('#mwc-vid-res').value;
      let price=null;
      if(mod){
        const map=mod.creditsPerSecond;
        if(map&&typeof map==='object'&&!Array.isArray(map)){
          const def=(mod.videoGeneration||{}).defaultResolution;
          if(res&&map[res]!==null&&map[res]!==undefined) price=map[res];
          else if(def&&map[def]!==null&&map[def]!==undefined) price=map[def];
        }else if(typeof map==='number'){ price=map; }
      }
      if(price===null||!sec){
        priceEl.textContent='预估花费：'+(mod?'该组合单价未测得':'先选模型')
          +'，以实际扣费为准；提交即计费，排队中未扣费。';
        return;
      }
      priceEl.innerHTML='预估花费 ≈ <b class="mono" style="color:var(--accent)">'+esc(money(price*sec))
        +'</b> 积分（'+esc(money(price))+' × '+esc(String(sec))+' 秒，按实测单价估算，实际以扣费为准；提交即计费，排队中未扣费）';
    }
    function fillVideoSelectors(m){
      const res=m.querySelector('#mwc-vid-res'), ar=m.querySelector('#mwc-vid-ar'),
            sec=m.querySelector('#mwc-vid-seconds');
      if(!res||!ar||!sec) return;
      const g=videoGenConfig(m.querySelector('#mwc-vid-model').value);
      const curRes=res.value, curAr=ar.value;
      res.innerHTML='<option value="">默认'+(g.defaultResolution?'（'+esc(g.defaultResolution)+'）':'')+'</option>'
        +(g.resolutions||[]).map(r=>'<option value="'+esc(r)+'">'+esc(r)+'</option>').join('');
      const ars=(g.aspectRatios&&g.aspectRatios.length)?g.aspectRatios:['16:9','9:16','1:1'];
      ar.innerHTML='<option value="">默认'+(g.defaultAspectRatio?'（'+esc(g.defaultAspectRatio)+'）':'')+'</option>'
        +ars.map(r=>'<option value="'+esc(r)+'">'+esc(r)+'</option>').join('');
      if(curRes&&res.querySelector('option[value="'+curRes+'"]')) res.value=curRes;
      if(curAr&&ar.querySelector('option[value="'+curAr+'"]')) ar.value=curAr;
      if(g.minSeconds!==null&&g.minSeconds!==undefined) sec.min=String(g.minSeconds);
      if(g.maxSeconds!==null&&g.maxSeconds!==undefined) sec.max=String(g.maxSeconds);
      paintVidPrice(m);
    }
    /* 生图表单（弹窗内即确认面：展示预估价与扣费警示） */
    function openGenModal(){
      const m=U.openModal({
        title:'生图 · /v1/images/generations',
        body:
          field('模型','<select id="mwc-gen-model" style="width:100%">'
            +modelOptions(imgGen(),'自动（目录首选）')+'</select>')
          +field('prompt','<textarea id="mwc-gen-prompt" rows="3" style="width:100%" placeholder="描述要生成的画面"></textarea>')
          +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-2)">'
          +field('尺寸（宽x高）','<input id="mwc-gen-size" list="mwc-sizes" value="1024x1024" style="width:100%">')
          +field('response_format','<select id="mwc-gen-fmt" style="width:100%">'
            +'<option value="url">url</option><option value="b64_json">b64_json</option></select>')+'</div>'
          +field('n（张数）','<select id="mwc-gen-n" style="width:100%"><option value="1">1</option></select>',
            '网关每次只出一张：n 只能为 1，多图请多次提交（每张都真实扣积分）')
          +'<div class="dim" id="mwc-gen-price" style="font-size:11px;line-height:1.6;margin:var(--sp-1) 0 var(--sp-2)"></div>'
          +'<div id="mwc-gen-out"></div>',
        actions:[{label:'关闭'},{label:'提交生图（扣积分）', kind:'pri', onClick:()=>submitGen(m)}]
      });
      const sel=m.querySelector('#mwc-gen-model'), price=m.querySelector('#mwc-gen-price');
      shell.listen(sel,'change',()=>paintImagePrice(sel,price));
      paintImagePrice(sel,price);
    }
    async function submitGen(m){
      const promptEl=m.querySelector('#mwc-gen-prompt'), sizeEl=m.querySelector('#mwc-gen-size');
      const prompt=(promptEl.value||'').trim();
      const size=(sizeEl.value||'').trim()||'1024x1024';
      const model=m.querySelector('#mwc-gen-model').value;
      const fmt=m.querySelector('#mwc-gen-fmt').value;
      if(!prompt){ U.toast('prompt 不能为空','warn'); promptEl.focus(); return true; }
      if(!isSize(size)){ U.toast('尺寸要写成「宽x高」，如 1024x1024','warn'); sizeEl.focus(); return true; }
      const payload={prompt:prompt, size:size, n:1, response_format:fmt};
      if(model) payload.model=model;
      const r=await wb.imageGenerate(payload);
      if(!shell.alive) return;
      const out=m.querySelector('#mwc-gen-out');
      if(out) out.innerHTML=imageOut(r);
      U.toast('生图完成'+((r&&r.credit!==null&&r.credit!==undefined)?('，扣 '+money(r.credit)+' 积分'):''),'ok');
      refreshTasks();
      return true;
    }
    /* 图生图表单（弹窗） */
    function openEditModal(){
      const m=U.openModal({
        title:'图生图 · /v1/images/edits',
        body:
          field('模型','<select id="mwc-edit-model" style="width:100%">'
            +modelOptions(imgEdit(),'自动（目录首选）')+'</select>')
          +field('prompt','<textarea id="mwc-edit-prompt" rows="3" style="width:100%" placeholder="描述要改成什么样"></textarea>')
          +field('image（data URL 或公网 URL）',
            '<input id="mwc-edit-image" style="width:100%" placeholder="data:image/png;base64,… 或 https://…">')
          +'<div class="toolbar" style="margin:0 0 var(--sp-2)"><input type="file" id="mwc-edit-file" accept="image/*">'
          +'<span class="dim" id="mwc-edit-note" style="font-size:11px">选本地图片→自动转 data URL</span></div>'
          +field('尺寸（宽x高）','<input id="mwc-edit-size" list="mwc-sizes" value="1024x1024" style="width:100%">')
          +'<div class="dim" id="mwc-edit-price" style="font-size:11px;line-height:1.6;margin:var(--sp-1) 0 var(--sp-2)"></div>'
          +'<div id="mwc-edit-out"></div>',
        actions:[{label:'关闭'},{label:'提交改图（扣积分）', kind:'pri', onClick:()=>submitEdit(m)}]
      });
      bindFilePicker(m.querySelector('#mwc-edit-file'), m.querySelector('#mwc-edit-image'), m.querySelector('#mwc-edit-note'));
      const sel=m.querySelector('#mwc-edit-model'), price=m.querySelector('#mwc-edit-price');
      shell.listen(sel,'change',()=>paintImagePrice(sel,price));
      paintImagePrice(sel,price);
    }
    async function submitEdit(m){
      const promptEl=m.querySelector('#mwc-edit-prompt'), imgEl=m.querySelector('#mwc-edit-image'),
            sizeEl=m.querySelector('#mwc-edit-size');
      const prompt=(promptEl.value||'').trim();
      const img=(imgEl.value||'').trim();
      const size=(sizeEl.value||'').trim()||'1024x1024';
      const model=m.querySelector('#mwc-edit-model').value;
      if(!prompt){ U.toast('prompt 不能为空','warn'); promptEl.focus(); return true; }
      if(!img){ U.toast('改图要带 image（data URL 或公网 URL）','warn'); imgEl.focus(); return true; }
      if(!isSize(size)){ U.toast('尺寸要写成「宽x高」，如 1024x1024','warn'); sizeEl.focus(); return true; }
      const payload={prompt:prompt, image:img, size:size, n:1};
      if(model) payload.model=model;
      const r=await wb.imageEdit(payload);
      if(!shell.alive) return;
      const out=m.querySelector('#mwc-edit-out');
      if(out) out.innerHTML=imageOut(r);
      U.toast('改图完成'+((r&&r.credit!==null&&r.credit!==undefined)?('，扣 '+money(r.credit)+' 积分'):''),'ok');
      refreshTasks();
      return true;
    }
    /* 生视频表单（弹窗） */
    function openVidModal(){
      const m=U.openModal({
        title:'生视频 · /v1/videos',
        body:
          field('模型','<select id="mwc-vid-model" style="width:100%">'+videoOptions()+'</select>')
          +field('prompt','<textarea id="mwc-vid-prompt" rows="3" style="width:100%" placeholder="描述镜头 / 画面 / 运动"></textarea>')
          +field('首帧图（可选）',
            '<input id="mwc-vid-image" style="width:100%" placeholder="data:image/… 或 https://…；填了就走图生视频">')
          +'<div class="toolbar" style="margin:0 0 var(--sp-2)"><input type="file" id="mwc-vid-file" accept="image/*">'
          +'<span class="dim" id="mwc-vid-note" style="font-size:11px">选本地图片→自动转 data URL</span></div>'
          +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-2)">'
          +field('时长（秒）','<input type="number" id="mwc-vid-seconds" value="5" min="1" max="120" style="width:100%">')
          +field('分辨率','<select id="mwc-vid-res" style="width:100%"><option value="">默认</option></select>')+'</div>'
          +field('画面比例','<select id="mwc-vid-ar" style="width:100%"><option value="">默认</option></select>',
            '图生视频时比例由首帧图决定，本字段会被忽略')
          +'<div class="dim" id="mwc-vid-price" style="font-size:11px;line-height:1.6;margin:var(--sp-1) 0 var(--sp-2)">'
          +'预估花费：先选模型与分辨率</div>'
          +'<div id="mwc-vid-out"></div>',
        actions:[{label:'关闭'},{label:'提交生视频（提交即计费）', kind:'pri', onClick:()=>submitVid(m)}]
      });
      const sel=m.querySelector('#mwc-vid-model'), res=m.querySelector('#mwc-vid-res'),
            sec=m.querySelector('#mwc-vid-seconds');
      shell.listen(sel,'change',()=>fillVideoSelectors(m));
      shell.listen(res,'change',()=>paintVidPrice(m));
      shell.listen(sec,'input',()=>paintVidPrice(m));
      bindFilePicker(m.querySelector('#mwc-vid-file'), m.querySelector('#mwc-vid-image'), m.querySelector('#mwc-vid-note'));
      fillVideoSelectors(m);
    }
    async function submitVid(m){
      const promptEl=m.querySelector('#mwc-vid-prompt');
      const prompt=(promptEl.value||'').trim();
      const model=m.querySelector('#mwc-vid-model').value;
      const img=(m.querySelector('#mwc-vid-image').value||'').trim();
      const sec=Number(m.querySelector('#mwc-vid-seconds').value);
      const res=m.querySelector('#mwc-vid-res').value;
      const ar=m.querySelector('#mwc-vid-ar').value;
      if(!prompt){ U.toast('prompt 不能为空','warn'); promptEl.focus(); return true; }
      if(!isFinite(sec)||sec<1){ U.toast('时长要写正整数秒','warn'); return true; }
      const mod=modelById(model);
      if(mod){
        const wantTag=img?'image-to-video':'text-to-video';
        if(!hasTag(mod,wantTag)){
          U.toast(img?'该模型不支持首帧图，请换图生视频模型或清空首帧图'
                     :'该模型是图生视频模型，必须先给首帧图','warn');
          return true;
        }
      }
      const payload={prompt:prompt, seconds:sec};
      if(model) payload.model=model;
      if(res) payload.resolution=res;
      if(ar&&!img) payload.aspect_ratio=ar;
      if(img) payload.image=img;
      const t=await wb.videoSubmit(payload);
      if(!shell.alive) return;
      const out=m.querySelector('#mwc-vid-out');
      if(out){ out.innerHTML='<div class="mwc-kv"></div>'; kvTable(out.querySelector('.mwc-kv'), taskBrief(t)); }
      U.toast((t&&t.status==='queued'&&t.queue_position!==null&&t.queue_position!==undefined)
        ?'已进入队列（未提交上游、未扣费）':'已提交生视频（已计费）','ok');
      refreshTasks();
      return true;
    }
    /* 任务详情 / 取消 */
    function showDetail(id){
      const m=U.openModal({title:'任务详情', body:'<div class="load">拉取中…</div>', wide:true, actions:[{label:'关闭'}]});
      wb.video(id).then(t=>{
        if(!shell.alive) return;
        const body=m.querySelector('.modal-body');
        if(!body) return;
        body.innerHTML='<div class="mwc-kv"></div>';
        kvTable(body.querySelector('.mwc-kv'), detailRows(t||{}));
      }).catch(e=>{
        const body=m.querySelector('.modal-body');
        if(body) body.innerHTML='<pre class="raw">'+esc(e&&e.message||String(e))+'</pre>';
      });
    }
    function askCancel(id){
      U.openModal({title:'取消任务',
        body:'<div style="font-size:12.5px;line-height:1.75">任务 <b class="mono">'+esc(id)+'</b><br>'
          +'只有<b>排队中</b>的任务能取消。若还没提交上游，取消不扣积分；若上游已受理，'
          +'取消只停止本地轮询，上游仍会跑完并<b style="color:var(--danger)">照常计费</b>。<br>'
          +'<span class="dim">运行中的任务取消会被拒绝（HTTP 409）。</span></div>',
        actions:[
          {label:'返回'},
          {label:'确认取消', kind:'danger', onClick:async function(){
            const t=await wb.videoCancel(id);
            if(!shell.alive) return;
            U.toast('已取消 '+(t&&t.id?t.id:id),'ok');
            refreshTasks();
          }}
        ]});
    }

    /* ═══ 7. 轮询刷新（只动统计卡与任务区，不重绘模型表） ═══ */
    async function refreshTasks(){
      if(!shell.alive) return;
      try{
        const r=await wb.mediaTasks(20);
        if(!shell.alive) return;
        state.tasks=(r&&r.tasks)||[];
        state.stats=(r&&r.stats)||{};
        if(tasksNote) tasksNote.innerHTML='';
        paintCards();
        paintTasksHead();
        paintTasks();
      }catch(e){
        if(!shell.alive) return;
        paintTasksNote(e,'任务刷新失败');
      }
    }

    /* ═══ 8. 布局与事件（shell 结构只建一次，后续只更新持久盒子） ═══ */
    function buildLayout(){
      const bar=shell.toolbar();
      bar.innerHTML=
        '<div class="toolbar"><span class="pill bad">扣积分</span>'
        +'<span class="dim" style="font-size:11.5px">生图按张计费 · 生视频提交即计费 · 排队中取消不扣费</span>'
        +'<span id="mwc-fbar"></span><span class="dim" id="mwc-count" style="font-size:11px"></span>'
        +'<button class="btn mini" data-act="m-refresh" style="margin-left:auto">立即刷新</button></div>'
        +'<div class="toolbar"><button class="btn pri" data-act="m-open-gen">提交生图</button>'
        +'<button class="btn" data-act="m-open-edit">图生图</button>'
        +'<button class="btn" data-act="m-open-vid">生视频</button>'
        +'<span class="dim" style="font-size:11px">三个表单都在弹窗内打开，提交前展示预估扣费</span></div>';
      const c=shell.content();
      c.innerHTML= billingBanner()
        +'<div id="mwc-cards"></div>'
        +'<h2>媒体模型 <span class="dim" style="font-weight:400;font-size:11.5px">'
        +'能力 / 计费 / 约束（单价为网关实测，未测到的不编造）</span></h2>'
        +'<div id="mwc-models-note"></div><div id="mwc-models" style="overflow-x:auto"></div>'
        +'<h2>任务</h2>'
        +'<div class="toolbar" id="mwc-tasks-head"></div><div id="mwc-tasks-note"></div>'
        +'<div id="mwc-tasks" style="overflow-x:auto"></div>'
        +'<datalist id="mwc-sizes">'+SIZES.map(s=>'<option value="'+s+'">').join('')+'</datalist>';
      fbar=bar.querySelector('#mwc-fbar');
      countEl=bar.querySelector('#mwc-count');
      cardsBox=c.querySelector('#mwc-cards');
      modelsNote=c.querySelector('#mwc-models-note');
      modelsBox=c.querySelector('#mwc-models');
      tasksHead=c.querySelector('#mwc-tasks-head');
      tasksNote=c.querySelector('#mwc-tasks-note');
      tasksBox=c.querySelector('#mwc-tasks');
    }
    /* 工具栏 / 重试按钮统一委托（dataTable 的详情 / 取消按钮自带监听，act 不匹配即忽略） */
    function onPageClick(ev){
      const btn=(ev.target&&ev.target.closest)?ev.target.closest('[data-act]'):null;
      if(!btn) return;
      const act=btn.getAttribute('data-act');
      if(act==='m-refresh') refreshTasks();
      else if(act==='m-open-gen') openGenModal();
      else if(act==='m-open-edit') openEditModal();
      else if(act==='m-open-vid') openVidModal();
    }
    function onTagChange(){ paintModels(); paintCount(); }

    /* ═══ 9. 装配：shell 接管标题 / 工具栏 / 内容区 / 轮询 ═══ */
    shell.setTitle('媒体','正在拉取媒体模型与任务…');
    shell.setContent(U.loadHtml('拉取媒体模型与任务…'));

    /* 两个面板各自容错：模型清单挂了，任务列表与表单仍可用（model 留空由后端选） */
    const pair=await Promise.all([
      wb.mediaModels().then(v=>({v:v}), e=>({e:e})),
      wb.mediaTasks(20).then(v=>({v:v}), e=>({e:e}))
    ]);
    if(!shell.alive) return;

    state.models=(pair[0].v&&pair[0].v.models)||[];
    state.realm=(pair[0].v&&pair[0].v.realm)||'';
    state.modelsErr=pair[0].e||null;
    state.tasks=(pair[1].v&&pair[1].v.tasks)||[];
    state.stats=(pair[1].v&&pair[1].v.stats)||{};
    const tasksErr=pair[1].e||null;

    if(state.modelsErr&&tasksErr){
      shell.setTitle('媒体','加载失败');
      shell.setContent(U.errHtml(new Error('媒体模型：'+(state.modelsErr.message||state.modelsErr)
        +'；任务：'+(tasksErr.message||tasksErr))));
      return;
    }

    shell.setTitle('媒体','生图 / 图生图 / 生视频 · 媒体出口 '+(state.realm||'自动')
      +' · 任务区每 5s 自动刷新（离开页面即停止）');
    buildLayout();
    C.filterBar(fbar,[{key:'tag', label:'能力', options:TAG_OPTS}], state, onTagChange);
    paintModelsNote();
    paintCount();
    paintCards();
    paintModels();
    paintTasksHead();
    if(tasksErr) paintTasksNote(tasksErr); else paintTasks();

    shell.listen(el,'click',onPageClick);
    shell.onCleanup(()=>U.closeModal());
    shell.poll(refreshTasks,5000);
  }
});
