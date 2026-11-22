# 后端 HTTP 端点清单（WB-Z-HUB 前端对接用）

> 生成方式：逐行通读下列两个后端源文件后手工整理，未抽样。
> - **wb 侧**：`D:/Desktop/workbuddy2api-hub-main/workbuddy2api-hub-main/wb_proxy.py`（29079 行）
>   —— `Handler.do_GET`（22658–22791）、`Handler.do_POST`（27758–28067）、
>   以及分段函数 `_handle_accounts`（26004–26071）、`_handle_codearts`（25925–26003）、
>   `_handle_proxy_slots`（25239–25323）、`_handle_media_post`（23897）、
>   `MEDIA_POST_PATHS`（329）、`_CHAT_PATHS`（1067）、`BODYLESS_PANEL_POSTS`（21851）。
> - **zc 侧**：`zcode2api/app/routes/admin_api.py`（844 行，`router = APIRouter(prefix="/admin/api")`）
>   与 `zcode2api/app/routes/gateway.py`（1825 行，`router = APIRouter()`）里的全部 `@router` 装饰器。
>
> **计数口径**：一条 = 一个「方法 + 处理分支」。分支带路径别名时在「路径」列用括号并列写出，
> 别名不另计行（别名合计 15 条，故字面「方法+路径」组合为 119 + 15 = 134 条）。
> - wb：**119** 条（GET 43 / POST 76）
> - zc：**33** 条（admin_api 28 / gateway 5）
> - 合计 **152** 条分支 / 167 条字面组合。

## 基路径与鉴权

| 侧 | 前端基路径 | 鉴权 |
|---|---|---|
| wb | `/wb`（zcode2api `wb_embed` 反代到内嵌 wb_proxy，默认内网 18790；独立部署时 wb_proxy 自身端口如 8789） | OpenAI 风格 `Authorization: Bearer <key>` 或 `?key=`；面板页用 `X-Panel-Token`（环回来源免 token）。`/agents/cli`、`/oauth/callback` 不过面板门；`/v1/videos/{id}/content` 用签名 `t`，不强制 Bearer。 |
| zc | `/admin/api`（管理面）、`/v1`（网关面） | `/admin/api/*` 全部挂 `Depends(verify_admin_key)`（Bearer admin key）；`/v1/*` 挂 `Depends(verify_gateway_key)`（gateway key）。 |

> `/wb` 之外的 wb 端点不存在别名前缀：下文 wb 表里的路径都相对于 wb 根，前端实际请求时加 `/wb` 前缀（例如 `/wb/accounts`）。

---

# 一、wb 侧（wb_proxy.py，119 条）

