/**
 * Web UI 服务器（零依赖）—— 小说下载工作台的后端。
 *
 * <p>业务目的：把引擎（novel-downloader.js）暴露为 HTTP API，前端页面轮询
 * 进度快照渲染界面；同时自动拉起 mock 模拟站，双击即可完整体验。</p>
 *
 * <p>接口：</p>
 * <ul>
 *   <li>GET  /            → web-ui.html 工作台页面</li>
 *   <li>GET  /api/state   → 任务状态快照（chapters/stats/logs/files）</li>
 *   <li>POST /api/start   → 启动一次下载任务（body: {bookName, epub}）</li>
 *   <li>GET  /api/preview/:n → 第 n 章正文纯文本（缓存或磁盘）</li>
 * </ul>
 *
 * <p>并发约束：同一时刻仅允许一个下载任务（running 标志位防重入），
 * 请求间共享引擎的全局限速器，避免并发任务叠加击穿 mock 站限流。</p>
 */
'use strict';

// libuv 线程池默认 4 线程，getaddrinfo(DNS) 占用线程池槽位；
// 体检 64/搜索 256 并发时死源 DNS 超时会在 4 槽上排队（实测 256 个新域名 5s 跑不完）。
// 必须在其他 require 触发线程池初始化之前设置才生效
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '32';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const engine = require('./novel-downloader');
const mockSite = require('./mock-novel-site');
const localImport = require('./local-import');
const { SourceHealth, isSearchCandidate } = require('./source-health');

const UI_PORT = 8735;
// mock 端口可用环境变量改道：默认 8734；当本机已有 exe 实例占着 8734（会复用旧 mock，
// 新夹具不生效）时，测试场景用 MOCK_PORT 起独立模拟站
const MOCK_PORT = Number(process.env.MOCK_PORT) || 8734;
const SOURCE_FILE = path.join(__dirname, 'book-source.json');
let sources = engine.loadBookSources(SOURCE_FILE);

// 内置 JS 书源模块（函数规则，无法经 JSON 导入）：启动时并入书源注册表。
// 2026-09-24 按需求移除全部内置源：purepen 此前已按体检结果移出；
// wikisource（维基文库·公版书）已注销注册（文件已归档 backup/cleanup-2026-09-24/sources/，
// 不再出现在书源列表）；demo 双源随 book-source.json 清空一并移除
const BUILTIN_SOURCE_MODULES = [];
for (const rel of BUILTIN_SOURCE_MODULES) {
  try {
    const loaded = require(path.join(__dirname, rel));
    const mods = Array.isArray(loaded) ? loaded : [loaded];
    // 境外站点（wikisource）在国内网络常不可达，默认禁用，用户可手动启用
    for (const mod of mods) {
      if (mod.bookSourceUrl.includes('wikisource')) mod.enabled = false;
      if (!sources.some((s) => s.bookSourceName === mod.bookSourceName)) {
        sources.push(mod);
      }
    }
  } catch (e) {
    console.error(`[ui] 内置书源 ${rel} 加载失败:`, e.message);
  }
}
loadUserSources();   // 恢复上次会话导入的 Legado 源（outputRoot 下可写文件）

// 书源健康度：白名单持久化在 outputRoot 下，搜索只打存活源；体检结果跨重启保留
const sourceHealth = new SourceHealth(path.join(outputRoot(), 'source-health.json'),
  (m) => log(m));

// 白名单磨光保护：降级只出不进（恢复靠体检），搜索期失败会让白名单持续缩水；
// 存活源跌破可搜索源两成时自动补一轮体检，防止白名单磨光后"搜索 0 结果"假死
async function ensureWhitelistFresh() {
  const enabled = sources.filter((s) => isSearchCandidate(s)).length;
  const alive = Object.values(sourceHealth.byUrl).filter((s) => s.state === 'alive').length;
  if (enabled > 0 && alive < enabled * 0.2 && !sourceHealth.probing) {
    log(`[健康度] 白名单存活 ${alive}/${enabled} 已低于 20%，自动触发体检补充白名单…`);
    try { await sourceHealth.probeAll(sources, 64, engine.searchBook); } catch (e) { /* 体检中或失败不阻断搜索 */ }
  }
}

// 用户书源持久化：pkg 快照 FS 只读，写入 outputRoot() 下的可写文件；
// 函数型内置书源由代码管理不落盘，Legado 包装源落盘时剥离包装保留原始 JSON
function userSourcesFile() { return path.join(outputRoot(), 'user-book-sources.json'); }
function saveSources() {
  const serializable = sources
    .filter((s) => typeof (s.ruleSearch && s.ruleSearch.bookList) !== 'function')
    .map((s) => s._legado ? s._legado.source : s);
  try { fs.writeFileSync(userSourcesFile(), JSON.stringify({ bookSources: serializable }, null, 2)); } catch (e) { console.error('[ui] 用户书源保存失败:', e.message); }
}
function loadUserSources() {
  // 历史版本把用户书源写在不同位置（output/ 子目录、exe 同目录）；按当前 outputRoot
  // 优先逐个回退读取，防止程序升级后用户已导入的 1200+ 书源因文件搬家而"消失"
  const candidates = [
    userSourcesFile(),
    path.join(__dirname, 'output', 'user-book-sources.json')
  ];
  let raw = null;
  for (const f of candidates) {
    try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch (e) { /* 该位置无文件，试下一个 */ }
  }
  if (!raw) return;   // 所有位置均无用户书源，按首次使用处理
  const arr = Array.isArray(raw.bookSources) ? raw.bookSources : [];
  for (const lg of arr) {
    // 名称+URL 联合判重：与导入接口同口径，同名不同站点都保留
    if (sources.some((s) => s.bookSourceName === (lg.bookSourceName || '')
      && s.bookSourceUrl === lg.bookSourceUrl)) continue;
    const w = engine.legadoAdapter.wrapLegado(lg);
    if (w) sources.push(w);
  }
}

/** 全局异常兜底：任何未捕获错误写日志文件后退出——
 *  uncaughtException 后进程状态不可信，继续服务可能用损坏状态响应；
 *  打包态没有开发控制台，crash.log 是唯一现场，写完即退出让用户重启获得干净进程 */
/** crash.log 追加写入（>1MB 先滚动归档为 crash.log.1，防只增不减撑大磁盘） */
function appendCrashLog(line) {
  const f = path.join(outputRoot(), 'crash.log');
  try {
    if (fs.existsSync(f) && fs.statSync(f).size > 1024 * 1024) {
      try { fs.renameSync(f, f + '.1'); } catch (_) { /* 归档失败继续追加 */ }
    }
    fs.appendFileSync(f, line);
  } catch (_) { /* 日志都写不进时只能放弃 */ }
}
process.on('uncaughtException', (e) => {
  appendCrashLog(`${new Date().toISOString()} ${e.stack || e.message}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  appendCrashLog(`${new Date().toISOString()} [rejection] ${(e && e.stack) || e}\n`);
});

/** 打包态识别：pkg 把快照文件挂在 /snapshot 前缀下；此时输出目录取 exe 所在目录，
 *  保证用户能在 Windows 资源管理器里直接看到下载结果。开发态维持 __dirname/output。 */
function outputRoot() {
  const frozen = process.pkg || /[/\\]snapshot[/\\]/.test(__dirname);
  return frozen ? path.dirname(process.execPath) : __dirname;
}

// ---- 任务状态：仅内存态，重启即失；落盘产物在 output/ 不受影响 ----
const state = {
  running: false,
  bookName: null,
  // 书源名/作者随快照下发：前端头卡（封面+书名+作者·来源）依赖三者渲染，
  // 队列自动续跑切书/追更启动时头卡才能同步切换（实测追更后头卡残留上一本书）
  sourceName: null,
  author: '',
  coverUrl: '',          // 封面地址（2026-10-08）：搜索选书随 /api/start 下发，快照/头卡/书架共用
  catalogKey: null,
  chapters: [],        // [{n,title,state:'pending|downloading|downloaded|failed|cached',error}]
  stats: { total: 0, done: 0, failed: 0, pending: 0 },
  logs: [],            // {t, msg}
  files: null,         // {dir, txtPath, epubPath}
  startedAt: null, finishedAt: null,
  lastResult: null,
  cancelToken: null,      // 当前任务的取消令牌（/api/stop 置位），任务结束清空
  tocUrl: null,           // 当前任务目录页地址（SSE rate 字段据此定位限速 host）
  minIntervalMs: 0,       // 当前任务生效基础间隔（rate.effIntervalMs = 它 × slow）
  libraryUpdates: {}      // 追更检查结果：{dirName: {newChapters, checkedAt, error}}
};

// ---- 下载队列（2026-09-28 新增）：内存态数组，上限 5。
// 任务运行中再调 /api/start 且校验通过即入队；当前任务到终态（完成/失败/
// 用户取消/熔断暂停——后两者同属终态）后自动出队启动下一个。
// 排队任务不支持单独取消（保持简单：取消=停当前任务，队列自动续跑）；
// 与任务状态同为纯内存态，重启即丢——不为此引入新的持久化面 ----
const taskQueue = [];
const TASK_QUEUE_MAX = 5;
function queueSnapshot() {
  // 快照只带书名与位次：manualChapters 等大字段绝不离开内存队列
  return taskQueue.map((q, i) => ({ bookName: q.bookName, position: i + 1 }));
}

// 启动即惰性清理：剔除不在当前注册表的健康度尸体记录（如已移除的 mock 站），
// 否则书源管理顶栏「存活 X / 共 Y」分母虚高（实测残留记录导致「存活 6 / 共 7」）。
// 必须放在 state 初始化之后：prune 的日志回调引用 state.logs（TDZ 实测崩启动）
sourceHealth.prune(new Set(sources.map((s) => s.bookSourceUrl)));

// ---------------------------------------------------------------------------
// 书架中心支撑函数：目录扫描缓存 / 元数据 / 回收站 / 追更
// ---------------------------------------------------------------------------

/** JSON 响应快捷写出（书架接口组统一走 JSON，配合前端 api() 的 r.json()） */
function replyJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** 目录名安全校验：只允许 output 的直接子目录名，拒绝分隔符/点段/回收站名自身 */
const TRASH_NAME = '_回收站';
function isSafeDirName(dirName) {
  return !!dirName && !/[\\/]/.test(dirName) && !dirName.includes('..') && dirName !== TRASH_NAME;
}

/** 收集书籍成品文件为 zip 条目（批量导出/整库备份共用）。
 *  只打成品：全书合并.txt + manifest.json + book.json + *.epub
 *  （单章文件量大且无独立价值）；返回 {entries, totalBytes} 供内存上限判定 */
function collectBookEntries(dirNames, maxBytes) {
  // 两阶段护栏（2026-09-29 架构审查 中）：先 statSync 累计体积、超限快速拒绝——
  // 旧实现先 readFileSync 全量读入内存再判上限，护栏挡不住读取阶段的内存尖峰
  // 与事件循环阻塞（数百 MB 串行读期间 SSE 停摆）；确认不超限后才读文件
  const outDir = path.join(outputRoot(), 'output');
  const files = [];
  let totalBytes = 0;
  const collect = (zipName, fp) => {
    try {
      const st = fs.statSync(fp);
      if (!st.isFile()) return;
      totalBytes += st.size;
      files.push({ zipName, fp });
    } catch (e) { /* 文件转瞬即逝按不存在处理 */ }
  };
  for (const dirName of dirNames) {
    if (!isSafeDirName(dirName)) continue;
    const dir = path.join(outDir, dirName);
    if (!fs.existsSync(dir)) continue;
    for (const f of ['全书合并.txt', 'manifest.json', 'book.json']) {
      collect(`${dirName}/${f}`, path.join(dir, f));
    }
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.epub'))) {
      collect(`${dirName}/${f}`, path.join(dir, f));
    }
    if (maxBytes && totalBytes > maxBytes) return { entries: [], totalBytes, overLimit: true };
  }
  const entries = files.map((x) => engine.zipEntry(x.zipName, fs.readFileSync(x.fp)));
  return { entries, totalBytes };
}

// ---- 书架扫描：30s 内存缓存，写操作失效 ----
let libCache = { at: 0, books: null };
function invalidateLibCache() { libCache.at = 0; }
function dirSizeBytes(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { total += fs.statSync(path.join(dir, f)).size; } catch (e) { /* 文件转瞬即逝按 0 计 */ }
    }
  } catch (e) { /* 目录不可读按 0 计 */ }
  return total;
}
function getLibrary() {
  if (libCache.books && Date.now() - libCache.at < 30000) return libCache.books;
  const outDir = path.join(outputRoot(), 'output');
  const books = [];
  try {
    for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === TRASH_NAME) continue;
      const dir = path.join(outDir, entry.name);
      const mf = path.join(dir, 'manifest.json');
      if (!fs.existsSync(mf)) continue;
      let chapters = 0;
      try { chapters = Object.keys(JSON.parse(fs.readFileSync(mf, 'utf8'))).length; } catch (e) { /* manifest 损坏按 0 计 */ }
      const dash = entry.name.indexOf('-');
      const epubFile = fs.readdirSync(dir).find((f) => f.endsWith('.epub')) || null;
      // 作者/封面取自 book.json（头卡/书架卡展示用）；历史书无 book.json 或字段缺失即空串
      let author = '';
      let coverUrl = '';
      let tocOk = false;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8'));
        author = meta.author || '';
        coverUrl = typeof meta.coverUrl === 'string' ? meta.coverUrl : '';
        tocOk = /^https?:\/\//.test(meta.tocUrl || '');
      } catch (e) { /* 无 book.json 按空值 */ }
      // 本地封面（EPUB 导入提取）：cover.* 文件存在则经 /api/library/cover 出图
      let coverFile = fs.readdirSync(dir).find((f) => /^cover\.[a-z0-9]+$/i.test(f)) || null;
      books.push({
        dirName: entry.name,
        source: dash > 0 ? entry.name.slice(0, dash) : '',
        name: dash > 0 ? entry.name.slice(dash + 1) : entry.name,
        author,
        coverUrl,
        coverFile,
        chapters,
        sizeBytes: dirSizeBytes(dir),
        hasTxt: fs.existsSync(path.join(dir, '全书合并.txt')),
        hasEpub: !!epubFile,
        // 追更能力标记：book.json 在 2026-09-24 后才开始落盘，历史书没有则不可追更；
        // 本地导入书有 book.json 但无 tocUrl，同样不可追更（防追更入口点了报错）
        canUpdate: tocOk,
        mtime: fs.statSync(dir).mtimeMs
      });
    }
  } catch (e) { /* output 目录不存在时返回空书架 */ }
  books.sort((a, b) => b.mtime - a.mtime);
  libCache = { at: Date.now(), books };
  return books;
}

// ---- 书架元数据：标签/收藏/阅读进度，落 output/library-meta.json ----
function libMetaFile() { return path.join(outputRoot(), 'output', 'library-meta.json'); }
function loadLibMeta() {
  try {
    const raw = JSON.parse(fs.readFileSync(libMetaFile(), 'utf8'));
    if (raw && typeof raw === 'object' && raw.books) return raw;
  } catch (e) { /* 无文件或损坏按空元数据 */ }
  return { books: {} };
}
function saveLibMeta(meta) {
  try { fs.writeFileSync(libMetaFile(), JSON.stringify(meta, null, 2)); }
  catch (e) { console.error('[ui] 书架元数据保存失败:', e.message); }
}

// ---- 回收站：删除即移动到 output/_回收站，可恢复/可清空 ----
function trashRoot() { return path.join(outputRoot(), 'output', TRASH_NAME); }
function moveToTrash(dirName) {
  const outDir = path.join(outputRoot(), 'output');
  const src = path.join(outDir, dirName);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    return { code: 404, error: '书籍目录不存在（可能已被删除，请刷新书架）' };
  }
  const tDir = trashRoot();
  fs.mkdirSync(tDir, { recursive: true });
  // 同名冲突加时间戳后缀：回收站可容同一本书的多个历史版本
  let trashName = dirName;
  if (fs.existsSync(path.join(tDir, trashName))) {
    trashName = `${dirName}__${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  }
  try {
    fs.renameSync(src, path.join(tDir, trashName));
  } catch (e) {
    const hint = (e.code === 'EBUSY' || e.code === 'EPERM')
      ? '文件可能正被阅读器或其他程序占用，请关闭后重试' : e.message;
    return { code: 500, error: `删除失败: ${hint}` };
  }
  invalidateLibCache();
  return { ok: true };
}
function listTrash() {
  const tDir = trashRoot();
  const items = [];
  try {
    for (const entry of fs.readdirSync(tDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(tDir, entry.name);
      let chapters = 0;
      try { chapters = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))).length; } catch (e) { /* 无 manifest */ }
      // 还原原始书名：剥掉移动时可能加的 __时间戳 后缀
      const origName = entry.name.replace(/__\d{14}$/, '');
      const dash = origName.indexOf('-');
      items.push({
        trashName: entry.name,
        name: dash > 0 ? origName.slice(dash + 1) : origName,
        chapters,
        sizeBytes: dirSizeBytes(dir),
        mtime: fs.statSync(dir).mtimeMs
      });
    }
  } catch (e) { /* 回收站不存在即空 */ }
  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}
