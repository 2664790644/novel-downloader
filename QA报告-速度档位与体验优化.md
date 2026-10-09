# QA 独立验证报告：速度档位与体验优化迭代

> 验证人：秦戈（QA）。原则：不信开发自证，全部亲手复验；命令实测 + 实际观察为准。
> 环境：自起实例 web-ui @127.0.0.1:8739（用户旧实例 8735-8738 未动）、mock 站 @8734、Node 22.22.2。测试数据全部 `pretest_` 前缀，测完已清理（15 个书籍目录已删，library-meta/user-book-sources 无残留，crash.log 未产生）。

## 【执行摘要】

| 层面 | 用例数 | 通过 | 失败 |
|---|---|---|---|
| 功能 | 21 | 20 | 1（P1-1） |
| 边界 | 11 | 10 | 1（同 P1-1 的 4 个注入子用例） |
| 安全 | 8 | 8 | 0 |

总结论：**有条件交付** —— 需修复 P1-1（一行校验修复，回归成本极低）；两条 P3 不阻塞上线。

## 【缺陷清单】

### P1-1 speedProfile 原型链属性注入绕过 400 校验，限速三参数被瓦解（白客）

- **描述**：`speedProfile` 校验用 `SPEED_PROFILES[speedProfile]` 真值判断（web-ui.js:1442），plain object 的继承属性（`constructor`/`toString`/`hasOwnProperty`/`__proto__`）均为真值，非法值绕过 400；随后 `buildManualSource`（:594）同模式取值得到函数/原型对象，`minIntervalMs`/`jitterMs`/`maxPerMin` 全为 undefined → 生效为 **120ms 固定间隔、零抖动、无每分钟窗口上限**，低于官宣最快的极速档（150ms），且恰恰瓦解了防封的机器指纹对抗（抖动）与总量封顶（窗口）。
- **复现**：
  1. `curl -X POST /api/start -H "X-Token: $T" -d '{"manual":true,"tocUrl":"http://127.0.0.1:8734/book/2/","speedProfile":"__proto__","manualChapters":[...]}'`
  2. 观察响应与 `/api/state` 日志。
- **实际结果**：4 个注入值全部返回 `{"ok":true} HTTP:200`；任务日志「下载 1/1 章（缓存命中 0，并发 8，**限速 120ms**）」。
- **预期结果**：按契约返回 400 `{ "error": "speedProfile 非法（conservative/balanced/fast）" }`。
- **影响范围**：任何持有 API token 的调用方（含被 XSS 劫持的页面上下文）可把下载节奏压到全档位体系之下，绕过「知情自选」的显式警告与防封评估前提。
- **修复建议**：校验改为 `Object.prototype.hasOwnProperty.call(SPEED_PROFILES, speedProfile)`；`buildManualSource` 内取值同样改 hasOwnProperty 或将 SPEED_PROFILES 改为 `Object.create(null)` 字面量。补一条单测：`speedProfile:"constructor"` 应 400。
- **定位**：web-ui.js:1442、web-ui.js:594。

### P3-1 排队任务出队日志被立即擦除，亚秒级任务日志从未推送（白客）

- **描述**：`startNextQueued` 先 `log('[队列] 自动开始排队任务…')`（web-ui.js:667）再 `launchTask → startTask`，后者 `state.logs = []`（:679）将该行立即擦除，SSE 永远看不到出队日志；且 <500ms 跑完的快速排队任务（fast 档单章），其「任务开始/任务完成」日志在 SSE 500ms tick 间隙被下一任务的 `state.logs=[]` 覆盖，前端日志抽屉里这些任务「静默开始、静默结束」。
- **证据**：队列连跑 5 个 fast 单章任务（qB1-qB5），SSE 流全文检索无「自动开始排队任务」字样；qB2/qB4 的「任务开始」行零次出现（qB1/qB3/qB5 有，取决于 tick 相位）。章节进度事件不丢（chapterEvents 累积推送 + chaptersDirty 全量快照兜底），仅日志行丢失。
- **影响**：用户看日志时无法感知排队任务的切换，对「队列在消化」无感知。
- **修复建议**：出队日志移入 `startTask` 内 `state.logs = []` 之后；或日志改为环形持久 buffer 不随任务切换清空（保留跨任务尾部）。