## 1. wb-accounts —— 账号池（23 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| GET | `/accounts` | `?realm=all/intl/cn` | `accounts[]` 账号视图、`storage` 目录、`usable`/`text_ready`/`media_ready` 计数 | wb-accounts |
| GET | `/accounts/export` | `?realm=`、`?uid=`（可重复/逗号）、`?secrets=0` 不含凭证、`?download=1` 附件 | 导出文档（默认昵称已脱敏、含凭证）；`download=1` 时是 `application/json` 附件；未知 uid → 404 | wb-accounts |
| GET | `/accounts/credits` | 无（全池刷积分，单飞+拟人间隔） | `accounts[]` + `busy`（已有一轮在跑时 `busy=true`，直接回当前快照） | wb-accounts |
| GET | `/accounts/credits/detail` | `?uid=`、`?refresh=1` | `ok`、`uid`、`nickname`、`realm`、`credits.packages[]`；无 uid 时取池内第一个号 | wb-accounts |
| GET | `/accounts/credits/grants` | 无（只读快照，不打上游） | 积分获取历史（积分包摊平表）+ 快照时刻 | wb-accounts |
| GET | `/accounts/login/poll` | `?state=` | `POOL.poll_login` 状态机：`pending/ready/expired/unknown/error` | wb-accounts |
| POST | `/accounts/credits`（`/accounts/credits/fetch`） | `uid` 或 `uids[]` 或 `realm`，可叠加 `group` | `results[]` 每号刷新结果、`accounts[]`、`busy`；多号刷新已有在跑 → `busy=true` | wb-accounts |
| POST | `/accounts/credits/detail` | `uid`、`refresh`（默认 true） | `ok`、`uid`、`nickname`、`realm`、`credits`；未找到号时 `ok=false`+`error` | wb-accounts |
| POST | `/accounts/checkin` | `uid`（缺省 = 全部国内版且开启任务的号） | `results[]`（每号 `ok/msg/error`）、`accounts[]` | wb-accounts |
| POST | `/accounts/daily-chat` | `uid` 或 `uids[]`（空数组 = 一个都不打） | `results[]`、`accounts[]` | wb-accounts |
| POST | `/accounts/daily-chat-web` | `uid`（缺省 = 全部国际版可任务号） | `results[]`、`accounts[]` | wb-accounts |
| POST | `/accounts/login/start` | `platform`（默认 CLI）、`realm`、`proxySlot`（`auto` 或槽 id） | `state`、`authUrl`（扫码/授权链接）、`realm`、`platform`、`proxySlot`、`proxy`（只回 host:port） | wb-accounts |
| POST | `/accounts/login/cancel` | `state` | `{cancelled: bool}` | wb-accounts |
| POST | `/accounts/import/desktop` | `{}` 只扫描；`path` 导入单个凭据；`all` 全导入；`realm`；`recoverKey`+`force`；`keyText`；`forgetKey` | 扫描：`detected[]`、`accounts[]`、`pool_uids[]`、`atrest`；导入：`imported[]`、`accounts[]`；密钥操作：`ok`、`keyId`、`atrest` | wb-accounts |
| POST | `/accounts/refresh` | `uid` 或 `uids[]`（空数组 = 不刷），可叠加 `group` | `results[{uid, ok, error}]` | wb-accounts |
| POST | `/accounts/sync-profile` | `uid` 或 `realm` | `updated[{uid,nickname}]`、`failed[{uid,error}]`、`accounts[]` | wb-accounts |
| POST | `/accounts/test` | 单号：`uid`、`model`；无 `uid` 时自动转「一键测试」：`realm`、`model`、`uids[]`、`group` | 单号：`ok/uid/model/elapsed_ms` + 成功 `reply` 或失败 `status/error/network`；批量：`summary`、`network`、`results[]`、`accounts[]` | wb-accounts |
| POST | `/accounts/set` | `uid` + 任一：`proxySlot`、`proxy`、`enabled`、`tasksEnabled`、`weight`(1–100)、`note`、`group`、`disabledModels[]`、`poolScope`(text/media) | `account` 更新后的完整视图；缺 uid → 400；无字段 → 400 | wb-accounts |
| POST | `/accounts/product` | `product`(workbuddy/vscode/cli)；目标：`uid` 或 `uids[]` 或 `realm` | `ok`、`product`、`changed[]`（uid 前 8 位）、`accounts[]` | wb-accounts |
| POST | `/accounts/set-all` | 三选一：`uids[]`+`enabled`；`group`+`enabled`；仅 `enabled`（全池）；另有 `uids[]`+`poolScope` | `changed`/`moved`、`uids[]`、`accounts[]` | wb-accounts |
| POST | `/accounts/delete` | `uid` | `deleted`(bool)、`accounts[]` | wb-accounts |
| POST | `/accounts/import` | `data`（对象或数组，也接受裸数组）；`dryRun`、`overwrite`、`realm`、`group` | `count`、`result{added,updated,skipped,invalid}`、`accounts[]`；`dryRun` 时回预览结果 | wb-accounts |
| POST | `/accounts/add-api-key` | `key`（或 `accessToken`，需 `ck_`/`pt_` 前缀）、`nickname`、`uid` | `ok`、`uid`、`updated`（是否覆盖）、`probe{used,limit}`、`account`；探测失败 → 400 且不落盘 | wb-accounts |

## 2. wb-usage —— 用量 / 积分统计（9 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| GET | `/usage`（`/v1/usage`） | `?realm=`、`?range=`、`?since=`、`?until=`，或头 `X-Realm` | 用量快照（总量、按模型/账号折叠、`accounts_map`、`account` 身份、`usd_cny`、`log_file`）+ ETag/304 | wb-usage |
| GET | `/usage/recent` | `?limit=1..1000`(默认100)、`?page=`、`?realm=`、`?account=`、`?model=`、`?key=`、`?outcome=` | 请求明细分页（面板「请求列表」） | wb-usage |
| GET | `/usage/analytics` | `?realm=`、`?range/since/until` | 分析聚合（缓存 + ETag/304） | wb-usage |
| GET | `/usage/by-account` | 无 | `{accounts: [...]}` + ETag/304 | wb-usage |
| GET | `/usage/remaining` | 无 | 余额/剩余额度视图；短 TTL(默认15s)+ETag，轮询多回 304 | wb-usage |
| GET | `/usage/perf` | `?sample=10..20000`(默认5000)、`?realm=`、`?range/since/until` | 性能分位（TTFT/总耗时等）+ ETag/304 | wb-usage |
| GET | `/usage/timeseries` | `?realm=`、`?range/since/until`、`?bucket=`（秒） | 时间序列桶 + ETag/304 | wb-usage |
| GET | `/v1/balance-summary` | `?realm=all/intl/cn` | 仅聚合本地缓存积分：总额、已知账号数、最近更新时间（**不发上游**） | wb-usage |
| GET | `/activity/history` | `?range=`、`?uid=`、`?task=`、`?result=`、`?limit=` | 每日活动结构化历史；筛选值非法 → 400 | wb-usage |