function restoreFromTrash(trashName) {
  const outDir = path.join(outputRoot(), 'output');
  const src = path.join(trashRoot(), trashName);
  if (!fs.existsSync(src)) return { code: 404, error: '回收站中不存在该项' };
  const dirName = trashName.replace(/__\d{14}$/, '');
  const dest = path.join(outDir, dirName);
  if (fs.existsSync(dest)) return { code: 409, error: `书架已存在「${dirName}」，请先处理重名书籍` };
  try { fs.renameSync(src, dest); }
  catch (e) { return { code: 500, error: '恢复失败: ' + e.message }; }
  invalidateLibCache();
  return { ok: true, dirName };
}
/** 删除失败原因格式化：识别 WorkBuddy 托管进程的安全护栏（agent 启动的服务
 *  删除 >50 文件的目录会被 SAFE_DELETE_BULK_CONFIRM_REQUIRED 拦截，2026-09-28 实测），
 *  给出可操作的指引；用户自行启动的服务（node/exe）无此护栏 */
function deleteFailHint(e) {
  if (/safe-delete|SAFE_DELETE/i.test((e && e.message) || '')) {
    return '当前服务由 AI 助手托管启动，环境安全护栏拦截了批量删除；请自行启动服务（node web-ui.js 或打包 exe）后重试';
  }
  return (e && (e.code === 'EBUSY' || e.code === 'EPERM')) ? '文件被占用，请关闭后重试' : String((e && e.message) || e);
}
function purgeTrashItem(trashName) {
  const target = path.join(trashRoot(), trashName);
  if (!fs.existsSync(target)) return { code: 404, error: '回收站中不存在该项' };
  try { fs.rmSync(target, { recursive: true, force: true }); }
  catch (e) {
    return { code: 500, error: '彻底删除失败: ' + deleteFailHint(e) };
  }
  invalidateLibCache();
  return { ok: true };
}

// ---- 手动链接目录抓取：单页解析 + 分页「下一页」跟随（上限 30 页，防分页环）----
// 供 /api/parse-link 与手动书籍追更共用；返回 {bookName, chapters, pages, filteredNoise}，
// 章节号统一按文档序重排（分页合并后各页编号可能冲突，顺序编号恒稳定）；
// filteredNoise 为各页噪声过滤（广告孤立链接）剔除条数之和，透传给前端提示
async function fetchGenericToc(pageUrl) {
  // 与书源抓取同管道（限速/重试/编码三级探测），超时 12s 防劣质站点拖死解析；
  // UA 伪装浏览器（默认 UA 自报爬虫身份，目录页请求同样会被反爬计数）；
  // browserLike：目录页请求同样携带浏览器头套件 + Cookie 会话（与章节下载同指纹）
  const fetchOpt = { timeoutMs: 12000, maxRetries: 1, retryBaseDelayMs: 800, minIntervalMs: 0,
    browserLike: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' } };
  let html = await engine.fetchWithRetry(pageUrl, fetchOpt);
  const parsed = engine.parseGenericToc(html, pageUrl);
  const merged = [...parsed.chapters];
  let filteredNoise = parsed.filteredNoise || 0;
  const visited = new Set([pageUrl]);
  let pages = 1;
  let next = engine.findNextTocPage(html, pageUrl);
  while (next && !visited.has(next) && pages < 30) {
    visited.add(next);
    pages++;
    const h = await engine.fetchWithRetry(next, fetchOpt);
    const p = engine.parseGenericToc(h, next);
    filteredNoise += p.filteredNoise || 0;
    const known = new Set(merged.map((c) => c.url));
    const fresh = p.chapters.filter((c) => !known.has(c.url));
    if (!fresh.length) break;
    merged.push(...fresh);
    next = engine.findNextTocPage(h, next);
  }
  return {
    bookName: parsed.bookName || '',
    reason: parsed.reason,
    pages,
    filteredNoise,
    chapters: merged.map((c, i) => ({ n: i + 1, title: c.title, url: c.url }))
  };
}

// ---- 追更：比对在线目录与本地 manifest 的章节差 ----
async function checkBookUpdates(dirName) {
  const dir = path.join(outputRoot(), 'output', dirName);
  const bookFile = path.join(dir, 'book.json');
  if (!fs.existsSync(bookFile)) return { error: '该书无追更信息（2026-09-24 之前下载的书缺少 book.json），重新下载一次即可开启追更' };
  const book = JSON.parse(fs.readFileSync(bookFile, 'utf8'));
  // 手动链接书籍：无注册书源，直接对原目录页重新做启发式解析比对；
  // 章节清单随响应下发，前端一键追更时转交 /api/start 手动模式
  if (book.sourceName === '手动链接') {
    const parsed = await fetchGenericToc(book.tocUrl);
    let localCountM = 0;
    try { localCountM = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))).length; } catch (e) { /* 按 0 计 */ }
    const newChaptersM = Math.max(0, parsed.chapters.length - localCountM);
    state.libraryUpdates[dirName] = { newChapters: newChaptersM, checkedAt: Date.now() };
    return { dirName, bookName: book.bookName, sourceName: book.sourceName, tocUrl: book.tocUrl,
      remoteChapters: parsed.chapters.length, localChapters: localCountM, newChapters: newChaptersM,
      manual: true, chapters: parsed.chapters };
  }
  const src = sources.find((s) => s.bookSourceName === book.sourceName);
  if (!src) return { error: `书源「${book.sourceName}」已不存在，无法追更` };
  // 用户导入的原生 JSON 源可能没有 option 字段，timeoutMs 缺省必须兜底
  const html = await engine.fetchPage(book.tocUrl,
    { timeoutMs: 10000, ...(src.option || {}), responseType: src.responseType });
  const toc = engine.parseCatalog(html, src);
  let localCount = 0;
  try { localCount = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))).length; } catch (e) { /* 按 0 计 */ }
  const newChapters = Math.max(0, toc.length - localCount);
  state.libraryUpdates[dirName] = { newChapters, checkedAt: Date.now() };
  return { dirName, bookName: book.bookName, sourceName: book.sourceName, tocUrl: book.tocUrl,
    remoteChapters: toc.length, localChapters: localCount, newChapters };
}

// 定时追更巡检：每 30 分钟静默检查全部可追更书籍（只检查不下载），
// 有更新的书在书架显示红点，用户一键追更（走 /api/start 断点续传只下新章）
async function checkAllUpdates() {
  const books = getLibrary().filter((b) => b.canUpdate);
  if (!books.length) return;
  log(`[追更] 开始巡检 ${books.length} 本可追更书籍…`);
  for (const b of books) {
    try {
      const r = await checkBookUpdates(b.dirName);
      if (r.newChapters > 0) log(`[追更] 《${b.name}》发现 ${r.newChapters} 章更新`);
    } catch (e) {
      state.libraryUpdates[b.dirName] = { newChapters: 0, checkedAt: Date.now(), error: e.message };
    }
  }
}
// 启动 15s 后首检，之后每 30 分钟一轮；unref 不阻止进程退出
setTimeout(() => {
  checkAllUpdates().catch(() => {});
  setInterval(() => checkAllUpdates().catch(() => {}), 30 * 60 * 1000).unref();
}, 15000).unref();


// SSE 的章节整包与增量事件分离：千章大书只在目录重建时推完整 chapters，
// 每章完成仅推送 n/state/error，避免每秒序列化和重建整份章节列表。
const chapterEvents = [];
let chapterVersion = 0;
let chaptersDirty = false;

function markChaptersDirty() {
  chapterEvents.length = 0;
  chaptersDirty = true;
  chapterVersion++;
}

function pushChapterEvent(n, chapterState, error) {
  chapterEvents.push({ n, state: chapterState, error: error || null });
}

function log(msg) {
  state.logs.push({ t: new Date().toISOString().substring(11, 19), msg });
  if (state.logs.length > 200) state.logs.shift();
}

// ---- SSE 客户端与推送去重：进度推送与整包推送分离 ----
// 整包 state 含全部章节行（千章大书序列化后数百 KB），高频重推浪费带宽与 CPU；
// 章节进度只经轻量 progress 快照（stats+日志尾部），首次连接/章节清单重建时才推整包
const sseClients = new Set();
let lastPushedState = '';
let errorSeq = 0;   // 任务失败事件序号：递增供前端去重弹窗，避免瞬时值被 SSE 丢失
/** 限速状态快照（SSE rate 字段，2026-10 迭代 F2）：任务运行中且能定位 host 时
 *  返回七字段对象，否则 null。在现有 500ms tick 内同步计算，不新增定时器；
 *  字段小（引擎侧只读快照），序列化成本可忽略。
 *  winRemainingMs 语义：距下一个请求名额释放的毫秒数（滑动窗口下 = 最早请求
 *  滑出窗口的剩余时间，未满窗为 0）；无窗口限速的源 winCount/maxPerMin/winRemainingMs 为 null */
