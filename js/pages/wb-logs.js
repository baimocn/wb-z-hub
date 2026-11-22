/* ─────────────────────────────────────────────────────────────
 * 页面：日志（wb-logs）
 * 左半：实时运行日志 —— 级别过滤 + 标签/搜索过滤 + since_id 增量轮询 + 暂停
 * 右半（下方）：活动历史 —— /activity/history 的签到 / 打卡记录表
 *
 * 调用（全部经 js/core/api.js 的 HUB.api，无裸 fetch）：
 *   HUB.api.wb.logs(limit, sinceId)        日志快照 / 增量
 *   HUB.api.wb.activityHistory(range, n)   活动历史
 *   HUB.api.GET('/wb/logs/export')         导出（api.js 未封装，见下方说明）
 *   HUB.api.POST('/wb/logs/clear')         清空（同上，二次确认）
 *
 * 注：/logs/export 与 /logs/clear 在 docs/api-inventory.md 里归属 wb-logs，
 * 但 js/core/api.js 只封装了 wb.logs，本模块不能改共享文件，故经 HUB.api
 * 的低层 GET/POST 调用（仍走统一的 req()，带同样的错误归一）。
 * 同理，/logs 的 level/tag/search 查询参数没被 wb.logs 暴露，级别与搜索
 * 在本页做前端过滤（窗口 = 最近 300 条 + 全部增量，上限 1500 条）。
 * ───────────────────────────────────────────────────────────── */
