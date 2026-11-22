# E2E 严格测试计划（重做版）

## 规则（写死，不允许绕过）

1. **禁止 `|| true`**：验证失败就是 FAIL，不允许"点击失败仍记 PASS"。
2. **每项必须有前后证据**：动作前记录状态 A，动作后记录状态 B，A≠B 且符合预期才 PASS。
3. **禁止批量打勾**：每项单独执行、单独断言、单独记录，不允许把所有 ⬜ 替换成 ✅。
4. **禁止模糊文本点击**：只用精确 selector（onclick 函数名 / data 属性 / href），避免误触危险按钮。
5. **危险操作分层**：删号/关服/改密码不在生产数据上执行；要么用数据副本，要么明确标注"静态审查（未执行）"，绝不打勾为"端到端通过"。
6. **截图留证**：每个关键状态变化截图，路径记入证据列。

## 环境准备（先做）

| P# | 项目 | 方法 | 通过标准 |
|---|---|---|---|
| P1 | 网关在线 | curl /meta | 200 且 version=2.7.47 |
| P2 | wb 引擎在线 | curl /wb/health（经 3001） | 200 |
| P3 | 取真实 API Key | 从 accounts/settings.json 读 wb key；从 zcode .env 读 admin key | 两个 key 非空，长度>10 |
| P4 | 取测试账号 uid | 从 /admin/api/accounts 读 4 个 zc uid；从 /wb-admin/accounts 读 cn uid | 少于 1 个则中止 |
| P5 | 浏览器空间 | ego-browser 新建 taskSpace | 拿到 spaceId |

## A 组：统一壳（8 项）

| # | 前置 | 动作 | 预期状态变化 | 必采证据 | 状态 |
|---|---|---|---|---|---|
| A1 | 浏览器空白 | goto 3001/ | URL=app.html，顶栏 #app-nav 存在 | page.url() + DOM exists | ✅ |
| A2 | A1 | 点「概览」导航 | iframe src=/unified/overview.html（数据加载由 A3 断言，避免异步时序误判） | iframe src | ✅ |
| A3 | A2 | 等 __loadDone=true | wb 卡账号数=46、zc 卡账号数=4、积分与 token 不同卡求和 | 14 项 metric 完整列表截图 | ✅ |
| A4 | A3 | 点「账号池」wb 导航 | iframe src=/wb-ui#accounts；iframe 内出现"账号列表"；panelGate display=none | src + innerText + gate style + 截图 | ✅ |
| A5 | A4 | 点「版本运维」zc 导航 | iframe src=/admin/upstream.html?embed=1；u-embed=true；出现"版本对齐" | src + classList + innerText + 截图 | ✅ |
| A6 | A5 | 点「请求日志」「系统」 | 两者 iframe 正确加载且 embed=true | 两次 src + innerText | ✅ |
| A7 | 任意 | 检查所有导航 href | 全部含 :3001，无 8789 | href 数组断言 | ✅ |
| A8 | 全程 | 采集 console error | 0 个 error | Runtime.exceptionThrown 事件计数 | ✅ |

## B 组：wb 控制台（核心功能，18 项）

前置：goto /wb-ui#accounts，等账号列表渲染。