### P3-2（已知限制，记录不阻塞）rate 区块对「章节 URL 与 tocUrl 不同 host」的手动书整任务期隐藏

- **描述**：`rateSnapshot` host 取自 `state.tocUrl`（契约规定口径），但引擎限速门按章节 URL 的 host 分桶；手动书章节在 CDN/分站 host 时 `getHostRate` 返回 null → rate=null → 前端限速区块隐藏。契约内行为，真实站点分 host 场景下 F2 可视化失效。
- **建议**：后续迭代可取「最近一章实际请求 host」作为快照口径。

## 【必测项逐条结论】

**1. 回归基线 —— 通过**
- `node --test test/engine.test.js`：16/16 全绿（含新增 4 用例：滑动窗口不平死等、任意窗口 ≤maxPerMin 不变量、getHostRate slow 快照、host 无记录返 null）。
- `node --check`：novel-downloader.js / web-ui.js / mock-novel-site.js 全过。
- web-ui.html 内联 script（1426-3602 行，单一 script 块）抽出后 `node --check` 通过。

**2. F1 速度三档 —— 通过（除 P1-1）**
- fast：SSE 日志「限速 150ms」，rate.effIntervalMs=150、maxPerMin=120 → 300ms 套底已移除 ✓
- balanced（缺省）：「限速 300ms」、maxPerMin=90 ✓
- conservative：rate.effIntervalMs=500、maxPerMin=60 ✓
- 非法值 `ludicrous` → 400，文案逐字 `{"error":"speedProfile 非法（conservative/balanced/fast）"}` ✓
- 书源模式带 `speedProfile:"garbage"`/`"fast"` → 均不校验不报错（返回 404 源不存在，证明未触发档位校验）✓
- 队列透传：1 个 conservative 在跑 + 5 个 fast 排队（position 1-5），第 6 个 409「下载队列已满（最多 5 个排队任务）」；5 个排队任务全部出队完成（磁盘产物核实），qB1/qB3/qB5 日志实证「限速 150ms」✓

**3. F3 滑动窗口 —— 通过**
- 单测 test 13 断言「打满后仅睡到最早请求滑出」（第 4 个请求 t3-t2≥100ms，固定窗口会 ≈0），test 14 断言任意窗口 ≤maxPerMin 不变量，均绿。
- 读码复核：winTimes 数组 ≤maxPerMin（≤120）无泄漏；chain 串行化无竞态。

**4. F2 SSE rate —— 通过**
- 运行中帧七字段齐全：`{"host","slow","effIntervalMs","downgraded","winCount","maxPerMin","winRemainingMs"}` 实测样本完整。
- 503 干扰实测（后台 30ms 频率 hammer mock 站触发全局限流）：slow 3.6→7.2→14.4→28.8→**32（封顶）**，`downgraded:true`，effIntervalMs 同步放大到 4800ms；干扰下任务仍 6/6 章全部完成（Retry-After+重试+降速兜底）。任务结束后 `rate:null` ✓

**5. F7 搜索边界 —— 通过**
- 空 q / 无 q 参数 → `{"books":[]}` 200；150 字符 q → 200 截断不报错；大写 `PRETEST` 命中小写书名（大小写不敏感）✓；章节名 `c3` 命中 3 本书并返回 `matchedChapters:[{n,title}]` ✓；无命中 → 空列表；损坏 manifest（`{broken json!!!`）→ 书籍按元数据命中、不崩、matchedChapters 为空 ✓；XSS（`<script>alert(1)</script>`）与特殊字符（`"\␀%FF`）→ 200 无反射 ✓。前端渲染用 textContent/escapeHtml，无 innerHTML 注入面 ✓

**6. F6 全部追更 —— 通过**
- 接口级全链路：check-updates（本地 4/远程 6 → newChapters:2，manual:true 带章节清单）→ 模拟前端 buildFollowupBody（manual+speedProfile:fast）→ /api/start 200 → 「限速 150ms」→ 6/6 完成 ✓
- 队列满防呆：前端 409「队列已满」正则匹配停止入队并 toast 实际入队数（web-ui.html:2274-2276），409 行为已在 F1 队列测试实证 ✓

