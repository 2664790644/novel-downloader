/**
 * 书源健康度管理 —— 探活白名单、失败降级与自愈。
 *
 * <p>业务目的：全量书源中死源占多数，搜索若全量广播必然被死源超时拖垮；
 * 本模块把"哪些源当前可用"收敛为一份持久化白名单，搜索默认只打白名单内的源，
 * 让搜索时长与活源数而非总源数挂钩，从机制上保证搜索稳定出结果。</p>
 *
 * <p>三个数据来源（按可信度递减）：</p>
 * <ul>
 *   <li>probe（体检）：并发探活，按真实搜索词请求每源的搜索接口，
 *       命中有效结果才算 alive——"站点根路径可达但搜索接口已失效"的源不会混入白名单；</li>
 *   <li>searchFail（搜索期失败）：搜索时某源连续失败满阈值，自动移出白名单；</li>
 *   <li>自愈：被降级的源仅在下次体检时重新评估，体检通过即加回白名单
 *       （旧注释承诺的空闲期自动重探从未实现，已从文档移除以免误导）。</li>
 * </ul>
 *
 * <p>持久化：状态写入 outputRoot 下 source-health.json（打包态 exe 同目录可写），
 * 重启不丢；结构 {byUrl: {url: {state, latencyMs, lastOkAt, lastFailAt, failStreak}}}。</p>
 */
'use strict';

const fs = require('fs');
const path = require('path');
// 探活不再直接发 HTTP 请求：经注入的 engine.searchBook 走真实搜索路径，
// 体检结论与"用户能不能搜到书"严格一致（根路径可达≠搜索可用，实测教训）

// 探活与降级阈值：单源探活 4s 足够区分死活（正常站点 DNS+连接+响应 < 2s）；
// 搜索期连续失败 3 次才降级，避免偶发超时误杀可用源
const PROBE_TIMEOUT_MS = 4000;
const FAIL_STREAK_LIMIT = 3;

/**
 * 判断书源是否具备当前引擎可执行的搜索条件。
 *
 * <p>数据来源：书源注册表中的 `enabled`、`bookSourceUrl`、`searchUrl`、
 * `ruleSearch.bookList`；Legado 包装源额外使用 `_legado.parseSearchUrl`
 * 解析真实请求地址。这个判定只回答“能不能发起一次有效搜索”，不预测网络连通性。</p>
 *
 * <p>结果去向：搜索与体检共用该口径，缺搜索列表、缺搜索地址、脚本搜索和
 * URL 无法解析的源会被排除，避免把必然失败的请求消耗在超时队列里。</p>
 *
 * @param {object} source 引擎书源对象或 Legado 包装源
 * @returns {boolean} true 表示当前引擎可以尝试搜索；false 表示应跳过
 */
function isSearchCandidate(source) {
  if (!source || source.enabled === false) return false;
  if (!source.bookSourceUrl || !source.searchUrl) return false;

  try {
    // Legado 源的 searchUrl 可能携带 method/body/options 或 @js: 前缀；
    // 必须用同一套解析器确认“存在真实 URL”，否则会在体检时才暴露。
    if (source.legado && source._legado) {
      const parsed = source._legado.parseSearchUrl('体检关键词', 1);
      // 与 searchViaLegado 保持同一解析口径：相对地址必须能挂到 bookSourceUrl
      // 上生成完整 URL，否则体检/搜索都会在 URL 构造阶段失败。
      new URL(parsed.url, source.bookSourceUrl);
      return !!(parsed && parsed.url && parsed.url.trim());
    }

    // 普通 JSON/HTML 书源在进入网络请求前必须同时具备列表规则；
    // 缺列表规则时即使搜索页可达，也无法装配出可点击结果。
    if (!source.ruleSearch || !source.ruleSearch.bookList) return false;
    if (typeof source.ruleSearch.bookList !== 'function' && !String(source.ruleSearch.bookList).trim()) return false;
    new URL(source.searchUrl, source.bookSourceUrl);
    return true;
  } catch (e) {
    return false;
  }
}

