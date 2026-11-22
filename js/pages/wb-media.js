/* ─────────────────────────────────────────────────────────────
 * 页面：媒体 —— 生图 / 图生图 / 生视频 + 任务轮询与取消
 * 端点：wb.mediaModels · wb.mediaTasks · wb.imageGenerate · wb.imageEdit
 *       wb.videoSubmit · wb.video · wb.videoCancel
 * 计费：真实提交会扣账号积分（生图按张、生视频提交即计费），顶部常驻警示。
 * 轮询：ctx.poll 每 5s 只刷新任务区与统计卡，不重绘表单（避免输入被冲掉）；
 *       离开页面由路由 stopPoll 自动停止，写入前一律 ctx.stale() 守卫。
 * ───────────────────────────────────────────────────────────── */
HUB.register({
  route:'wb-media', group:'wb', title:'媒体', order:30,
  async render(el, ctx){
    const U=HUB.ui;
    const wb=HUB.api.wb;
    const esc=U.esc;

    /* 图像尺寸候选（后端按总像素 ≤ 4MP 校验，2560x1600 = 4.10MP 在限内） */
    const SIZES=['1024x1024','1536x1024','1024x1536','2048x2048',
                 '2560x1440','1440x2560','2560x1600','1600x2560'];
    const TAG_LABEL={'text-to-image':'文生图','image-to-image':'图生图',
                     'text-to-video':'文生视频','image-to-video':'图生视频'};

    if(ctx.stale()) return;
    el.innerHTML=U.loadHtml('拉取媒体模型与任务…');

    /* 两个面板各自容错：模型清单挂了，任务列表与表单仍可用（model 留空由后端选） */
    const pair=await Promise.all([
      wb.mediaModels().then(function(v){return {v:v};},function(e){return {e:e};}),
      wb.mediaTasks(20).then(function(v){return {v:v};},function(e){return {e:e};})
    ]);
    if(ctx.stale()) return;

    const modelsOut=pair[0], tasksOut=pair[1];
    const models=(modelsOut.v&&modelsOut.v.models)||[];
    const realm=(modelsOut.v&&modelsOut.v.realm)||'';
    const modelsErr=modelsOut.e||null;
    const tasksErr=tasksOut.e||null;
    let tasks=(tasksOut.v&&tasksOut.v.tasks)||[];
    let stats=(tasksOut.v&&tasksOut.v.stats)||{};

    if(modelsErr&&tasksErr){
      el.innerHTML=U.errHtml(new Error('媒体模型：'+(modelsErr.message||modelsErr)
        +'；任务：'+(tasksErr.message||tasksErr)));
      return;
    }

    /* ---------------- 数据工具 ---------------- */
    function hasTag(m,t){ return (m&&m.tags||[]).indexOf(t)>=0; }
    function money(v){
      const n=Number(v);
      if(!isFinite(n)) return '—';
      return String(Math.round(n*100)/100);
    }
    function modelById(id){
      if(!id) return null;
      for(let i=0;i<models.length;i++){ if(models[i].id===id) return models[i]; }
      return null;
    }
    function modelOptions(list, autoLabel){
      let html='<option value="">'+esc(autoLabel)+'</option>';
      list.forEach(function(m){
        const label=(m.name&&m.name!==m.id)?(m.name+' · '+m.id):m.id;
        html+='<option value="'+esc(m.id)+'">'+esc(label)+'</option>';
      });
      return html;
    }
    function isSize(s){ return s==='auto'||/^\d{2,5}x\d{2,5}$/.test(s); }
    function dlHref(url){
      if(!url) return '';
      if(url.indexOf('http://')===0||url.indexOf('https://')===0||url.indexOf('/wb/')===0) return url;
      return '/wb'+url;
    }

    const imgGen=models.filter(function(m){ return hasTag(m,'text-to-image'); });
    const imgEdit=models.filter(function(m){ return hasTag(m,'image-to-image'); });
    const vidT2V=models.filter(function(m){ return hasTag(m,'text-to-video'); });
    const vidI2V=models.filter(function(m){ return hasTag(m,'image-to-video'); });
    const vidAll=models.filter(function(m){ return hasTag(m,'text-to-video')||hasTag(m,'image-to-video'); });

    /* ---------------- 状态药丸 / 价格 ---------------- */
    function statusPill(s){
      const map={queued:['排队中','warn'],in_progress:['生成中','info'],
                 completed:['已完成','ok'],failed:['失败','bad']};
      const hit=map[s]||[s||'未知','mute'];
      return U.pill(hit[0],hit[1]);
    }
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
        if(m.creditPerImage===null||m.creditPerImage===undefined){
          return '<span class="dim">未测得</span>';
        }
        return '<span class="mono">'+esc(money(m.creditPerImage))+'</span> 积分/张'
          +(m.creditPerImageMeasured?'':' <span class="dim">（估算）</span>');
      }
      const map=m.creditsPerSecond;
      const parts=[];
      if(map&&typeof map==='object'&&!Array.isArray(map)){
        Object.keys(map).forEach(function(k){
          parts.push(esc(k)+' <span class="mono">'+esc(money(map[k]))+'</span>');
        });
      }else if(typeof map==='number'){
        parts.push('<span class="mono">'+esc(money(map))+'</span>');
      }
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
      const g=m.videoGeneration||{};
      const li=[];
      if(hasTag(m,'text-to-video')||hasTag(m,'image-to-video')){
        if(g.minSeconds!==null&&g.minSeconds!==undefined
           &&g.maxSeconds!==null&&g.maxSeconds!==undefined){
          li.push(esc(g.minSeconds+'–'+g.maxSeconds)+' 秒');
        }else if(g.defaultSeconds!==null&&g.defaultSeconds!==undefined){
          li.push('默认 '+esc(g.defaultSeconds)+' 秒');
        }
        if(g.resolutions&&g.resolutions.length) li.push(esc(g.resolutions.join(' / ')));
        else if(g.defaultResolution) li.push('默认 '+esc(g.defaultResolution));
        if(hasTag(m,'text-to-video')){
          const ars=(g.aspectRatios&&g.aspectRatios.length)?g.aspectRatios:['16:9','9:16','1:1'];
          li.push(esc(ars.join(' / ')));
        }else{
          li.push('比例随首帧图');
        }
        if(g.maxPromptLength!==null&&g.maxPromptLength!==undefined){
          li.push('prompt ≤ '+esc(g.maxPromptLength));
        }
        const refs=[];
        if(g.maxReferenceImages) refs.push('图 '+g.maxReferenceImages);
        if(g.maxReferenceVideos) refs.push('视频 '+g.maxReferenceVideos);
        if(g.maxReferenceAudios) refs.push('音频 '+g.maxReferenceAudios);
        if(refs.length) li.push('参考素材：'+esc(refs.join(' · ')));
        if(g.supportsFirstFrame) li.push('支持首帧');
        if(g.supportsFirstLastFrame) li.push('支持首尾帧');
      }else{
        li.push('单张计费 · n=1');
        li.push('size ≤ 4.00 MP');
      }
      if(!li.length) return '<span class="dim">—</span>';
      return '<span class="dim" style="font-size:11px;line-height:1.65">'+li.join(' · ')+'</span>';
    }
    function capabilityCell(m){
      const tags=m.tags||[];
      if(!tags.length) return '<span class="dim">—</span>';
      return tags.map(function(t){
        return U.pill(TAG_LABEL[t]||t,TAG_LABEL[t]?((t.indexOf('video')>=0)?'warn':'info'):'mute');
      }).join(' ');
    }

    /* ---------------- 顶部：警示 + 统计卡 ---------------- */
    function billingBanner(){
      return '<div style="display:flex;gap:10px;align-items:flex-start;background:var(--danger-soft);'
        +'border:1px solid rgba(232,106,92,.45);border-radius:var(--card-radius);padding:12px 14px;'
        +'margin:0 0 var(--sp-4)">'
        +'<span class="pill bad">扣积分</span>'
        +'<div style="font-size:12px;line-height:1.7;color:var(--ink-2)">'
        +'<b style="color:var(--danger)">真实提交会扣账号积分。</b> '
        +'生图按张计费；生视频在<b>提交时即计费</b>，并发已满时先本地排队（未提交上游、不扣费）。'
        +'取消只对排队中的任务生效：排队中取消不扣费，上游已受理后取消仅停止本地轮询、照常计费。'
        +'<span class="dim">单价见下方模型表，未实测的档位不编造数字。</span>'
        +'</div></div>';
    }
    function cardsHtml(){
      const by=(stats&&stats.by_status)||{};
      const total=(stats&&stats.total!==null&&stats.total!==undefined)?stats.total:tasks.length;
      return U.cards([
        {k:'媒体出口',v:'<span class="mono">'+esc(realm||'自动')+'</span>',n:'媒体号池出口，模型目录按该区返回'},
        {k:'可用媒体模型',v:String(models.length),
         n:'生图 '+imgGen.length+' · 图生图 '+imgEdit.length+' · 视频 '+vidAll.length},
        {k:'排队（未扣费）',v:String((stats&&stats.waiting)||0),
         n:'队列深度 '+((stats&&stats.queue_depth)||0)+' · 排队中取消不扣费'},
        {k:'并发生视频',v:String((stats&&stats.active)||0)+' / '+String((stats&&stats.concurrency)||0),
         n:'占用媒体账号 '+((stats&&stats.busy_accounts)||0)},
        {k:'任务总数',v:String(total),
         n:'已完成 '+String(by.completed||0)+' · 失败 '+String(by.failed||0)}
      ]);
    }

    /* ---------------- 模型表 ---------------- */
    function modelsHtml(filter){
      const list=filter?models.filter(function(m){ return hasTag(m,filter); }):models;
      const rows=list.map(function(m){
        const name='<b>'+esc(m.name||m.id)+'</b>'
          +((m.name&&m.name!==m.id)
            ?'<div class="mono dim" style="font-size:11px">'+esc(m.id)+'</div>':'');
        return [name,capabilityCell(m),creditCell(m),constraintCell(m)];
      });
      return U.table(['模型','能力','计费','约束'],rows,{empty:'该区目录里没有匹配的媒体模型'});
    }
    function modelsSection(){
      if(modelsErr){
        return '<h2>媒体模型</h2>'
          +'<div class="toolbar"><span class="pill bad">模型清单加载失败</span>'
          +'<span class="dim" style="font-size:11.5px">'+esc(modelsErr.message||String(modelsErr))+'</span></div>'
          +'<p class="sub">表单仍可提交：model 留空时由后端在目录中自动选择。</p>';
      }
      const opt=[['','全部能力'],['text-to-image','文生图'],['image-to-image','图生图'],
                 ['text-to-video','文生视频'],['image-to-video','图生视频']]
        .map(function(p){ return '<option value="'+p[0]+'">'+p[1]+'</option>'; }).join('');
      return '<h2>媒体模型 <span class="dim" style="font-weight:400;font-size:11.5px">'
        +'能力 / 计费 / 约束（单价为网关实测，未测到的不编造）</span></h2>'
        +'<div class="toolbar"><label>能力</label><select id="mw-tag">'+opt+'</select>'
        +'<span class="dim" id="mw-models-count" style="font-size:11px">'+models.length+' 个模型</span></div>'
        +'<div id="mw-models">'+modelsHtml('')+'</div>';
    }

    /* ---------------- 表单 ---------------- */
    function field(label, control, hint){
      return '<label style="display:block;margin-bottom:var(--sp-2)">'
        +'<span style="display:block;color:var(--ink-3);font-size:11.5px;margin-bottom:4px">'+label+'</span>'
        +control
        +(hint?'<span class="dim" style="display:block;font-size:10.5px;margin-top:3px">'+hint+'</span>':'')
        +'</label>';
    }
    function formCard(title, endpoint, body){
      return '<section class="card">'
        +'<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:var(--sp-3)">'
        +'<h2 style="margin:0;font-size:13.5px">'+title+'</h2>'
        +'<span class="pill mute mono">'+endpoint+'</span></div>'
        +body+'</section>';
    }
    function genCard(){
      return formCard('生图','/v1/images/generations',
        field('模型','<select id="mw-gen-model" style="width:100%">'
          +modelOptions(imgGen,'自动（目录首选）')+'</select>')
        +field('prompt','<textarea id="mw-gen-prompt" rows="3" style="width:100%" '
          +'placeholder="描述要生成的画面"></textarea>')
        +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-2)">'
        +field('尺寸（宽x高）','<input id="mw-gen-size" list="mw-size-list" value="1024x1024" style="width:100%">')
        +field('response_format','<select id="mw-gen-fmt" style="width:100%">'
          +'<option value="url">url</option><option value="b64_json">b64_json</option></select>')
        +'</div>'
        +field('n（张数）','<select id="mw-gen-n" style="width:100%"><option value="1">1</option></select>',
          '网关每次只出一张：n 只能为 1，多图请多次提交（每张都真实扣积分）')
        +'<div class="toolbar" style="margin:0 0 var(--sp-2)">'
        +'<button class="btn pri" id="mw-gen-go">提交生图（扣积分）</button>'
        +'<span class="dim" id="mw-gen-price" style="font-size:11px"></span></div>'
        +'<div id="mw-gen-out"></div>');
    }
    function editCard(){
      return formCard('图生图（改图）','/v1/images/edits',
        field('模型','<select id="mw-edit-model" style="width:100%">'
          +modelOptions(imgEdit,'自动（目录首选）')+'</select>')
        +field('prompt','<textarea id="mw-edit-prompt" rows="3" style="width:100%" '
          +'placeholder="描述要改成什么样"></textarea>')
        +field('image（data URL 或公网 URL）',
          '<input id="mw-edit-image" style="width:100%" placeholder="data:image/png;base64,… 或 https://…">')
        +'<div class="toolbar" style="margin:0 0 var(--sp-2)">'
        +'<input type="file" id="mw-edit-file" accept="image/*">'
        +'<span class="dim" id="mw-edit-file-note" style="font-size:11px">选本地图片→自动转 data URL</span></div>'
        +field('尺寸（宽x高）','<input id="mw-edit-size" list="mw-size-list" value="1024x1024" style="width:100%">')
        +'<div class="toolbar" style="margin:0 0 var(--sp-2)">'
        +'<button class="btn pri" id="mw-edit-go">提交改图（扣积分）</button>'
        +'<span class="dim" id="mw-edit-price" style="font-size:11px"></span></div>'
        +'<div id="mw-edit-out"></div>');
    }
    function videoOptions(){
      let html='<option value="">自动（按是否给首帧图选择）</option>';
      vidAll.forEach(function(m){
        const label=(m.name&&m.name!==m.id)?(m.name+' · '+m.id):m.id;
        const suffix=hasTag(m,'text-to-video')?'':'（图生视频，需首帧图）';
        html+='<option value="'+esc(m.id)+'">'+esc(label+suffix)+'</option>';
      });
      return html;
    }
    function videoCard(){
      return formCard('生视频','/v1/videos',
        field('模型','<select id="mw-vid-model" style="width:100%">'+videoOptions()+'</select>')
        +field('prompt','<textarea id="mw-vid-prompt" rows="3" style="width:100%" '
          +'placeholder="描述镜头 / 画面 / 运动"></textarea>')
        +field('首帧图（可选）',
          '<input id="mw-vid-image" style="width:100%" placeholder="data:image/… 或 https://…；填了就走图生视频">')
        +'<div class="toolbar" style="margin:0 0 var(--sp-2)">'
        +'<input type="file" id="mw-vid-file" accept="image/*">'
        +'<span class="dim" id="mw-vid-file-note" style="font-size:11px">选本地图片→自动转 data URL</span></div>'
        +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-2)">'
        +field('时长（秒）','<input type="number" id="mw-vid-seconds" value="5" min="1" max="120" style="width:100%">')
        +field('分辨率','<select id="mw-vid-res" style="width:100%"><option value="">默认</option></select>')
        +'</div>'
        +field('画面比例','<select id="mw-vid-ar" style="width:100%"><option value="">默认</option></select>',
          '图生视频时比例由首帧图决定，本字段会被忽略')
        +'<div class="dim" id="mw-vid-price" style="font-size:11px;line-height:1.6;margin-bottom:var(--sp-2)">'
        +'预估花费：先选模型与分辨率</div>'
        +'<div class="toolbar" style="margin:0"><button class="btn pri" id="mw-vid-go">提交生视频（提交即计费）</button></div>'
        +'<div id="mw-vid-out" style="margin-top:var(--sp-2)"></div>');
    }
    function formsSection(){
      return '<h2>提交任务</h2>'
        +'<div style="display:grid;gap:var(--sp-3);grid-template-columns:repeat(auto-fill,minmax(340px,1fr));'
        +'margin-bottom:var(--sp-4)">'+genCard()+editCard()+videoCard()+'</div>';
    }

    /* ---------------- 任务表 ---------------- */
    function taskRows(list){
      return list.map(function(t){
        const canCancel=t.status==='queued';
        return [
          '<span class="mono" style="font-size:11px">'+esc(U.ts(t.created_at))+'</span>',
          '<span class="mono" title="'+esc(t.id||'')+'" style="font-size:11px">'
            +esc(String(t.id||'—').slice(0,12))+'</span>',
          '<span class="mono" style="font-size:11px">'+esc(t.model||'—')+'</span>',
          statusCell(t),
          '<span class="mono" style="font-size:11px">'+(t.seconds?esc(t.seconds)+'s':'—')
            +(t.resolution?' · '+esc(t.resolution):'')+'</span>',
          (t.credit!==null&&t.credit!==undefined)
            ?'<span class="mono">'+esc(money(t.credit))+'</span>':'<span class="dim">—</span>',
          downloadLink(t),
          '<span style="white-space:nowrap">'
            +'<button class="btn mini" data-act="detail" data-id="'+esc(t.id||'')+'">详情</button>'
            +(canCancel?' <button class="btn mini danger" data-act="cancel" data-id="'+esc(t.id||'')+'">取消</button>':'')
            +'</span>'
        ];
      });
    }
    function tasksErrorHtml(){
      return '<div class="toolbar"><span class="pill bad">任务列表加载失败</span>'
        +'<span class="dim" style="font-size:11.5px">'+esc(tasksErr.message||String(tasksErr))+'</span>'
        +'<button class="btn mini" data-act="refresh" style="margin-left:auto">重试</button></div>';
    }
    function tasksHtml(){
      const by=(stats&&stats.by_status)||{};
      const total=(stats&&stats.total!==null&&stats.total!==undefined)?stats.total:tasks.length;
      const head='<div class="toolbar"><h2 style="margin:0;font-size:13.5px">任务</h2>'
        +'<span class="pill mute">共 '+esc(total)+'</span>'
        +'<span class="pill '+((stats&&stats.waiting)?'warn':'mute')+'">排队 '+esc((stats&&stats.waiting)||0)+'</span>'
        +'<span class="pill mute">并发 '+esc(((stats&&stats.active)||0)+'/'+((stats&&stats.concurrency)||0))+'</span>'
        +'<span class="pill '+(by.failed?'bad':'mute')+'">失败 '+esc(by.failed||0)+'</span>'
        +'<span class="dim" style="font-size:11px">每 5s 自动刷新</span>'
        +'<button class="btn mini" data-act="refresh" style="margin-left:auto">立即刷新</button></div>';
      return head+U.table(['时间','任务 id','模型','状态','时长 / 分辨率','积分','下载','操作'],
        taskRows(tasks),{empty:'暂无任务；提交后会出现在这里'});
    }

    /* ---------------- 结果渲染 ---------------- */
    function imageOut(r){
      const item=(r&&r.data&&r.data[0])||{};
      const src=item.url||(item.b64_json?('data:image/png;base64,'+item.b64_json):'');
      return '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start">'
        +(src?'<img src="'+esc(src)+'" alt="生成结果" '
          +'style="width:168px;height:168px;object-fit:cover;border:1px solid var(--line);'
          +'border-radius:var(--radius-m);background:var(--surface-2)">':'')
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
      const rows=[
        ['任务 id','<span class="mono">'+esc(t&&t.id||'—')+'</span>'],
        ['状态',statusCell(t||{})],
        ['模型','<span class="mono">'+esc(t&&t.model||'—')+'</span>'],
        ['积分',(t&&t.credit!==null&&t.credit!==undefined)
          ?'<span class="mono">'+esc(money(t.credit))+'</span>':'<span class="dim">未扣（排队中）</span>'],
        ['排队位',(t&&t.queue_position!==null&&t.queue_position!==undefined)
          ?'<span class="mono">'+esc(t.queue_position)+'</span>':'—'],
        ['提示',(t&&t.hint)?esc(t.hint):'—']
      ];
      return U.table(['字段','值'],rows);
    }
    function detailHtml(t){
      const err=(t.error&&t.error.message)?t.error.message:'—';
      const rows=[
        ['id','<span class="mono">'+esc(t.id||'—')+'</span>'],
        ['object','<span class="mono">'+esc(t.object||'video')+'</span>'],
        ['状态',statusCell(t)],
        ['模型','<span class="mono">'+esc(t.model||'—')+'</span>'],
        ['创建时间','<span class="mono">'+esc(U.ts(t.created_at))+'</span>'],
        ['完成时间','<span class="mono">'+esc(t.completed_at?U.ts(t.completed_at):'—')+'</span>'],
        ['时长',t.seconds?'<span class="mono">'+esc(t.seconds)+' 秒</span>':'—'],
        ['分辨率','<span class="mono">'+esc(t.resolution||'—')+'</span>'],
        ['积分',(t.credit!==null&&t.credit!==undefined)
          ?'<span class="mono">'+esc(money(t.credit))+'</span>':'<span class="dim">未扣 / 未知</span>'],
        ['错误',err!=='—'?'<span style="color:var(--danger)">'+esc(err)+'</span>':'—'],
        ['下载',downloadLink(t)]
      ];
      return U.table(['字段','值'],rows);
    }

    /* ---------------- 首屏 ---------------- */
    el.innerHTML=
      '<h1>媒体</h1>'
      +'<p class="sub">生图 / 图生图 / 生视频 · 媒体出口 <b class="mono">'+esc(realm||'自动')+'</b>'
      +' · 任务区每 5s 自动刷新（离开页面即停止）</p>'
      +billingBanner()
      +'<div id="mw-cards">'+cardsHtml()+'</div>'
      +modelsSection()
      +formsSection()
      +'<div id="mw-tasks-err"></div>'
      +'<div id="mw-tasks">'+(tasksErr?tasksErrorHtml():tasksHtml())+'</div>'
      +'<datalist id="mw-size-list">'
      +SIZES.map(function(s){ return '<option value="'+s+'">'; }).join('')
      +'</datalist>';

    const $=function(id){ return el.querySelector('#'+id); };

    /* ---------------- 模型表筛选 ---------------- */
    if($('mw-tag')){
      $('mw-tag').onchange=function(){
        const filter=this.value;
        const box=$('mw-models');
        if(box) box.innerHTML=modelsHtml(filter);
        const count=$('mw-models-count');
        if(count){
          const n=filter?models.filter(function(m){ return hasTag(m,filter); }).length:models.length;
          count.textContent=n+' 个模型';
        }
      };
    }

    /* ---------------- 本地图片 → data URL ---------------- */
    function bindFile(fileId,targetId,noteId){
      const file=$(fileId), target=$(targetId), note=$(noteId);
      if(!file||!target) return;
      file.onchange=function(){
        const f=file.files&&file.files[0];
        if(!f) return;
        if(f.size>8*1024*1024){
          U.toast('图片不能超过 8MB（base64 会膨胀，网关请求体上限 24MB）','bad');
          file.value='';
          return;
        }
        const fr=new FileReader();
        fr.onload=function(){
          target.value=String(fr.result||'');
          if(note) note.textContent='已读入 '+f.name+'（'+(f.size/1048576).toFixed(2)+' MB）';
          U.toast('已转为 data URL','ok');
        };
        fr.onerror=function(){ U.toast('读取文件失败','bad'); };
        fr.readAsDataURL(f);
      };
    }
    bindFile('mw-edit-file','mw-edit-image','mw-edit-file-note');
    bindFile('mw-vid-file','mw-vid-image','mw-vid-file-note');

    /* ---------------- 价格提示 ---------------- */
    function paintImagePrice(selectId,labelId){
      const sel=$(selectId), label=$(labelId);
      if(!sel||!label) return;
      const m=modelById(sel.value);
      if(!m){ label.textContent='价格随目录首选模型，以实际扣费为准'; return; }
      label.textContent=(m.creditPerImage!==null&&m.creditPerImage!==undefined)
        ?('约 '+money(m.creditPerImage)+' 积分/张'+(m.creditPerImageMeasured?'':'（估算）'))
        :'单价未测得，以实际扣费为准';
    }
    if($('mw-gen-model')) $('mw-gen-model').onchange=function(){ paintImagePrice('mw-gen-model','mw-gen-price'); };
    if($('mw-edit-model')) $('mw-edit-model').onchange=function(){ paintImagePrice('mw-edit-model','mw-edit-price'); };
    paintImagePrice('mw-gen-model','mw-gen-price');
    paintImagePrice('mw-edit-model','mw-edit-price');

    /* ---------------- 生视频：模型 → 分辨率 / 比例 / 预估价 ---------------- */
    const vidModelEl=$('mw-vid-model'), vidResEl=$('mw-vid-res'), vidArEl=$('mw-vid-ar');
    const vidSecEl=$('mw-vid-seconds'), vidPriceEl=$('mw-vid-price');

    function videoGenConfig(){
      const m=modelById(vidModelEl?vidModelEl.value:'');
      if(m) return m.videoGeneration||{};
      const res=[], ars=[];
      vidAll.forEach(function(x){
        const g=x.videoGeneration||{};
        (g.resolutions||[]).forEach(function(r){ if(res.indexOf(r)<0) res.push(r); });
        const a=(g.aspectRatios&&g.aspectRatios.length)?g.aspectRatios:['16:9','9:16','1:1'];
        a.forEach(function(r){ if(ars.indexOf(r)<0) ars.push(r); });
      });
      return {resolutions:res,aspectRatios:ars};
    }
    function paintVidPrice(){
      if(!vidPriceEl) return;
      const m=modelById(vidModelEl?vidModelEl.value:'');
      const sec=Number(vidSecEl&&vidSecEl.value)||0;
      const res=vidResEl?vidResEl.value:'';
      let price=null;
      if(m){
        const map=m.creditsPerSecond;
        if(map&&typeof map==='object'&&!Array.isArray(map)){
          const def=(m.videoGeneration||{}).defaultResolution;
          if(res&&map[res]!==null&&map[res]!==undefined) price=map[res];
          else if(def&&map[def]!==null&&map[def]!==undefined) price=map[def];
        }else if(typeof map==='number'){
          price=map;
        }
      }
      if(price===null||!sec){
        vidPriceEl.textContent='预估花费：'+(m?'该组合单价未测得':'先选模型')+'，以实际扣费为准';
        return;
      }
      vidPriceEl.innerHTML='预估花费 ≈ <b class="mono" style="color:var(--accent)">'
        +esc(money(price*sec))+'</b> 积分（'+esc(money(price))+' × '+esc(String(sec))+' 秒，'
        +'按实测单价估算，实际以扣费为准；提交即计费，排队中未扣费）';
    }
    function fillVideoSelectors(){
      if(!vidResEl||!vidArEl||!vidSecEl) return;
      const g=videoGenConfig();
      const curRes=vidResEl.value, curAr=vidArEl.value;
      vidResEl.innerHTML='<option value="">默认'
        +(g.defaultResolution?'（'+esc(g.defaultResolution)+'）':'')+'</option>'
        +(g.resolutions||[]).map(function(r){
          return '<option value="'+esc(r)+'">'+esc(r)+'</option>';
        }).join('');
      const ars=(g.aspectRatios&&g.aspectRatios.length)?g.aspectRatios:['16:9','9:16','1:1'];
      vidArEl.innerHTML='<option value="">默认'
        +(g.defaultAspectRatio?'（'+esc(g.defaultAspectRatio)+'）':'')+'</option>'
        +ars.map(function(r){ return '<option value="'+esc(r)+'">'+esc(r)+'</option>'; }).join('');
      if(curRes&&vidResEl.querySelector('option[value="'+curRes+'"]')) vidResEl.value=curRes;
      if(curAr&&vidArEl.querySelector('option[value="'+curAr+'"]')) vidArEl.value=curAr;
      if(g.minSeconds!==null&&g.minSeconds!==undefined) vidSecEl.min=String(g.minSeconds);
      if(g.maxSeconds!==null&&g.maxSeconds!==undefined) vidSecEl.max=String(g.maxSeconds);
      paintVidPrice();
    }
    if(vidModelEl){
      vidModelEl.onchange=fillVideoSelectors;
      fillVideoSelectors();
    }
    if(vidResEl) vidResEl.onchange=paintVidPrice;
    if(vidSecEl) vidSecEl.oninput=paintVidPrice;

    /* ---------------- 金额确认 ---------------- */
    function confirmSubmit(title,body,run){
      U.openModal({title:title,body:'<div style="font-size:12.5px;line-height:1.75">'
        +body+'</div>',actions:[
        {label:'取消'},
        {label:'确认提交（扣积分）',kind:'pri',onClick:async function(){ await run(); }}
      ]});
    }

    /* ---------------- 生图提交 ---------------- */
    if($('mw-gen-go')) $('mw-gen-go').onclick=function(){
      const promptEl=$('mw-gen-prompt'), sizeEl=$('mw-gen-size');
      const prompt=(promptEl.value||'').trim();
      const size=(sizeEl.value||'').trim()||'1024x1024';
      const model=$('mw-gen-model').value;
      const fmt=$('mw-gen-fmt').value;
      if(!prompt){ U.toast('prompt 不能为空','warn'); promptEl.focus(); return; }
      if(!isSize(size)){ U.toast('尺寸要写成「宽x高」，如 1024x1024','warn'); sizeEl.focus(); return; }
      const m=modelById(model);
      const per=(m&&m.creditPerImage!==null&&m.creditPerImage!==undefined)
        ?money(m.creditPerImage):'—';
      confirmSubmit('确认提交生图',
        '模型 <b class="mono">'+esc(model||'自动选择')+'</b> · 尺寸 <b class="mono">'+esc(size)+'</b>'
        +' · 返回 <span class="mono">'+esc(fmt)+'</span><br>'
        +'预估扣费 <b class="mono" style="color:var(--accent)">≈ '+esc(per)+'</b> 积分/张'
        +((m&&!m.creditPerImageMeasured)?'（估算）':'')+'<br>'
        +'<span style="color:var(--danger)">真实提交会扣账号积分；成功后即计费，失败会换号重试。</span>',
        async function(){
          const payload={prompt:prompt,size:size,n:1,response_format:fmt};
          if(model) payload.model=model;
          const r=await wb.imageGenerate(payload);
          if(ctx.stale()) return;
          const out=$('mw-gen-out');
          if(out) out.innerHTML=imageOut(r);
          U.toast('生图完成'+((r&&r.credit!==null&&r.credit!==undefined)?('，扣 '+money(r.credit)+' 积分'):''),'ok');
          await refreshTasks();
        });
    };

    /* ---------------- 改图提交 ---------------- */
    if($('mw-edit-go')) $('mw-edit-go').onclick=function(){
      const promptEl=$('mw-edit-prompt'), imgEl=$('mw-edit-image'), sizeEl=$('mw-edit-size');
      const prompt=(promptEl.value||'').trim();
      const img=(imgEl.value||'').trim();
      const size=(sizeEl.value||'').trim()||'1024x1024';
      const model=$('mw-edit-model').value;
      if(!prompt){ U.toast('prompt 不能为空','warn'); promptEl.focus(); return; }
      if(!img){ U.toast('改图要带 image（data URL 或公网 URL）','warn'); imgEl.focus(); return; }
      if(!isSize(size)){ U.toast('尺寸要写成「宽x高」，如 1024x1024','warn'); sizeEl.focus(); return; }
      const m=modelById(model);
      const per=(m&&m.creditPerImage!==null&&m.creditPerImage!==undefined)
        ?money(m.creditPerImage):'—';
      confirmSubmit('确认提交改图',
        '模型 <b class="mono">'+esc(model||'自动选择')+'</b> · 尺寸 <b class="mono">'+esc(size)+'</b><br>'
        +'输入图 <b class="mono">'+esc(img.indexOf('data:')===0?'data URL':img.slice(0,60)+'…')+'</b><br>'
        +'预估扣费 <b class="mono" style="color:var(--accent)">≈ '+esc(per)+'</b> 积分/张'
        +((m&&!m.creditPerImageMeasured)?'（估算）':'')+'<br>'
        +'<span style="color:var(--danger)">真实提交会扣账号积分。</span>',
        async function(){
          const payload={prompt:prompt,image:img,size:size,n:1};
          if(model) payload.model=model;
          const r=await wb.imageEdit(payload);
          if(ctx.stale()) return;
          const out=$('mw-edit-out');
          if(out) out.innerHTML=imageOut(r);
          U.toast('改图完成'+((r&&r.credit!==null&&r.credit!==undefined)?('，扣 '+money(r.credit)+' 积分'):''),'ok');
          await refreshTasks();
        });
    };

    /* ---------------- 生视频提交 ---------------- */
    if($('mw-vid-go')) $('mw-vid-go').onclick=function(){
      const promptEl=$('mw-vid-prompt');
      const prompt=(promptEl.value||'').trim();
      const model=vidModelEl?vidModelEl.value:'';
      const img=(($('mw-vid-image').value)||'').trim();
      const sec=Number(vidSecEl&&vidSecEl.value);
      const res=vidResEl?vidResEl.value:'';
      const ar=vidArEl?vidArEl.value:'';
      if(!prompt){ U.toast('prompt 不能为空','warn'); promptEl.focus(); return; }
      if(!isFinite(sec)||sec<1){ U.toast('时长要写正整数秒','warn'); return; }
      const m=modelById(model);
      if(m){
        const wantTag=img?'image-to-video':'text-to-video';
        if(!hasTag(m,wantTag)){
          U.toast(img?'该模型不支持首帧图，请换图生视频模型或清空首帧图'
                     :'该模型是图生视频模型，必须先给首帧图','warn');
          return;
        }
      }
      const guess=(vidPriceEl)?vidPriceEl.textContent:'';
      confirmSubmit('确认提交生视频',
        '模型 <b class="mono">'+esc(model||'自动选择')+'</b> · 时长 <b class="mono">'+esc(sec)+'</b> 秒'
        +' · 分辨率 <b class="mono">'+esc(res||'默认')+'</b> · 比例 <b class="mono">'+esc(img?'随首帧图':(ar||'默认'))+'</b><br>'
        +'<span class="dim">'+esc(guess)+'</span><br>'
        +'<span style="color:var(--danger)">提交即计费</span>：并发已满时会先本地排队（未提交上游、不扣费），'
        +'排队中可取消；上游受理后取消仍会计费。',
        async function(){
          const payload={prompt:prompt,seconds:sec};
          if(model) payload.model=model;
          if(res) payload.resolution=res;
          if(ar&&!img) payload.aspect_ratio=ar;
          if(img) payload.image=img;
          const t=await wb.videoSubmit(payload);
          if(ctx.stale()) return;
          const out=$('mw-vid-out');
          if(out) out.innerHTML=taskBrief(t);
          U.toast((t&&t.status==='queued'&&t.queue_position!==null&&t.queue_position!==undefined)
            ?'已进入队列（未提交上游、未扣费）':'已提交生视频（已计费）','ok');
          await refreshTasks();
        });
    };

    /* ---------------- 任务：轮询 / 详情 / 取消 ---------------- */
    function showDetail(id){
      const m=U.openModal({title:'任务详情',body:'<div class="load">拉取中…</div>',wide:true});
      wb.video(id).then(function(t){
        if(ctx.stale()) return;
        const body=m.querySelector('.modal-body');
        if(body) body.innerHTML=detailHtml(t||{});
      }).catch(function(e){
        const body=m.querySelector('.modal-body');
        if(body) body.innerHTML='<pre class="raw">'+esc(e&&e.message||String(e))+'</pre>';
      });
    }
    function askCancel(id){
      U.openModal({title:'取消任务',
        body:'<div style="font-size:12.5px;line-height:1.75">'
          +'任务 <b class="mono">'+esc(id)+'</b><br>'
          +'只有<b>排队中</b>的任务能取消。若还没提交上游，取消不扣积分；'
          +'若上游已受理，取消只停止本地轮询，上游仍会跑完并'
          +'<b style="color:var(--danger)">照常计费</b>。<br>'
          +'<span class="dim">运行中的任务取消会被拒绝（HTTP 409）。</span></div>',
        actions:[
          {label:'返回'},
          {label:'确认取消',kind:'danger',onClick:async function(){
            const t=await wb.videoCancel(id);
            if(ctx.stale()) return;
            U.toast('已取消 '+(t&&t.id?t.id:id),'ok');
            await refreshTasks();
          }}
        ]});
    }
    async function refreshTasks(){
      try{
        const r=await wb.mediaTasks(20);
        if(ctx.stale()) return;
        tasks=(r&&r.tasks)||[];
        stats=(r&&r.stats)||{};
        const box=$('mw-tasks'), cardsBox=$('mw-cards'), errBox=$('mw-tasks-err');
        if(errBox) errBox.innerHTML='';
        if(box) box.innerHTML=tasksHtml();
        if(cardsBox) cardsBox.innerHTML=cardsHtml();
      }catch(e){
        if(ctx.stale()) return;
        const errBox=$('mw-tasks-err');
        if(errBox) errBox.innerHTML='<div class="toolbar"><span class="pill bad">任务刷新失败</span>'
          +'<span class="dim" style="font-size:11.5px">'+esc(e&&e.message||String(e))+'</span></div>';
      }
    }

    el.addEventListener('click',function(ev){
      const node=ev.target;
      const btn=(node&&node.closest)?node.closest('[data-act]'):null;
      if(!btn) return;
      const act=btn.getAttribute('data-act');
      const id=btn.getAttribute('data-id');
      if(act==='refresh') refreshTasks();
      else if(act==='detail') showDetail(id);
      else if(act==='cancel') askCancel(id);
    });

    ctx.poll(refreshTasks,5000);
  }
});