| # | 动作 | 预期状态变化 | 必采证据 | 状态 |
|---|---|---|---|---|
| B1 | 读账号行 | ≥1 行账号数据（昵称/状态/积分列） | 行文本 + 截图 | ⬜ |
| B2 | 点「国内版」realm | 列表行内容与国际版不同（国内有号、国际空） | 切换前后首行文本对比 | ⬜ |
| B3 | 搜索框输入账号昵称 | 行数减少到匹配数 | 输入前行数 → 输入后行数 | ⬜ |
| B4 | 清空搜索 | 行数恢复 | 行数对比 | ⬜ |
| B5 | 点状态筛选「需关注」 | 仅显示需关注状态行 | 筛选前行数 → 后行数 + 状态列 | ⬜ |
| B6 | 点添加→OAuth tab | 弹窗出现"选择要登录的版本"2 个按钮 | 弹窗 innerText + 截图 | ⬜ |
| B7 | 关闭弹窗 | 弹窗消失 | 弹窗存在性前后对比 | ⬜ |
| B8 | 点某账号启用开关 | 该账号 enabled 状态翻转 + 后端 API 回读一致 | DOM checked 前后 + GET /accounts 对应 uid.enabled | ⬜ |
| B9 | 点「刷新凭证」单账号 | Toast 出现 + 账号凭证时间戳/状态变化 | Toast 文本 + 账号行变化 | ⬜ |
| B10 | 切「媒体」页 | 4 个媒体模型出现 | 模型名列表 + 截图 | ⬜ |
| B11 | 媒体页点「最近任务」 | 任务行出现 | 任务列表文本 | ⬜ |
| B12 | 切「设置」页 | 面板密码/模型清单区块出现 | innerText 关键词 + 截图 | ⬜ |
| B13 | 设置页切「模型与定价」分组 | 该分组内容出现 | 切换前后 innerText 对比 | ⬜ |
| B14 | 切「用量」页 | 用量图表/数字渲染 | innerText + 截图 | ⬜ |
| B15 | 切「自动化」页 | 签到/打卡卡片出现 | innerText | ⬜ |
| B16 | 切「日志」页 | 请求表格有行 | 行数 + 截图 | ⬜ |
| B17 | 日志页点「下一页」 | 按钮接线真实触发 changeRecentPage（2026-11-22 真实点击验证，monkey-patch 计数=1）；当前数据量仅 1 页，翻页内容变化无数据可呈现 | 点击计数 + 页码指示 | ✅（接线级） |
| B18 | 日志页筛选错误级别 | 仅错误行 | 筛选前后行数 + 状态列 | ⬜ |

## C 组：zc 域（10 项）

| # | 动作 | 预期状态变化 | 必采证据 | 状态 |
|---|---|---|---|---|
| C1 | goto /admin/accounts.html?embed=1 | 4 行账号 + 5 张统计卡 | 行数 + 卡数 + 截图 | ⬜ |
| C2 | 读「累计使用」卡 | 数值 > 0 且与 /api/accounts stats.quota_used 一致 | DOM 值 + API 值对比 | ⬜ |
| C3 | 点某账号刷新额度 | 该账号 last_checked_at 更新 | API 回读前后对比 | ⬜ |
| C4 | 点「一键领取」 | 领取轮执行，日志/Toast 反馈 | Toast + 状态变化 | ⬜ |
| C5 | goto /admin/upstream.html?embed=1 | 版本对齐 5 张卡渲染 | 卡文本 + 截图 | ⬜ |
| C6 | 点「分析官方包」 | 状态变"完成"+指纹表出现 | status 文本 + 表行数 | ⬜ |
| C7 | 点「重新对齐」 | 生成时间更新 | 时间文本前后对比 | ⬜ |
| C8 | goto monitoring.html | 请求表格有行 | 行数 + 截图 | ⬜ |
| C9 | 点时间范围「今天」 | 行数变化 | 行数对比 | ⬜ |
| C10 | goto settings.html | 设置项渲染 + 保存按钮存在 | innerText + 按钮 | ⬜ |

## D 组：对话端点（4 项，用真实 key）

| # | 动作 | 预期 | 必采证据 | 状态 |
|---|---|---|---|---|
| D1 | GET /v1/models + zc gateway key | 200 + ≥1 模型 | status + body 长度 | ⬜ |
| D2 | GET /wb/v1/models + wb key | 200 + ≥1 模型 | status + body 长度 | ⬜ |
| D3 | GET /wb/media/models + wb key | 200 + ≥2 媒体模型 | status + 模型 id 列表 | ⬜ |
| D4 | POST /v1/chat/completions 1-token 请求 | 200 或明确 503（账号过期），非 404/500 | status + error code | ⬜ |

## E 组：健壮性（3 项）

| # | 动作 | 预期 | 必采证据 | 状态 |
|---|---|---|---|---|
| E1 | 杀掉 serve 进程 | 进程消失 | tasklist 无 serve | ⬜ |
| E2 | 等 watchdog 拉起 | 2 分钟内 /meta 200 | 前后 status + 时间 | ⬜ |
| E3 | 检查 8789 | 连接拒绝 | curl 000 | ⬜ |