function rateSnapshot() {
  if (!state.running || !state.tocUrl) return null;
  let host;
  try { host = new URL(state.tocUrl).host; } catch (e) { return null; }
  const snap = engine.getHostRate(host);
  if (!snap) return null;   // 任务刚启动尚未发出首个请求：门未建立
  const slow = snap.slow || 1;
  return {
    host: snap.host,
    slow,
    effIntervalMs: Math.round((state.minIntervalMs || 0) * slow),
    downgraded: slow > 1.5,
    winCount: snap.winCount,
    maxPerMin: snap.maxPerMin,
    winRemainingMs: snap.winRemainingMs
  };
}

function snapshot(includeChapters = true) {
  return {
    running: state.running, bookName: state.bookName,
    sourceName: state.sourceName, author: state.author, coverUrl: state.coverUrl,
    stats: state.stats, logs: state.logs.slice(-30),
    startedAt: state.startedAt, finishedAt: state.finishedAt,
    files: state.files,
    lastError: state.lastError,
    rate: rateSnapshot(),
    chapters: includeChapters ? state.chapters : null,
    chapterVersion,
    queue: queueSnapshot(),
    searchProgress: state.searchProgress || null,
    // 搜索结果推送截断 200 条：先到先得场景首屏足够，全量大数组每 500ms
    // 全量序列化是无谓 CPU（搜索早停阈值 50 本，截断不影响展示完整性）
    searchResults: state.searchResults ? state.searchResults.slice(0, 200) : null
  };
}

function progressSnapshot(includeEvents = true) {
  return {
    running: state.running, bookName: state.bookName,
    sourceName: state.sourceName, author: state.author, coverUrl: state.coverUrl,
    stats: state.stats, logs: state.logs.slice(-30),
    startedAt: state.startedAt, finishedAt: state.finishedAt,
    files: state.files,
    lastError: state.lastError,
    rate: rateSnapshot(),
    chapterVersion,
    // undefined 会被 JSON.stringify 丢弃：基准快照不含事件字段
    chapterEvents: includeEvents ? chapterEvents.slice() : undefined,
    queue: queueSnapshot(),
    searchProgress: state.searchProgress || null,
    searchResults: state.searchResults ? state.searchResults.slice(0, 200) : null
  };
}

function broadcastSse(serialized) {
  for (const client of sseClients) {
    try { client.write(`data: ${serialized}\n\n`); } catch (e) { sseClients.delete(client); }
  }
}

setInterval(() => {
  if (sseClients.size === 0) {
    chapterEvents.length = 0;
    return;
  }
  if (chaptersDirty) {
    chaptersDirty = false;
    chapterEvents.length = 0;
    lastPushedState = JSON.stringify(progressSnapshot(false));   // 与常规分支同口径：基准不含事件
    broadcastSse(JSON.stringify(snapshot(true)));
    return;
  }

  // 基准快照不含章节事件：比对基准与广播帧同源，事件以字符串拼接注入——
  // 旧实现广播后清空事件再全量序列化一次作基准，每轮恒两次全量序列化（SSE 卡顿源）
  const baseStr = JSON.stringify(progressSnapshot(false));
  const hasEvents = chapterEvents.length > 0;
  if (!hasEvents && baseStr === lastPushedState) return;
  const events = hasEvents ? chapterEvents.slice() : null;
  chapterEvents.length = 0;
  lastPushedState = baseStr;
  broadcastSse(events
    ? baseStr.slice(0, -1) + ',"chapterEvents":' + JSON.stringify(events) + '}'
    : baseStr);
}, 500);

// ---- mock 站自动拉起：打包后 process.execPath 指向 exe 自身，spawn 子进程方案失效，
//      故改为同进程 require 启动；探活逻辑由 mockSite.start 内部处理 ----
function ensureMockSite() {
  return mockSite.start(MOCK_PORT);
}

/** 手动模式速度档位（2026-10 迭代「知情自选速度」）：仅手动模式生效，
 *  书源模式忽略——书源声明的 minIntervalMs 是书源作者对站点的承诺，不开放用户档位。
 *  依据迭代方案档位参数表：均衡档 300+300/90 仍在 shudugu 实测封禁线
 *  （400ms 固定间隔 ~150 请求/分钟）之下；极速档 150+150/120 贴近封禁线，
 *  依赖自适应降速/Retry-After/熔断三道动态防线兜底（三档共有，不可削弱） */
const SPEED_PROFILES = {
  conservative: { minIntervalMs: 500, jitterMs: 500, maxPerMin: 60 },
  balanced:     { minIntervalMs: 300, jitterMs: 300, maxPerMin: 90 },
  fast:         { minIntervalMs: 150, jitterMs: 150, maxPerMin: 120 }
};
const SPEED_PROFILE_DEFAULT = 'balanced';

/** 档位合法性校验：必须用 hasOwnProperty 而非 SPEED_PROFILES[p] 真值判断——
 *  后者被原型链成员绕过（"constructor"/"toString"/"hasOwnProperty"/"__proto__"
 *  均解析为继承来的真值，QA 实测可绕过 400 使限速瓦解到 120ms/无窗口上限） */
function isValidSpeedProfile(p) {
  return Object.prototype.hasOwnProperty.call(SPEED_PROFILES, p);
}

/** 手动链接模式的一次性合成源（manual 标记）：正文提取走引擎启发式容器识别。
 *  从 /api/start 抽出供 launchTask 复用——队列只存纯数据，出队时据此重建合成源。
 *  speedProfile 决定 minIntervalMs/jitterMs/maxPerMin 三参数（调用方已校验合法性，
 *  此处 hasOwnProperty 复查兜底——队列项同为外部输入的延伸，不信任单一校验点） */
function buildManualSource(manualChapters, tocUrl, speedProfile) {
  const profile = isValidSpeedProfile(speedProfile)
    ? SPEED_PROFILES[speedProfile] : SPEED_PROFILES[SPEED_PROFILE_DEFAULT];
  return {
    bookSourceName: '手动链接',
    bookSourceUrl: new URL(manualChapters[0].url).origin,
    manual: true,
    // 手动站点质量未知，反爬策略（借鉴怠惰下载器 + GitHub 反反爬调研 + shudugu 封禁实测）：
    // ① 间隔+抖动——固定节奏是机器指纹；三档间隔见 SPEED_PROFILES；
    // ② 每分钟窗口上限——shudugu 实测 400ms 固定间隔 ~93 章/37s 触发整站封禁，
    //    窗口计数型反爬只限总量才有效；
    // ③ 连续 3 章反爬型失败熔断自动暂停——封禁窗口内续发只会白烧章节加深封禁；
    // ④ 浏览器 UA + 目录页 Referer——默认 UA「NovelDownloaderDemo」自报爬虫身份，
    //    浏览器插件天然带真实 UA/Referer，Node 端须显式补齐；
    // ⑤ browserLike 三件套（2026-09-24 调研落地）：浏览器请求头套件（Accept/Sec-Fetch-* 等，
    //    裸 Node 缺头本身就是指纹）+ Cookie 会话保持（无会话连续请求是机器人信号）
    //    + 自适应降速（429/403/封禁信号自动加倍间隔、遵守 Retry-After，成功缓慢回落）
    option: { timeoutMs: 10000, maxRetries: 2, retryBaseDelayMs: 1000,
      minIntervalMs: profile.minIntervalMs, jitterMs: profile.jitterMs,
      maxPerMin: profile.maxPerMin, banCircuitThreshold: 3,
      browserLike: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Referer': String(tocUrl || '').slice(0, 2000)
      } }
  };
}

/** 启动一个下载任务（/api/start 立即执行与队列出队共用入口）：统一走 startTask 全流程
 *  （断点校验、state 初始化、SSE 推送）；结束后经 afterTaskSettled 自动出队续跑。
 *  preLogMsg：需在 state.logs 重置后补写的前置日志（出队提示）——直接在此 log()
 *  会被 startTask 的 state.logs=[] 清掉（QA P3-1：排队任务「任务开始」日志丢失） */
function launchTask(q, preLogMsg) {
  let source;
  if (q.manual) {
    // 档位随队列项透传：排队任务出队后仍按用户入队时选择的档位执行
    source = buildManualSource(q.manualChapters, q.tocUrl, q.speedProfile);
  } else {
    source = sources.find((s) => s.bookSourceName === q.sourceName);
    if (!source) {
      // 排队期间书源被删除：跳过该任务并继续出队，不阻塞后续排队任务
      log(`[队列] 《${q.bookName}》的书源「${q.sourceName}」已不存在，跳过该任务`);
      state.lastError = { seq: ++errorSeq,
        msg: `排队任务《${q.bookName}》被跳过：书源「${q.sourceName}」已不存在` };
      startNextQueued();
      return;
    }
  }
  // 取消令牌随任务生命周期创建/销毁：/api/stop 置位后引擎在领新章前退出
  state.cancelToken = { cancelled: false };
  startTask(source, q.bookName, q.wantEpub, outputRoot(), q.tocUrl, q.concurrency,
    q.author, q.manual ? q.manualChapters : null, preLogMsg, q.coverUrl)
    .then(afterTaskSettled, (e) => {
      // startTask 内部已全量兜底（try/catch/finally 不向外抛），此分支理论不可达，
      // 防御性落 crash.log 并继续出队，保证队列不因单个异常任务卡死
      appendCrashLog(`${new Date().toISOString()} [task] ${(e && e.stack) || e}\n`);
      startNextQueued();
    });
}

/** 任务终态后的统一收尾：按结果重建章节清单（含缓存章与失败章），再自动出队 */
function afterTaskSettled() {
  if (state.lastResult) {
    state.chapters = state.lastResult.results.map((r) => ({
      n: r.n, title: r.title,
      state: r.file ? (r.fresh ? 'downloaded' : 'cached') : 'failed',
      error: null
    }));
    markChaptersDirty();
  }
  startNextQueued();
}

/** 出队启动下一个排队任务：当前任务到达终态（完成/失败/用户取消/熔断暂停）后调用。
 *  出队日志经 preLogMsg 透传，由 startTask 在 state.logs 重置后补写（否则被清空） */
function startNextQueued() {
  if (state.running || !taskQueue.length) return;
  const next = taskQueue.shift();
  launchTask(next, `[队列] 自动开始排队任务：《${next.bookName}》（队列剩余 ${taskQueue.length} 个）`);
}