## 3. wb-media —— 图片 / 视频（8 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| GET | `/v1/media/tasks` | `?limit=`(默认50) | `tasks[]`（按 Key 归属过滤，面板会话可见全部）、`stats`（队列/并发） | wb-media |
| GET | `/v1/videos/{id}` | 路径参数 `id` | 任务对象：`id/object=video/status/model/created_at`，可选 `completed_at/seconds/resolution/credit/error/url`，`url` 为已签名下载地址；不可见 → 404 | wb-media |
| GET | `/v1/videos/{id}/content` | `?i=`（产物索引，默认0）、`?t=`（签名令牌）；也可用 API Key | `video/mp4` 附件下载（`Content-Disposition`）；令牌无效且无 Key → 401 | wb-media |
| GET | `/v1/media/models`（`/media/models`） | `?realm=`、`?tag=` | `realm`、`enabled`、`models[]`（原始媒体条目 + `creditPerImage`/`creditsPerSecond` 按分辨率明细/参考素材价） | wb-media |
| POST | `/v1/images/generations`（`/images/generations`） | `model`、`prompt`（必填非空）、`size`、`n`、`response_format`(url/b64_json) | OpenAI Images 形状 `{created, data:[{url 或 b64_json}]}` + 实际扣费 `credit`/提示；支持换号重试（最多3） | wb-media |
| POST | `/v1/images/edits`（`/images/edits`） | `model`、`prompt`、`image`（data URL 或公网 URL，可为数组）、`size`、`n` | 同上；请求体上限单独放宽到 24MB | wb-media |
| POST | `/v1/videos`（`/videos`） | `model`、`prompt`、`seconds`、`size/resolution`、`image`/`input_reference`、`reference_images[]`、`reference_videos[]`、`reference_audios[]`、`wait`（body 或 `?wait=1`） | 202 + 任务对象；并发满时先本地排队并附 `queue_position`/`hint`（未扣费）；`wait=1` 阻塞至完成或轮询超时 | wb-media |
| POST | `/v1/videos/{id}/cancel` | 路径参数 `id` | 任务对象；**仅 `queued` 可取消**，`running` → 409（上游无取消接口，已提交任务照常计费） | wb-media |

## 4. wb-models —— 模型目录 / 定价 / 网关 API 契约（11 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| GET | `/v1/models`（`/models`） | `?realm=` 或头 `X-Realm` | `{object:"list", data[]}` + `realm` + `catalog` 来源元信息；`realm=codearts` 时改走 CodeArts 目录；可被 Key 模型白名单与「仅列可用模型」裁剪，别名条目并列展示 | wb-models |
| GET | `/pricing` | 无 | 价估算状态：`enabled/running/policies/models/current/logs/gaps/gap_summary/timeline/overrides_file` 等；未运行时给零值骨架 | wb-models |
| POST | `/pricing/refresh` | `{}`（面板会话） | 后台线程取价，立即回 `status` + `ok` + `msg` | wb-models |
| POST | `/pricing/mapping` | `model`、`or_id`（空 = 删除该映射） | `ok/model/or_id/known/msg`；`or_id` 形状非法 → 400 | wb-models |
| POST | `/catalog/refresh` | `realm`(intl/cn) | `refresh_catalog` 结果（`ok/msg` 与条目信息）；同版本 30s 冷却，失败也回 200+ok 标志 | wb-models |
| POST | `/v1/chat/completions`（`/chat/completions`） | OpenAI chat body：`model`、`messages`、`stream`、`tools`、`reasoning_effort`、`max_tokens` 等 | OpenAI Chat 响应或 SSE；受 Key 模型白名单 / 日 token 限额 / 并发限额约束 | wb-models |
| POST | `/v1/completions`（`/completions`） | legacy 文本补全 body（同 chat 管线） | OpenAI 响应或 SSE（与 chat 共用调度/换号/记账） | wb-models |
| POST | `/v1/responses`（`/responses`） | `model`、`input`、`stream`、`tools`、`tool_choice`、`parallel_tool_calls`；**不支持 `previous_response_id`**（非 compact 时 400） | Responses 对象或 SSE（内部转 chat） | wb-models |
| POST | `/v1/responses/compact`（`/responses/compact`） | compaction 请求（body 带摘要提示词，或 `compaction_trigger`） | Responses 形状（压缩语义） | wb-models |
| POST | `/v1/messages`（`/messages`） | Anthropic body：`model`、`messages`、`system`、`max_tokens`、`stream`、`tools` | Anthropic message 或 SSE；**默认关闭**，需设置页开启或 `WB_ENABLE_ANTHROPIC_MESSAGES=1`，否则 400 | wb-models |
| POST | `/v1/messages/count_tokens`（`/messages/count_tokens`） | `model` + Anthropic messages | `{input_tokens}`（本地估算，不占额度、不打上游） | wb-models |