(function(){
'use strict';

const POLL_MS = 3000;      /* 增量轮询间隔 */
const INIT_LIMIT = 300;    /* 首次快照条数 */
const PULL_LIMIT = 400;    /* 增量请求条数（since_id>0 时后端忽略 limit，仅作语义标注） */
const BUF_CAP = 1500;      /* 内存缓冲上限，超出丢最旧 */
const VIEW_CAP = 800;      /* 单次渲染行数上限 */
const ACT_LIMIT = 200;     /* 活动历史拉取条数 */

const LEVELS = [
  {v:'',      t:'全部'},
  {v:'INFO',  t:'INFO'},
  {v:'WARN',  t:'WARN'},
  {v:'ERROR', t:'ERROR'}
];
const RANGES = [
  ['today','今日'], ['1d','近 24 小时'], ['7d','近 7 天'],
  ['30d','近 30 天'], ['90d','近 90 天'], ['all','全部']
];
const TASK_LABEL = {checkin:'签到', daily_chat:'打卡'};
const TRIGGER_LABEL = {
  scheduler:'调度器', manual:'手动', account_add:'新增账号',
  account_import:'导入', unknown:'未知'
};

const CSS = `
.wb-logs .spacer{flex:1}
.wb-logs .pillrow{display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap;margin-bottom:var(--sp-3)}
.wb-logs .logpanel{border:1px solid var(--card-border);border-radius:var(--card-radius);background:var(--card-bg);overflow:hidden;margin-bottom:var(--sp-4)}
.wb-logs .logbody{height:420px;overflow:auto;background:var(--bg);font-family:var(--font-mono);font-size:11.5px;line-height:1.6;padding:var(--sp-2) 0}
.wb-logs .logline{display:flex;gap:var(--sp-2);padding:0 var(--sp-3)}
.wb-logs .logline:hover{background:var(--surface-2)}
.wb-logs .logline .t{color:var(--ink-4);flex:none}
.wb-logs .logline .lv{flex:none;min-width:46px;height:16px;line-height:16px;margin-top:1px;text-align:center;border-radius:var(--radius-s);font-size:10px}
.wb-logs .logline .lv.INFO{color:var(--info);background:var(--info-soft)}
.wb-logs .logline .lv.WARN{color:var(--accent);background:var(--accent-soft)}
.wb-logs .logline .lv.ERROR{color:var(--danger);background:var(--danger-soft)}
.wb-logs .logline .lv.DEBUG{color:var(--violet);background:var(--surface-2)}
.wb-logs .logline .tag{color:var(--ink-4);flex:none;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wb-logs .logline .m{color:var(--ink-2);min-width:0;white-space:pre-wrap;word-break:break-all}
.wb-logs .logempty{color:var(--ink-4);text-align:center;padding:var(--sp-6)}
.wb-logs .logfoot{display:flex;gap:var(--sp-4);align-items:center;flex-wrap:wrap;padding:6px var(--sp-3);border-top:1px solid var(--line);background:var(--surface);color:var(--ink-4);font-size:11px;font-family:var(--font-mono)}
.wb-logs .logfoot b{color:var(--ink-2);font-weight:500}
.wb-logs .logfoot .err{color:var(--danger);margin-left:auto}
.wb-logs .tablewrap{overflow:auto}
`;

let S = null;              /* 当前挂载的页面状态 */
let els = {};              /* 当前挂载的 DOM 引用 */
let tagSig = '';           /* 标签下拉的签名，避免每次轮询重建 */
let logQTimer = null;
let actQTimer = null;

/* ── 小工具 ─────────────────────────────────────────────── */
function clipMsg(e){
  const m = String((e && e.message) || e || '未知错误');
  return m.length > 140 ? m.slice(0, 140) + '…' : m;
}
function clip(s, n){
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function bytes(n){
  n = Number(n) || 0;
  if(n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if(n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}
function stamp(){
  const d = new Date();
  const p = function(n){ return (n < 10 ? '0' : '') + n; };
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
/* 活动历史的时间戳是带偏移的 ISO 串，不是 epoch：先转 epoch 再交给 U.ts 统一格式化 */
function fmtTs(v){
  if(!v) return '—';
  const d = new Date(v);
  if(!isNaN(d.getTime())) return HUB.ui.ts(Math.floor(d.getTime() / 1000));
  return String(v).slice(0, 19).replace('T', ' ');
}
function isOk(r){
  return !!r && (r.ok === true || r.ok === 'true' || r.ok === 1);
}

/* ── 日志过滤 ───────────────────────────────────────────── */
function matchLevel(level){
  if(!S.level) return true;
  const n = String(level || 'INFO').toUpperCase();
  if(S.level === 'WARN') return n.indexOf('WARN') === 0;   /* 兼容 WARNING */
  if(S.level === 'INFO') return n === 'INFO';
  return n.indexOf(S.level) === 0;
}
function matchLog(it){
  if(!matchLevel(it.level)) return false;
  if(S.tag && String(it.tag || '') !== S.tag) return false;
  if(S.q){
    const n = S.q.toLowerCase();
    const hay = (String(it.msg || '') + ' ' + String(it.tag || '') + ' ' + String(it.level || '')).toLowerCase();
    if(hay.indexOf(n) < 0) return false;
  }
  return true;
}
function lineInner(it){
  const U = HUB.ui;
  const lv = String(it.level || 'INFO').toUpperCase();
  const cls = lv.indexOf('ERROR') === 0 ? 'ERROR'
    : lv.indexOf('WARN') === 0 ? 'WARN'
    : (lv.indexOf('DEBUG') === 0 || lv.indexOf('TRACE') === 0) ? 'DEBUG'
    : 'INFO';
  const t = it.time || String(it.ts || '').slice(11, 19) || '—';
  return '<span class="t" title="' + U.esc(it.ts || '') + '">' + U.esc(t) + '</span>'
    + '<span class="lv ' + cls + '">' + U.esc(lv) + '</span>'
    + '<span class="tag">' + U.esc(it.tag || '—') + '</span>'
    + '<span class="m">' + U.esc(it.msg || '') + '</span>';
}

/* ── 状态 ───────────────────────────────────────────────── */
function newState(seq, ctx){
  return {
    seq: seq, ctx: ctx,
    logs: [], seen: {}, maxId: 0,
    level: '', tag: '', q: '',
    mode: '', stored: 0, dbBytes: 0,
    paused: false, follow: true,
    logLoading: true, logErr: '', lastAt: 0, toastErr: '',
    ticks: 0,
    act: {
      range: '7d', limit: ACT_LIMIT,
      rows: [], total: 0,
      task: '', result: '', q: '',
      busy: false, err: '', reqId: 0
    }
  };
}

/* ── 视图骨架 ───────────────────────────────────────────── */
function shell(){
  const lv = LEVELS.map(function(o){
    return '<button class="btn mini" data-act="level" data-level="' + o.v + '">' + o.t + '</button>';
  }).join('');
  const ranges = RANGES.map(function(o){
    return '<option value="' + o[0] + '"' + (o[0] === '7d' ? ' selected' : '') + '>' + o[1] + '</option>';
  }).join('');
  return '<style>' + CSS + '</style>'
    + '<h1>日志</h1>'
    + '<p class="sub">网关运行日志实时流（since_id 增量拉取）· 账号每日签到 / 打卡历史</p>'
    + '<div class="toolbar">'
    +   '<label>级别</label>' + lv
    +   '<input id="logQ" data-q="log" placeholder="搜索消息 / 标签" autocomplete="off" style="width:200px">'
    +   '<select id="logTag" data-sel="tag"><option value="">全部标签</option></select>'
    +   '<button class="btn" id="logPause" data-act="pause">暂停</button>'
    +   '<button class="btn" id="logFollow" data-act="follow">跟随最新：开</button>'
    +   '<span class="spacer"></span>'
    +   '<button class="btn" data-act="export">导出日志</button>'
    +   '<button class="btn danger" data-act="clear">清空</button>'
    + '</div>'
    + '<div class="pillrow" id="logMeta"></div>'
    + '<div class="logpanel">'
    +   '<div class="logbody" id="logbody"></div>'
    +   '<div class="logfoot" id="logfoot"></div>'
    + '</div>'
    + '<h2>活动历史 <span class="pill mute">签到 / 打卡</span></h2>'
    + '<div class="toolbar">'
    +   '<label>时间范围</label><select data-sel="act-range">' + ranges + '</select>'
    +   '<label>任务</label><select data-sel="act-task">'
    +     '<option value="">全部</option>'
    +     '<option value="checkin">签到</option>'
    +     '<option value="daily_chat">打卡</option>'
    +   '</select>'
    +   '<label>结果</label><select data-sel="act-result">'
    +     '<option value="">全部</option>'
    +     '<option value="ok">成功</option>'
    +     '<option value="failed">失败</option>'
    +   '</select>'
    +   '<input data-q="act" placeholder="筛选昵称 / uid / 说明" autocomplete="off" style="width:200px">'
    +   '<button class="btn" data-act="act-reload">刷新</button>'
    +   '<span class="spacer"></span>'
    +   '<span class="pill mute">/activity/history</span>'
    + '</div>'
    + '<div class="pillrow" id="actStats"></div>'
    + '<div id="actTable"></div>';
}

function bind(el, ctx){
  el.className = 'wb-logs';
  els = {
    root: el,
    body: el.querySelector('#logbody'),
    foot: el.querySelector('#logfoot'),
    meta: el.querySelector('#logMeta'),
    pause: el.querySelector('#logPause'),
    follow: el.querySelector('#logFollow'),
    tag: el.querySelector('#logTag'),
    logQ: el.querySelector('#logQ'),
    actStats: el.querySelector('#actStats'),
    actTable: el.querySelector('#actTable'),
    actQ: el.querySelector('[data-q="act"]'),
    actRange: el.querySelector('[data-sel="act-range"]'),
    actTask: el.querySelector('[data-sel="act-task"]'),
    actResult: el.querySelector('[data-sel="act-result"]')
  };
  tagSig = '';
  clearTimeout(logQTimer);
  clearTimeout(actQTimer);

  if(!el.getAttribute('data-bound')){
    el.setAttribute('data-bound', '1');
    el.addEventListener('click', function(ev){ onAction(ev, ctx); });
    el.addEventListener('change', function(ev){ onChange(ev, ctx); });
    el.addEventListener('input', function(ev){ onInput(ev, ctx); });
    if(els.body){
      els.body.addEventListener('scroll', function(){
        if(!els.body || !S) return;
        const at = els.body.scrollHeight - els.body.scrollTop - els.body.clientHeight < 24;
        if(at !== S.follow){ S.follow = at; syncFollow(); }
      });
    }
  }
  markLevels();
  syncPause();
  syncFollow();
}

/* ── 按钮 / 输入状态 ────────────────────────────────────── */
function markLevels(){
  if(!els.root) return;
  const btns = els.root.querySelectorAll('[data-act="level"]');
  for(let i = 0; i < btns.length; i++){
    btns[i].classList.toggle('pri', btns[i].getAttribute('data-level') === (S.level || ''));
  }
}
function syncPause(){
  if(!els.pause) return;
  els.pause.textContent = S.paused ? '继续实时' : '暂停';
  els.pause.classList.toggle('pri', !!S.paused);
}
function syncFollow(){
  if(!els.follow) return;
  els.follow.textContent = '跟随最新：' + (S.follow ? '开' : '关');
}

/* ── 元信息 / 页脚 ──────────────────────────────────────── */
function updateMeta(){
  if(!S || S.ctx.stale()) return;
  if(!els.meta) return;
  const U = HUB.ui;
  const mode = S.mode === 'db' ? '落库' : (S.mode ? '内存' : '—');
  let html = '<span class="pill ' + (S.mode === 'db' ? 'info' : 'mute') + '">存储 '
    + '<span class="mono">' + U.esc(mode) + '</span> 模式</span>';
  if(S.mode === 'db'){
    html += '<span class="pill mute">库 <span class="mono">' + U.num(S.stored) + '</span> 行 · '
      + '<span class="mono">' + U.esc(bytes(S.dbBytes)) + '</span></span>';
  }
  html += '<span class="pill ' + (S.paused ? 'warn' : 'ok') + '">'
    + (S.paused ? '已暂停 · 停止拉取' : '实时 · 每 ' + (POLL_MS / 1000) + 's') + '</span>';
  html += '<span class="pill mute">max_id <span class="mono">' + U.esc(String(S.maxId || 0)) + '</span></span>';
  html += '<span class="pill mute">缓冲 <span class="mono">' + U.num(S.logs.length) + '</span> 条</span>';
  els.meta.innerHTML = html;
}
function updateFoot(){
  if(!S || S.ctx.stale()) return;
  if(!els.foot) return;
  const U = HUB.ui;
  const shown = S.logs.filter(matchLog).length;
  const last = S.lastAt ? new Date(S.lastAt).toLocaleTimeString('zh-CN', {hour12: false}) : '—';
  els.foot.innerHTML = '<span>显示 <b class="mono">' + U.num(shown) + '</b> / 缓冲 <b class="mono">'
    + U.num(S.logs.length) + '</b></span>'
    + '<span>最近更新 <b class="mono">' + U.esc(last) + '</b></span>'
    + '<span>级别 / 标签 / 搜索为前端过滤</span>'
    + (S.logErr ? '<span class="err">' + U.esc(S.logErr) + '</span>' : '');
}

/* ── 日志渲染 ───────────────────────────────────────────── */
function hasTag(tag){
  for(let i = 0; i < S.logs.length; i++){
    if(String(S.logs[i].tag || '') === tag) return true;
  }
  return false;
}
function renderTagOptions(){
  if(!S || S.ctx.stale()) return;
  if(!els.tag) return;
  const set = {};
  for(let i = 0; i < S.logs.length; i++){
    const t = S.logs[i].tag;
    if(t) set[t] = 1;
  }
  const tags = Object.keys(set).sort();
  const sig = tags.join('|');
  if(sig === tagSig) return;
  tagSig = sig;
  els.tag.innerHTML = '<option value="">全部标签</option>' + tags.map(function(t){
    return '<option value="' + HUB.ui.esc(t) + '">' + HUB.ui.esc(t) + '</option>';
  }).join('');
  els.tag.value = tags.indexOf(S.tag) >= 0 ? S.tag : '';
}
function paintLogs(){
  if(!S || S.ctx.stale()) return;
  if(!els.body) return;
  const U = HUB.ui;
  if(S.tag && !hasTag(S.tag)) S.tag = '';   /* 标签已随缓冲裁剪 / 清空消失 */
  const list = S.logs.filter(matchLog).slice(-VIEW_CAP);
  if(!list.length){
    const msg = S.logErr ? ('拉取失败：' + S.logErr)
      : S.logLoading ? '拉取中…' : '暂无匹配日志';
    els.body.innerHTML = '<div class="logempty">' + U.esc(msg) + '</div>';
  }else{
    els.body.innerHTML = list.map(function(it){
      return '<div class="logline">' + lineInner(it) + '</div>';
    }).join('');
  }
  if(S.follow) els.body.scrollTop = els.body.scrollHeight;
  renderTagOptions();
  updateFoot();
  updateMeta();
}
function appendLogs(items){
  if(!S || S.ctx.stale()) return;
  if(!els.body || !items.length) return;
  const box = els.body;
  if(box.querySelector('.logempty')) box.innerHTML = '';
  const frag = document.createDocumentFragment();
  for(let i = 0; i < items.length; i++){
    const d = document.createElement('div');
    d.className = 'logline';
    d.innerHTML = lineInner(items[i]);
    frag.appendChild(d);
  }
  box.appendChild(frag);
  while(box.children.length > VIEW_CAP && box.firstChild){
    box.removeChild(box.firstChild);
  }
  if(S.follow) box.scrollTop = box.scrollHeight;
  renderTagOptions();
  updateFoot();
}

/* ── 日志数据 ───────────────────────────────────────────── */
function merge(list){
  if(list.length > BUF_CAP) list = list.slice(-BUF_CAP);
  const fresh = [];
  for(let i = 0; i < list.length; i++){
    const it = list[i] || {};
    const id = Number(it.id) || 0;
    if(id && S.seen[id]) continue;
    if(id) S.seen[id] = 1;
    S.logs.push(it);
    fresh.push(it);
    if(id > S.maxId) S.maxId = id;
  }
  if(S.logs.length > BUF_CAP){
    const drop = S.logs.splice(0, S.logs.length - BUF_CAP);
    for(let i = 0; i < drop.length; i++){
      const did = Number(drop[i].id) || 0;
      if(did) delete S.seen[did];
    }
  }
  return fresh;
}
function applyMeta(d){
  if(!d) return;
  if(typeof d.mode === 'string' && d.mode) S.mode = d.mode;
  if(typeof d.stored === 'number') S.stored = d.stored;
  if(typeof d.db_bytes === 'number') S.dbBytes = d.db_bytes;
  S.lastAt = Date.now();
}
async function pullLogs(reset, ctx){
  if(reset) S.logLoading = true;
  const since = reset ? 0 : (S.maxId || 0);
  let d;
  try{
    d = await HUB.api.wb.logs(reset ? INIT_LIMIT : PULL_LIMIT, since > 0 ? since : undefined);
  }catch(e){
    if(ctx.stale()) return {ok: false, stale: true};
    S.logLoading = false;
    S.logErr = clipMsg(e);
    if(reset) paintLogs(); else { updateFoot(); updateMeta(); }
    return {ok: false, error: S.logErr};
  }
  if(ctx.stale()) return {ok: false, stale: true};
  S.logLoading = false;
  S.logErr = '';
  applyMeta(d);
  const fresh = merge(Array.isArray(d && d.logs) ? d.logs : []);
  if(reset) paintLogs();
  else if(fresh.length) appendLogs(fresh);
  else { updateFoot(); updateMeta(); }
  return {ok: true, added: fresh.length};
}

/* ── 活动历史 ───────────────────────────────────────────── */
function actMatch(r){
  const a = S.act;
  if(a.task && r.task !== a.task) return false;
  if(a.result === 'ok' && !isOk(r)) return false;
  if(a.result === 'failed' && isOk(r)) return false;
  if(a.q){
    const n = a.q.toLowerCase();
    const hay = (String(r.nickname || '') + ' ' + String(r.uid || '') + ' '
      + String(r.message || '') + ' ' + String(TASK_LABEL[r.task] || '')).toLowerCase();
    if(hay.indexOf(n) < 0) return false;
  }
  return true;
}
function actRow(r){
  const U = HUB.ui;
  const uid = String(r.uid || '');
  const name = r.nickname ? U.esc(r.nickname) : '<span class="dim">未命名</span>';
  const realm = r.realm === 'cn' ? U.pill('国内', 'warn')
    : r.realm === 'intl' ? U.pill('国际', 'info') : '—';
  return [
    '<span class="mono">' + U.esc(fmtTs(r.ts)) + '</span>',
    '<b>' + name + '</b><div class="dim mono">' + U.esc(uid ? uid.slice(0, 8) : '—') + '</div>',
    realm,
    r.task ? U.pill(TASK_LABEL[r.task] || r.task, r.task === 'checkin' ? 'info' : 'mute') : '—',
    U.esc(TRIGGER_LABEL[r.trigger] || r.trigger || '—'),
    isOk(r) ? U.pill('成功', 'ok') : U.pill('失败', 'bad'),
    '<span class="dim" title="' + U.esc(r.message || '') + '">' + U.esc(clip(r.message, 90)) + '</span>'
  ];
}
function paintActivity(){
  if(!S || S.ctx.stale()) return;
  if(!els.actTable) return;
  const U = HUB.ui;
  const a = S.act;
  const shown = a.rows.filter(actMatch);
  let okN = 0;
  let ck = 0;
  let dc = 0;
  for(let i = 0; i < shown.length; i++){
    if(isOk(shown[i])) okN++;
    if(shown[i].task === 'checkin') ck++;
    else if(shown[i].task === 'daily_chat') dc++;
  }
  const failN = shown.length - okN;

  els.actStats.innerHTML =
    '<span class="pill mute">显示 <span class="mono">' + U.num(shown.length)
      + '</span> / 共 <span class="mono">' + U.num(a.total) + '</span></span>'
    + '<span class="pill ok">成功 <span class="mono">' + U.num(okN) + '</span></span>'
    + '<span class="pill bad">失败 <span class="mono">' + U.num(failN) + '</span></span>'
    + '<span class="pill info">签到 <span class="mono">' + U.num(ck) + '</span></span>'
    + '<span class="pill mute">打卡 <span class="mono">' + U.num(dc) + '</span></span>'
    + (a.busy ? '<span class="pill warn">刷新中…</span>' : '')
    + (a.err ? '<span class="pill bad">' + U.esc(a.err) + '</span>' : '');

  if(a.busy && !a.rows.length){
    els.actTable.innerHTML = U.loadHtml('拉取活动历史…');
    return;
  }
  if(a.err && !a.rows.length){
    els.actTable.innerHTML = '<div class="empty">' + U.esc(a.err)
      + '<br><button class="btn mini" data-act="act-reload" style="margin-top:var(--sp-2)">重试</button></div>';
    return;
  }
  els.actTable.innerHTML = '<div class="tablewrap">' + U.table(
    ['时间', '账号', '区域', '任务', '来源', '结果', '说明'],
    shown.map(actRow),
    {empty: '该区间暂无签到 / 打卡记录'}
  ) + '</div>';
}
async function loadActivity(ctx){
  const a = S.act;
  a.busy = true;
  a.reqId++;
  const rid = a.reqId;
  paintActivity();
  let d;
  try{
    d = await HUB.api.wb.activityHistory(a.range, a.limit);
  }catch(e){
    if(ctx.stale() || !S || rid !== S.act.reqId) return;
    S.act.busy = false;
    S.act.err = clipMsg(e);
    paintActivity();
    HUB.ui.toast('活动历史拉取失败：' + S.act.err, 'bad');
    return;
  }
  if(ctx.stale() || !S || rid !== S.act.reqId) return;
  S.act.busy = false;
  S.act.err = '';
  S.act.rows = Array.isArray(d && d.rows) ? d.rows : [];
  const total = Number(d && d.total);
  S.act.total = isNaN(total) ? S.act.rows.length : total;
  paintActivity();
}

/* ── 导出 / 清空 ────────────────────────────────────────── */
async function exportLogs(){
  const U = HUB.ui;
  try{
    const text = await HUB.api.GET('/wb/logs/export');
    const body = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
    const blob = new Blob([body], {type: 'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wb-proxy-' + stamp() + '.log';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function(){ try{ URL.revokeObjectURL(url); }catch(e){} }, 5000);
    U.toast('已导出最近 5000 行（出口已脱敏）', 'ok');
  }catch(e){
    U.toast('导出失败：' + clipMsg(e), 'bad');
  }
}
function askClear(){
  const U = HUB.ui;
  U.openModal({
    title: '清空运行日志',
    body: '<p class="sub" style="margin:0 0 var(--sp-2)">将清空内存缓冲与日志库中的全部历史，无法恢复。</p>'
      + '<p class="sub" style="margin:0">日志 id 继续单调递增，增量轮询（since_id）不受影响；清空后新产生的日志会继续出现在这里。</p>',
    actions: [
      {label: '取消'},
      {label: '确认清空', kind: 'danger', onClick: async function(){
        try{
          await HUB.api.POST('/wb/logs/clear', {});
          S.logs = [];
          S.seen = {};
          S.logErr = '';
          S.logLoading = false;
          paintLogs();
          U.toast('日志已清空', 'ok');
        }catch(e){
          U.toast('清空失败：' + clipMsg(e), 'bad');
        }
      }}
    ]
  });
}

/* ── 轮询 ───────────────────────────────────────────────── */
async function tick(ctx){
  if(!S || ctx.stale() || S.paused) return;
  S.ticks++;
  const r = await pullLogs(false, ctx);
  if(ctx.stale()) return;
  if(r && r.ok){
    S.toastErr = '';
  }else if(r && r.error && r.error !== S.toastErr){
    S.toastErr = r.error;
    HUB.ui.toast('日志拉取失败：' + r.error, 'bad');
  }
  if(S.ticks % 20 === 0 && !S.act.busy){
    loadActivity(ctx);       /* 活动历史约每分钟跟一次，签到结果不会停留在旧值 */
  }
}

/* ── 事件 ───────────────────────────────────────────────── */
function onAction(ev, ctx){
  const t = ev.target;
  const b = t && t.closest ? t.closest('[data-act]') : null;
  if(!b) return;
  const act = b.getAttribute('data-act');
  if(act === 'level'){
    S.level = b.getAttribute('data-level') || '';
    markLevels();
    paintLogs();
  }else if(act === 'pause'){
    S.paused = !S.paused;
    syncPause();
    updateMeta();
    if(!S.paused) tick(ctx);
  }else if(act === 'follow'){
    S.follow = !S.follow;
    syncFollow();
    if(S.follow && els.body) els.body.scrollTop = els.body.scrollHeight;
  }else if(act === 'export'){
    exportLogs();
  }else if(act === 'clear'){
    askClear();
  }else if(act === 'act-reload'){
    loadActivity(ctx);
  }
}
function onChange(ev, ctx){
  const t = ev.target;
  if(!t || !t.getAttribute) return;
  const sel = t.getAttribute('data-sel');
  if(!sel || !S) return;
  if(sel === 'tag'){
    S.tag = t.value || '';
    paintLogs();
  }else if(sel === 'act-range'){
    S.act.range = t.value || '7d';
    loadActivity(ctx);
  }else if(sel === 'act-task'){
    S.act.task = t.value || '';
    paintActivity();
  }else if(sel === 'act-result'){
    S.act.result = t.value || '';
    paintActivity();
  }
}
function onInput(ev, ctx){
  const t = ev.target;
  if(!t || !t.getAttribute) return;
  const q = t.getAttribute('data-q');
  if(q === 'log'){
    clearTimeout(logQTimer);
    logQTimer = setTimeout(function(){
      if(!S || ctx.stale()) return;
      S.q = t.value || '';
      paintLogs();
    }, 180);
  }else if(q === 'act'){
    clearTimeout(actQTimer);
    actQTimer = setTimeout(function(){
      if(!S || ctx.stale()) return;
      S.act.q = t.value || '';
      paintActivity();
    }, 180);
  }
}

/* ── 注册 ───────────────────────────────────────────────── */
HUB.register({
  route: 'wb-logs', group: 'wb', title: '日志', order: 65,
  async render(el, ctx){
    if(!S || S.seq !== ctx.seq){
      S = newState(ctx.seq, ctx);
      if(ctx.stale()) return;
      el.innerHTML = shell();
      bind(el, ctx);
      paintLogs();
      paintActivity();
      updateMeta();
      await Promise.all([pullLogs(true, ctx), loadActivity(ctx)]);
      if(ctx.stale()) return;
      ctx.poll(function(){ tick(ctx); }, POLL_MS);
      return;
    }
    /* 同一挂载点二次渲染（防御性）：只刷新数据，不重建 DOM，避免丢焦点 */
    await Promise.all([pullLogs(true, ctx), loadActivity(ctx)]);
    if(ctx.stale()) return;
    ctx.poll(function(){ tick(ctx); }, POLL_MS);
  }
});
})();