// ---- 下载任务编排：调用引擎 downloadBook，hooks 实时回写 state ----
// manualChapters：手动链接模式的预解析目录（引擎据此跳过目录抓取），书源模式为 null
async function startTask(source, bookName, wantEpub, outRoot, tocUrl, concurrency, author, manualChapters = null, preLogMsg = null, coverUrl = '') {
  if (state.running) throw new Error('已有任务在运行中');
  state.running = true;
  state.bookName = bookName;
  state.sourceName = source.bookSourceName || null;
  state.author = author || '';
  state.coverUrl = coverUrl || '';
  state.logs = [];
  // 出队提示等前置日志在重置后补写，保证排队任务的完整日志链在 SSE 可见
  if (preLogMsg) log(preLogMsg);
  state.startedAt = Date.now();
  state.finishedAt = null;
  state.files = null;
  state.lastResult = null;
  // 同一本书的目录已在 /api/bookinfo 预载时保留列表；点击下载只重置进度，不清空目录。
  // 不同书或目录缺失时才等待引擎 onChapters 重建，避免旧书章节串页。
  const requestedKey = `${source.bookSourceName}|${tocUrl}`;
  const canReuseCatalog = state.catalogKey === requestedKey && state.chapters.length > 0;
  if (!canReuseCatalog) {
    state.chapters = [];
    state.stats = { total: 0, done: 0, failed: 0, pending: 0, cached: 0 };
  } else {
    const downloaded = state.chapters.filter((ch) => ch.state === 'downloaded').length;
    const cached = state.chapters.filter((ch) => ch.state === 'cached').length;
    state.chapters = state.chapters.map((ch) => ({
      ...ch,
      state: ch.state === 'downloaded' || ch.state === 'cached' ? ch.state : 'pending',
      error: null
    }));
    state.stats = {
      total: state.chapters.length,
      done: downloaded,
      failed: 0,
      pending: state.chapters.length - downloaded - cached,
      cached
    };
  }
  markChaptersDirty();
  log(`任务开始: 《${bookName}》@${source.bookSourceName}${wantEpub ? '（含 EPUB）' : ''}`);

  try {
    // 目录预载已经把详情页解析成目录地址，这里不再重复请求详情页，减少开始下载前的等待。
    const realToc = tocUrl;
    // 并发由前端控制；同站限速按起始时间排队。80ms 兼顾速度与常见源站限流。
    const safeConcurrency = Math.min(16, Math.max(1, Number(concurrency) || 8));
    const sourceInterval = Number(source.option && source.option.minIntervalMs) || 120;
    // 手动链接站点反爬未知且普遍偏弱（shudugu 实测 80ms 打 60 章即封 IP），
    // 不适用高并发的 80ms 快车道，直接采用档位声明的间隔（2026-10 迭代：
    // 移除旧的 Math.max(300,…) 套底——fast 档 150ms 不能被套底回 300，
    // 档位下限本身已经方案评估，防封由自适应降速/Retry-After/熔断兜底）
    const minIntervalMs = source.manual
      ? sourceInterval
      : safeConcurrency >= 12 ? 80 : safeConcurrency >= 8 ? 80 : Math.max(80, sourceInterval);
    // 限速可视化（SSE rate 字段）依赖：当前任务 host 与生效基础间隔
    state.tocUrl = realToc;
    state.minIntervalMs = minIntervalMs;
    // 反爬熔断计数：见 onChapter failed 分支
    let banStreak = 0;
    // 封面预拉（2026-10-08）：下载开始前取好封面字节随 opt.coverData 带入引擎——
    // 建目录即落盘 cover.*，EPUB 导出直接嵌真实封面；10s 超时封顶不拖慢启动。
    // 失败仅记日志（大概率源站死链），完成后回调会再兜底试一次
    let coverData = null;
    if (coverUrl) {
      const got = await fetchCoverBuffer(coverUrl);
      if (got) coverData = { buf: got.buf, ext: coverExtOf(got.ct) };
      else log('封面拉取失败（可能为源站死链），不影响下载');
    }
    const r = await engine.downloadBook(source, bookName,
      {
        ...source.option,
        epub: wantEpub,
        outRoot,
        tocUrl: realToc,
        concurrency: safeConcurrency,
        minIntervalMs,
        author,
        coverData,
        cancelToken: state.cancelToken,
        manualChapters: manualChapters || undefined
      }, {
      onLog: (m) => log(m),
      // 目录解析完成即重建章节清单：下载进行中 UI 就能看到章节列表与缓存标记
      onChapters: (chList, cachedCount) => {
        state.chapters = chList.map((ch) => ({
          n: ch.n, title: ch.title,
          state: ch.cached ? 'cached' : 'pending', error: null
        }));
        state.stats = { total: chList.length, done: 0, failed: 0,
          pending: chList.length - cachedCount, cached: cachedCount };
        markChaptersDirty();
      },
      onChapter: (ch, st, info) => {
        // 目录解析完成时已按章节号建好 state.chapters，此处按 n 回写实时状态
        const row = state.chapters.find((c) => c.n === ch.n);
        if (!row) return;
        if (st === 'downloaded') { row.state = 'downloaded'; banStreak = 0; }
        else if (st === 'failed') {
          row.state = 'failed'; row.error = info;
          // 反爬熔断：连续跨域重定向失败说明站点已封禁当前 IP，继续打满剩余
          // 章节只会加深封禁且每章白等超时（shudugu 实测 302→google.com，10s/章），
          // 连发 8 次（约一波并发）即取消任务，已下章节保留断点可后续补抓
          if (/重定向至外域/.test(info || '')) {
            banStreak++;
            if (banStreak >= 8 && !state.cancelToken.cancelled) {
              state.cancelToken.cancelled = true;
              log('检测到站点反爬封禁（连续重定向至外域），已停止任务避免加重封禁；已下载章节保留断点，请稍后重试或用「补抓失败章」续传');
            }
          } else banStreak = 0;
        }
        pushChapterEvent(ch.n, row.state, row.error);
      },
      onProgress: (stats) => {
        state.stats = stats;
      }
    });
    // onChapter 只覆盖本轮实际请求的章节，缓存命中的章节从 results 补状态
    for (const res of r.results) {
      const row = state.chapters.find((c) => c.n === res.n);
      if (row && row.state === 'pending' && res.file) row.state = 'cached';
    }
    if (r.cancelled) {
      // 取消/熔断：保留断点与章节现状，不产出 files；pending 章回写为待下载
      state.stats = { total: state.chapters.length || r.chapters.length,
        done: r.okCount, failed: r.failedCount,
        pending: Math.max(0, (state.chapters.length || r.chapters.length) - r.okCount - r.failedCount - r.cachedCount),
        cached: r.cachedCount };
      if (r.banned) {
        log(`任务已自动暂停：连续触发站点反爬封禁，已下载 ${r.okCount} 章入断点；解封后重跑即续传`);
        // 复用 lastError 的 seq 推送让前端弹 toast——用户多半不盯着日志抽屉，
        // 封禁暂停必须主动告知，否则会误以为任务失败或卡死
        state.lastError = { seq: ++errorSeq,
          msg: `疑似被站点封禁：已自动暂停并保存断点（已存 ${r.okCount} 章），解封后点「开始下载」续传` };
      } else {
        log(`任务已取消: 已下载 ${r.okCount} 章入断点，重跑即续传`);
      }
    } else {
      // 任务结束 pending 恒为 0（done+failed+cached=total），原值错写为 failedCount
      state.stats = { total: r.chapters.length, done: r.okCount, failed: r.failedCount,
        pending: 0, cached: r.cachedCount };
      state.files = { dir: r.dir, txtPath: r.txtPath, epubPath: r.epubPath };
      // 追更元信息落盘：书架「检查更新/一键追更」依赖书源与目录地址，
      // manifest 只记章节不含 tocUrl，故任务完成时单独写 book.json；
      // coverUrl 合并旧值：追更重下不带封面参数时不丢书架封面
      let prevCover = '';
      try { prevCover = JSON.parse(fs.readFileSync(path.join(r.dir, 'book.json'), 'utf8')).coverUrl || ''; } catch (e) { /* 无旧元信息 */ }
      const effCover = state.coverUrl || prevCover || '';
      // 封面落盘（2026-10-08）：书架/EPUB 优先本地 cover.*，远程图死链不影响已下载书；
      // 已有本地封面不重复拉（封面不会变，省流量）。失败静默——封面是锦上添花
      if (effCover && !fs.readdirSync(r.dir).some((f) => /^cover\.[a-z0-9]+$/i.test(f))) {
        try {
          const got = await fetchCoverBuffer(effCover);
          if (got) {
            fs.writeFileSync(path.join(r.dir, 'cover.' + coverExtOf(got.ct)), got.buf);
            log('封面已保存到书籍目录');
          }
        } catch (e) { /* 封面拉取失败不影响下载结果 */ }
      }
      try {
        fs.writeFileSync(path.join(r.dir, 'book.json'), JSON.stringify({
          sourceName: source.bookSourceName, bookName, tocUrl: realToc,
          author: author || '', coverUrl: effCover, updatedAt: Date.now()
        }, null, 2));
      } catch (e) { /* 元信息写失败不影响下载结果 */ }
      invalidateLibCache();
      // lastResult 剥离正文只留元数据：全书文本常驻内存数十 MB 的问题（大书场景），
      // 预览改经 /api/preview 按需从磁盘读；fresh 由引擎按本轮实际下载成功标记，
      // 不能靠 text 驻留判定（非 EPUB 任务 text 恒空，曾致全章节误标 cached）
      state.lastResult = {
        ...r,
        results: r.results.map((x) => ({ n: x.n, title: x.title, file: x.file, fresh: !!x.fresh }))
      };
      log(`任务完成: 新下载 ${r.okCount} 章，缓存命中 ${r.cachedCount}，失败 ${r.failedCount}，共 ${r.chapters.length} 章`);
    }
  } catch (e) {
    log(`任务失败: ${e.message}`);
    // 失败原因带序号推给前端：finally 会同步清除 lastError，SSE 1 秒粒度根本来不及
    // 捕捉瞬时值（实测 toast 从未弹出）；改推递增序号，前端见到新序号即弹且只弹一次
    state.lastError = { seq: ++errorSeq, msg: e.message };
  } finally {
    state.running = false;
    state.finishedAt = Date.now();
    state.cancelToken = null;
  }
}

// ---- 封面上游取图（2026-10-08）：模块顶层供三处共用——/api/cover 代理、
// 下载完成封面落盘、EPUB 导出取真实封面。10s 超时 + 3MB 上限 + 仅 image/*
async function fetchCoverBuffer(target) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const resp = await fetch(target, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*,*/*;q=0.8' } });
    const ct = resp.headers.get('content-type') || '';
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!resp.ok || buf.length === 0 || buf.length > 3 * 1024 * 1024 || !ct.startsWith('image/')) return null;
    return { buf, ct };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** content-type → 落盘扩展名（封面文件名 cover.<ext>，getLibrary/readdirSync 按此识别） */
function coverExtOf(ct) {
  if (ct.includes('png')) return 'png';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('webp')) return 'webp';
  return 'jpg';
}

// ---- 静态与 API 路由 ----
/** 读取 POST body（受控上限防异常大请求） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 2 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** 二进制请求体读取（本地导入专用）：Buffer 直收不走字符串拼接（大文件拼接既慢
 *  又有 utf8 截断风险）；超限即毁连接。仅 /api/library/import 使用 */
function readBodyRaw(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { reject(new Error(`文件过大（上限 ${Math.round(cap / 1024 / 1024)}MB）`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 安全解析 JSON body：非法 JSON 返回 null（调用方统一回 400）。
 * 旧实现多处直接 JSON.parse，异常 body 会让 async 路由抛出 unhandledRejection，
 * 客户端连接挂起直到超时（可复现的正确性 bug），所有 POST 接口必须经此入口。
 */
function parseJsonBody(body) {
  if (!body) return {};
  try { return JSON.parse(body); } catch (e) { return null; }
}

/** 400 应答：请求体不是合法 JSON */
function replyBadJson(res) {
  res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: '请求体不是合法 JSON' }));
}

/** 工作台页面启动时读入内存：每请求 readFileSync 70KB 属无谓 IO（改动需重启生效）。
 *  注入随机 API token：写操作（POST）必须携带 X-Token 头。
 *  背景——服务监听 127.0.0.1 但浏览器可跨站发起到本机的请求（CSRF/DNS 重绑定）：
 *  恶意网页此前能直接 POST /api/sources/import 导入恶意书源，配合规则即代码
 *  （new Function 求值）形成本机 RCE 链路。跨站请求无法携带/读取自定义头，
 *  token 校验 + Host/Origin 白名单双保险即根治该面 */
const API_TOKEN = crypto.randomBytes(16).toString('hex');
/* 版本号上屏（2026-09-30 防呆）：多次「修复看不到」均为用户开着旧实例页面的版本罗生门，
   顶栏常显版本号后一眼可辨。发版流程：改此处版本串 → 重新 pkg 打包 */
const APP_VERSION = 'v62 · 2026-10-09';
const UI_HTML = Buffer.from(fs.readFileSync(path.join(__dirname, 'web-ui.html'), 'utf8')
  .replace('</head>', `<meta name="api-token" content="${API_TOKEN}">\n</head>`)
  .replace('<!--APP_VERSION-->', APP_VERSION), 'utf8');

// PWA 应用图标：启动时用引擎自带的最小 PNG 编码器生成一次缓存于内存
// （纯色金棕底 + 像素「书」字），供 /icon-192.png /icon-512.png 路由直接吐 Buffer
const APP_ICON_192 = engine.makeIconPng(192);
const APP_ICON_512 = engine.makeIconPng(512);

/** Host 白名单：仅本机回环地址（挡 DNS 重绑定——攻击者域名解析到 127.0.0.1 时 Host 非白名单） */
function isLocalHostHeader(host) {
  const h = String(host || '').split(':')[0].toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    // 路由统一错误出口：此前任何 async 路由抛错都会穿透为 unhandledRejection，
    // 客户端连接永久挂起直至超时（readBody 超限/路由异常均可复现）；
    // 统一回 500 并落 crash.log，客户端立即得到明确失败
    appendCrashLog(`${new Date().toISOString()} [route] ${req.method} ${req.url} ${(e && e.stack) || e}\n`);
    try {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: '服务器内部错误：' + ((e && e.message) || e) }));
    } catch (_) { /* 连接已损坏则放弃 */ }
  });
});