**7. F8 阅读器增强 —— 通过（静态审计）**
- ←/→ 快捷键：`!typing`（INPUT/TEXTAREA/SELECT 聚焦不触发）+ readerMask 可见双守卫，readerMask 初始 inline `display:none` 无「空字符串≠none」误判；边界由 loadReaderChapter 索引守卫停止 ✓
- Esc 优先级链：阅读器 → 导入包 → 选源器 → 视图回退，与 ←/→ 分支不同键无冲突 ✓
- readerPrefs：新 key 优先、旧 key `nd-reader` 读取一次迁移、applyReaderCfg 落盘新 key ✓
- 目录侧栏 renderReaderToc / 章节跳转 openReader(b, targetN) /api/library/preview 实测返回正文 ✓

**8. 前端一致性 —— 通过**
- `$('id')` 交叉校验：使用 159 个 id，全部在 HTML 中有定义（comm 差集为空）✓
- `nd-mock`/调试开关：零残留 ✓
- 下载状态区 CSS（900-1200 行）：无 hex/rgb 硬编码色值，全部走 `var(--*)` 令牌 ✓

**9. 安全红线 —— 通过**
- 三道动态防线读码确认均在：buildManualSource `banCircuitThreshold:3`（web-ui.js:611）、`browserLike:true`（:612）、Retry-After 解析封顶 120s（novel-downloader.js:492-496）、429/403/503→bumpHostPenalty（:528-529）、web 层 banStreak≥8 取消（web-ui.js:763）。
- fast 档 503 实测：自适应降速爬升至 32 倍封顶生效，任务未失控完成 ✓
- 补充：无 token POST /api/start → `{"error":"缺少或无效的访问令牌"}`；/api/library/preview、chapters 目录穿越（`../../`）→ 403 ✓

**10. 边界挖掘 —— 发现 P1-1（见缺陷清单）**；其余注入面（q 超长/XSS/特殊字符、目录穿越、并发数负数/超大 clamp 1-16、章节清单 >20000 拒绝、url>2000 拒绝）均按预期处理。

## 【验收标准核对】

| 验收标准（任务清单） | 结论 | 依据 |
|---|---|---|
| T1 node --test 全绿，新用例覆盖滑出即放行 | 通过 | 16/16，test 13 断言原文核对 |
| T2 fast 日志 150ms / 非法 400 文案 / 出队透传 | 通过 | SSE 日志 + curl 实录 |
| T3 SSE rate 七字段 / 429·503 后 slow 翻倍 downgraded | 通过 | 503 干扰实测 slow→32 |
| T4 请求体含 speedProfile / 极速警告 / 书源隐藏档位 | 通过 | web-ui.html:3486/2794/2831 |
| T5 降速琥珀徽章 / rate=null 隐藏 | 通过 | :3215-3221 + SSE 实测 null |
| T6 sparkline 随 SSE 更新 | 通过（静态） | :3224-3271，浏览器目视未测 |
| T7 状态区三视图/移动端/对比度 | 部分 | 令牌与断点静态过；目视未测 |
| T8 全部追更入队与 409 toast | 通过 | 接口级模拟 + 代码路径 |
| T9 搜索契约 | 通过 | curl 全边界 |
| T10 章节直达阅读器 | 通过（静态+preview 实测） | :2352-2354 |
| T11 prefs 持久 / 快捷键边界停止 | 通过（静态） | :3155-3187/:2563 |
| T12 既有 12 用例无回归 / pkg 打包 | 部分 | 16 用例全绿；pkg 打包未测 |

## 【未覆盖声明】

- pkg 打包 exe 验证（T12 后半）未执行；
- 浏览器端目视（F5 曲线渲染、F9 移动端 375px、WCAG 对比度）未开浏览器，仅以静态审计代替；
- F6 前端按钮本身未做浏览器点击实测（以接口级模拟等价链路代替）。

## 【测试结论】

**有条件交付**：P1-1 修复（一行校验 + 一条单测）并回归通过后即可进入打包上线；P3-1/P3-2 建议排入下轮，不阻塞。