## 5. wb-agents —— 客户端一键配置（7 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| GET | `/agents` | `?realm=intl/cn` | `enabled`、`realm`、`clients[]`、`models[]`、`selected_models[]`、`models_configured`、`model_embedding_clients[]`、`keys[]`、`global_key_set`、`auth_required`、`gateway.base_url` | wb-agents |
| GET | `/agents/available` | 无（廉价判定，不 import wb_agents） | `{enabled: bool}` | wb-agents |
| GET | `/agents/model-selection` | 无 | `configured`（是否保存过）、`selected_models[]` | wb-agents |
| GET | `/agents/cli` | 无（**面板门之前**放行，独立配置器） | 纯文本 Python 脚本（客户端机器本地配置用），非 JSON | wb-agents |
| POST | `/agents/model-selection` | `models[]`（空数组合法 = 全取消） | `ok`、`configured`、`selected_models[]` | wb-agents |
| POST | `/agents/apply` | `client`（或 `client_id`）、`base_url`（http/https）、`model`、`models[]`、`key_id`（`__global` 或 Key id）、`realm` | 写入的 `files[]` + `warnings[]`；远程看板（非网关本机）→ 403 | wb-agents |
| POST | `/agents/restore` | `client`（或 `client_id`） | `restored[]`；远程看板 → 403 | wb-agents |

## 6. wb-automation —— 任务福利 / 调度器（11 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| GET | `/tasks` | `?uid=`（缺省取第一个国内版任务号） | `tasks[]`、`summary`、`account`、`accounts[]`（含 `tasks_done/tasks_total/checkin_today`） | wb-automation |
| GET | `/tasks/progress` | `?uids=a,b,c`（最多 6 个/批，3 并发） | `items[{uid,done,total,updated_at,state:cached/fetched/error}]` | wb-automation |
| POST | `/tasks/run` | `uid`（`all` 或空 = 全部国内任务号）、`claim`（默认 true） | `ok`、`credit_added`、`logs[]`、`accounts_count` | wb-automation |
| POST | `/tasks/night` | `uid`（`all` 或空 = 全部） | `ok`、`results[{uid,nickname,ok,logs,earned_credit}]`、`msg`、`accounts_count` | wb-automation |
| POST | `/tasks/claim` | `uid`（必填、非 all）、`code`（任务代码） | `ok`、`msg`、`credit` | wb-automation |
| POST | `/tasks/travel` | `uid`（`all` 或空 = 全部） | `ok`、`results[{uid,nickname,action,msg,reward_credit}]`、`msg` | wb-automation |
| POST | `/tasks/streak-bonus` | `uid`（`all` 或空 = 全部） | `ok`、`msg`（逐号文案拼接） | wb-automation |
| GET | `/scheduler` | 无 | 调度器状态（`enabled` 等）；未初始化 → `{enabled:false,msg:"未运行"}` | wb-automation |
| POST | `/scheduler/trigger` | 无 | `trigger_now()` 结果；未初始化 → `ok:false` | wb-automation |
| POST | `/scheduler/toggle` | 无 | 切换后的 `status()` | wb-automation |
| POST | `/quota-scan/run` | 无（面板会话） | `ok`、`sent`（本次查询的配额线条数）、`msg` | wb-automation |

## 7. wb-logs —— 运行日志（3 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| GET | `/logs` | `?limit=`(默认200)、`?level=`、`?tag=`、`?search=`、`?since_id=` | `logs[]`、`mode`(memory/db)、db 模式下附 `stored`(行数)、`db_bytes` | wb-logs |
| GET | `/logs/export` | 无 | `text/plain` 附件，最近 5000 行，已脱敏 | wb-logs |
| POST | `/logs/clear` | 无 | `{ok: true}` | wb-logs |