async function handleRequest(req, res) {
  // Host 校验：DNS 重绑定场景下浏览器以攻击者域名为 Host 访问本机服务，直接拒
  if (!isLocalHostHeader(req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '仅允许本机访问' }));
    return;
  }
  const isWrite = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  if (isWrite) {
    // Origin 校验（存在时）：跨站表单/fetch 必带 Origin 且非本地，直接拒；
    // 同源页面或无 Origin 的本地调用再核 X-Token
    const origin = req.headers.origin;
    if (origin && !isLocalHostHeader(origin.replace(/^https?:\/\//, ''))) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '跨站写操作被拒绝' }));
      return;
    }
    if (req.headers['x-token'] !== API_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '缺少或无效的访问令牌（请刷新页面重试）' }));
      return;
    }
  }
  const url = new URL(req.url, `http://127.0.0.1:${UI_PORT}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    // no-store：浏览器无协商缓存时可能复用旧页面，旧页面对不上新服务 API 会造成功能"假失效"
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(UI_HTML);
    return;
  }

  // ---- 主题静态资产（v60 波奇主题壁纸）：pkg 快照内 __dirname 直读（与 web-ui.html 同机制） ----
  if (url.pathname === '/assets/bocchi-bg.jpg') {
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'assets', 'bocchi-bg.jpg'));
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
      res.end(buf);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '资产不存在' }));
    }
    return;
  }

  // ---- PWA：Web App Manifest 与应用图标（Chrome/Edge「安装为应用」）----
  // 不注册 service worker（保持简单：现代 Chromium 对安装提示不再强制 SW）
  if (url.pathname === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      name: '小说下载工作台',
      short_name: '书阁',
      start_url: '/',
      display: 'standalone',
      // 取「宣纸」主题色值：theme_color=金棕 accent，background_color=宣纸底色
      theme_color: '#9a6b23',
      background_color: '#f1ede3',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
      ]
    }));
    return;
  }
  if (url.pathname === '/icon-192.png' || url.pathname === '/icon-512.png') {
    res.writeHead(200, { 'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400' });
    res.end(url.pathname === '/icon-192.png' ? APP_ICON_192 : APP_ICON_512);
    return;
  }

  // 静态资源白名单已清空：neon-* 旧版资源随「书阁 v2」改版废弃并归档，
  // 工作台为单文件 HTML（样式/脚本全内联），当前无任何需暴露的静态文件

  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(snapshot(true)));
    return;
  }

  // ---- SSE 事件流：状态有变化才推送（1 秒粒度去重），空闲时零流量。
  //      取代旧版前端 0.7s 无条件轮询 /api/state 的设计缺陷（空闲时也狂发请求） ----
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(`data: ${JSON.stringify(snapshot(true))}\n\n`);   // 建立连接立即推当前快照
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ---- 搜索：白名单内全量并发 + SSE 流式推送，先到先得 ----
  // 业务时间线：请求进入 → 按健康度白名单筛出存活源 → 并发上限内全量同时发起
  // （每源 4s 超时不重试）→ 任一源返回结果立即经 SSE 推给前端渲染，不等全批 →
  // 全部落定后经 HTTP 返回汇总（兼容无 SSE 场景）并完成成功/失败上报。
  // 稳定性依据：搜索时长由活源数决定（体检后通常几十上百个），死源在体检阶段
  // 已被隔离；搜索期连续失败 3 次的源自动降级，下次搜索不再拖累。
  if (url.pathname === '/api/search' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJsonBody(body);
    if (payload === null) { replyBadJson(res); return; }
    const keyword = String(payload.keyword || '').trim().slice(0, 100);
    if (!keyword) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '搜索词为空' }));
      return;
    }
    // 前端取消搜索（AbortController）会中止响应连接：停止派发新源，在途请求自然落定，
    // 避免用户已放弃的关键词继续打满全部书源。
    // 注意必须监听 res 而非 req：Node 14+ 的 req 在 body 读完即触发 close，会误判
    let clientGone = false;
    res.on('close', () => { if (!res.writableEnded) clientGone = true; });
    const enabled = sources.filter((s) => isSearchCandidate(s));
    // 白名单磨光保护：尚有少量活源但低于阈值时后台补体检；体检不阻断本次搜索，
    // 防止用户把 4 秒级搜索等成约 1 分钟。全 dead/无健康数据走下方全量候选搜索兜底。
    const aliveNow = Object.values(sourceHealth.byUrl).filter((s) => s.state === 'alive').length;
    if (aliveNow > 0 && enabled.length > 0 && aliveNow < enabled.length * 0.2 && !sourceHealth.probing) {
      ensureWhitelistFresh();
    }
    // 白名单策略：有健康记录时打存活源；健康表为空或全部 dead 时退回可搜索源全集。
    // 无健康记录的源（新增/从未体检）必须参与搜索——白名单的职责是剔除确认 dead 的源，
    // 而非惩罚未体检的新源，否则新导入的源在手动体检前永远搜不到（2026-09-30 实测修复）。
    // 全集仍经过 isSearchCandidate，先排除缺规则、坏地址和脚本搜索等结构性无效源。
    const hasHealthData = Object.keys(sourceHealth.byUrl).length > 0;
    const healthyTargets = hasHealthData
      ? enabled.filter((s) => sourceHealth.isHealthy(s) || !sourceHealth.byUrl[s.bookSourceUrl])
      : [];
    const usingWhitelist = healthyTargets.length > 0;
    const targets = usingWhitelist ? healthyTargets : enabled;

    const SEARCH_TIMEOUT = 4000;
    const SEARCH_CONCURRENCY = 256;   // 全量并发上限：活源数通常远低于此值
    const TOTAL_DEADLINE = 12000;     // 兜底死线：超过后未完成的源按失败落定
    const EARLY_RESULT_HITS = 50;     // 首批结果足够展示后收束，避免为尾部死源继续等待
    const deadline = Date.now() + TOTAL_DEADLINE;
    let nextIdx = 0;
    const settled = [];
    // 流式结果缓冲：单源命中即写入 state.searchResults，经既有 SSE 通道（1s 粒度）
    // 推给前端先渲染；HTTP 汇总响应仍是最终事实，SSE 仅负责"先到先得"的即时展示
    const streamedBooks = [];
    state.searchResults = [];
    // 进度快照随每次单源落定经 SSE 推送，前端实时显示"已完成/总数"
    const searchProgress = { active: true, done: 0, total: targets.length, hits: 0 };

    async function searchLane() {
      while (true) {
        const idx = nextIdx++;
        if (idx >= targets.length || Date.now() > deadline
          || clientGone || searchProgress.hits >= EARLY_RESULT_HITS) return;
        const s = targets[idx];
        try {
          const books = await engine.searchBook(s, keyword,
            { ...s.option, timeoutMs: SEARCH_TIMEOUT, maxRetries: 0, retryBaseDelayMs: 0 });
          // 达到早停阈值或总死线后停止接收新结果；在途请求仍自然落定，
          // 但不再扩大本次结果，避免一个超高产源把其它站点完全挤出首屏。
          if (Date.now() > deadline || searchProgress.hits >= EARLY_RESULT_HITS) return;
          // 只有真实返回可点击书籍的源才能确认 alive；空结果和首页垃圾不改白名单，
          // 与体检准入保持同一口径，避免关键词差异或规则错位误判成站点可用。
          const hasValidBook = (books || []).some((b) => b && b.name && b.bookUrl
            && !/^https?:\/\/[^/]+\/?$/.test(b.bookUrl));
          if (hasValidBook) sourceHealth.reportSuccess(s);
          settled.push({ status: 'fulfilled', value: books, src: s });
          streamedBooks.push(...books);
          searchProgress.done++; searchProgress.hits += books.length;
        } catch (e) {
          if (Date.now() > deadline || searchProgress.hits >= EARLY_RESULT_HITS) return;
          sourceHealth.reportFailure(s, e.message);
          settled.push({ status: 'rejected', reason: e, src: s });
          searchProgress.done++;
        }
      }
    }
    // 并发池与引擎 runPool 同模式；搜索进行中前端从 SSE 快照读取 searchProgress 与 searchResults。
    // 命中早停阈值后只停止派发新源，在途请求仍自然落定后才返回汇总，避免迟到结果改写状态。
    state.searchProgress = searchProgress;
    state.searchResults = streamedBooks;   // 引用共享，lane 内 push 即对 SSE 快照可见
    await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, targets.length) }, searchLane));
    state.searchProgress = null;
    state.searchResults = [];
    // 客户端已取消：连接关闭，直接丢弃结果，不再写响应
    if (clientGone) { try { res.destroy(); } catch (e) { /* 已关闭 */ } return; }

    const results = [];
    let errCount = 0;
    settled.forEach((r) => {
      if (r.status === 'fulfilled') results.push(...r.value);
      else { errCount++; results.push({ sourceError: true, sourceName: r.src.bookSourceName, error: r.reason && r.reason.message }); }
    });
    // 早停说明：命中达上限时失败计数只含已落定源，hint 明示避免误读为全量结论
    const earlyStopped = searchProgress.hits >= EARLY_RESULT_HITS;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      results,
      hint: (usingWhitelist
        ? `白名单搜索：${targets.length} 个存活源，失败 ${errCount} 个`
        : `全量搜索（白名单为空或未体检）：${targets.length} 个源，建议先体检收敛白名单`)
        + (earlyStopped ? '；命中达上限提前收束，在途源未计入' : '')
    }));
    return;
  }

  // ---- 书源体检：全量探活并重建白名单；进行中可查询进度/手动停止 ----
  if (url.pathname === '/api/sources/probe' && req.method === 'POST') {
    try {
      const r = await sourceHealth.probeAll(sources, 64, engine.searchBook);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, ...r }));
    } catch (e) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === '/api/sources/probe/stop' && req.method === 'POST') {
    sourceHealth.stopProbe();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === '/api/health') {
    // 统计口径修复：只统计当前注册表内的书源——先惰性清理注册表外的尸体记录，
    // stats 的 alive/dead 即天然只剩注册表内的源（Y=注册表内源数的口径由前端
    // 以 alive+dead 展示，清理后二者均不含注册表外残留）
    sourceHealth.prune(new Set(sources.map((s) => s.bookSourceUrl)));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    const enabledCount = sources.filter((s) => s.enabled).length;
    const searchableCount = sources.filter((s) => isSearchCandidate(s)).length;
    res.end(JSON.stringify({ ...sourceHealth.stats(), enabled: enabledCount, searchable: searchableCount }));
    return;
  }

  // ---- 手动链接解析：用户粘贴书籍目录页地址，启发式解析出完整章节目录 ----
  // 解决内置书源搜索不到的书：目录解析与下载全程不依赖任何书源规则。
  // 分页目录自动跟随「下一页」（上限 30 页，URL 去重防环）；章节号按文档序编号。
  if (url.pathname === '/api/parse-link' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJsonBody(body);
    if (payload === null) { replyBadJson(res); return; }
    const pageUrl = String(payload.url || '').trim();
    // 仅放行 http(s) 页面地址；拒带凭据 URL（user:pass@host 会泄露到日志与书源列表）
    if (!/^https?:\/\/[^\s/]+\//.test(pageUrl) || pageUrl.length > 2000
      || /^https?:\/\/[^/\s]*@/.test(pageUrl)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '链接格式无效：请输入以 http:// 或 https:// 开头的书籍目录页地址' }));
      return;
    }
    if (state.running) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '已有下载任务在运行，请完成后再解析新链接' }));
      return;
    }
    try {
      const parsed = await fetchGenericToc(pageUrl);
      if (!parsed.chapters.length) {
        const hint = parsed.reason === 'no-anchors'
          ? '该页面没有可用的链接内容，可能不是书籍目录页'
          : '未能从该页面识别出章节目录：页面可能不是目录页，或目录结构特殊（如纯图片/JS 动态渲染）。请确认链接为书籍的章节目录页';
        res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: hint }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        bookName: parsed.bookName,
        tocUrl: pageUrl,
        chapterTotal: parsed.chapters.length,
        pages: parsed.pages,
        chapters: parsed.chapters,
        // 噪声过滤条数：>0 时前端在章节数旁提示「已过滤 N 条噪声链接」
        filteredNoise: parsed.filteredNoise || 0,
        // 识别置信提示：仅识别到极少量章节时提醒用户核对目录完整性
        warning: parsed.pages === 1 && parsed.chapters.length < 3
          ? '仅识别到少量章节，请核对目录是否完整' : null
      }));
    } catch (e) {
      // 失败原因翻译成用户可行动的提示：HTTP 状态码/超时/DNS 各有不同对策
      let hint;
      const st = /HTTP (\d+)/.exec(e.message || '');
      if (e.crossDomainRedirect) hint = `站点疑似触发了反爬封禁（请求被重定向至外域）：${e.message}`;
      else if (st) hint = `目标站点返回 HTTP ${st[1]}：页面不存在或拒绝访问，请检查链接是否正确`;
      else if (/ENOTFOUND|EAI_AGAIN/.test(e.message || '')) hint = '域名无法解析：请检查链接拼写是否正确，或该站点已关闭';
      else if (/ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/.test(e.message || '')) hint = '无法连接目标站点：站点可能已关闭或拒绝了访问';
      else if (/超时/.test(e.message || '')) hint = '访问超时：站点不可达或响应过慢，请稍后重试或更换链接';
      else hint = `访问失败：${e.message}`;
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: hint }));
    }
    return;
  }

  // ---- 书籍详情：目录预览（章节数）----
  if (url.pathname === '/api/bookinfo' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJsonBody(body);
    if (payload === null) { replyBadJson(res); return; }
    // bookUrl 必须是合法 http(s) 地址：非法输入直接 400，不进引擎
    if (typeof payload.bookUrl !== 'string' || !/^https?:\/\//.test(payload.bookUrl)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'bookUrl 非法' }));
      return;
    }
    const src = sources.find((s) => s.bookSourceName === payload.sourceName);
    if (!src) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '书源不存在' }));
      return;
    }
    if (state.running) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '已有下载任务在运行，目录预览暂不可用' }));
      return;
    }
    try {
      const info = await engine.getBookInfo(src, payload.bookUrl, { ...src.option });
      // 选中书籍时只解析目录，不启动下载；解析结果进入全局快照，
      // 让 SSE 渲染与 HTTP 响应使用同一份章节状态，避免旧任务章节残留。
      const tocHtml = await engine.fetchPage(info.tocUrl, { ...src.option, responseType: src.responseType });
      const chapters = engine.parseCatalog(tocHtml, src);
      // 目录抓取耗时期间用户可能已启动下载；写入全局状态前再次互斥，
      // 防止预览结果覆盖任务章节进度。
      if (state.running) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '已有下载任务在运行，目录预览暂不可用' }));
        return;
      }
      state.chapters = chapters.map((ch) => ({
        n: ch.n, title: ch.title, state: 'pending', error: null
      }));
      state.catalogKey = `${src.bookSourceName}|${info.tocUrl}`;
      state.stats = {
        total: chapters.length, done: 0, failed: 0,
        pending: chapters.length, cached: 0
      };
      state.lastResult = null;
      state.files = null;
      markChaptersDirty();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        tocUrl: info.tocUrl,
        chapterTotal: chapters.length,
        chapters: state.chapters,
        name: payload.name || payload.bookName,
        // 简介/封面（2026-10-09）：书源 ruleBookInfo 声明了就有，未声明为空串，前端隐简介区
        intro: info.intro || '',
        cover: info.coverUrl || '',
        // Legado 源声明了分页目录规则但适配层只抓当前页：前端据以提示"目录可能不完整"
        pagedToc: !!(src._legado && src._legado.source && src._legado.source.ruleToc
          && src._legado.source.ruleToc.nextTocUrl)
      }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- 书源管理：列表 / 启停 / 删除 / 导入 ----
  if (url.pathname === '/api/sources') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ sources: sources.map((s) => ({
      bookSourceName: s.bookSourceName, bookSourceGroup: s.bookSourceGroup,
      bookSourceUrl: s.bookSourceUrl, enabled: !!s.enabled,
      sourceType: s.responseType === 'json' ? 'API' : 'HTML',
      builtin: typeof (s.ruleSearch && s.ruleSearch.bookList) === 'function'
    })) }));
    return;
  }

  // ---- 书源导出：用户书源文件原样打包下载（JSON attachment）----
  if (url.pathname === '/api/sources/export') {
    const f = userSourcesFile();
    let raw = null;
    try { raw = fs.readFileSync(f); } catch (e) { /* 文件不存在按 404 */ }
    let count = 0;
    if (raw) {
      try { count = (JSON.parse(raw.toString('utf8')).bookSources || []).length; }
      catch (e) { count = 0; }
    }
    if (!raw || !count) {
      replyJson(res, 404, { error: '暂无可导出的书源（用户书源文件不存在或为空，请先导入书源）' });
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="book-sources-${stamp}.json"`
    });
    res.end(raw);
    return;
  }

  if (url.pathname === '/api/sources/toggle' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJsonBody(body);
    if (payload === null) { replyBadJson(res); return; }
    const { bookSourceName, enabled } = payload;
    const src = sources.find((s) => s.bookSourceName === bookSourceName);
    if (!src) { res.writeHead(404); res.end('{}'); return; }
    src.enabled = !!enabled;
    saveSources();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/api/sources/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJsonBody(body);
    if (payload === null) { replyBadJson(res); return; }
    const { bookSourceName } = payload;
    sources = sources.filter((s) => s.bookSourceName !== bookSourceName);
    saveSources();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 一键导入 Legado 书源包（支持 394/1937 条大文件），只保留 full/partial 兼容源。
  // 2026-09-24 新增可用性预检：逐源探测 bookSourceUrl 可达性，DNS 失败/超时的源
  // 既不进入注册表，也同步从书源包文件中物理剔除（剔除前先备份原包）。
  if (url.pathname === '/api/sources/import-legado' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJsonBody(body);
    if (payload === null) { replyBadJson(res); return; }
    const file = payload.file || 'legado_shuyuan_jingxuan.json';
    const allowed = ['legado_shuyuan_jingxuan.json', 'legado_shuyuan_quanliang.json'];
    if (!allowed.includes(file)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '文件名不在允许列表' }));
      return;
    }
    // 书源包路径：打包态从快照内读（book_sources 已作为 assets 打入），开发态读上级目录
    const srcPath = path.join(__dirname, 'book_sources', file);
    try {
      const raw = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
      const arr = Array.isArray(raw) ? raw : (raw.bookSources || []);
      // 第一步：规则兼容性过滤（full/partial），@js 类不支持的直接排除
      const candidates = [];
      for (const lg of arr) {
        const w = engine.legadoAdapter.wrapLegado(lg);
        if (!w) continue;
        if (w.compatibility === 'full') w.legadoRank = 1;
        else if (w.compatibility === 'partial') w.legadoRank = 2;
        else continue;
        w.legadoMeta = { respondTime: lg.respondTime || 999999, weight: lg.weight || 0 };
        candidates.push({ lg, w, alive: false });
      }
      // 第二步：可用性探测。判定口径——收到任何 HTTP 响应（含 4xx，说明站点活着）
      // 即为可用；DNS 解析失败、连接超时、请求异常判为失效。URL 去重：同站多源只探一次。
      const probeAlive = (u) => new Promise((resolve) => {
        try { engine.httpRequest(u, 4000).then(() => resolve(true), () => resolve(false)); }
        catch (e) { resolve(false); }
      });
      const urlVerdict = new Map();   // bookSourceUrl → boolean（注意存布尔值而非 Promise，Promise 恒真会全判活）
      let probeIdx = 0;
      const PROBE_CONCURRENCY = 64;   // 与体检同量级的并发上限
      async function probeLane() {
        while (probeIdx < candidates.length) {
          const c = candidates[probeIdx++];
          const u = c.w.bookSourceUrl;
          if (!urlVerdict.has(u)) urlVerdict.set(u, await probeAlive(u));
          c.alive = urlVerdict.get(u);
        }
      }
      await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, candidates.length) }, probeLane));
      const aliveList = candidates.filter((c) => c.alive);
      const deadCount = candidates.length - aliveList.length;
      // 第三步：存活源写入注册表（与 /api/sources/import 同口径：名称+URL 联合判重）
      for (const c of aliveList) {
        const idx = sources.findIndex((x) => x.bookSourceName === c.w.bookSourceName
          && x.bookSourceUrl === c.w.bookSourceUrl);
        if (idx >= 0) sources[idx] = c.w; else sources.push(c.w);
      }
      // 第四步：失效源从书源包文件中物理剔除，下次导入不再重复探测死站。
      // 原包先备份到 backup/（当天同文件只备份一次，保留最原始版本）
      if (deadCount > 0) {
        const bakDir = path.join(__dirname, 'backup', `book_sources-pruned-${new Date().toISOString().slice(0, 10)}`);
        fs.mkdirSync(bakDir, { recursive: true });
        const bakFile = path.join(bakDir, file);
        if (!fs.existsSync(bakFile)) fs.copyFileSync(srcPath, bakFile);
        const outArr = aliveList.map((c) => c.lg);
        fs.writeFileSync(srcPath,
          Array.isArray(raw) ? JSON.stringify(outArr, null, 2) : JSON.stringify({ bookSources: outArr }, null, 2));
      }
      saveSources();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true, total: arr.length,
        full: aliveList.filter((c) => c.w.compatibility === 'full').length,
        partial: aliveList.filter((c) => c.w.compatibility === 'partial').length,
        alive: aliveList.length, dead: deadCount
      }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/sources/import' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const raw = parseJsonBody(body);
      if (raw === null || typeof raw !== 'object') throw new Error('请求体不是合法 JSON');
      const incoming = Array.isArray(raw.bookSources) ? raw.bookSources : [raw];
      // 导入条数与字段校验：限制单次规模，必填字段缺失即拒
      if (incoming.length > 5000) throw new Error('单次导入超过 5000 条上限');
      for (const src of incoming) {
        for (const key of ['bookSourceName', 'bookSourceUrl', 'searchUrl', 'ruleSearch', 'ruleContent']) {
          if (!src[key]) throw new Error(`导入书源缺少字段: ${key}`);
        }
        if (!/^https?:\/\//.test(src.bookSourceUrl)) throw new Error(`书源[${src.bookSourceName}]地址非法`);
      }
      // 同名同址书源覆盖（重复导入同一源），同名不同址视为两个站点都保留——
      // 原按名称去重会把同名不同站点的源互踢丢失
      for (const src of incoming) {
        const idx = sources.findIndex((s) => s.bookSourceName === src.bookSourceName
          && s.bookSourceUrl === src.bookSourceUrl);
        if (idx >= 0) sources[idx] = src; else sources.push(src);
      }
      saveSources();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, imported: incoming.length }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/start' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJsonBody(body);
    if (payload === null) { replyBadJson(res); return; }
    const bookName = String(payload.bookName || 'mock書').replace(/[\\/:*?"<>|]/g, '').trim() || 'mock書';
    const wantEpub = !!payload.epub;
    const concurrency = Math.min(16, Math.max(1, Number(payload.concurrency) || 8));
    const author = String(payload.author || '').slice(0, 60);
    // 封面（2026-10-08）：搜索卡片随请求下发；仅接受合法 http(s) 地址，异常值静默丢弃
    const coverUrl = typeof payload.coverUrl === 'string'
      && /^https?:\/\//.test(payload.coverUrl) && payload.coverUrl.length <= 2000
      ? payload.coverUrl : '';
    if (typeof payload.tocUrl !== 'string' || !/^https?:\/\//.test(payload.tocUrl)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'tocUrl 非法（请从搜索结果进入）' }));
      return;
    }
    // 任务运行中：校验通过的请求进入下载队列（上限 TASK_QUEUE_MAX），
    // 当前任务终态后自动出队续跑；返回 {queued:true, position:N}
    const enqueue = (q) => {
      if (taskQueue.length >= TASK_QUEUE_MAX) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `下载队列已满（最多 ${TASK_QUEUE_MAX} 个排队任务），请等待队列消化后再试` }));
        return;
      }
      taskQueue.push(q);
      log(`[队列] 《${q.bookName}》已加入下载队列（第 ${taskQueue.length} 位）`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, queued: true, position: taskQueue.length }));
    };
    // 手动链接模式：章节清单由 /api/parse-link 解析随任务下发，不查书源注册表；
    // 合成源由 launchTask 经 buildManualSource 构造（立即执行与队列出队同路径）
    if (payload.manual) {
      // 速度档位仅手动模式生效（书源模式忽略不报错）；缺省 balanced，非法值 400
      const speedProfile = payload.speedProfile === undefined || payload.speedProfile === null
        ? SPEED_PROFILE_DEFAULT : String(payload.speedProfile);
      if (!isValidSpeedProfile(speedProfile)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'speedProfile 非法（conservative/balanced/fast）' }));
        return;
      }
      const list = Array.isArray(payload.manualChapters) ? payload.manualChapters : null;
      if (!list || !list.length) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '章节清单为空：请先解析目录再开始下载' }));
        return;
      }
      if (list.length > 20000) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '章节数量超过上限（20000）' }));
        return;
      }
      const invalid = list.find((c) => !c || typeof c.url !== 'string'
        || !/^https?:\/\//.test(c.url) || c.url.length > 2000
        || !Number.isFinite(Number(c.n)) || Number(c.n) < 1);
      if (invalid) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '章节清单含非法条目，请重新解析目录' }));
        return;
      }
      const manualChapters = list.map((c, i) => ({
        n: Number(c.n) || i + 1,
        title: String(c.title || `第${i + 1}章`).slice(0, 120),
        url: c.url
      }));
      const q = { manual: true, bookName, wantEpub, tocUrl: payload.tocUrl,
        concurrency, author, manualChapters, speedProfile, coverUrl };
      if (state.running) { enqueue(q); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      launchTask(q);
      return;
    }
    // 严格按前端传来的 sourceName 选源：静默回退到"任意启用源"会让用户以为
    // 在用 A 源下载实际走了 B 源（下载内容与搜索结果对不上），必须显式报错
    const src = sources.find((s) => s.bookSourceName === payload.sourceName);
    if (!src) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `书源[${payload.sourceName || '?'}]不存在，可能已被删除，请返回搜索重新选择` }));
      return;
    }
    const q = { manual: false, bookName, wantEpub, tocUrl: payload.tocUrl,
      concurrency, author, sourceName: payload.sourceName, coverUrl };
    if (state.running) { enqueue(q); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    launchTask(q);
    return;
  }

  // 取消当前下载任务：置位令牌，引擎在领下一章前退出并保存断点
  if (url.pathname === '/api/stop' && req.method === 'POST') {
    if (state.running && state.cancelToken) {
      state.cancelToken.cancelled = true;
      log('收到取消请求，将在当前在途章节落定后停止…');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, stopping: !!(state.running && state.cancelToken) }));
    return;
  }

  // ================= 书架中心 =================
  // 扫描 output 目录还原历史下载；目录名为 "书源名-书名"（引擎 safeFsName 口径），
  // manifest 存在即视为有效书籍。_回收站 是删除暂存区，不计入书架。
  // 结果 30s 内存缓存：书架切换/刷新频繁，16+ 目录全量 stat 属无谓 IO；
  // 任何写操作（删除/恢复/任务完成）即失效

  // ---- 封面代理（2026-10-08）：书源封面直挂前端会因防盗链/混合内容加载失败，
  // 服务端代取后回图；仅 http(s)、限 3MB、10s 超时，非图片类型一律 404（前端渐变兜底）。
  // 本机工具无 Cookie 态，不带凭据转发；浏览器侧缓存一天减少重复回源。
  // 内存计数器（?stats=1 读取）：命中/上游失败——浏览器侧封面不出图时用于分流
  // 「请求没到服务器」（前端挂载问题）vs「到了但失败」（上游问题）
  const coverStats = { hits: 0, upstreamFail: 0 };
  // 404 负缓存（2026-10-08）：源站死链（实测 cread 部分书目封面 404）没有理由每次
  // 搜索/翻页都重新打死——失败结果记 10 分钟，期间同 URL 秒回 404
  const coverNegCache = new Map();   // target -> expiresAt(ms)
  const COVER_NEG_TTL = 10 * 60 * 1000;
  function coverNegHit(target) {
    const exp = coverNegCache.get(target);
    if (exp === undefined) return false;
    if (Date.now() > exp) { coverNegCache.delete(target); return false; }
    return true;
  }
  if (url.pathname === '/api/cover' && url.searchParams.get('stats') === '1') {
    replyJson(res, 200, { ...coverStats });
    return;
  }
  if (url.pathname === '/api/cover') {
    coverStats.hits++;
    const target = url.searchParams.get('u') || '';
    if (!/^https?:\/\//.test(target) || target.length > 2000 || /@[^\d]/.test(target.split('/')[2] || '')) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '封面地址非法' }));
      return;
    }
    if (coverNegHit(target)) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'max-age=60' });
      res.end(JSON.stringify({ error: '封面不可用（负缓存）' }));
      return;
    }
    const got = await fetchCoverBuffer(target);
    if (!got) {
      coverStats.upstreamFail++;
      coverNegCache.set(target, Date.now() + COVER_NEG_TTL);
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'max-age=60' });
      res.end(JSON.stringify({ error: '封面不可用' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': got.ct, 'Cache-Control': 'public, max-age=86400', 'Content-Length': got.buf.length });
    res.end(got.buf);
    return;
  }

  // ---- 本地导入（2026-10-08）：TXT/EPUB → 书架。请求体为原始文件字节
  // （专用 readBodyRaw，上限 80MB；base64+JSON 会撞 parseJsonBody 2MB 上限且膨胀 4/3），
  // kind/nameHint 走查询串。产出与引擎下载同构的 manifest+章节+book.json，
  // 书架/阅读/导出零改动复用；导入书无 tocUrl 不可追更 ----
  if (url.pathname === '/api/library/import' && req.method === 'POST') {
    try {
      const kind = url.searchParams.get('kind') === 'epub' ? 'epub' : 'txt';
      const nameHint = String(url.searchParams.get('name') || '').slice(0, 120);
      const buf = await readBodyRaw(req, kind === 'epub' ? 80 * 1024 * 1024 : 30 * 1024 * 1024);
      const r = localImport.importBook({ outRoot: outputRoot(), kind, buf, nameHint });
      invalidateLibCache();
      log(`[导入] 《${r.name}》完成：${r.chapters} 章${r.coverFile ? '（含封面）' : ''}`);
      replyJson(res, 200, { ok: true, ...r });
    } catch (e) {
      replyJson(res, 400, { error: e.message });
    }
    return;
  }

  // ---- 本地封面出图：EPUB 导入提取的 cover.* 文件，替代远程代理路径 ----
  if (url.pathname === '/api/library/cover') {
    const dirName = url.searchParams.get('dir') || '';
    if (!isSafeDirName(dirName)) { replyJson(res, 403, { error: '目录参数不合法' }); return; }
    const dir = path.join(outputRoot(), 'output', dirName);
    let coverFile = null;
    try { coverFile = fs.readdirSync(dir).find((f) => /^cover\.[a-z0-9]+$/i.test(f)) || null; } catch (e) { /* 目录不存在 */ }
    if (!coverFile) { replyJson(res, 404, { error: '无本地封面' }); return; }
    const ext = (coverFile.split('.').pop() || 'jpg').toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    try {
      const buf = fs.readFileSync(path.join(dir, coverFile));
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400', 'Content-Length': buf.length });
      res.end(buf);
    } catch (e) { replyJson(res, 404, { error: '封面读取失败' }); }
    return;
  }

  // ---- 书架：扫描 output 目录（30s 缓存 + 体积统计 + 追更状态） ----
  if (url.pathname === '/api/library') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ books: getLibrary(), updates: state.libraryUpdates }));
    return;
  }

  // ---- 书架搜索（2026-10 迭代 F7）：书名/作者/标签 + manifest 章节标题，
  // 大小写不敏感；q 超 100 字符截断不报错；matchedChapters 最多 20 条。
  // 复用 getLibrary() 30s 缓存的书架清单，manifest 按需读盘（损坏按无章节命中计），
  // 不新增落盘；空关键词直接返空列表，避免无意义全盘扫描 ----
  if (url.pathname === '/api/library/search') {
    const q = String(url.searchParams.get('q') || '').slice(0, 100).trim().toLowerCase();
    const books = [];
    if (q) {
      const meta = loadLibMeta();
      const outDir = path.join(outputRoot(), 'output');
      for (const b of getLibrary()) {
        const tags = (meta.books[b.dirName] && meta.books[b.dirName].tags) || [];
        const metaHit = b.name.toLowerCase().includes(q)
          || String(b.author || '').toLowerCase().includes(q)
          || tags.some((t) => String(t).toLowerCase().includes(q));
        const matchedChapters = [];
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(outDir, b.dirName, 'manifest.json'), 'utf8'));
          // 整数键按数值升序迭代（JS 规范）：取前 20 条即章节号最小的 20 个命中
          for (const k of Object.keys(manifest)) {
            const title = String(manifest[k] && manifest[k].title || '');
            if (title.toLowerCase().includes(q)) {
              matchedChapters.push({ n: Number(k), title });
              if (matchedChapters.length >= 20) break;
            }
          }
        } catch (e) { /* manifest 缺失/损坏：仅按元数据命中判定 */ }
        if (metaHit || matchedChapters.length) {
          books.push({ dir: b.dirName, bookName: b.name, author: b.author, matchedChapters });
        }
      }
    }
    replyJson(res, 200, { books });
    return;
  }

  // ---- 书架元数据：标签 / 收藏 / 阅读进度（library-meta.json 持久化） ----
  if (url.pathname === '/api/library/meta' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(loadLibMeta()));
    return;
  }
  if (url.pathname === '/api/library/meta' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJsonBody(body);
    if (payload === null) { replyBadJson(res); return; }
    const dirName = String(payload.dirName || '');
    if (!isSafeDirName(dirName)) { replyJson(res, 403, { error: '目录参数不合法' }); return; }
    const meta = loadLibMeta();
    const cur = meta.books[dirName] || {};
    // 只更新传入的字段：tags 限 8 个去重、lastRead 取非负整数，防异常输入污染持久化文件
    meta.books[dirName] = {
      tags: Array.isArray(payload.tags)
        ? [...new Set(payload.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 8) : (cur.tags || []),
      fav: payload.fav === undefined ? !!cur.fav : !!payload.fav,
      lastRead: payload.lastRead === undefined ? (cur.lastRead || 0)
        : Math.max(0, Math.floor(Number(payload.lastRead) || 0)),
      // lastRead 变化时同步落 lastReadAt（2026-09-30 首屏甲板「上次读到 X 前」依赖；
      // 老数据无此字段前端自动省略时间片段，向前兼容）
      lastReadAt: payload.lastRead !== undefined ? Date.now() : (cur.lastReadAt || 0)
    };
    saveLibMeta(meta);
    replyJson(res, 200, { ok: true });
    return;
  }

  // ---- 阅读器换源（2026-10-08，借鉴番茄）：本章打不开/想换源时，按书名在目标源
  // 重新搜索→解析目录→按标题定位当前章→抓正文临时显示。不改动书架书的源与缓存，
  // 仅本次阅读有效；切章即恢复原书正文 ----
  if (url.pathname === '/api/reader/sources' && req.method === 'GET') {
    const candidates = sources.filter((s) => s.enabled !== false && s.searchUrl && !s.manual);
    const bookName = (url.searchParams.get('name') || '').trim();
    if (!bookName) {
      replyJson(res, 200, { sources: candidates.map((s) => ({ name: s.bookSourceName })) });
      return;
    }
    // 按书名实搜过滤（2026-10-09 用户反馈「换源不该列全部源」）：只留能搜到这本书的源；
    // 全源并发、单源 9s 死线、命中即记录 bookUrl（switch-source 可凭此跳过重复搜索）
    const norm = engine.normalizeChapterTitle(bookName);
    const probes = candidates.map(async (s) => {
      try {
        const hits = await engine.searchBook(s, bookName, { timeout: 9000 });
        const hit = (hits || []).find((b) => {
          const hn = engine.normalizeChapterTitle(b.name || '');
          return hn.includes(norm) || norm.includes(hn);
        });
        return hit ? { name: s.bookSourceName, bookUrl: hit.bookUrl || '' } : null;
      } catch (e) { return null; }   // 单源失败/超时只意味着它不参与候选，不影响其它源
    });
    const found = (await Promise.all(probes)).filter(Boolean);
    replyJson(res, 200, { sources: found });
    return;
  }
  if (url.pathname === '/api/reader/switch-source' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJsonBody(body);
    if (payload === null) { replyBadJson(res); return; }
    const bookName = String(payload.bookName || '').trim();
    const chapterTitle = String(payload.chapterTitle || '').trim();
    const sourceName = String(payload.sourceName || '').trim();
    if (!bookName || !chapterTitle || !sourceName) { replyJson(res, 400, { error: '参数不完整' }); return; }
    const src = sources.find((s) => s.bookSourceName === sourceName && s.enabled !== false && s.searchUrl);
    if (!src) { replyJson(res, 404, { error: `书源[${sourceName}]不可用` }); return; }
    try {
      // 全链路：搜书 → 详情目录 → 标题定位 → 抓正文（与下载链路同源同清洗）；
      // 调用方已在 /api/reader/sources 实搜阶段拿到 bookUrl 时直传跳过重复搜索（省一轮全源请求）
      let hit = null;
      if (typeof payload.bookUrl === 'string' && /^https?:\/\//.test(payload.bookUrl)) {
        hit = { bookUrl: payload.bookUrl };
      } else {
        const hits = await engine.searchBook(src, bookName, { timeout: 15000 });
        hit = (hits || []).find((b) => engine.normalizeChapterTitle(b.name).includes(engine.normalizeChapterTitle(bookName))
          || engine.normalizeChapterTitle(bookName).includes(engine.normalizeChapterTitle(b.name)));
      }
      if (!hit) { replyJson(res, 404, { error: `目标源未搜到《${bookName}》` }); return; }
      const info = await engine.getBookInfo(src, hit.bookUrl, { timeout: 15000 });
      const tocUrl = (info && info.tocUrl) || hit.bookUrl;
      const catalogHtml = await engine.fetchWithRetry(tocUrl, { timeout: 15000 });
      const chapters = engine.parseCatalog(catalogHtml, src);
      const ch = engine.matchChapterByTitle(chapters, chapterTitle);
      if (!ch || !ch.url) { replyJson(res, 404, { error: `目标源目录未找到「${chapterTitle}」` }); return; }
      const html = await engine.fetchWithRetry(ch.url, { timeout: 15000 });
      const text = engine.extractContent(html, src);
      if (!text) { replyJson(res, 502, { error: '目标源正文提取失败（ruleContent 不匹配）' }); return; }
      replyJson(res, 200, { ok: true, sourceName, chapterTitle: ch.title, text });
    } catch (e) {
      replyJson(res, 502, { error: '换源失败: ' + e.message });
    }
    return;
  }

  // ---- 书架章节清单与正文预览：按需从磁盘读（阅读器视图数据源） ----
  if (url.pathname === '/api/library/chapters') {
    const dirName = url.searchParams.get('dir') || '';
    if (!isSafeDirName(dirName)) { replyJson(res, 403, { error: '目录参数不合法' }); return; }
    const mf = path.join(outputRoot(), 'output', dirName, 'manifest.json');
    if (!fs.existsSync(mf)) { replyJson(res, 404, { error: '书籍不存在' }); return; }
    try {
      const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
      const chapters = Object.keys(manifest).map((k) => Number(k))
        .sort((a, b) => a - b)
        .map((n) => ({ n, title: manifest[n].title || `第 ${n} 章` }));
      replyJson(res, 200, { chapters });
    } catch (e) { replyJson(res, 500, { error: 'manifest 读取失败: ' + e.message }); }
    return;
  }
  if (url.pathname === '/api/library/preview') {
    const dirName = url.searchParams.get('dir') || '';
    const n = Number(url.searchParams.get('n'));
    if (!isSafeDirName(dirName)) { replyJson(res, 403, { error: '目录参数不合法' }); return; }
    const dir = path.join(outputRoot(), 'output', dirName);
    const mf = path.join(dir, 'manifest.json');
    if (!fs.existsSync(mf)) { replyJson(res, 404, { error: '书籍不存在' }); return; }
    try {
      const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
      const rec = manifest[n];
      const text = rec && rec.file ? engine.readCachedText(dir, rec.file) : null;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ n, title: rec ? rec.title : '', text: text || null }));
    } catch (e) { replyJson(res, 500, { error: '章节读取失败: ' + e.message }); }
    return;
  }

  // ---- 书架删除：移入回收站（可恢复），不再物理删除 ----
  if (url.pathname === '/api/library/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJsonBody(body);
    if (payload === null) { replyBadJson(res); return; }
    const dirName = String(payload.dirName || '');
    if (!isSafeDirName(dirName)) { replyJson(res, 403, { error: '目录参数不合法' }); return; }
    const r = moveToTrash(dirName);
    if (r.error) { replyJson(res, r.code, { error: r.error }); return; }
    replyJson(res, 200, { ok: true });
    return;
  }

  // ---- 批量删除：逐个校验+移回收站，部分失败不影响其余（失败明细回传） ----
  if (url.pathname === '/api/library/delete-batch' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJsonBody(body);
    if (payload === null) { replyBadJson(res); return; }
    const dirNames = Array.isArray(payload.dirNames) ? payload.dirNames : [];
    if (!dirNames.length || dirNames.length > 200) {
      replyJson(res, 400, { error: '批量删除需 1-200 个目录' }); return;
    }
    const deleted = [], failed = [];
    for (const d of dirNames) {
      const dirName = String(d);
      if (!isSafeDirName(dirName)) { failed.push({ dirName, error: '目录参数不合法' }); continue; }
      const r = moveToTrash(dirName);
      if (r.error) failed.push({ dirName, error: r.error });
      else deleted.push(dirName);
    }
    replyJson(res, 200, { ok: true, deleted: deleted.length, failed });
    return;
  }

  // ---- 回收站：列表 / 恢复 / 彻底删除 / 清空 ----
  if (url.pathname === '/api/library/trash' && req.method === 'GET') {
    replyJson(res, 200, { items: listTrash() });
    return;
  }
  if (url.pathname === '/api/library/trash/restore' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJsonBody(body);
    if (payload === null) { replyBadJson(res); return; }
    const trashName = String(payload.trashName || '');
    if (!isSafeDirName(trashName)) { replyJson(res, 403, { error: '目录参数不合法' }); return; }
    const r = restoreFromTrash(trashName);
    if (r.error) { replyJson(res, r.code, { error: r.error }); return; }
    replyJson(res, 200, { ok: true, dirName: r.dirName });
    return;
  }
  if (url.pathname === '/api/library/trash/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJsonBody(body);
    if (payload === null) { replyBadJson(res); return; }
    const trashName = String(payload.trashName || '');
    if (!isSafeDirName(trashName)) { replyJson(res, 403, { error: '目录参数不合法' }); return; }
    const r = purgeTrashItem(trashName);
    if (r.error) { replyJson(res, r.code, { error: r.error }); return; }
    replyJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/library/trash/clear' && req.method === 'POST') {
    const tDir = trashRoot();
    let cleared = 0;
    const failed = [];
    try {
      for (const entry of fs.readdirSync(tDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try { fs.rmSync(path.join(tDir, entry.name), { recursive: true, force: true }); cleared++; }
        catch (e) { failed.push(entry.name + '（' + deleteFailHint(e) + '）'); }
      }
    } catch (e) { /* 回收站不存在即空 */ }
    invalidateLibCache();
    // 失败不再静默：旧版逐条吞错恒报 ok（2026-09-28 实测护栏拦截 7 项全失败，
    // 前端却 toast「已清空(0项)」误导用户）——部分/全部失败必须显式回传
    if (failed.length) {
      replyJson(res, 200, { ok: false, cleared, failed: failed.length,
        error: `${failed.length} 项删除失败（已成功 ${cleared} 项）：${failed[0]}${failed.length > 1 ? ' 等' : ''}` });
      return;
    }
    replyJson(res, 200, { ok: true, cleared });
    return;
  }

  // ---- 批量导出：所选书籍的成品文件（TXT+EPUB+manifest）打成 zip 下载 ----
  if (url.pathname === '/api/library/export-batch' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJsonBody(body);
    if (payload === null) { replyBadJson(res); return; }
    const dirNames = Array.isArray(payload.dirNames) ? payload.dirNames : [];
    if (!dirNames.length || dirNames.length > 100) {
      replyJson(res, 400, { error: '批量导出需 1-100 个目录' }); return;
    }
    const { entries, overLimit } = collectBookEntries(dirNames.map(String), 400 * 1024 * 1024);
    // 内存护栏前置（stat 阶段即拒绝，未读文件入内存）
    if (overLimit) { replyJson(res, 413, { error: '所选内容超过 400MB，请分批导出' }); return; }
    if (!entries.length) { replyJson(res, 404, { error: '所选书籍没有可导出的成品文件' }); return; }
    const zip = engine.buildZip(entries);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="books.zip"; filename*=UTF-8''${encodeURIComponent(`书阁导出-${dirNames.length}本.zip`)}`
    });
    res.end(zip);
    return;
  }

  // ---- 整库备份：全部书籍成品 + manifest + 书架元数据打成 zip ----
  if (url.pathname === '/api/library/backup') {
    const books = getLibrary();
    const { entries, overLimit } = collectBookEntries(books.map((b) => b.dirName), 800 * 1024 * 1024);
    if (overLimit) { replyJson(res, 413, { error: '书库超过 800MB，请用批量导出分批备份' }); return; }
    const metaFile = path.join(outputRoot(), 'output', 'library-meta.json');
    if (fs.existsSync(metaFile)) entries.push(engine.zipEntry('library-meta.json', fs.readFileSync(metaFile)));
    if (!entries.length) { replyJson(res, 404, { error: '书架为空，无可备份内容' }); return; }
    const zip = engine.buildZip(entries);
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="backup.zip"; filename*=UTF-8''${encodeURIComponent(`书阁备份-${stamp}.zip`)}`
    });
    res.end(zip);
    return;
  }

  // ---- 追更：检查某本书目录是否有新章节（依赖 book.json 元信息） ----
  if (url.pathname === '/api/library/check-updates' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJsonBody(body);
    if (payload === null) { replyBadJson(res); return; }
    const dirName = String(payload.dirName || '');
    if (!isSafeDirName(dirName)) { replyJson(res, 403, { error: '目录参数不合法' }); return; }
    try {
      const r = await checkBookUpdates(dirName);
      replyJson(res, r.error ? 400 : 200, r);
    } catch (e) { replyJson(res, 502, { error: e.message }); }
    return;
  }

  // 汇总 TXT 是下载完成后的落盘产物；接口只允许读取 output/output 内固定文件名，
  // 防止前端状态异常时借下载接口访问其他本地文件。
  // 汇总 TXT/EPUB 是下载完成后的落盘产物；文件定位只允许两种方式：
  // ① 当前任务状态 state.files（内存态）；② ?dir= 指定 output 直接子目录（书架场景）。
  // 两条路径都强制约束在 output 目录内 + 固定文件名模式，防止借下载接口穿越读本地文件。
  const dlMatch = url.pathname.match(/^\/api\/download\/(txt|epub)$/);
  if (dlMatch) {
    const kind = dlMatch[1];
    const outputDir = path.resolve(outputRoot(), 'output');
    let bookDir = null;
    let displayName = state.bookName || 'novel';
    const dirParam = url.searchParams.get('dir');
    if (dirParam) {
      // dir 参数必须是 output 的直接子目录名（不允许任何路径分隔符与点段）
      if (/[\\/]|\.\./.test(dirParam)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('目录参数不合法');
        return;
      }
      bookDir = path.join(outputDir, dirParam);
      const dash = dirParam.indexOf('-');
      displayName = dash > 0 ? dirParam.slice(dash + 1) : dirParam;
    } else {
      bookDir = state.files && state.files.dir;
    }
    if (!bookDir) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('文件尚未生成');
      return;
    }
    const resolvedDir = path.resolve(bookDir);
    const relative = path.relative(outputDir, resolvedDir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('路径不合法');
      return;
    }
    // TXT 固定文件名；EPUB 取目录内唯一 .epub（书名由引擎 safeFsName 生成）
    let filePath = null;
    try {
      if (kind === 'txt') {
        const p = path.join(resolvedDir, '全书合并.txt');
        if (fs.existsSync(p)) filePath = p;
      } else {
        const f = fs.readdirSync(resolvedDir).find((x) => x.endsWith('.epub'));
        if (f) filePath = path.join(resolvedDir, f);
      }
    } catch (e) { /* 目录不可读按不存在处理 */ }
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(kind === 'txt' ? '汇总 TXT 尚未生成' : 'EPUB 尚未生成');
      return;
    }
    const mime = kind === 'txt' ? 'text/plain' : 'application/epub+zip';
    const fname = kind === 'txt' ? `${displayName}-全书合并.txt` : `${displayName}.epub`;
    res.writeHead(200, {
      'Content-Type': `${mime}; charset=utf-8`,
      'Content-Disposition': `attachment; filename="novel.${kind}"; filename*=UTF-8''${encodeURIComponent(fname)}`
    });
    // 流必须挂 error 监听：existsSync 与 open 之间的删除/移动竞态、Windows 文件被占用
    // 的 EPERM 都在异步 open 阶段触发——无监听的 error 事件穿透为 uncaughtException
    // 按崩溃策略退出，一个本地请求即可杀服务（2026-09-29 架构审查 高）
    const rs = fs.createReadStream(filePath);
    rs.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); });
    rs.pipe(res);
    return;
  }

  // 章节预览：lastResult 只存章节元数据（正文不落内存，大书场景常驻数十 MB 的问题），
  // 正文按需从磁盘单章文件读取并剥离首行书名行
  const pm = url.pathname.match(/^\/api\/preview\/(\d+)$/);
  if (pm && state.lastResult) {
    const n = Number(pm[1]);
    const r = state.lastResult.results.find((x) => x.n === n);
    let text = null;
    if (r && r.file && state.files && state.files.dir) {
      text = engine.readCachedText(state.files.dir, r.file);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text ? `《${state.bookName}》 ${r.title}\n\n${text}` : '（该章暂无正文）');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

ensureMockSite().then(() => {
  // 端口被占（如已双击过一次）则向后换端口重试：双实例场景第二个实例也能起服务，
  // 而不是 EADDRINUSE 直接崩溃退出——取证确认这正是用户看到"全是报错"的死法之一
  let uiPort = UI_PORT;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && uiPort < UI_PORT + 20) {
      console.log(`[ui] 端口 ${uiPort} 被占用，尝试 ${uiPort + 1}`);
      uiPort += 1;
      server.listen(uiPort, '127.0.0.1');
    } else {
      console.error('[ui] 服务启动失败:', e.message);
      process.exit(1);
    }
  });
  server.listen(uiPort, '127.0.0.1', () => {
    console.log(`[ui] 小说下载工作台: http://127.0.0.1:${uiPort}`);
    console.log(`[ui] mock 模拟站已就绪 (端口 ${MOCK_PORT})`);
    console.log(`[ui] 下载输出目录: ${path.join(outputRoot(), 'output')}`);
    // 上次异常退出的现场提示：crash.log 存在说明上一次运行有未捕获异常，
    // 提醒用户可反馈/排查，读完即归档改名避免每次启动都报
    const crashFile = path.join(outputRoot(), 'crash.log');
    if (fs.existsSync(crashFile) && fs.statSync(crashFile).size > 0) {
      const archived = crashFile + '.' + Date.now();
      try { fs.renameSync(crashFile, archived); console.log(`[ui] ⚠ 检测到上次运行的崩溃日志: ${archived}`); }
      catch (e) { console.log('[ui] ⚠ 检测到 crash.log（归档失败，原文件保留）'); }
    }
    // 打包态双击启动时自动打开浏览器；开发态手动访问即可
    if (process.pkg) {
      const { exec } = require('child_process');
      exec(`start http://127.0.0.1:${uiPort}`);
    }
  });
});

process.on('exit', () => { /* mock 站与本服务同进程，进程退出即一并结束 */ });