class SourceHealth {
  /**
   * @param {string} stateFile 持久化文件绝对路径
   * @param {function} log 进度回调（msg: string）
   */
  constructor(stateFile, log = () => {}) {
    this.stateFile = stateFile;
    this.log = log;
    this.byUrl = this._load();
    this.probing = false;
    this.probeProgress = null;   // {done, total} 体检进度，供 UI 展示
    this.probeAbort = false;     // 用户手动停止体检标志
    this._saveTimer = null;      // 落盘节流定时器：合并高频失败/成功上报
    // 进程退出兜底：节流期内未落盘的状态在退出前强制写一次，防丢最后一批降级记录
    process.on('exit', () => this._flushSync());
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return raw.byUrl && typeof raw.byUrl === 'object' ? raw.byUrl : {};
    } catch (e) { /* 首次运行无状态文件，按空表处理 */ }
    return {};
  }

  save() {
    // 节流落盘：搜索一次会触发几十次失败/成功上报（实测 109 源 37 次），
    // 每次全量同步重写 12KB JSON 挤占主线程；合并到 2 秒窗口内只写一次
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._flushSync();
    }, 2000);
    // 定时器不应阻止进程退出
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  _flushSync() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try {
      fs.writeFileSync(this.stateFile,
        JSON.stringify({ savedAt: new Date().toISOString(), byUrl: this.byUrl }, null, 1));
    } catch (e) { this.log('健康度状态保存失败: ' + e.message); }
  }

  /** 白名单判定：仅"最近一次探测或搜索确认存活"的源放行。从未参与过体检的源视为未验证，不放行 */
  isHealthy(source) {
    const st = this.byUrl[source.bookSourceUrl];
    return !!(st && st.state === 'alive');
  }

  /** 搜索期失败上报：未验证源不进入白名单；连续失败达阈值后标记 dead，等待体检自愈 */
  reportFailure(source, errMsg) {
    const key = source.bookSourceUrl;
    // 失败记录可能来自"全量搜索"阶段的未验证源；只有体检或搜索成功后才允许进入 alive 白名单。
    const st = this.byUrl[key] || {
      state: 'unverified', latencyMs: null, lastOkAt: null, lastFailAt: null, failStreak: 0
    };
    st.failStreak = (st.failStreak || 0) + 1;
    st.lastFailAt = Date.now();
    st.lastError = String(errMsg || '').slice(0, 120);
    if (st.failStreak >= FAIL_STREAK_LIMIT && st.state !== 'dead') {
      st.state = 'dead';
      this.log(`[健康度] ${source.bookSourceName} 连续失败 ${st.failStreak} 次，标记 dead（体检后可自愈）`);
    }
    this.byUrl[key] = st;
    this.save();
  }

  /** 搜索期成功上报：真实搜索返回结果时确认 alive，防止健康表为空时成功源无法进入白名单 */
  reportSuccess(source) {
    const key = source.bookSourceUrl;
    const st = this.byUrl[key] || {
      state: 'unverified', latencyMs: null, lastOkAt: null, lastFailAt: null, failStreak: 0
    };
    st.state = 'alive';
    st.lastOkAt = Date.now();
    st.failStreak = 0;
    delete st.lastError;
    this.byUrl[key] = st;
    this.save();
  }

  /**
   * 全量体检：并发对每个可搜索的启用源执行一次真实搜索（关键词可传，默认"斗"），
   * 命中有效结果（有书名有链接）才判 alive——根路径可达但搜索接口失效的源
   * 不再混入白名单，从源头消除"体检通过却搜不到书"的白名单磨光。
   * 搜索执行复用引擎 searchBook（含 legado 分派与规则解释），与真实搜索同路径。
   * 体检关键词用两字「斗破」：部分模板站（实测速读谷 sudugu）要求关键词 ≥2 字，
   * 单字词会返回空结果被误判 dead（2026-09-30 实测修复）。
   * 结构性无效源由 isSearchCandidate 排除，不消耗体检并发和超时预算；
   * 并发 64、每源 PROBE_TIMEOUT_MS 硬超时；结果覆盖写回健康表并立即落盘。
   * 返回 {alive, dead, skipped} 计数；进度经 this.probeProgress 暴露给 UI 轮询。
   */
  async probeAll(sources, concurrency = 64, searchBookFn, keyword = '斗破') {
    if (this.probing) throw new Error('体检已在进行中');
    if (typeof searchBookFn !== 'function') throw new Error('体检需要注入 searchBook 函数');
    this.probing = true;
    this.probeAbort = false;
    const targets = sources.filter((s) => isSearchCandidate(s));
    // 只统计启用但结构上不可搜索的源；已禁用源本来就不参与体检，
    // 不应混入 skipped，否则 UI 会把“用户主动禁用”误解为“书源格式无效”。
    const skipped = sources.filter((s) => s.enabled !== false && !isSearchCandidate(s)).length;
    this.probeProgress = { done: 0, total: targets.length, skipped };
    this.log(`[健康度] 开始体检 ${targets.length} 个可搜索书源，跳过 ${skipped} 个结构性无效源（真实搜索词"${keyword}"，并发 ${concurrency}，单源 ${PROBE_TIMEOUT_MS}ms 超时）…`);

    let alive = 0, dead = 0, next = 0;
    async function lane() {
      while (true) {
        if (this.probeAbort) return;
        const idx = next++;
        if (idx >= targets.length) return;
        const s = targets[idx];
        const started = Date.now();
        try {
          // 与真实搜索完全同路径：searchBook 内部完成 URL 构造/编码/规则解析，
          // 体检结论与"用户搜这个词能不能出书"严格一致，不再有探活与实搜的偏差
          const books = await searchBookFn(s, keyword,
            { ...(s.option || {}), timeoutMs: PROBE_TIMEOUT_MS, maxRetries: 0, retryBaseDelayMs: 0 });
          // 有效结果准入：有书名有链接才可信；规则错位返回的空名/首页垃圾按无效处理
          const valid = (books || []).filter((b) => b && b.name && b.bookUrl
            && !/^https?:\/\/[^/]+\/?$/.test(b.bookUrl));
          if (valid.length > 0) {
            this.byUrl[s.bookSourceUrl] = {
              state: 'alive', latencyMs: Date.now() - started, lastOkAt: Date.now(),
              failStreak: 0, hits: valid.length
            };
            alive++;
          } else {
            // 接口通但 0 有效结果：站点改版/规则失效，归 dead 并记录原因
            this.byUrl[s.bookSourceUrl] = {
              state: 'dead', latencyMs: null, lastOkAt: this.byUrl[s.bookSourceUrl]?.lastOkAt || null,
              lastFailAt: Date.now(), failStreak: 0, lastError: `搜索无有效结果(${(books || []).length}原始)`
            };
            dead++;
          }
        } catch (e) {
          this.byUrl[s.bookSourceUrl] = {
            state: 'dead', latencyMs: null, lastOkAt: this.byUrl[s.bookSourceUrl]?.lastOkAt || null,
            lastFailAt: Date.now(), failStreak: 0, lastError: String(e.message || '').slice(0, 120)
          };
          dead++;
        }
        this.probeProgress.done++;
      }
    }
    // 并发 lane 共享 next 游标，与引擎 runPool 相同的固定并发池模式
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) },
      () => lane.call(this)));
    this._flushSync();   // 体检是状态大变更，结束立即落盘不等节流窗口
    this.probing = false;
    this.log(`[健康度] 体检完成：可用 ${alive}，无效/不可达 ${dead}，跳过 ${skipped} 个结构性无效源，白名单已更新并保存`);
    return { alive, dead, skipped };
  }

  stopProbe() { this.probeAbort = true; }

  /** 惰性清理：剔除不在当前书源注册表内的健康度记录（尸体记录）。
   *  书源删除/换包后旧记录残留会让书源管理顶栏「存活 X / 共 Y」分母虚高
   *  （实测 byUrl 残留 127.0.0.1:8734 mock 站 dead 记录，显示「存活 6 / 共 7」）；
   *  不做独立迁移脚本，加载后/查询时顺带清理。返回剔除条数（>0 时走节流落盘） */
  prune(validUrls) {
    let removed = 0;
    for (const key of Object.keys(this.byUrl)) {
      if (!validUrls.has(key)) { delete this.byUrl[key]; removed++; }
    }
    if (removed) {
      this.log(`[健康度] 惰性清理 ${removed} 条已移除书源的残留记录`);
      this.save();
    }
    return removed;
  }

  /** 汇总统计供 UI 展示。
   *  unverified（导入后尚未探测）单独计数不计入 dead——旧口径把未验证源全部
   *  算作 dead，顶栏「存活 x / 共 y」分母虚高，用户会误读为大量站点已失效 */
  stats() {
    let alive = 0, dead = 0, unverified = 0;
    for (const st of Object.values(this.byUrl)) {
      if (st.state === 'alive') alive++;
      else if (st.state === 'dead') dead++;
      else unverified++;
    }
    return { alive, dead, unverified, probing: this.probing, probeProgress: this.probeProgress };
  }
}

module.exports = { SourceHealth, isSearchCandidate, PROBE_TIMEOUT_MS, FAIL_STREAK_LIMIT };