## 8. wb-settings —— 网关设置 / 出口（7 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| GET | `/settings` | 无 | 运行时设置全量视图（`runtime_settings_view()`：Key 列表含掩码、限额、策略、身份、调度开关等） | wb-settings |
| POST | `/settings/save` | `api_keys[]`（含 `deleted_api_key_ids[]`）、`auth_disabled`、`limits{}`、`pricing_enabled`、`pricing_refresh_minutes/hours`、`credits_refresh_hours`、`section_max_height`、`schedule{}`、`ui_language`、`pricing_variant_inherit`、`enable_anthropic_messages`、`model_aliases`、`model_aliases_enabled`、`filter_models_by_key`、`reasoning_effort_map`、`models_only_available`、`identity`、`identity_versions`、`auto_switch_product(s)`、`daily_activity`、`daily_chat_web` 等 | 逐键回显已保存值（`api_keys_saved`、`limits`、`pricing_refresh_minutes` 等）；空 Key 值 = 保留原值 | wb-settings |
| GET | `/settings/reveal` | `?id=`（Key id，面板会话） | `{id, key}` 明文；非面板 → 401，未知 id → 404 | wb-settings |
| POST | `/settings/device-token/reload` | 无（面板会话） | `ok`、`device_token_status`；失败 → 500 | wb-settings |
| POST | `/settings/restriction/reset` | 无（面板会话） | `ok`、`message`、`restriction_holds:{}`（立即解除风控连坐暂停） | wb-settings |
| GET | `/realm` | 无 | `current`、`options[]`（当前出口与可选项） | wb-settings |
| POST | `/realm` | `realm`(intl/cn/codearts)（面板会话） | `ok`、`current`、`persisted:true`；codearts 未配置 → 400 | wb-settings |

## 9. wb-updates —— 版本更新 / 回滚（5 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| GET | `/updates` | 无（只读，不触发检查） | `current_version/latest_version/update_available/enabled/checking/last_attempt/last_success/last_error/release_url/latest_tag/published_at` + 安装请求状态 | wb-updates |
| GET | `/updates/backups` | 无 | `backups[]`（版本/大小/时间/完整性）、`current_version`、`keep_backups`、`keep_backups_max`、`rollback_enabled` | wb-updates |
| POST | `/updates/check` | 无（面板会话；body 已在分发前排空） | 本次检查状态（`manual=True`，忽略日开关与 24h 窗口） | wb-updates |
| POST | `/updates/install` | 无（面板会话；**不读 body，前端传 `tag` 会被忽略**） | 202 + 排队信息；无可用更新 / 未先检查 → 409 | wb-updates |
| POST | `/updates/rollback` | `version`（面板会话） | 202 + 排队信息；未知版本 / 备份不完整 / 已有任务在跑 → 409 | wb-updates |

## 10. wb-infra —— 出口 / 代理槽 / CodeArts（25 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| GET | `/proxy/slots` | 无（面板会话） | `slots[]`（出口槽：id/name/url 摘要/探测到的 ip/国家/ISP） | wb-infra |
| POST | `/proxy/slots` | `{}`（面板会话） | `slots[]`（同 GET） | wb-infra |
| POST | `/proxy/slots/save` | `slots[]`（整表覆盖，条目经 `_clean_slot_entry` 归一） | 保存后的 `slots[]`；被删除槽的账号/CodeArts 绑定自动解绑 | wb-infra |
| POST | `/proxy/slots/test` | `id`（槽 id） | 探测结果（`ok/exit_ip/country/country_code/ip_type/isp/asn/probed_at`）+ `id` + `slot`（已回写探测字段）；未知槽 → 404 | wb-infra |
| POST | `/proxy/discover` | 无 | `candidates[]`（本机可发现的代理出口候选） | wb-infra |
| POST | `/proxy/subbridge` | `action`：`test/list/refresh/apply`；`subs[]`；`nodes[]`（apply 必填） | 转换器 JSON 结果（`ok`/`error`/节点列表）；未安装 → 503，超时 → 504 | wb-infra |
| GET | `/codearts/overview` | 无 | CodeArts 概览 + `online`、`health`、`base_url`；未配置 → 503 | wb-infra |
| GET | `/codearts/accounts` | 无 | `provider:"codearts"`、`accounts[]`、`stats`、`models[]`、`base_url` | wb-infra |
| POST | `/codearts/test` | 无 | `ok`、`health`、`stats`、`models`（数量）；健康检查失败 → 502 | wb-infra |
| POST | `/codearts/accounts/oauth/start` | 无 | OAuth 启动信息（`session_id`/授权 URL，端口取自当前 server） | wb-infra |
| POST | `/codearts/accounts/oauth/poll` | `session_id` | 轮询状态 | wb-infra |
| POST | `/codearts/accounts/oauth/callback` | `session_id`、`callback_url` | 回调结果 | wb-infra |
| POST | `/codearts/keepalive` | 无 | 保活结果 | wb-infra |
| POST | `/codearts/models/refresh` | 无 | 模型清单刷新结果 | wb-infra |
| POST | `/codearts/credits/refresh` | 无 | 积分刷新结果 | wb-infra |
| POST | `/codearts/accounts/checkin` | `uid`（可空 = 全员签到） | 签到结果 | wb-infra |
| POST | `/codearts/accounts/proxy` | `uid`（必填）、`slot_id` | 绑定出口槽结果 | wb-infra |
| POST | `/codearts/accounts/note` | `uid`、`note` | 备注保存结果 | wb-infra |
| POST | `/codearts/accounts/tasks` | `uid`、`enabled`（默认 true） | 任务开关结果 | wb-infra |
| POST | `/codearts/accounts/test` | `uid` | 单号探测结果 | wb-infra |
| POST | `/codearts/accounts/enable` | `uid` | 启用结果 | wb-infra |
| POST | `/codearts/accounts/disable` | `uid`、`reason` | 禁用结果 | wb-infra |
| POST | `/codearts/accounts/delete` | `uid` | 删除结果；上游版本过旧 → 409 | wb-infra |
| POST | `/codearts/accounts/clear-cooldown` | `uid` | 清冷却结果 | wb-infra |
| GET | `/oauth/callback` | 华为云 OAuth 回调 query（`ticket_id`/`secret` 等） | `text/html` 结果页（**免面板会话**，在面板门之前处理） | wb-infra |

