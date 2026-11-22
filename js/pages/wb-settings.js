/* 页面：WB 设置（高级）—— 分组表单 + 原始 JSON + 运维动作 */
HUB.register({
  route:'wb-settings', group:'wb', title:'WB 设置', order:70,
  async render(el, ctx){
    el.innerHTML=HUB.ui.loadHtml('拉取设置中…');
    const s=await HUB.api.wb.settings();
    if(ctx.stale()) return;
    const v=(k,d)=> (s&&s[k]!==undefined&&s[k]!==null)?s[k]:d;
    const chk=(k,label,hint)=>`
      <div class="settings-row" style="margin-bottom:10px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" data-set="${k}" ${v(k,false)?'checked':''}> <b>${HUB.ui.esc(label)}</b>
        </label>
        ${hint?`<div class="dim" style="font-size:11px;margin-top:2px">${HUB.ui.esc(hint)}</div>`:''}
      </div>`;
    const numf=(k,label,hint,min=0,max=99999)=>`
      <div class="settings-row" style="margin-bottom:10px">
        <label><b>${HUB.ui.esc(label)}</b></label>
        <input type="number" data-set="${k}" value="${HUB.ui.esc(v(k,0))}" min="${min}" max="${max}" style="width:140px">
        ${hint?`<div class="dim" style="font-size:11px;margin-top:2px">${HUB.ui.esc(hint)}</div>`:''}
      </div>`;
    const media=(s&&s.media)||{};
    el.innerHTML=`
    <h1>WB 设置（高级）</h1><p class="sub">常用开关在此编辑 · 保存即时生效（POST /settings/save）· 全量字段见底部 JSON</p>
    <div class="grid grid-2">
      <div class="card">
        <div class="k">自动化</div>
        ${chk('daily_activity','国际版每日活跃打卡','每日向上游上报活跃，维持账号权重')}
        ${chk('daily_chat_web','每日对话保号','按调度窗口对账号执行网页对话')}
        ${numf('daily_chat_budget','每日对话预算（秒）','单账号当日累计对话时长上限')}
        ${chk('remaining_priority_enabled','剩余用量优先调度','额度多的账号优先接请求')}
      </div>
      <div class="card">
        <div class="k">稳定性</div>
        ${chk('affinity_stable_key_enabled','更稳的会话粘滞键','同会话稳定路由同账号（上游缓存依赖）')}
        ${numf('restriction_hold_seconds','风控连坐暂停（秒）','同域多号被限触发的全池暂停','0','86400')}
        ${numf('account_max_concurrent','单账号并发上限','0 = 不限；1-10',0,10)}
      </div>
      <div class="card">
        <div class="k">媒体限制</div>
        ${numf('media.image_max_per_minute','生图 / 分钟','',1,60)}
        ${numf('media.video_max_seconds','视频最长秒数','',1,60)}
        ${numf('media.video_concurrency','视频并发','',1,8)}
        ${numf('media.daily_credits_per_key','单 Key 日积分上限','0 = 不限',0,1000000)}
      </div>
      <div class="card">
        <div class="k">日志与模型</div>
        ${chk('log_db_enabled','日志落库','请求日志写入本地库')}
        ${chk('pricing_enabled','价格估算','按上游定价折算成本')}
        ${chk('enable_anthropic_messages','启用 Anthropic Messages 通道','/v1/messages 走官方形态')}
        ${chk('models_only_available','只列出可用模型','模型列表过滤掉当前不可用的')}
      </div>
    </div>
    <div class="toolbar">
      <button class="btn pri" id="btnSave">保存以上字段</button>
      <button class="btn" id="btnUnhold">解除风控连坐暂停</button>
      <button class="btn" id="btnDevice">重载设备 Token</button>
      <span class="pill mute">风控冻结 ${Object.entries((s&&s.restriction_holds)||{}).map(e=>e[0]+' '+e[1]+'s').join(' · ')||'无'}</span>
    </div>
    <details style="margin-top:10px"><summary style="cursor:pointer;color:var(--ink-3)">全量设置 JSON（只读）</summary>
      <pre class="raw" style="max-height:360px">${HUB.ui.esc(JSON.stringify(s,null,2).slice(0,20000))}</pre>
    </details>`;

    el.querySelector('#btnSave').onclick=async()=>{
      const payload={};
      el.querySelectorAll('[data-set]').forEach(inp=>{
        const k=inp.dataset.set;
        payload[k]= inp.type==='checkbox' ? inp.checked : (inp.type==='number'? Number(inp.value||0) : inp.value);
      });
      // media 是嵌套对象
      const mediaKeys=['image_max_per_minute','video_max_seconds','video_concurrency','daily_credits_per_key'];
      const mediaPatch={}; let hasMedia=false;
      for(const k of mediaKeys){ if(k in payload){ mediaPatch[k]=payload[k]; delete payload[k]; hasMedia=true; } }
      if(hasMedia) payload.media=mediaPatch;
      try{ await HUB.api.wb.settingsSave(payload); HUB.ui.toast('设置已保存','ok'); }
      catch(e){ HUB.ui.toast('保存失败: '+e.message,'bad'); }
    };
    el.querySelector('#btnUnhold').onclick=async()=>{
      try{ await HUB.api.wb.restrictionReset(); HUB.ui.toast('连坐暂停已解除','ok'); ctx.poll(()=>{},1); }
      catch(e){ HUB.ui.toast('失败: '+e.message,'bad'); }
    };
    el.querySelector('#btnDevice').onclick=async()=>{
      try{ await HUB.api.wb.deviceTokenReload(); HUB.ui.toast('设备 Token 已重载','ok'); }
      catch(e){ HUB.ui.toast('失败: '+e.message,'bad'); }
    };
  }
});