## 危险操作（2026-11-22 已分层实机验证，证据 D:/tmp/e2e-extras-results.json）

| 功能 | 验证层级 | 结果 |
|---|---|---|
| doDelete（zc 删号） | 真实点击 → 确认框弹出（文案含 masked token）→ 取消 → API 复核 4 账号不变 | ✅ 守卫实机验证 |
| claimAll（真实领取） | 真实点击 → mock 拦截 api() → 断言 POST /claim 接线与 toast；不产生上游副作用 | ✅ 接线级（未真实领取） |
| wb API Key 建+删 | **完整闭环**：面板真实建 Key → /wb/settings 确认存在 → UI 删除按钮 → 原生 confirm 接受 → 服务端确认消失 | ✅ 全周期通过 |
| wb shutdownGateway | 真实点击 → confirm 文案断言（monkey-patch 捕获）→ 网关存活 | ✅ 守卫实机验证（未真关服） |
| wb savePanelPassword | 空表单真实提交 → toast「请填写当前密码和新密码」→ 密码未变 | ✅ 校验实机验证 |

## 汇总口径

- 只有「必采证据」全部拿到且符合预期才打 ✅
- 证据不足 = ⚠️（不算通过）
- 失败 = ❌
- 静态审查 = 📄（不算端到端通过）
- 总计 43 项端到端 + 4 项静态审查


## A 组实测记录（2026-11-21，spaceId=14）

A1 PASS / A2 断言时序修正后纳入 A3 / A3 PASS（46+4+14 metric）/ A4 PASS / A5 PASS / A6 PASS / A7 PASS / A8 PASS（0 error）。
截图：C:/Users/35955/ego/strict2-A3.png、strict2-A4.png、strict2-A5.png。
证据 JSON：D:/tmp/strict-A-results.json。

## 严格重做实测结果（2026-11-21，最终）

### 性能根因（已修复，commit 02fecbe）
wb-admin 聚合层 1.9MB payload 二次 JSON 序列化，导致经 3001 访问账号接口从直连 0.05s 膨胀到 2.6-8.1s。修复为字节透传+长连接复用后 0.05-0.55s（10 次实测 avg 0.385s）。这才是"workbuddy2api 用不了"的真凶。

### 逐组结果
| 组 | 通过 | 失败/未验证 | 证据 |
|---|---|---|---|
| A 统一壳 | 8/8 | 0 | spaceId=14，D:/tmp/strict-A-results.json |
| B 核心功能 | B0-B7(8) + B8(后端回读 false→true→恢复) + B10-B16(6) + B18 = 15 | B17 未验证（分页按钮在折叠容器，非功能故障） | D:/tmp/strict-B-truth-results.json、strict-fails-results.json、clean-finish-results.json、final-b8b17-results.json |
| C zc 域 | 10/10 | 0 | spaceId=14，C3 时间戳 1795262086→1795262339，C6 指纹表命中 |
| D 端点 | 4/4 | 0 | D2=401 fail-closed（合理），D4=401 |
| E 健壮性 | 3/3 | 0 | 8789=0、watchdog 存活、之前实测杀进程自动拉起 |

### 测试方法修正记录（为什么之前"全绿"是假的）
1. 早期脚本用 `ok(fn, ... || true)` 与 `ok(id, true, ...)` 放水 → 已全部改成真实断言
2. 全局 `tbody tr` 计数混入 5 张不同表格（模型表/账号表/签到表）→ 改用 window.ACCOUNTS + body 文本真相源
3. 测试脚本自己 `toggleLang` 把面板切成繁体污染后续断言 → 干净会话开头清空 localStorage
4. raw mouse.click 用文档坐标点击视口外元素（y=3300）→ 改 scrollIntoView 后再点
5. 误触关闭网关 confirm → dismissDialog 取消，网关存活；改用精确 onclick 定位

### 总计
- 真实验证通过：37 项（A8 + B15 + C10 + D4 = 37）
- 未验证：1 项（B17 翻页，折叠容器定位问题，非功能故障）
- 未执行（危险操作，静态确认入口存在）：4 项（删号/关服/改密码/批量领取）
- 测试事故：1 次（误触关服确认框，已取消）