## 11. system —— 面板 / 健康 / 控制台（10 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| GET | `/`（`/dashboard`、`/ui`） | 无 | `dashboard.html` 静态页（注入 ui_language；强 ETag，可 304） | system |
| GET | `/panel/status` | 无（免 token，登录前判定用） | `panel_password_required`、`panel_password_is_default`、`authenticated`、`crypto_ok`(失败附 `crypto_error`)、`outbound_tls`、`api_key_set` | system |
| POST | `/panel/login` | `password` | `ok`、`token`、`using_default_password`；60s 内 5 次失败 → 429 | system |
| POST | `/panel/logout` | 无 | `{ok:true}`（吊销当前 token） | system |
| POST | `/panel/password` | `current`、`new`（≥4 字符，面板会话） | `ok`、新 `token`、`using_default_password`；改非默认密码会吊销其它会话 | system |
| POST | `/panel/host-login` | 头 `X-Host-Key`（仅环回 + `WB_HOST_KEY`） | `{ok:true, token}`；不匹配一律 404 | system |
| GET | `/console/state` | 无 | `supported`、`mode:"web"`、`visible:false` | system |
| POST | `/console/toggle` | `{}`（面板会话） | `ok`、`mode`、`url:"/dashboard?tab=logs"`、`visible:false`（改为新窗口打开日志页） | system |
| POST | `/shutdown` | 无（面板会话） | `ok`、`shutting_down`（先回包再 0.4s 退出进程） | system |
| GET | `/health` | 无（匿名可通；带 Key 时附账号身份） | `ok`、`realm`、`crypto_ok`、`outbound_tls`、池就绪计数、`api_key_required`、`codearts{}`、`media{enabled,realm,slots,inflight,video_concurrency,tasks}`；带 Key 另附 uid/domain/issuer/expires_at | system |

> `OPTIONS *`（22649）只做 CORS 预检（204），不计入业务端点。

---

# 二、zc 侧（admin_api.py + gateway.py，33 条）

## 12. zc-accounts —— zcode 账号池（14 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| GET | `/admin/api/accounts` | 无 | `accounts[]`（`public_view` + `key_no_balance_remaining_s`）、`stats{total,active,exhausted,cooling,invalid,disabled,calls,fail,quota_used}`、`providers[]`、`ts` | zc-accounts |
| GET | `/admin/api/status` | 无 | `providers[]`、`gateway_key_set`、`quota_pool{provider: 可选号数}` | zc-accounts |
| POST | `/admin/api/accounts` | `provider`(默认 zai)、`tokens[]`（或换行字符串）、`name` | `{count, ids[]}`；新增 JWT 号立即刷新额度，并后台跑安装序 + 自动领取 | zc-accounts |
| DELETE | `/admin/api/accounts` | body 为 `ids: string[]` | `{deleted: n}`；同时清 Key-1113 冷却记忆 | zc-accounts |
| PUT | `/admin/api/accounts/{account_id}` | `name`、`token` 或 `secret` | `{ok:true}`；JWT 同 uid 与其它账号冲突 → 409；换凭证会清冷却 | zc-accounts |
| POST | `/admin/api/accounts/{account_id}/enabled` | `enabled`（默认 true） | `{ok:true}`；启用时清 Key-1113 与模型级 1005 冷却 | zc-accounts |
| POST | `/admin/api/accounts/{account_id}/fingerprint/rotate` | 无 | `{ok:true, fingerprint}`；重置 `installed_at` 并重跑安装序 | zc-accounts |
| POST | `/admin/api/accounts/refresh` | `all: true` 或 `ids[]` | `summary`、`count`、`cooling`、`skipped_invalid`（只刷有 JWT 且可查账的号） | zc-accounts |
| POST | `/admin/api/accounts/{account_id}/refresh` | 无 | `ok`、`result`（quota）、`account`；非 JWT → `ok:false`+message；账本被禁 → `ok:false`+原因 | zc-accounts |
| GET | `/admin/api/accounts/{account_id}/coding_limits` | 无 | `ok` + coding 平面额度（`fetch_coding_limits` 原样展开）；体验套餐常报「无 coding plan」 | zc-accounts |
| POST | `/admin/api/login/start` | `label`（可选，账号名前缀） | `flow_id`、`authorize_url`、`expires_in`(300s)；上游失败 → 502 | zc-accounts |
| GET | `/admin/api/login/poll/{flow_id}` | 路径参数 `flow_id` | `status ∈ pending/ready/failed/expired`（未知 flow 也回 expired）；`ready` 附 `account` | zc-accounts |
| POST | `/admin/api/export` | 无 | 账号导出文档（含 JWT/API Key 明文，`Cache-Control: no-store`） | zc-accounts |
| POST | `/admin/api/import` | 导出文档（任意 JSON 对象） | `{count}`；新 JWT 号后台安装 + 自动领取 | zc-accounts |

## 13. zc-claim —— 额度领取（4 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| GET | `/admin/api/claim/preview` | `?account_id=`（缺省 = 全部 JWT 号） | `preview[]`：每号 `plans[]`、`error`、`activated`、`activation_error`（先上报激活事件，失败不阻断） | zc-claim |
| POST | `/admin/api/claim` | `account_ids[]`（可选）、`plan_id`（可选；缺省自动选最优） | `outcomes[{account_id,account_name,ok,plan_name?,grants?,message?,code?,next_at?}]`、`summary{ok,fail}` | zc-claim |
| GET | `/admin/api/claim/captcha-config` | 无 | 阿里验证码 SDK 初始化参数：`enabled`、`scene_id`、`region`、`prefix`（出口跟随 `BILLING_EGRESS`） | zc-claim |
| POST | `/admin/api/claim/manual` | `account_id`（必填）、`captcha_verify_param`、`captcha_region`、`plan_id` | `outcomes[]` + `summary`；verify_param 必须是浏览器内阿里滑块成功回调产物 | zc-claim |

## 14. zc-monitor —— 请求监控（2 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| GET | `/admin/api/monitoring` | 无（**不读 `limit` 参数**，整环快照） | `entries[]`（内存环形日志）、`keep`（环容量）；重启清零 | zc-monitor |
| POST | `/admin/api/monitoring/clear` | 无 | `{ok:true}` | zc-monitor |

## 15. zc-upstream —— 上游版本 / 包探针（3 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| POST | `/admin/api/version/zcode/check` | 无 | `version_tracker.check_and_sync(force=True)` 结果（当前/最新/是否有更新/日志） | zc-upstream |
| GET | `/admin/api/upstream-analysis` | 无 | `{ok:true, data}`：zcode 正文锁状态 + wb versionfeed 联动 + 动作建议 | zc-upstream |
| GET | `/admin/api/upstream-package-analysis` | `?version=`、`?refresh=true` | `{ok:true, data}` 版本与提示词指纹 diff；首次需下载数 MB；探针失败 → 502 `{ok:false,error}` | zc-upstream |

## 16. zc-io —— zcode 网关流量面（5 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| GET | `/v1/models` | 无 | `{object:"list", data:[{id,type,display_name,created_at}]}`（`MODEL_CATALOG`，Anthropic 风格） | zc-io |
| POST | `/v1/messages` | Anthropic body：`model`、`messages`、`system`、`max_tokens`、`stream`、`tools` | Anthropic message 或 SSE；非法 JSON → 400；客户端断开 → 499 记账；内部错误 → 500 | zc-io |
| POST | `/v1/chat/completions` | OpenAI chat body（`model`、`messages`、`stream`、`tools`…） | OpenAI Chat 响应或 SSE（内部转 Anthropic 再转回） | zc-io |
| POST | `/v1/responses` | Responses body（`model`、`input`、`stream`、`tools`…） | Responses 对象或 SSE（Responses→Chat→Anthropic 两跳） | zc-io |
| POST | `/v1/messages/count_tokens` | `model`（必填）、`messages` | `{input_tokens}`（本地确定性估算，不占额度、池空也能回） | zc-io |

## 17. system（zc 侧）—— 鉴权探针 / 设置 / wb 透传（5 条）

| 方法 | 路径（别名） | 关键载荷 / 查询 | 返回要点 | 归属页面 |
|---|---|---|---|---|
| GET | `/admin/api/verify` | 无 | `{status:"ok"}`（admin key 探针） | system |
| GET | `/admin/api/settings` | 无 | 密钥掩码、`quota_refresh_interval`、`account_concurrency`、`claim_round_interval/hours`、`auto_sync_client_version`、zcode 当前/最新版本与更新日志字段 | system |
| PUT | `/admin/api/settings` | `admin_key`、`gateway_key`（≥12 字符；掩码值原样回传则不修改）、`quota_refresh_interval`、`claim_round_interval`、`claim_round_hours`、`auto_sync_client_version`；`account_concurrency` 被忽略 | `{ok:true}`；弱密钥/非法整数 → 400 | system |
| GET | `/admin/api/wb-admin/{path:path}` | 任意 wb 管理面 GET 路径 + 原样 query 透传 | wb 响应字节透传（保留 status/content-type）；wb 聚合层未配置 → 503 | system |
| POST | `/admin/api/wb-admin/{path:path}` | 任意 wb 管理面 POST 路径 + payload 原样透传 | 同上（用于启停/刷新/签到/保存设置等写操作） | system |

---

# 三、前端缺口提示（对照 `js/core/api.js`）

`js/core/api.js` 目前只覆盖了上表的一部分。以下端点**在 api.js 中没有任何封装**（按影响排序）：

1. `PUT /admin/api/accounts/{account_id}`（zc-accounts）—— 账号改名/换 token 的唯一入口，api.js 只有新增与删除。
2. `PUT /admin/api/settings`（system）—— zc 设置保存；api.js 只有 `GET /admin/api/settings`，保存会静默失败。
3. `GET/POST /admin/api/wb-admin/{path}`（system）—— 整块 wb 管理面透传，可绕过 `/wb` 反代直接走统一网关。
4. `GET /v1/videos/{id}/content`（wb-media）—— 视频下载必须带签名 `t`，`<video>`/浏览器无法附 Bearer；只封装 `video(id)` 拿不到产物。
5. `POST /proxy/slots/save`、`POST /proxy/slots/test`、`POST /proxy/discover`、`POST /proxy/subbridge`（wb-infra）—— 出口槽整组写操作，api.js 只有 `GET /proxy/slots`。
6. `POST /tasks/run|night|claim|travel|streak-bonus`、`POST /scheduler/trigger|toggle`、`POST /quota-scan/run`（wb-automation）—— 自动化页所有动作按钮。
7. `POST /accounts/checkin|daily-chat|daily-chat-web`、`POST /accounts/login/start`、`GET /accounts/login/poll`、`POST /accounts/login/cancel`、`POST /accounts/sync-profile`（wb-accounts）。
8. `POST/GET /accounts/credits/detail`、`GET /accounts/credits`、`GET /accounts/export`（wb-accounts）—— 积分明细与导出。
9. `GET /logs/export`、`POST /logs/clear`（wb-logs）。
10. `POST /updates/rollback`（wb-updates）；另注意 `api.js` 的 `updatesInstall(tag)` 传了 `tag`，但后端 `/updates/install` **完全不读 body**，安装对象只能来自上一次 `/updates/check` 的结果。
11. `POST /agents/apply`、`POST /agents/restore`、`POST /agents/model-selection`、`GET /agents/cli`（wb-agents）。
12. `POST /panel/login|logout|password`、`GET /panel/status`、`GET /console/state`、`POST /console/toggle`、`POST /shutdown`（system）。
13. CodeArts 全部写操作与 `GET /codearts/accounts`、`GET /oauth/callback`（wb-infra）。
14. `POST /settings/reveal` 不存在——明文 Key 是 **GET** `/settings/reveal?id=`；api.js 已正确用 GET。
15. 媒体与文本入口互斥：媒体入口（`/v1/media/*`、`/v1/videos*`、`/v1/images/*`）调文本路由返回 403，文本入口调媒体路由返回 503 `pool_boundary`；页面需要按入口分流。

---

# 四、未计入本清单的端点（超出本次指定文件）

以下是同一后端里存在、但**不在本次点名的两个文件/两段路由**中的端点，未计入 119/33：

- `zcode2api/app/routes/pages.py`：`GET /`、`/wb-ui`、`/admin`、`/admin/login(.html)`、`/admin/accounts(.html)`、`/admin/monitoring(.html)`、`/admin/settings(.html)`、`GET /meta`（页面与元信息）。
- `zcode2api/app/wb_embed.py`：`/wb/{path}` 反代（通配，承载上面全部 wb 端点）。
- `wb_proxy.py` 的 `do_OPTIONS`：CORS 预检 204，非业务端点。
