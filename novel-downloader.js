/**
 * 通用小说下载器引擎 v3（Node.js 零依赖）—— 可复用抓取库 + CLI 双入口。
 *
 * <p>v3 变化（为 Web UI 复用做的解耦）：</p>
 * <ul>
 *   <li>抽出 downloadBook(source, bookName, opt, hooks)：把目录解析、并发下载、
 *       断点续传、合并导出收敛为单个可编程调用，CLI 与 Web UI 共用同一入口</li>
 *   <li>新增 hooks 回调（onLog/onChapter/onProgress），UI 轮询或推送进度不再依赖解析 stdout</li>
 *   <li>manifest 记录章节标题与抓取 URL，缓存命中时可直接提供正文预览，
 *       修复书源更换后缓存错位风险（旧版只看文件是否存在）</li>
 *   <li>导出函数（exportTxt/exportEpub）可独立调用，输出格式与抓取彻底解耦</li>
 * </ul>
 *
 * <p>CLI 用法不变：node novel-downloader.js [书名] [--source xx.json] [--epub]。</p>
 *
 * <p>版权约束：仅供学习 HTTP 抓取与电子书打包技术；不得用于批量复制受版权保护的作品。</p>
 */
'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const { decodeGbk, nativeGbkSupported } = require('./gbk-decoder');
const legadoAdapter = require('./legado-adapter');

// ---------------------------------------------------------------------------
// 书源加载与规则执行器
// ---------------------------------------------------------------------------

/** 读取并校验多书源文件；返回书源数组。兼容 v1 单书源裸对象格式 */
function loadBookSources(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const list = Array.isArray(raw.bookSources) ? raw.bookSources : [raw];
  for (const src of list) {
    for (const key of ['bookSourceName', 'bookSourceUrl', 'searchUrl', 'ruleSearch', 'ruleContent']) {
      if (!src[key]) throw new Error(`书源[${src.bookSourceName || '?'}]缺少字段: ${key}`);
    }
  }
  return list;
}

/** v1 兼容：单书源加载（CLI --source 场景仍可用） */
function loadBookSource(filePath) {
  return loadBookSources(filePath)[0];
}

/**
 * 在受限上下文中执行书源规则片段。
 * Function 构造的参数列表形成白名单作用域，规则拿不到引擎内部变量；
 * 返回值为规则的求值结果（字符串/数组等）。
 */
function evalRule(code, ctx) {
  const keys = Object.keys(ctx);
  const fn = new Function(...keys, `"use strict"; return (${code});`);
  return fn(...keys.map((k) => ctx[k]));
}

/**
 * 目录/文件名安全化：剔除文件系统非法字符、点路径段与控制字符。
 * 书源名与书名都可来自外部书源 JSON，直接拼路径存在 ../ 穿越写出
 * output 目录的风险（安全评审实测可复现），所有落盘路径必须经此清洗。
 */
function safeFsName(s) {
  const cleaned = String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\.{2,}/g, '')
    .trim();
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned.slice(0, 80) : '未命名';
}

// ---------------------------------------------------------------------------
// HTTP 层：请求、解压、编码探测
// ---------------------------------------------------------------------------

// keep-alive 连接池：同一站点的搜索/详情/目录/章节请求复用 TCP 连接，
// 免去每次 TLS 握手（1~2 RTT）；65536 起步的 socket 余量覆盖多源并发体检
const keepAliveAgents = {
  http: new http.Agent({ keepAlive: true, maxSockets: 256, keepAliveMsecs: 30000 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 256, keepAliveMsecs: 30000 })
};

// ---------------------------------------------------------------------------
// 反爬基础件（2026-09-24 GitHub 反反爬调研落地：浏览器头套件 + Cookie 会话
// + 代理出口；自适应降速见 throttle 节）。shudugu 封禁实测定性为 IP 窗口计数型，
// TLS 指纹层已证实不查（纯 Node 成功 93 章），故不做 TLS 伪装。
// ---------------------------------------------------------------------------

/** 代理出口：标准环境变量 HTTPS_PROXY/HTTP_PROXY（小写同认），NO_PROXY 支持
 *  逗号分隔的主机后缀排除（* 全排除）。返回代理 URL 字符串或 null。
 *  IP 级封禁的唯一根治是换出口 IP；无代理资源时不设置即完全不影响原链路 */
function proxyEnvFor(url) {
  const u = new URL(url);
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  if (noProxy) {
    const list = noProxy.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.some((p) => p === '*' || u.hostname === p
      || u.hostname.endsWith('.' + p.replace(/^\./, '')))) return null;
  }
  const key = u.protocol === 'https:' ? 'HTTPS_PROXY' : 'HTTP_PROXY';
  return process.env[key] || process.env[key.toLowerCase()] || null;
}

/** 代理 CONNECT 隧道（https 目标专用）：先与代理建连，再把返回的 socket
 *  升级 TLS 直连目标站。零依赖手工实现，避免引入代理 agent 依赖破坏打包体系 */
function connectTunnel(targetUrl, proxyRaw, timeoutMs) {
  const u = new URL(targetUrl);
  const p = new URL(proxyRaw);
  const headers = {};
  if (p.username) {
    headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(
      `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64');
  }
  return new Promise((resolve, reject) => {
    const creq = http.request({
      host: p.hostname, port: Number(p.port) || 80, method: 'CONNECT',
      path: `${u.hostname}:${u.port || 443}`, headers, timeout: timeoutMs
    });
    creq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 被拒绝(HTTP ${res.statusCode}): ${p.host}`));
        return;
      }
      resolve(socket);
    });
    creq.on('error', (e) => reject(new Error(`代理连接失败(${p.host}): ${e.message}`)));
    creq.on('timeout', () => creq.destroy(new Error(`代理连接超时(${timeoutMs}ms): ${p.host}`)));
    creq.end();
  });
}

// Cookie 会话罐按 host 分桶：无 Cookie 的连续裸请求是典型机器人信号，
// 浏览器插件天然带会话（借鉴 antiscraping-toolkit 调研结论）。仅 browserLike 模式启用
const cookieJarsByHost = new Map();

function cookieJarFor(host) {
  if (!cookieJarsByHost.has(host)) cookieJarsByHost.set(host, new Map());
  return cookieJarsByHost.get(host);
}

/** 收集响应 Set-Cookie 入罐（重定向每一跳都会收集：站点常在跳转链上种会话 Cookie） */
function storeResponseCookies(setCookie, host) {
  if (!setCookie) return;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  const jar = cookieJarFor(host);
  for (const sc of arr) {
    const pair = String(sc).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

/** 生成浏览器风格请求头套件：裸 Node 请求缺一大半浏览器头，本身就是指纹。
 *  Accept-Encoding 只广告 gzip/deflate——解压层不支持 br，广告了会解码失败。
 *  UA/Referer 由调用方经 extra 覆盖（手动模式传 Chrome UA + 目录页 Referer） */
function browserLikeHeaders(extra) {
  return {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    ...(extra || {})
  };
}

/** 发起 HTTP 请求（GET/POST + 重定向跟随 + 硬超时覆盖 DNS/连接/响应头/响应体全阶段）。
 *  options: {method, body, headers}；body 为字符串时按 application/x-www-form-urlencoded 发送 */
function httpRequest(url, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https:');
    const transport = isHttps ? https : http;
    const headers = { 'User-Agent': 'NovelDownloaderDemo/3.0 (learning purpose)', ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    // Cookie 会话回带（browserLike 模式经 cookieHost 启用）：无 Cookie 的连续裸请求
    // 是典型机器人信号；调用方显式传 Cookie 头时不覆盖（书源自定义优先）
    const cookieHost = options.cookieHost || null;
    if (cookieHost && !headers.Cookie) {
      const jar = cookieJarFor(cookieHost);
      if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    // 响应处理抽成命名函数：直连与代理两条建链路径共用同一套重定向/上限/解码逻辑
    const onResponse = (res) => {
      // 会话 Cookie 收集（含重定向每一跳：站点常在跳转链上种会话 Cookie）
      if (cookieHost) storeResponseCookies(res.headers['set-cookie'], cookieHost);
      // 重定向跟随（最多 3 次）
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && (options._redirects || 0) < 3) {
        res.resume();
        clearTimeout(hardTimer);
        // 畸形 Location（含空格/非法字符/协议相对异常）会让 new URL 同步抛错，
        // 发生在响应回调内会穿透 Promise 链直达 uncaughtException 崩进程，
        // 必须就地捕获并按普通请求失败处理（安全评审实测可达）
        let next;
        try {
          next = new URL(res.headers.location, url).href;
        } catch (e) {
          reject(new Error(`站点返回了非法的重定向地址: ${String(res.headers.location).slice(0, 120)}`));
          return;
        }
        // 跨注册域重定向不跟随：小站反爬常见手法是封禁后 302 到 google.com 等外域
        // （shudugu 实测），跟随过去只会对不可达外域白等超时且污染失败原因。
        // 同注册域（shudugu.org ↔ www.shudugu.org）视为正常跳转放行；
        // 注册域按 hostname 末两级近似（co.uk 类后缀误判可接受，本工具场景均为普通站点）
        const curDomain = new URL(url).hostname.split('.').slice(-2).join('.');
        const nextDomain = new URL(next).hostname.split('.').slice(-2).join('.');
        if (curDomain !== nextDomain) {
          const err = new Error(`站点将请求重定向至外域 ${new URL(next).host}，疑似触发反爬封禁或域名变更，请稍后重试或更换站点`);
          err.crossDomainRedirect = true;
          reject(err);
          return;
        }
        httpRequest(next, timeoutMs, { ...options, _redirects: (options._redirects || 0) + 1 })
          .then(resolve, reject);
        return;
      }
      const chunks = [];
      // 响应体大小上限：异常/恶意站点可持续回传 GB 级数据撑爆内存（资源耗尽面），
      // 超限即销毁流并按失败处理。章节/目录 HTML 实测均 <2MB，16MB 余量充足
      const MAX_BODY = 16 * 1024 * 1024;
      let received = 0;
      res.on('data', (c) => {
        received += c.length;
        if (received > MAX_BODY) {
          res.destroy();
          clearTimeout(hardTimer);
          reject(new Error(`响应体超过 ${MAX_BODY / 1024 / 1024}MB 上限，站点响应异常: ${new URL(url).host}`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        clearTimeout(hardTimer);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          bodyBuffer: Buffer.concat(chunks)
        });
      });
      res.on('error', (e) => { clearTimeout(hardTimer); reject(e); });
    };
    // 硬超时到响应体完整接收才解除：响应头到达后若对端以极慢速度持续 drip 数据，
    // 旧实现已清除定时器，请求会被无限挂起（慢速攻击/劣质站点实测可见）。
    // req 先声明再挂定时器：url 非法时 transport.request 会同步抛错，
    // 若定时器回调引用未初始化的 req 会触发 TDZ ReferenceError（2026-09-24 清洗
    // 书源包时实测命中），且抛错路径必须清掉定时器，否则 4s 后仍会误触发
    let req;
    // 代理隧道建立期间硬超时可能先触发：建连成功后须检测 abandoned 立即销毁，
    // 否则孤儿 socket 常驻（代理路径特有的竞态）
    let abandoned = false;
    const hardTimer = setTimeout(() => {
      abandoned = true;
      if (req) req.destroy();
      reject(new Error(`请求超时(${timeoutMs}ms，站点DNS或连接不可达): ${new URL(url).host}`));
    }, timeoutMs);
    const finishReq = () => {
      req.on('error', (e) => { clearTimeout(hardTimer); reject(e); });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时(${timeoutMs}ms): ${url}`)));
      if (options.body) req.write(options.body);
      req.end();
    };
    // 代理出口：options.proxy 显式指定（传 null 禁用），缺省读 HTTPS_PROXY/HTTP_PROXY
    // 环境变量——IP 级封禁的唯一根治是换出口 IP，无代理资源时不设置即零影响
    const proxyRaw = options.proxy !== undefined ? options.proxy : proxyEnvFor(url);
    try {
      if (proxyRaw && isHttps) {
        // https 经代理：CONNECT 隧道 + TLS 升级，硬超时覆盖隧道建立全程
        connectTunnel(url, proxyRaw, timeoutMs).then((sock) => {
          if (abandoned) { sock.destroy(); return; }
          const u = new URL(url);
          req = https.request({
            host: u.hostname, port: Number(u.port) || 443, path: u.pathname + u.search,
            method: options.method || 'GET', headers, agent: false,
            createConnection: () => tls.connect({ socket: sock, servername: u.hostname })
          }, onResponse);
          finishReq();
        }).catch((e) => { clearTimeout(hardTimer); reject(e); });
        return;
      }
      if (proxyRaw) {
        // http 经代理：请求行携带绝对 URI，Host 头指向目标站；
        // 代理连接不复用目标站 keepAlive 池（agent:false）
        const p = new URL(proxyRaw);
        headers.Host = new URL(url).host;
        if (p.username) {
          headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(
            `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64');
        }
        req = http.request({
          host: p.hostname, port: Number(p.port) || 80, path: url,
          method: options.method || 'GET', headers, agent: false
        }, onResponse);
      } else {
        req = transport.request(url, {
          method: options.method || 'GET',
          headers,
          agent: keepAliveAgents[isHttps ? 'https' : 'http']
        }, onResponse);
      }
    } catch (e) {
      // url 非法（协议缺失/主机含非法字符等）同步抛错：清定时器 + 以该错误拒绝，
      // 调用方（书源探测/重试层）据此判该源失效
      clearTimeout(hardTimer);
      reject(e);
      return;
    }
    finishReq();
  });
}

/** 发起请求（兼容旧 GET 调用），硬超时覆盖 DNS/连接/响应全阶段 */
function httpGet(url, timeoutMs) {
  return httpRequest(url, timeoutMs);
}

/** 按响应头解压 gzip/deflate；未压缩原样返回 */
function decompress(buf, headers) {
  const enc = (headers['content-encoding'] || '').toLowerCase();
  if (enc.includes('gzip')) return zlib.gunzipSync(buf);
  if (enc.includes('deflate')) return zlib.inflateSync(buf);
  return buf;
}

/**
 * 编码探测链：HTTP 头 charset → HTML meta charset → UTF-8 严格解码失败判 GBK。
 * 严格模式的价值：声明与实际不符时（声明 utf-8 实为 GBK）能被捕获并纠正。
 * GBK 兜底优先用 Node 原生 TextDecoder；pkg 打包裁剪 ICU 后不可用，
 * 此时落自研查表解码器（gbk-decoder.js），保证 exe 内编码链路完整。
 * JSON API 响应按规范永远是 UTF-8，type=json 时跳过 GBK 探测链。
 */
const NATIVE_GBK = nativeGbkSupported();
function decodeBody(buf, headers, type) {
  if (type === 'json') {
    return buf.toString('utf8');
  }
  const ct = headers['content-type'] || '';
  let charset = (ct.match(/charset=([\w-]+)/i) || [])[1];
  if (!charset) {
    const head = buf.subarray(0, 2048).toString('latin1');
    charset = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  }
  charset = (charset || 'utf-8').toLowerCase();
  if (charset === 'utf-8' || charset === 'utf8') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) { /* 实际编码非 UTF-8，落 GBK 兜底 */ }
  }
  if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') {
    // 显式 GBK 家族：原生可用走原生（覆盖表外全字符集），否则查表兜底
    return NATIVE_GBK ? new TextDecoder(charset).decode(buf) : decodeGbk(buf);
  }
  try {
    return new TextDecoder(charset).decode(buf);
  } catch (e) {
    // 其他不支持的编码（如 big5 在裁剪 ICU 的 exe 内）按 GBK 尽力解码
    return NATIVE_GBK ? new TextDecoder('gbk').decode(buf) : decodeGbk(buf);
  }
}

// ---------------------------------------------------------------------------
// 抓取原语：限速 + 重试
// ---------------------------------------------------------------------------

// 限速器按站点 host 分桶：不同站点并行互不排队，同站点保持礼貌间隔。
// 旧版全局单例让 261 个源共享一个队列，一次多源搜索要排队 60 秒以上（实测瓶颈）。
// 这里保存“上一个请求开始时间”和等待队列，防止并发 worker 同时读旧时间戳后一起放行。
const requestGatesByHost = new Map();

function requestGate(host) {
  const bucket = host || 'global';
  if (!requestGatesByHost.has(bucket)) {
    // winTimes：滑动窗口内最近请求时间戳数组（长度 ≤ maxPerMin ≤ 120，无泄漏风险）；
    // maxPerMin：最近一次 throttle 调用声明的窗口上限（供 getHostRate 快照展示）
    requestGatesByHost.set(bucket,
      { chain: Promise.resolve(), last: 0, slow: 1, winTimes: [], maxPerMin: null });
  }
  return requestGatesByHost.get(bucket);
}

/** 滑动窗口长度（毫秒）。抽成可变常量：单测经 __setThrottleWindowMs 缩短窗口，
 *  避免 60s 真实等待（生产路径恒为 60000，语义不变量「任意 60s ≤ maxPerMin」） */
let throttleWindowMs = 60000;

/** 测试钩子：临时改滑动窗口长度，返回恢复函数。生产代码不应调用 */
function __setThrottleWindowMs(ms) {
  const prev = throttleWindowMs;
  throttleWindowMs = Math.max(1, Number(ms) || 60000);
  return () => { throttleWindowMs = prev; };
}

/** 自适应降速（调研方案 3：scrapehero/bright 共识——固定节奏在封禁前一秒还在全速冲）：
 *  命中限流/封禁信号时该 host 间隔倍率 ×2（封顶 32 倍），成功则缓慢回落 ×0.9。
 *  效果：在站点封禁阈值之下自动收敛出安全速度，而非一头撞进封禁窗口 */
function bumpHostPenalty(host) {
  const gate = requestGate(host);
  gate.slow = Math.min(32, (gate.slow || 1) * 2);
}

function noteHostSuccess(host) {
  const gate = requestGate(host);
  gate.slow = Math.max(1, (gate.slow || 1) * 0.9);
}

async function throttle(minIntervalMs, host, maxPerMin) {
  const gate = requestGate(host);
  const previous = gate.chain.catch(() => {});
  let release;
  gate.chain = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    // 每分钟请求上限（借鉴怠惰下载器 maxDlPerMin）：窗口计数型反爬对请求总量敏感
    // （shudugu 实测 400ms 固定间隔 ~93 章/37s 即整站封禁），仅放慢间隔无法规避，
    // 必须在 host 维度限制每 60s 窗口内的总请求数。
    // 滑动窗口（2026-10 迭代，替代固定窗口）：固定窗口打满后全员睡到窗口重置，
    // 表现为「突发后整窗死等、重置后新一轮突发」的走走停停；滑动窗口打满时只睡到
    // 最早一个请求滑出窗口（winTimes[0]+window-now）即放行一个，总量不变、节奏匀速，
    // 语义不变量保持「任意 60s 内 ≤ maxPerMin」（已固化进 test/engine.test.js）
    if (maxPerMin > 0) {
      gate.maxPerMin = maxPerMin;
      let now = Date.now();
      while (gate.winTimes.length && now - gate.winTimes[0] >= throttleWindowMs) gate.winTimes.shift();
      if (gate.winTimes.length >= maxPerMin) {
        const waitWin = gate.winTimes[0] + throttleWindowMs - now;
        if (waitWin > 0) await new Promise((r) => setTimeout(r, waitWin));
        now = Date.now();
        while (gate.winTimes.length && now - gate.winTimes[0] >= throttleWindowMs) gate.winTimes.shift();
      }
      gate.winTimes.push(now);
    }
    // 自适应倍率作用在基础间隔上：被封过的 host 自动慢下来
    const effInterval = (minIntervalMs || 0) * (gate.slow || 1);
    const wait = effInterval - (Date.now() - gate.last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    gate.last = Date.now();
  } finally {
    release();
  }
}

/** 只读快照某 host 的限速门状态（供 Web 层 SSE 限速可视化）；host 无记录返回 null。
 *  不引入新状态，直接读 requestGatesByHost；winCount 只计窗口内未过期时间戳
 *  （throttle 只在请求路径裁剪数组，快照侧自行过滤保证显示值实时准确）。
 *  winRemainingMs 语义：距下一个请求名额释放的毫秒数——窗口打满时为
 *  「最早请求滑出窗口的剩余时间」，未满窗为 0；该 host 无窗口限速（maxPerMin 未声明）为 null */
function getHostRate(host) {
  const gate = requestGatesByHost.get(host || 'global');
  if (!gate) return null;
  const now = Date.now();
  const inWin = (gate.winTimes || []).filter((t) => now - t < throttleWindowMs);
  const maxPerMin = gate.maxPerMin || null;
  let winRemainingMs = null;
  if (maxPerMin != null) {
    winRemainingMs = (inWin.length >= maxPerMin && inWin.length)
      ? Math.max(0, inWin[0] + throttleWindowMs - now) : 0;
  }
  return { host: host || 'global', slow: gate.slow || 1,
    winCount: inWin.length, maxPerMin, winRemainingMs };
}

/** 单页抓取：限速→请求→验 200→解压→解码；非 200 抛错交由重试层。
 *  opt.responseType='json' 时跳过 HTML 探测链按 UTF-8 解码（API 型书源）。
 *  opt.browserLike 启用反爬三件套：浏览器头套件 + Cookie 会话 + 自适应降速（手动模式） */
async function fetchPage(url, opt) {
  // timeoutMs 缺省兜底：undefined 传给 httpRequest 会让 setTimeout 抛
  // 「msecs argument」型错误，掩盖真实的网络错误（2026-09-29 实测）
  const timeoutMs = opt.timeoutMs != null ? opt.timeoutMs : 15000;
  // 间隔随机抖动（借鉴怠惰下载器 Math.random()*500 退避）：固定毫秒节奏是
  // 教科书式机器指纹，真人浏览间隔天然抖动；jitterMs 为随机增量上界
  const interval = (opt.minIntervalMs || 0)
    + (opt.jitterMs ? Math.floor(Math.random() * opt.jitterMs) : 0);
  const host = new URL(url).host;
  await throttle(interval, host, opt.maxPerMin);
  // opt.headers 携带书源要求的 Referer/UA/设备头（legado header 字段预求值产物），
  // 缺失时部分接口以 incorrect referer 拒绝；默认 UA 放最前保证可被源头覆盖。
  // browserLike 时先铺浏览器头套件再叠书源头（书源头优先级恒最高）
  const headers = opt.browserLike ? browserLikeHeaders(opt.headers) : opt.headers;
  const res = await httpRequest(url, timeoutMs, {
    method: opt.method, body: opt.body, headers,
    cookieHost: opt.browserLike ? host : undefined
  });
  if (res.status !== 200) {
    // status 挂到错误对象上：重试层据此区分确定性失败（4xx）与可恢复失败（5xx/网络）
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    // Retry-After（429/503 限流站点常携带）：秒数或 HTTP 日期，封顶 120s 防恶意长挂
    const ra = res.headers['retry-after'];
    if (ra) {
      const ms = /^\d+$/.test(ra) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - Date.now());
      if (ms > 0) err.retryAfterMs = Math.min(ms, 120000);
    }
    throw err;
  }
  // 成功即让该 host 的自适应倍率缓慢回落（browserLike 才启用惩罚机制）
  if (opt.browserLike) noteHostSuccess(host);
  return decodeBody(decompress(res.bodyBuffer, res.headers), res.headers, opt.responseType);
}

/** 指数退避重试：base→2x→4x；4xx 属确定性失败（地址错/拒绝访问），重试无意义
 *  且会把失败反馈拖长 7 倍，直接抛出；仅网络错误与 5xx 消耗重试预算。耗尽后抛给调用方决定去留。
 *  例外：429 是限流信号而非确定性失败（站点明说「稍后再来」），遵守 Retry-After 后重试 */
async function fetchWithRetry(url, opt) {
  // 缺省参数兜底：库方式调用 opt 不全时 attempt<=undefined 循环零迭代，
  // throw lastErr 为 undefined（reject 无值，上层 catch 无 message 极难诊断，
  // 2026-09-28 实测踩坑）；maxRetries=0 是合法值故不能用 || 兜底
  const maxRetries = opt.maxRetries != null ? opt.maxRetries : 2;
  const retryBaseDelayMs = opt.retryBaseDelayMs != null ? opt.retryBaseDelayMs : 800;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = retryBaseDelayMs * 2 ** (attempt - 1);
      // Retry-After 优先于指数退避：站点给定的等待时长是最准确的解限信号
      const ra = (lastErr && lastErr.retryAfterMs) || 0;
      await new Promise((r) => setTimeout(r, Math.max(backoff, ra)));
    }
    try {
      return await fetchPage(url, opt);
    } catch (e) {
      lastErr = e;
      // 自适应升速：命中限流/封禁信号立刻拉高该 host 的间隔倍率，
      // 后续章节自动慢下来（browserLike 模式；固定节奏撞阈值是 shudugu 封禁的直接原因）
      if (opt.browserLike) {
        if (e.status === 429 || e.status === 403 || e.status === 503 || e.crossDomainRedirect) {
          bumpHostPenalty(new URL(url).host);
        }
      }
      // 429 限流属可恢复失败：消耗重试预算、按 Retry-After/退避等待后重试
      if (e.status === 429) continue;
      if (typeof e.status === 'number' && e.status >= 400 && e.status < 500) break;
      // DNS 解析失败/连接拒绝/网络不可达同属确定性失败：与 4xx 一样重试无意义，
      // 重试会把失败反馈拖长数倍（死域名实测 23s → 立即返回）
      if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/.test(e.message || '')) break;
      // 跨域重定向（反爬封禁）同属确定性失败：封禁窗口内重试只会加深封禁
      if (e.crossDomainRedirect) break;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 解析层：由书源规则驱动
// ---------------------------------------------------------------------------

/**
 * 执行 ruleToc：chapterList 规则返回迭代序列（HTML 正则 matchAll 数组，
 * 或 JSON API 场景的函数型规则返回对象数组）。
 * 引擎对每个元素注入 m 并求值 chapterUrl/chapterName/chapterNumber。
 * 结果按章节号升序，保证输出顺序与目录一致。
 */
function parseCatalog(html, source) {
  // legado 源：目录规则是 DSL（class.x@tag.dd 形态），当 JS 执行必抛语法错误（实测
  // "Unexpected token '.'"），交适配层翻译；内置源规则为 JS 表达式维持原路径
  if (source.legado) {
    return legadoAdapter.legadoParseCatalog(html, source);
  }
  const rt = source.ruleToc;
  let list;
  if (typeof rt.chapterList === 'function') {
    // 函数规则入参：responseType=json 传解析后对象；HTML 书源传原始 html
    if (source.responseType === 'json') {
      let json = null;
      try { json = JSON.parse(html); } catch (e) { json = null; }
      list = rt.chapterList(json !== null ? json : html);
    } else {
      list = rt.chapterList(html);
    }
  } else if (rt.chapterListRegex) {
    // 正则字符串规则：全局迭代，每项 {m1, m2, ...} 为捕获组（避免书源内嵌正则字面量的转义问题）
    const re = new RegExp(rt.chapterListRegex, 'gi');
    list = [];
    let mm;
    while ((mm = re.exec(html)) !== null) {
      const item = { raw: mm[0] };
      for (let g = 1; g < mm.length; g++) item['m' + g] = mm[g];
      list.push(item);
    }
  } else {
    list = evalRule(rt.chapterList, { html, source });
  }
  const chapters = [];
  let i = 0;
  for (const m of list) {
    const ctx = { html, source, m, i: i++ };
    const seq = i;   // ctx 内 i 已自增，此处为 1 基出现序号
    const item = typeof m === 'object' && m !== null ? m : {};
    const url = typeof rt.chapterUrl === 'function' ? rt.chapterUrl(item) : evalRule(rt.chapterUrl, ctx);
    // 章节号规则缺失或求值非法时回退为出现序：排序与导出恒有稳定顺序，
    // 不再因书源规则残缺导致目录乱序
    const rawN = rt.chapterNumber
      ? (typeof rt.chapterNumber === 'function' ? rt.chapterNumber(item, seq) : evalRule(rt.chapterNumber, ctx))
      : seq;
    const n = Number.isFinite(Number(rawN)) ? Number(rawN) : seq;
    chapters.push({
      n,
      url: new URL(url, source.bookSourceUrl).href,
      title: typeof rt.chapterName === 'function' ? rt.chapterName(item) : evalRule(rt.chapterName, ctx)
    });
  }
  chapters.sort((a, b) => a.n - b.n);
  return chapters;
}

/**
 * 执行 ruleContent：content 规则抽出正文。
 * HTML 场景：表达式返回原始 HTML 片段，replaceRegex 行级过滤后规整缩进。
 * JSON API 场景：content 为函数，收到解析后的 JSON 对象，直接返回纯文本
 * （API 无 HTML 标签可清，replaceRegex 仍生效于行级过滤）。
 */
function extractContent(html, source) {
  // 手动链接模式：无书源规则，走启发式正文容器识别
  if (source.manual) {
    const raw = extractGenericContent(html);
    if (!raw) return null;
    // 广告行清洗作用在 normalizeContent 产出的纯文本上（extractGenericContent 返回
    // 的是 HTML 片段，「行」概念在其上不成立），位置等同手动模式正文链路返回前
    return cleanAdLines(normalizeContent(raw, source));
  }
  // legado 源：content 规则同为 DSL，交适配层翻译（含 legado 格式 replaceRegex），
  // 返回值已是 HTML 片段或纯文本，落回下方统一的标签清洗与行过滤
  if (source.legado) {
    const legadoRaw = legadoAdapter.legadoExtractContent(html, source);
    if (!legadoRaw) return null;
    return normalizeContent(legadoRaw, source);
  }
  const rc = source.ruleContent;
  let raw;
  if (typeof rc.content === 'function') {
    let json = null;
    if (source.responseType === 'json') { try { json = JSON.parse(html); } catch (e) { json = null; } }
    raw = json !== null ? rc.content(json) : rc.content(html);
  } else {
    raw = evalRule(rc.content, { html, source });
  }
  if (!raw) return null;
  return normalizeContent(raw, source);
}

/** 正文统一清洗：HTML 转行、剥标签、实体还原、行过滤后规整缩进。
 *  从 extractContent 抽出复用——legado 与原生源在规则求值后走同一套清洗口径 */
function normalizeContent(raw, source) {
  // replaceRegex 只认字符串数组（原生源格式）；legado 源的对象数组与字符串
  // 简写形态均已在适配层消化（见 legado-adapter.legadoExtractContent），
  // 此处对非数组形态一律跳过——字符串直接 .map 会抛 TypeError（速读谷实测复现）
  const rr = source.ruleContent && source.ruleContent.replaceRegex;
  const filters = (Array.isArray(rr) ? rr : []).map((p) =>
    typeof p === 'string'
      ? (/^\/(.+)\/$/.test(p) ? new RegExp(p.slice(1, -1)) : new RegExp(p))
      : null);   // legado 的对象型 replaceRegex 已在适配层消化，此处跳过防误建
  const text = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p>/gi, '\n').replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    // 文末断标签清理（2026-10-08 bookmaopu 实测）：站点 HTML 残缺出现 <b</div
    // 这类无 > 收尾的开标签，<[^>]+> 剥不掉，提取片段尾部残留孤立 <b。
    // 限定 <字母 + ≤15 个非尖括号字符且紧贴文末——正文中间的 < 字符（罕见）
    // 不会被跨段误吞（宁漏勿错，最大误删面 15 字符）
    .replace(/<[a-zA-Z][^<>]{0,15}$/, '')
    .replace(/&nbsp;/g, ' ')
    // &emsp;/&ensp; 全角/半角空格实体：速读谷等站用它做段落缩进，不清理会原样
    // 残留进 TXT 正文（清洗已统一加两空格缩进，实体缩进属重复，直接删除）
    .replace(/&emsp;/g, '').replace(/&ensp;/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // legado 字符串形态 replaceRegex（"##re##rep" 简写）在此消化：语义要求作用于
  // 剥标签后的纯文本，且 $ 类行尾锚定需多行模式——适配层 HTML 阶段消化不到
  // （速读谷「（本章完）」行尾标记实测复现）；与适配层的 HTML 阶段消化幂等共存
  let cleaned = text;
  if (typeof rr === 'string' && rr.trim()) {
    for (const line of rr.split('\n')) {
      const f = line.trim();
      if (!f.startsWith('##')) continue;
      const parts = f.slice(2).split('##');
      try {
        cleaned = cleaned.replace(new RegExp(parts[0], 'gm'), parts[1] !== undefined ? parts[1] : '');
      } catch (e) { /* 非法正则跳过 */ }
    }
  }
  const lines = cleaned.split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => !filters.some((f) => f && f.test(s)));
  return lines.map((s) => '  ' + s).join('\n\n');
}

// ---------------------------------------------------------------------------
// 手动链接模式：无书源规则的启发式解析（目录页锚点聚类 + 正文容器识别）
// 供 /api/parse-link 与 manual 下载任务使用；与书源规则体系完全解耦
// ---------------------------------------------------------------------------

/** 中文数字转整数（十/百/千/万 分段累加，覆盖目录常见的 一至数万 量级） */
function cnNum(s) {
  const d = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0, section = 0, num = 0;
  for (const ch of s) {
    if (ch in d) num = d[ch];
    else if (ch === '十') { section += (num || 1) * 10; num = 0; }
    else if (ch === '百') { section += num * 100; num = 0; }
    else if (ch === '千') { section += num * 1000; num = 0; }
    else if (ch === '万') { total += (section + num) * 10000; section = 0; num = 0; }
    else return null;
  }
  return total + section + num;
}

/** 从章节标题提取序号：第X章（中/阿数字）、数字开头、「开始阅读」视为第 1 章；
 *  无法识别返回 null（公告类条目不参与排序） */
function chapterNoFromTitle(title) {
  const m = title.match(/第\s*([0-9零〇一二三四五六七八九十百千两万]+)\s*[章节回卷集部幕]/);
  if (m) return /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : cnNum(m[1]);
  const m2 = title.match(/^([0-9]{1,6})[.、\s]/);
  if (m2) return parseInt(m2[1], 10);
  // 目录页「开始阅读」按钮通常指向第一章，而正式列表常从第二章列起（shudugu 实测模板）
  if (/^(开始阅读|开始阅读全文|开始正?文?)$/.test(title)) return 1;
  return null;
}

/**
 * 目录噪声过滤（解析后处理）：剔除混入章节目录的广告/活动孤立链接。
 *
 * <p>实测依据：2026-09-28 shudugu.org 目录页末章混入「九月份中奖名单」链接
 * （外链/孤立路径）：聚类签名只取 pathname，外链 URL 的 pathname 与章节同构时
 * 会混进章节簇。本过滤把「主机 + 数字打码路径」作为模式，外链因主机不同、
 * 孤立路径因模板不同，都与众数模式不一致而被识别。</p>
 *
 * <p>策略：统计全部条目「主机+路径模板」的众数；与众数不一致
 * 且标题不含章节特征词（第X章/楔子/序章/番外/终章/尾声）的条目判为噪声剔除。
 * 保底：总章数 <10（小目录误杀代价大）或剔除比例 >30%（模式分散说明站点
 * 本身多模板，众数假设不成立）时不启用过滤。返回 {chapters, filteredNoise}，
 * 保留条目按结果序重排章节号，供上层透传过滤条数提示用户。</p>
 */
function filterTocNoise(chapters) {
  if (!chapters || chapters.length < 10) return { chapters, filteredNoise: 0 };
  const CHAPTER_TITLE_FEATURE = /第.*[章回卷节]|楔子|序章|番外|终章|尾声/;
  // 模式 = 主机 + 数字打码路径：外链广告靠主机维度与众数区分开
  const sigOf = (u) => { try { const x = new URL(u); return x.host + x.pathname.replace(/\d+/g, '#'); } catch (e) { return ''; } };
  const counts = new Map();
  for (const c of chapters) {
    const sig = sigOf(c.url);
    counts.set(sig, (counts.get(sig) || 0) + 1);
  }
  let mode = '', modeCount = 0;
  for (const [sig, n] of counts) { if (n > modeCount) { mode = sig; modeCount = n; } }
  const kept = [];
  let dropped = 0;
  for (const c of chapters) {
    if (sigOf(c.url) !== mode && !CHAPTER_TITLE_FEATURE.test(c.title)) { dropped++; continue; }
    kept.push(c);
  }
  // 误杀保护：剔除比例过高说明众数假设不成立，整体放弃过滤
  if (!dropped || dropped / chapters.length > 0.3) return { chapters, filteredNoise: 0 };
  kept.forEach((c, i) => { c.n = i + 1; });
  return { chapters: kept, filteredNoise: dropped };
}

/**
 * 从任意书籍目录页 HTML 启发式解析章节目录。
 *
 * <p>策略：① 全量锚点提取（滤掉 javascript:/#/mailto: 与超长文本）；② 剔除导航类
 * 锚点（首页/登录/收藏等）；③ 按 URL 路径「数字打码签名」聚类——章节链接几乎共享
 * 同一 URL 模板且带章节编号，取含数字的最大簇；④ 兜底按「第X章/数字.」标题形态筛选；
 * ⑤ 按 URL 去重（同 URL 的「开始阅读」占位标题可被真章节名替换）；
 * ⑥ 过半条目可提取章节号时按号稳定升序（预告区倒序/分页混入不再影响目录序），
 * 无号公告条目排到末尾；章节号最终按结果序重排。</p>
 *
 * <p>结果去向：{bookName, chapters:[{n,title,url}], reason?}；无法识别时 chapters 为空
 * 并附 reason（no-anchors / no-chapters）供上层给出针对性提示。</p>
 */
function parseGenericToc(html, baseUrl) {
  // 书名猜测：<title> 按常见分隔符截掉站点名/宣传后缀，兜底 <h1>
  let bookName = '';
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleM) {
    bookName = titleM[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
      .split(/[_|｜—–\-·]/)[0]
      .replace(/(最新章节|全文阅读|章节列表|目录|无弹窗|TXT下载|txt全集下载).*$/i, '')
      .trim();
  }
  if (!bookName) {
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1) bookName = h1[1].replace(/<[^>]+>/g, '').trim();
  }

  // ① 全量锚点
  const anchors = [];
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    if (!href || /^(javascript:|#|mailto:)/i.test(href)) continue;
    const title = m[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title || title.length > 60) continue;
    let abs;
    try { abs = new URL(href, baseUrl).href; } catch (e) { continue; }
    if (!/^https?:\/\//.test(abs)) continue;
    anchors.push({ title, url: abs });
  }
  if (!anchors.length) return { bookName, chapters: [], reason: 'no-anchors' };

  // ② 剔除导航锚点：整词与包含两档（站点 chrome 文案实测高频词）
  const NAV_EXACT = /^(首页|末页|上一页|下一页|上页|下页|返回|返回首页|返回书页|目录|书架|加入书架|加入书签|收藏本书|收藏|投票推荐|推荐本书|手机版|手机阅读|登录|注册|下载|报错|章节报错|上一章|下一章|网站首页|帮助|留言|RSS|txt|TXT)$/i;
  const NAV_PART = /(登录|注册|加入收藏|加入书架|加入书签|收藏本|排行榜|书库|全本小说|完本|连载中|最新更新|网站地图|免责声明|手机版|客户端|APP)/i;
  const candidates = anchors.filter((a) => !NAV_EXACT.test(a.title) && !NAV_PART.test(a.title));

  // ③ URL 形态聚类：路径数字打码为签名，章节簇同模板且规模最大（≥3）
  const groups = new Map();
  for (const a of candidates) {
    let sig;
    try { sig = new URL(a.url).pathname.replace(/\d+/g, '#'); } catch (e) { continue; }
    if (!sig.includes('#')) continue;   // 无数字路径不可能是章节页
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(a);
  }
  let used = null;
  for (const list of groups.values()) {
    if (list.length >= 3 && (!used || list.length > used.length)) used = list;
  }
  // ④ 兜底：URL 不带数字的站点（rewrite 成拼音/英文路径），按章节标题形态筛选
  if (!used) {
    const titled = candidates.filter((a) =>
      /第\s*[0-9零〇一二三四五六七八九十百千两]+\s*[章节回卷集部幕]/.test(a.title)
      || /^[0-9]{1,5}[.、\s]/.test(a.title));
    if (titled.length >= 3) used = titled;
  }
  if (!used) return { bookName, chapters: [], reason: 'no-chapters' };

  // ⑤ URL 去重保文档序（首页常含「最新章节」预告区与正文目录重复），顺序编号。
  // 同 URL 标题升级：「开始阅读」占位标题若后又出现带章节号的同名链接，换成真章节名
  const seen = new Map();   // url -> chapters 下标
  const chapters = [];
  for (const a of used) {
    const idx = seen.get(a.url);
    if (idx === undefined) {
      seen.set(a.url, chapters.length);
      chapters.push({ n: chapters.length + 1, title: a.title, url: a.url });
    } else if (/^(开始阅读|开始阅读全文|开始正?文?)$/.test(chapters[idx].title)
      && chapterNoFromTitle(a.title) !== null) {
      chapters[idx].title = a.title;
    }
  }
  // ⑥ 按章节号稳定升序：预告区（最新 3 章倒序）与分页目录混入时文档序不可靠，
  // 有过半条目可提取章节号即按号排序；公告类无号条目（上架加更/求月票等）
  // 保持原相对顺序排到正文章节之后，不丢弃（站点真实条目，用户可自行取舍）
  const decorated = chapters.map((c, i) => ({ c, no: chapterNoFromTitle(c.title), i }));
  const numberedCount = decorated.filter((x) => x.no !== null).length;
  if (numberedCount >= 3 && numberedCount >= chapters.length / 2) {
    decorated.sort((a, b) =>
      (a.no === null ? Infinity : a.no) - (b.no === null ? Infinity : b.no) || a.i - b.i);
    decorated.forEach((x, i) => { x.c.n = i + 1; });
    // ⑦ 噪声过滤：剔除与众数路径模板不一致的广告孤立链接（见 filterTocNoise）
    const fin = filterTocNoise(decorated.map((x) => x.c));
    return { bookName, chapters: fin.chapters, filteredNoise: fin.filteredNoise };
  }
  const fin = filterTocNoise(chapters);
  return { bookName, chapters: fin.chapters, filteredNoise: fin.filteredNoise };
}

/**
 * 探测目录页的「下一页」链接（分页目录跟随用）。
 * 命中 下一页/下页/next 锚点即返回其绝对地址，否则 null；调用方负责 visited 去重与页数上限。
 */
function findNextTocPage(html, baseUrl) {
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    if (!/^(下一页|下页|next|Next|NEXT)[\s>»]*$/.test(title)) continue;
    try {
      const abs = new URL(m[1].trim(), baseUrl).href;
      if (/^https?:\/\//.test(abs)) return abs;
    } catch (e) { /* 非法地址忽略 */ }
  }
  return null;
}

/**
 * 平衡扫描提取元素 innerHTML：正则无法处理嵌套同名标签，
 * 从开标签结束位起向后数同标签开/闭，深度归零处即配对闭标签。
 */
function extractElementInner(html, openTagEnd, tag) {
  const re = new RegExp(`<${tag}\\b|</${tag}\\s*>`, 'gi');
  re.lastIndex = openTagEnd;
  let depth = 1, mm;
  while ((mm = re.exec(html)) !== null) {
    if (mm[0].charAt(1) === '/') {
      depth--;
      if (depth === 0) return html.slice(openTagEnd, mm.index);
    } else if (!/\/>$/.test(mm[0])) {
      depth++;
    }
  }
  return null;   // 页面残缺未闭合：宁缺毋滥，交上层兜底
}

/** 常见小说站正文容器 id/class 名单（覆盖笔趣阁系、顶点、八一、79 等主流模板） */
const GENERIC_CONTENT_IDS = [
  'content', 'chaptercontent', 'chapterContent', 'chapter_content', 'booktext', 'BookText',
  'htmlContent', 'novelcontent', 'showtxt', 'readcontent', 'readContent', 'TextArea',
  'txtContent', 'articlecontent', 'nr1', 'maintext', 'readarea', 'readArea', 'txtnav'
];
const GENERIC_CONTENT_CLASSES = [
  'chapter-content', 'chaptercontent', 'read-content', 'readcontent', 'article-content',
  'novel_content', 'showtxt', 'postbody', 'entry-content', 'book-content', 'readarea',
  'main-text', 'text-content', 'chapter-text', 'contentbox'
];

/**
 * 候选容器杂质信号（2026-10-08 bookmaopu 实测根因）：名单序靠前的泛化 id
 * （如 content）常是「面包屑+导航+推荐书单+正文」的外层布局容器，首个命中
 * 即返回会把杂质全收进来；真正文容器（htmlContent）藏在它后面。全候选打分：
 * 容器文本头部命中杂质行即扣分，penalty 最小者胜，同分取 DOM 位置最靠后
 * （包裹容器的内层，即更特化的正文容器）。
 */
const GENERIC_IMPURITY_RES = [
  /^[^\n>»→]{1,24}\s*[>»→]/m,                      // 面包屑行：「XX阅读 > 玄幻奇幻 > …」
  /^[^\n]{0,6}目\s*录[^\n]{0,6}$/m,                // 「目 录」独立导航行
  /^[^\n]{0,4}(投票推荐|推荐阅读[：:]|投推荐票)/m,  // 站点功能块标题行
  /^[^\n]{0,2}(上一[页章]|下一[页章])[.。!！]?$/m,   // 翻页导航独立行
  /(记住|收藏|牢记).{0,10}(域名|网址|地址)|最新(域名|网址|地址)/m   // 域名水印行（v61）
];

/**
 * 无规则正文提取（候选打分版）：id/class 名单命中的**全部**候选容器参与评比，
 * 杂质 penalty 升序 → DOM 位置降序取最优；无名单命中再走「带属性的最长文本
 * div」密度兜底。返回原始 HTML 片段（交 normalizeContent 清洗），
 * 识别失败返回 null——上层据此报「正文容器未匹配」。
 */
function extractGenericContent(html) {
  // 预清洗：script/style/注释的正文会污染纯文本提取（script 文本无标签可剥）
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const candidates = [];
  for (const attr of ['id', 'class']) {
    for (const name of attr === 'id' ? GENERIC_CONTENT_IDS : GENERIC_CONTENT_CLASSES) {
      const re = new RegExp(`<(div|article|section)\\b[^>]*?${attr}\\s*=\\s*["']${name}["'][^>]*>`, 'gi');
      let m;
      while ((m = re.exec(cleaned)) !== null) {
        // 注意不能用 re.lastIndex 之外的首选位：m.index + m[0].length 定位开标签结束位（实测踩坑）
        const inner = extractElementInner(cleaned, m.index + m[0].length, m[1].toLowerCase());
        if (!inner) continue;
        const text = inner.replace(/<[^>]+>/g, '').trim();
        if (text.length < 100) continue;
        let penalty = 0;
        const head = text.slice(0, 600);
        for (const p of GENERIC_IMPURITY_RES) if (p.test(head)) penalty++;
        candidates.push({ inner, pos: m.index, penalty });
      }
    }
  }
  if (candidates.length) {
    candidates.sort((a, b) => a.penalty - b.penalty || b.pos - a.pos);
    return candidates[0].inner;
  }
  // 密度兜底：遍历带 id/class 的 div（上限 200 个防病态页面 O(n²)），取纯文本最长者
  const re = /<(div)\b[^>]*?(?:id|class)\s*=\s*["'][^"']+["'][^>]*>/gi;
  let m, best = '', scanned = 0;
  while ((m = re.exec(cleaned)) !== null && scanned < 200) {
    scanned++;
    const inner = extractElementInner(cleaned, re.lastIndex, 'div');
    if (!inner) continue;
    const len = inner.replace(/<[^>]+>/g, '').trim().length;
    if (len > best.length) best = inner;
  }
  if (best.replace(/<[^>]+>/g, '').trim().length >= 100) return best;
  return null;
}

// 手动模式章内分页跟随上限：一章被站点拆成多页时逐页拼接（实测 shudugu 一章 4 页），
// 上限防病态站点「下一页」自链死循环
const MAX_CONTENT_PAGES = 12;

// 「下一页」锚文本名单：简体全词/简写 + 繁体两形（覆盖港台书站模板）
const NEXT_PAGE_LABELS = new Set(['下一页', '下页', '下一頁', '下頁']);

/**
 * 章内分页探测：在正文页中找锚文本为「下一页」的链接并返回绝对 URL。
 *
 * <p>小站常把一章拆成多页（实测 shudugu：目录指向 /101/3331.html，
 * 页内「下一页」依次指向 3331-2/3/4.html）。约束：与当前页同 host 且同章——
 * 章 key 取路径尾部的 目录+主数字（/101/3331.html 与 /101/3331-2.html 同为 101/3331），
 * 防止跨章误跟随（「下一章」链接锚文本不同已天然排除，此约束再兜一层）。
 * 已知边界：JS 动态分页、?page=N 形态不识别（手动模式启发式覆盖静态分页主流形态）。</p>
 */
function findNextContentPage(html, currentUrl) {
  // 同章配对判定（2026-10-08 bookmaopu 实测重构）：独立 key 无法区分两种拓扑
  // 同构形态（/101/3331.html 既可读作「章文件」也可读作「目录 101 的页 3331」），
  // 改为以当前页形态主导的配对规则：
  //   目录式入口（…/99480611/ 尾斜杠）→ 候选必须位于该章节目录下（…/2.html）
  //   双文件页（…/章目录/页.html 三级形态）→ 同章节目录即同章
  //   文件式（…/3331.html ↔ …/3331-2.html 二级形态）→ 同目录+同主数字（老语义）
  const sameChapter = (curUrl, candUrl) => {
    try {
      const a = new URL(curUrl);
      const b = new URL(candUrl);
      if (a.host !== b.host) return false;
      const pa = a.pathname;
      const pb = b.pathname;
      if (pa === pb) return false;
      let m;
      // 目录式入口：候选必须是当前章节目录下的分页文件
      if ((m = pa.match(/^(.*\/\d+)\/$/))) {
        const prefix = m[1] + '/';
        return pb.startsWith(prefix) && /\d+\.html?$/i.test(pb);
      }
      // 三级形态双文件页：…/99480611/2.html ↔ …/99480611/3.html，同章节目录即同章
      const ma = pa.match(/^(.*\/\d+)\/(\d+)\.html?$/i);
      const mb = pb.match(/^(.*\/\d+)\/(\d+)\.html?$/i);
      if (ma && mb) return ma[1] === mb[1];
      // 文件式二级形态：…/3331.html ↔ …/3331-2.html（实测 shudugu）
      const fa = pa.match(/^(.*\/)(\d+)(?:-\d+)?\.html?$/i);
      const fb = pb.match(/^(.*\/)(\d+)(?:-\d+)?\.html?$/i);
      return !!(fa && fb && fa[1] === fb[1] && fa[2] === fb[2]);
    } catch (e) { return false; }
  };
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const label = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, '');
    if (!NEXT_PAGE_LABELS.has(label)) continue;
    let abs;
    try { abs = new URL(m[1].trim(), currentUrl).href; } catch (e) { continue; }
    if (abs !== currentUrl && sameChapter(currentUrl, abs)) return abs;
  }
  return null;
}

/**
 * 分页正文拼接（手动模式章内多页合并）。
 *
 * <p>站点分页常把同一自然段切在两页边界（上页末行无终止标点收尾），直接
 * join('\n\n') 会把一段切成两段。缝合规则（宁漏勿错）：仅当上页末行以
 * 汉字/逗号/顿号收尾时判定为「段被页边界切断」，与下页首段无缝相接；
 * 终止标点（。！？…」"等）收尾的正常段间仍空行分隔。</p>
 */
function joinContentPages(parts) {
  const CUT_TAIL = /[一-鿿，、]$/;
  return parts.filter(Boolean).reduce((acc, cur) => {
    if (!acc) return cur;
    return CUT_TAIL.test(acc) ? acc + cur.replace(/^\s+/, '') : acc + '\n\n' + cur;
  }, '');
}

// ---------------------------------------------------------------------------
// 手动模式正文广告行清洗（实测依据：小站章节正文首尾普遍夹带水印行，
// 如「请记住本站域名」「顶点小说最快更新」、纯域名行，随下载落入 TXT/EPUB 成品）
// ---------------------------------------------------------------------------

// 水印行模式名单（原始形态，命中语义见 cleanAdLines）
// 一、水印类（v61 起全文扫描——小站常在正文段落中间插播域名/求票水印，
//     仅扫首尾 5 行抓不到；「整行命中」包装已保证行内夹正文的不误伤）
const AD_LINE_RAW = [
  /^(请记住|收藏|牢记)?本?(书|站|文).*(域名|网址|地址)/,
  /(顶点|笔趣|追书|UU|顶点小说).*(小说|网|最快|更新|无弹窗)/,
  /(最快|最新|无弹窗|免费全?文)?(更新|阅读).*(最快|无弹窗|首发)/,
  /(最新|备用|永久)(域名|网址|地址)/,
  // 手机端引流行（实测：「手机用户请浏览m.xxx.com阅读」「手机阅读请访问xxx」）
  /^手机(用户)?(请)?(浏览|访问|阅读|搜索).*/,
  // 「一秒记住【xx】www.xxx.com，无弹窗，更新快」系
  /一秒记住.*/,
  // 求票/求支持 PS 行（「PS：求推荐票月票」「ps.求收藏订阅」）
  /^[pPＰ][sSＳ]\s*[.：:，,]\s*.{0,60}(推荐票|月票|收藏|订阅|鲜花|打赏|支持|谅解).*/,
  // 章节尾标记行（「本章完」「（未完待续）」——站点排版噪音非正文）
  /^[（(]?(本章完|未完待续|待续)[）)]?\s*[.。!！]?$/,
  // 面包屑导航行 A：短前缀 + > 分隔 + 第X章标题（实测 shudugu 系模板：
  // 「设置仙道尽头 > 第一章 成亲了？」——正文容器把页首导航包入，
  // 剥标签后混为正文首行）。`.*` 消化章题余文，配合外层「整行命中」包装
  /^[^\n>»→]{1,28}\s*[>»→]\s*第\s*[0-9零〇一二三四五六七八九十百千两]+\s*[章回卷节].*/,
  // 面包屑导航行 B：导航词开头 + > + 任意短标题——公告/名单类条目无章节号
  // （实测「设置仙道尽头 > 说几句？」「设置仙道尽头 > 二月份中奖名单」）。
  // 标题超 41 字消耗不完时外层整行判定不命中，自动放弃（宁漏勿错）
  /^(设置|首页|书页|目录|导航)[^\n>»→]{0,28}\s*[>»→]\s*\S{1,41}/,
  // 面包屑导航行 C：多级 > 链（≥2 个分隔符）——站点名/分类/书名/章名四级
  // （2026-10-08 实测 bookmaopu：「猫扑中文文学阅读 > 玄幻奇幻 > 书名 > 第1章 xx」，
  // 前缀非导航词、首个 > 后非章号，A/B 均不命中）。正文行几乎不含连级 >，
  // 叠加首尾 5 行窗口 + 10% 误杀保护
  /^[^\n>»→]{1,24}\s*[>»→](\s*[^\n>»→]{1,30}\s*[>»→])+[^\n>»→]{1,60}/,
  // 翻页导航行：纯导航词首尾相接（实测「上一章目录下一页」——三个 <a>
  // 剥标签后无缝拼接成一行）。行内另有正文内容的不命中（外层整行判定兜底）；
  // 「目 录」含站方空格排版（bookmaopu 实测），补 投票推荐/推荐阅读 功能块词
  /^((上一|下一)[章节页]|章节目录|返回目录|目\s*录|目录|加入书签|书签|手机阅读|投推荐票|投票推荐|推荐阅读[：:]?)+[.。!！]?/
];
// 全文扫描的水印类（名单前 8 条）；导航/翻页类仍限首尾窗口（正文短行有撞型风险）
const AD_WATERMARK_COUNT = 8;
// 纯域名行（全文范围剔除，不限首尾）
const PURE_DOMAIN_LINE = /^[\w\-]+(\.[\w\-]+)*\.(com|net|org|cc|xyz|top|me|io|cn|vip|fun|la|co)\/?$/i;
// 含 URL/裸域名的短行（v61，全文剔除）：「请访问 www.xxx.com」「新域名 xxxx.com 敬请收藏」
// 等引流短行；约束行长 ≤42 且无句读（正文句几乎必长必带标点）——双重门槛守宁漏勿错
function isShortUrlLine(t) {
  if (t.length > 42) return false;
  if (!/(https?:\/\/|www\.|[\w-]+\.(com|net|org|cc|xyz|top|me|io|cn|vip|fun|la)\b)/i.test(t)) return false;
  return !/[。！？!?,，]/.test(t);
}
// 「整行命中」判定：模式命中后行尾只允许非中文字符（域名/标点/空白）——
// 行内夹水印词但后接正文内容的不动（宁漏勿错原则的关键实现）
const AD_LINE_PATTERNS = AD_LINE_RAW.map((p) =>
  new RegExp('^(?:' + p.source + ')[^\\u4e00-\\u9fff]*$', p.flags));

/**
 * 正文广告行保守清洗（手动链接模式专用，extractContent 手动分支返回前调用）。
 *
 * <p>规则：纯域名行 / 含 URL 短行 / 水印整行（域名收藏、最快更新、手机引流、
 * 一秒记住、PS 求票、章节尾标记）全文范围剔除；面包屑/翻页导航类整行仍限
 * 正文首尾各 5 个非空行（正文短行有撞型风险，窗口外不碰）。只剔「整行命中」
 * 的行，行内含水印词但有其它正文内容的不动；剔除行数超过正文总行数 10% 时
 * 判定模式与站点风格冲突，放弃本次清洗返回原文（防误杀——宁可漏掉水印，
 * 不可误删正文）。</p>
 */
function cleanAdLines(text) {
  if (!text) return text;
  const lines = String(text).split('\n');
  const nonEmpty = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].trim()) nonEmpty.push(i);
  if (nonEmpty.length < 3) return text;
  const edge = new Set(nonEmpty.slice(0, 5).concat(nonEmpty.slice(-5)));
  const watermark = AD_LINE_PATTERNS.slice(0, AD_WATERMARK_COUNT);
  const navClass = AD_LINE_PATTERNS.slice(AD_WATERMARK_COUNT);
  const drop = new Set();
  for (const i of nonEmpty) {
    const t = lines[i].trim();
    if (PURE_DOMAIN_LINE.test(t)) { drop.add(i); continue; }
    if (isShortUrlLine(t)) { drop.add(i); continue; }
    if (watermark.some((p) => p.test(t))) { drop.add(i); continue; }   // 水印类：全文
    if (edge.has(i) && navClass.some((p) => p.test(t))) drop.add(i);    // 导航类：首尾窗口
  }
  if (!drop.size) return text;
  // 误杀保护：剔除比例超 10% 即放弃清洗
  if (drop.size > Math.ceil(nonEmpty.length * 0.1)) return text;
  return lines.filter((_, i) => !drop.has(i)).join('\n');
}

// ---------------------------------------------------------------------------
// 搜索与书籍发现：searchUrl + ruleSearch + ruleBookInfo
// ---------------------------------------------------------------------------

/**
 * 在单个书源内搜索书籍。
 *
 * <p>业务时间线：搜索词 encodeURIComponent 后替换 searchUrl 的 {{key}} 占位符 →
 * 抓取搜索结果页 → ruleSearch.bookList 迭代匹配 → 每项求值 bookUrl/bookName/author →
 * 相对地址按站点根解析。结果按书源分组返回，多书源结果不合并，便于界面展示来源。</p>
 *
 * <p>双规则形态：bookList 等规则可以是表达式字符串（HTML 场景，注入 m），
 * 也可以是 function（JSON API 场景，参数为整个解析后的 json 对象，返回对象数组）。
 * responseType:'json' 时页面文本先 JSON.parse 再进入规则上下文。</p>
 *
 * <p>结果去向：返回 [{bookUrl, name, author, sourceName}]；解析失败抛错给调用方。</p>
 */
async function searchBook(source, keyword, opt) {
  // Legado 书源分派：规则经解释器执行
  if (source.legado) {
    return legadoAdapter.searchViaLegado(source, keyword, opt, { fetchWithRetry });
  }
  // {{key}} 可能在 searchUrl 出现多次（如 q={{key}}&kw={{key}}），必须全局替换
  const url = source.searchUrl.replace(/\{\{key\}\}/g, encodeURIComponent(keyword));
  const full = new URL(url, source.bookSourceUrl).href;
  const pageOpt = { ...opt, responseType: source.responseType };
  const html = await fetchWithRetry(full, pageOpt);
  const rs = source.ruleSearch;
  let items;
  if (typeof rs.bookList === 'function') {
    // 函数规则入参：responseType=json 传解析后的 JSON 对象；
    // HTML 书源也可用函数规则（静态书库等无搜索场景），此时传原始 html，JSON 解析失败不报错
    let json = null;
    if (source.responseType === 'json') { try { json = JSON.parse(html); } catch (e) { json = null; } }
    items = rs.bookList(json !== null ? json : html);
  } else {
    items = evalRule(rs.bookList, { html, source });
  }
  const books = [];
  for (const m of items) {
    const ctx = { html, source, m };
    const item = typeof m === 'object' && m !== null ? m : {};
    // 封面（2026-10-08）：规则可选，缺省空串；相对地址补全为绝对，非法值丢弃不致命
    let cover = '';
    if (rs.coverUrl) {
      try {
        const raw = typeof rs.coverUrl === 'function' ? rs.coverUrl(item) : evalRule(rs.coverUrl, ctx);
        if (raw) cover = new URL(String(raw).trim(), source.bookSourceUrl).href;
      } catch (e) { /* 封面规则非法仅影响外观，不影响搜索结果 */ }
    }
    books.push({
      bookUrl: new URL(typeof rs.bookUrl === 'function' ? rs.bookUrl(item) : evalRule(rs.bookUrl, ctx),
        source.bookSourceUrl).href,
      name: typeof rs.bookName === 'function' ? rs.bookName(item) : evalRule(rs.bookName, ctx),
      author: rs.author ? (typeof rs.author === 'function' ? rs.author(item) : evalRule(rs.author, ctx)) : '',
      cover,
      sourceName: source.bookSourceName
    });
  }
  return books;
}

/**
 * 解析书籍详情页：目录页地址与章节总数（ruleBookInfo 均为可选规则）。
 * tocUrl 缺省时退回 bookUrl 本身（部分站点目录与详情同页）。
 * 函数型规则收到解析后的 JSON 对象；表达式型收到 html/m 上下文。
 */
async function getBookInfo(source, bookUrl, opt) {
  const pageOpt = { ...opt, responseType: source.responseType };
  const html = await fetchWithRetry(new URL(bookUrl, source.bookSourceUrl).href, pageOpt);
  // legado 源的 ruleBookInfo 是 DSL 规则，交适配层翻译；原生源仍走 evalRule
  if (source.legado) {
    return legadoAdapter.legadoGetBookInfo(html, source, bookUrl);
  }
  const rb = source.ruleBookInfo || {};
  let json = null;
  try { json = source.responseType === 'json' ? JSON.parse(html) : null; } catch (e) { json = null; }
  // tocUrl 规则求值为空串时必须回退 bookUrl 本身：空串经 new URL('', base) 会变成
  // 站点根路径（mock 站实测 404），误判为"详情页不可达"而整任务失败
  const tocEvaluated = rb.tocUrl
    ? (typeof rb.tocUrl === 'function' ? rb.tocUrl(json) : evalRule(rb.tocUrl, { html, source }))
    : '';
  const tocUrl = tocEvaluated
    ? new URL(tocEvaluated, source.bookSourceUrl).href
    : new URL(bookUrl, source.bookSourceUrl).href;
  const chapterTotal = rb.chapterTotal
    ? (typeof rb.chapterTotal === 'function' ? rb.chapterTotal(json) : evalRule(rb.chapterTotal, { html, source }))
    : null;
  // 简介/封面（2026-10-09）：原生 JSON 源若在 ruleBookInfo 声明 intro/coverUrl 同样透出
  const intro = rb.intro
    ? (typeof rb.intro === 'function' ? rb.intro(json) : evalRule(rb.intro, { html, source }))
    : '';
  const coverRaw = rb.coverUrl
    ? (typeof rb.coverUrl === 'function' ? rb.coverUrl(json) : evalRule(rb.coverUrl, { html, source }))
    : '';
  // 相对封面地址绝对化（站点返回 /files/... 相对路径时前端直连 404）
  let coverAbs = '';
  if (coverRaw) { try { coverAbs = new URL(coverRaw, source.bookSourceUrl).href; } catch (e) { /* 非法地址留空 */ } }
  return { tocUrl, chapterTotal, intro: intro || '', coverUrl: coverAbs };
}

// ---------------------------------------------------------------------------
// 并发池：N 个 worker 共享任务队列，限速器保证站点级串行间隔
// ---------------------------------------------------------------------------

/**
 * 固定大小并发池。并发决定"同时几个 worker 在跑"，限速决定
 * "任意相邻两个请求的最小间隔"，二者叠加形成最终请求节奏。
 */
async function runPool(items, concurrency, worker) {
  // 非法并发兜底（2026-09-29 架构审查 低）：undefined/NaN 时 Math.min 得 NaN，
  // Array.from({length:NaN}) 长度 0 → 零 lane 静默返回，全部章节不下也不计失败，
  // 最终导出「全部缺失」成品书。Web 层有 safeConcurrency，CLI/库调用靠这里兜底
  concurrency = Math.max(1, Number(concurrency) || 4);
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

// ---------------------------------------------------------------------------
// 导出层：TXT 合并 + 零依赖 EPUB
// ---------------------------------------------------------------------------

/**
 * TXT 合并：流式逐章读拼，不在内存中累积全书字符串——千章大书旧实现
 * 同步 readFileSync 全书一次性拼接会阻塞事件循环数百 ms（SSE 停顿）。
 * 文件头部写入缺失章节清单，用户拿到书即知缺了哪几章，而非翻页才发现。
 */
async function exportTxt(dir, results, bookName) {
  const p = path.join(dir, '全书合并.txt');
  const failed = results.filter((r) => !r.file);
  const ws = fs.createWriteStream(p, 'utf8');
  try {
    if (failed.length) {
      ws.write(`【缺失章节】共 ${failed.length} 章未能下载（重跑可断点补抓）：\n`);
      for (const f of failed) ws.write(`  第${f.n}章 ${f.title}\n`);
      ws.write('\n');
    }
    for (const r of results) {
      if (!r.file) continue;
      const text = await fs.promises.readFile(path.join(dir, r.file), 'utf8');
      if (!ws.write(text + '\n\n')) {
        // 背压：写缓冲满时等 drain，避免大书在写队列中堆积内存
        await new Promise((resolve) => ws.once('drain', resolve));
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      ws.end(() => resolve());
      ws.on('error', reject);
    });
  }
  return p;
}

// ---- 最小 ZIP 实现（store 无压缩），EPUB 本质是带特定结构的 ZIP ----

/** CRC32：ZIP 必需；查表法实现，表惰性初始化 */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

// ---- 最小 PNG 编码器（8-bit RGB，filter 0），供 EPUB 算法封面使用 ----

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** HSL → RGB（0-255 整数），封面渐变色计算用 */
function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/**
 * 生成 EPUB 封面 PNG：书名 hash → 确定性纵向渐变（与前端卡片墙同一思路，
 * 同一本书封面色相恒定）。零依赖纯 Buffer 组装，阅读器显示效果远好于无封面。
 */
function makeCoverPng(bookName) {
  const W = 480, H = 640;
  let hue = 0;
  for (const ch of String(bookName || '书')) hue = (hue * 31 + ch.codePointAt(0)) % 360;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const rowStart = y * (1 + W * 3);
    raw[rowStart] = 0;   // filter type 0
    const t = y / (H - 1);
    const [r, g, b] = hslToRgb((hue + t * 60) % 360, 0.42, 0.32 - t * 0.18);
    for (let x = 0; x < W; x++) {
      const o = rowStart + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- PWA 应用图标：纯色底 + 像素字「书」（复用上方最小 PNG 编码器） ----

// 「书」16×16 点阵（#=笔画）：横折 / 横折钩 / 中竖 / 右侧点，图标整格放大后仍可辨
const SHU_BITMAP = [
  '................',
  '.......#........',
  '.......#........',
  '..#########.....',
  '.......#..#.....',
  '.......#..#.....',
  '.......#..#.....',
  '.###########....',
  '.......#...#..#.',
  '.......#...#.##.',
  '.......#...#....',
  '.......#...#....',
  '.......#..##....',
  '.......#........',
  '.......#........',
  '................'
];

/**
 * 生成应用图标 PNG：宣纸主题金棕底（#9a6b23）+ 米白「书」字（#f6ead9）。
 * 点阵按图标边长整格放大；供 web-ui.js 的 /icon-192.png /icon-512.png 路由
 * 启动时生成一次缓存于内存（PWA「安装为应用」用）。
 */
function makeIconPng(size) {
  const W = Math.max(16, Math.floor(Number(size)) || 192);
  const cell = W / 16;
  const BG = [154, 107, 35], FG = [246, 234, 217];
  const raw = Buffer.alloc(W * (1 + W * 3));
  for (let y = 0; y < W; y++) {
    const rowStart = y * (1 + W * 3);
    raw[rowStart] = 0;   // filter type 0
    const by = Math.min(15, Math.floor(y / cell));
    for (let x = 0; x < W; x++) {
      const bx = Math.min(15, Math.floor(x / cell));
      const c = SHU_BITMAP[by].charAt(bx) === '#' ? FG : BG;
      const o = rowStart + 1 + x * 3;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** 组装单个 ZIP 条目的 local header + 文件名 + 数据 */
function zipEntry(name, data, utf8Flag = true) {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(utf8Flag ? 0x0800 : 0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0x21, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);
  return { header, nameBuf, data, crc, utf8Flag };
}

/** 组装完整 ZIP：local entries + central directory + EOCD */
function buildZip(entries) {
  const locals = []; let offset = 0;
  const centrals = [];
  for (const e of entries) {
    const local = Buffer.concat([e.header, e.nameBuf, e.data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.utf8Flag ? 0x0800 : 0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(e.nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push({ central, extra: e.nameBuf });
    locals.push(local);
    offset += local.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of centrals) cdSize += c.central.length + c.extra.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locals, ...centrals.map((c) => Buffer.concat([c.central, c.extra])), eocd]);
}

/** XML 文本转义：正文与标题进入 XHTML 前必须处理实体 */
function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * 生成 EPUB 2.0（零依赖）。mimetype 条目按规范不带 UTF-8 标志与额外字段，
 * 其余条目使用 UTF-8 文件名标志。
 * 附封面（2026-10-08：opts.coverFile 真实封面优先，缺失回退算法生成 cover.png）
 * 与 dc:creator 作者元数据；存在失败章时书末追加「缺失章节」页，与 TXT 头部清单同口径。
 * opts: { author } 作者名（来自搜索结果/书源详情，可空）
 *       { coverFile } 真实封面文件绝对路径（可选，jpg/png/gif/webp）
 */
async function exportEpub(dir, results, bookName, source, opts = {}) {
  // 封面二选一：真实封面读盘定 mime；回退算法 PNG
  let coverEntry = { name: 'cover.png', mime: 'image/png', buf: makeCoverPng(bookName) };
  if (opts.coverFile && fs.existsSync(opts.coverFile)) {
    try {
      const ext = (opts.coverFile.split('.').pop() || 'jpg').toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      const buf = fs.readFileSync(opts.coverFile);
      if (buf.length) coverEntry = { name: `cover.${ext}`, mime, buf };
    } catch (e) { /* 读盘失败回退算法封面 */ }
  }
  const chapters = results.filter((r) => r.file && r.text);
  const failed = results.filter((r) => !r.file);
  const chapterFiles = chapters.map((r, i) => {
    const paras = r.text.split('\n\n').map((p) => `    <p>${xmlEscape(p.trim())}</p>`).join('\n');
    return {
      id: `ch${String(i + 1).padStart(4, '0')}`,
      href: `OEBPS/${String(i + 1).padStart(4, '0')}.xhtml`,
      title: xmlEscape(r.title),
      html: `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${xmlEscape(r.title)}</title></head>
<body>
  <h2>${xmlEscape(r.title)}</h2>
${paras}
</body>
</html>`
    };
  });

  // 缺失章节页：失败章占位说明，避免用户以为书已完整
  let missingFile = null;
  if (failed.length) {
    const items = failed.map((f) => `    <li>第${f.n}章 ${xmlEscape(f.title)}</li>`).join('\n');
    missingFile = {
      id: 'missing', href: 'OEBPS/missing.xhtml',
      html: `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>缺失章节</title></head>
<body>
  <h2>缺失章节（共 ${failed.length} 章，重跑下载可断点补抓）</h2>
  <ul>
${items}
  </ul>
</body>
</html>`
    };
  }

  const allXhtml = missingFile ? [...chapterFiles, missingFile] : chapterFiles;
  const opfManifest = allXhtml.map((c) => `    <item id="${c.id}" href="${path.basename(c.href)}" media-type="application/xhtml+xml"/>`).join('\n');
  const opfSpine = allXhtml.map((c) => `    <itemref idref="${c.id}"/>`).join('\n');
  const ncxPoints = chapterFiles.map((c, i) => `    <navPoint id="nav${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${c.title}</text></navLabel>
      <content src="${path.basename(c.href)}"/>
    </navPoint>`).join('\n');
  const uuid = `urn:uuid:` + Buffer.from(source.bookSourceUrl + bookName).subarray(0, 16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');

  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${xmlEscape(bookName)}</dc:title>
    <dc:language>zh</dc:language>
    <dc:identifier id="bookid">${uuid}</dc:identifier>
    <dc:source>${xmlEscape(source.bookSourceUrl)}</dc:source>
${opts.author ? `    <dc:creator>${xmlEscape(opts.author)}</dc:creator>\n` : ''}    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover-img" href="${coverEntry.name}" media-type="${coverEntry.mime}"/>
${opfManifest}
  </manifest>
  <spine toc="ncx">
${opfSpine}
  </spine>
</package>`;
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${uuid}"/></head>
  <docTitle><text>${xmlEscape(bookName)}</text></docTitle>
  <navMap>
${ncxPoints}
  </navMap>
</ncx>`;

  const zip = buildZip([
    zipEntry('mimetype', Buffer.from('application/epub+zip', 'ascii'), false),
    zipEntry('META-INF/container.xml', Buffer.from(container, 'utf8')),
    zipEntry('OEBPS/content.opf', Buffer.from(opf, 'utf8')),
    zipEntry('OEBPS/toc.ncx', Buffer.from(ncx, 'utf8')),
    zipEntry(`OEBPS/${coverEntry.name}`, coverEntry.buf),
    ...allXhtml.map((c) => zipEntry(c.href, Buffer.from(c.html, 'utf8')))
  ]);
  const p = path.join(dir, `${safeFsName(bookName)}.epub`);
  // 异步落盘：大书 ZIP 数十 MB，writeFileSync 会阻塞事件循环（SSE 进度卡顿）
  await fs.promises.writeFile(p, zip);
  return p;
}

// ---------------------------------------------------------------------------
// 断点续传：manifest 记录章节号→{file,title,url}，并校验文件完整性
// ---------------------------------------------------------------------------

function manifestPath(dir) { return path.join(dir, 'manifest.json'); }

/**
 * 读断点清单。条目必须满足：文件存在、大小>0、清单记录的章节标题与本次目录解析
 * 结果一致——书源或目录变更后旧缓存不再命中，避免内容与章节号错位。
 */
function loadManifest(dir, chapters) {
  const titleByN = new Map((chapters || []).map((c) => [c.n, c.title]));
  if (!fs.existsSync(manifestPath(dir))) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'));
    for (const n of Object.keys(raw)) {
      const entry = raw[n];
      const file = typeof entry === 'string' ? entry : entry.file;
      const f = path.join(dir, file);
      const stale = chapters && titleByN.has(Number(n))
        && typeof entry === 'object' && entry.title !== titleByN.get(Number(n));
      if (!fs.existsSync(f) || fs.statSync(f).size === 0 || stale) delete raw[n];
    }
    return raw;
  } catch (e) {
    console.log('  manifest 损坏，按空断点处理:', e.message);
    return {};
  }
}

/** 写断点清单：v3 起记录 {file,title,url}，供预览与缓存一致性校验 */
function saveManifest(dir, manifest) {
  fs.writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 2));
}

/** 读缓存章节正文：读单章文件并剥离首行书名行，供 EPUB 组装与预览复用 */
function readCachedText(dir, entry) {
  const file = typeof entry === 'string' ? entry : entry.file;
  if (!file) return null;
  const f = path.join(dir, file);
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').split('\n\n').slice(1).join('\n\n');
}

// ---------------------------------------------------------------------------
// 核心编排：downloadBook —— CLI 与 Web UI 共用的唯一下载入口
// ---------------------------------------------------------------------------

/**
 * 下载整本书（目录 → 并发下载 → 合并导出）。
 *
 * <p>业务时间线：第一步抓目录并解析章节清单（目录地址可由 tocUrl 指定，
 * 支持从搜索结果的书籍详情页进入）；第二步按 manifest 跳过已完成章，
 * 并发池下载剩余章并逐章落盘；第三步按章节序组装导出 TXT（可选 EPUB）。</p>
 *
 * <p>hooks（均为可选）：onLog(msg) / onChapter(ch, state, info) / onProgress(stats)。</p>
 *
 * <p>结果去向：返回 {dir, chapters, results, okCount, failedCount, cachedCount,
 * txtPath, epubPath}；cachedCount 为断点命中章数，避免全缓存重跑显示"完成 0/N"。</p>
 */
async function downloadBook(source, bookName, opt, hooks = {}) {
  const log = hooks.onLog || (() => {});
  // 输出根目录：打包态由调用方传 exe 所在目录（opt.outRoot），开发态默认本目录
  const root = opt.outRoot || __dirname;
  // 书源名与书名均经安全化：外部书源可携带 ../ 等路径段，防目录穿越
  const dir = path.join(root, 'output', `${safeFsName(source.bookSourceName)}-${safeFsName(bookName)}`);
  fs.mkdirSync(dir, { recursive: true });
  // 真实封面落盘（2026-10-08）：调用方（Web 层）在下载开始前拉好的封面字节
  // 随任务带入，导出 EPUB 前必须已在磁盘（exportEpub 按 coverFile 探测嵌入）
  if (opt.coverData && Buffer.isBuffer(opt.coverData.buf) && opt.coverData.buf.length) {
    try {
      fs.writeFileSync(path.join(dir, `cover.${opt.coverData.ext || 'jpg'}`), opt.coverData.buf);
      log('封面已保存到书籍目录');
    } catch (e) { /* 封面写盘失败不影响下载 */ }
  }
  // 取消令牌：Web 层 /api/stop 置位后，worker 领新任务前退出，已完成的章正常入断点
  const cancelled = () => !!(opt.cancelToken && opt.cancelToken.cancelled);

  log(`抓取目录: ${opt.tocUrl || source.catalogUrl}`);
  // 手动链接模式：目录已在 /api/parse-link 解析并随任务下发，不再回抓目录页；
  // 章节号沿用解析时的顺序编号（文档序），保证断点续传与重跑编号稳定
  let chapters;
  if (Array.isArray(opt.manualChapters) && opt.manualChapters.length) {
    chapters = opt.manualChapters.map((c, i) => ({
      n: Number.isFinite(Number(c.n)) ? Number(c.n) : i + 1,
      title: String(c.title || `第${i + 1}章`),
      url: c.url
    }));
    log(`手动目录已载入：${chapters.length} 章`);
  } else {
    const catalogHtml = await fetchWithRetry(opt.tocUrl || source.catalogUrl, opt);
    chapters = parseCatalog(catalogHtml, source);
    log(`解析出 ${chapters.length} 章`);
  }
  if (chapters.length === 0) {
    throw new Error('目录解析为空：ruleToc.chapterList 与页面结构不匹配');
  }

  const manifest = loadManifest(dir, chapters);
  const todo = chapters.filter((ch) => !manifest[ch.n]);
  const cachedCount = chapters.length - todo.length;
  // 目录解析完成即推送章节清单（含缓存标记）：UI 立即可见章节列表，
  // 而非等全部章节下载结束才显示——长篇下载全程空白的根因
  if (hooks.onChapters) {
    hooks.onChapters(chapters.map((ch) => ({ n: ch.n, title: ch.title, cached: !!manifest[ch.n] })), cachedCount);
  }
  log(`下载 ${todo.length}/${chapters.length} 章（缓存命中 ${cachedCount}，并发 ${opt.concurrency}，限速 ${opt.minIntervalMs}ms）`);

  // 正文驻内存仅限 EPUB 场景：TXT 导出本身是读盘流式（exportTxt），
  // 不勾选 EPUB 时保留全书正文纯属浪费——千章书数十 MB 常驻堆内存
  const keepText = !!opt.epub;
  const texts = new Map();
  let okCount = 0, failedCount = 0;
  // 本轮实际下载成功的章节号：results 标 fresh 供调用方区分「本轮新下」与
  // 「缓存命中」——不能用 text 是否驻留判定（非 EPUB 场景 keepText=false 正文恒空，
  // 曾致完成后全部章节误标 cached，2026-09-29 架构审查 中）
  const freshNs = new Set();
  const stats = () => ({
    total: chapters.length, done: okCount, failed: failedCount,
    pending: chapters.length - okCount - failedCount, cached: cachedCount
  });

  // 反爬熔断（默认关闭，opt.banCircuitThreshold 开启）：连续 N 次反爬型失败
  // （跨域重定向封禁）自动停止领新章。封禁窗口内继续派发只会白烧章节并加深
  // 封禁（shudugu 实测封禁后 15 章连号失败），断点逐章落盘，暂停后重跑即续传
  const banThreshold = opt.banCircuitThreshold || 0;
  let banStop = false;
  let consecutiveBan = 0;

  await runPool(todo, opt.concurrency, async (ch) => {
    if (cancelled() || banStop) return;
    try {
      const html = await fetchWithRetry(ch.url, opt);
      let text = extractContent(html, source);
      if (!text) throw new Error('正文容器未匹配（ruleContent.content 失效）');
      // 手动模式章内分页跟随：一章拆多页的小站（实测 shudugu 一章 4 页，页尾
      // 「下一页」指 3331-2/3/4.html）逐页抓取拼接。每页独立走 extractContent 单页
      // 清洗链——面包屑/翻页行是页级边缘噪声，先合并再洗会漏掉中部页的边缘行
      if (source.manual) {
        const parts = [text];
        let nextUrl = findNextContentPage(html, ch.url);
        for (let pg = 1; nextUrl && pg < MAX_CONTENT_PAGES && !cancelled(); pg++) {
          const pageHtml = await fetchWithRetry(nextUrl, opt);
          const pageText = extractContent(pageHtml, source);
          // 中间页提取失败：nextUrl 不推进，循环退出后统一按「不完整」处理
          if (!pageText) break;
          parts.push(pageText);
          nextUrl = findNextContentPage(pageHtml, nextUrl);
        }
        // 未自然到达末页（取消中断/超页数上限/中间页失败）：正文不完整时抛错
        // 跳过写盘——否则部分页残章会标完成入 manifest，断点续传只认 manifest，
        // 残章永不被补抓（2026-09-29 修复：隐性残章缺陷）
        if (nextUrl) {
          throw new Error(cancelled() ? '任务已取消' : '章内分页抓取不完整（超页数上限或中间页提取失败），重跑即可补抓');
        }
        text = joinContentPages(parts);
      }
      const file = `chapter_${String(ch.n).padStart(3, '0')}.txt`;   // 命名与既有 manifest 兼容，不可轻改
      fs.writeFileSync(path.join(dir, file), `《${bookName}》 ${ch.title}\n\n${text}\n`, 'utf8');
      manifest[ch.n] = { file, title: ch.title, url: ch.url };
      if (keepText) texts.set(ch.n, text);
      okCount++;
      freshNs.add(ch.n);
      consecutiveBan = 0;
      if (hooks.onChapter) hooks.onChapter(ch, 'downloaded');
      if (hooks.onProgress) hooks.onProgress(stats());
    } catch (e) {
      failedCount++;
      if (banThreshold > 0 && e.crossDomainRedirect) {
        consecutiveBan++;
        if (consecutiveBan >= banThreshold && !banStop) {
          banStop = true;
          log(`连续 ${consecutiveBan} 章疑似触发站点反爬封禁，自动暂停（断点已保存）`);
        }
      } else if (!e.crossDomainRedirect) {
        // 非封禁类失败（超时/5xx/正文缺失）打断连击计数，避免误判熔断
        consecutiveBan = 0;
      }
      if (hooks.onChapter) hooks.onChapter(ch, 'failed', e.message);
      if (hooks.onProgress) hooks.onProgress(stats());
    }
  });
  saveManifest(dir, manifest);

  // 取消/熔断：不导出半成品文件，断点已保存，重跑即可续传（避免用户误把残缺合并本当全书）
  if (cancelled() || banStop) {
    log(banStop
      ? '任务已自动暂停（反爬熔断）：断点已保存，待站点解封后重新开始即可续传'
      : '任务已取消：断点已保存，重新开始即可续传');
    return { dir, chapters, results: [], okCount, failedCount, cachedCount,
      txtPath: null, epubPath: null, cancelled: true, banned: banStop };
  }

  // 缓存命中章读回正文（仅供 EPUB 组装使用；非 EPUB 场景 results 不携带正文）
  if (keepText) {
    for (const ch of chapters) {
      if (!texts.has(ch.n) && manifest[ch.n]) {
        texts.set(ch.n, readCachedText(dir, manifest[ch.n]));
      }
    }
  }

  const results = chapters.map((ch) => ({
    ...ch,
    file: manifest[ch.n] ? manifest[ch.n].file : null,
    fresh: freshNs.has(ch.n),
    text: keepText ? (texts.get(ch.n) || null) : null
  }));

  log('合并导出');
  const txtPath = await exportTxt(dir, results, bookName);
  let epubPath = null;
  if (opt.epub) {
    // EPUB 真实封面：目录内已有 cover.*（本轮落盘或历史缓存）则嵌入，否则算法封面
    let coverFile = null;
    try { coverFile = fs.readdirSync(dir).find((f) => /^cover\.[a-z0-9]+$/i.test(f)) || null; } catch (e) { /* 目录不可读 */ }
    epubPath = await exportEpub(dir, results, bookName, source,
      { author: opt.author, coverFile: coverFile ? path.join(dir, coverFile) : null });
  }

  return { dir, chapters, results, okCount, failedCount, cachedCount, txtPath, epubPath };
}

// ---------------------------------------------------------------------------
// CLI 入口（参数解析 + 进度打印），下载逻辑全部委托 downloadBook
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const sourceFile = path.resolve(__dirname, args.includes('--source')
    ? args[args.indexOf('--source') + 1] : 'book-source.json');
  const wantEpub = args.includes('--epub');
  // 书名 = 不以 -- 开头、且不是 --source 参数值的位置参数
  const skipIdx = new Set();
  if (args.includes('--source')) skipIdx.add(args.indexOf('--source') + 1);
  const bookName = args.find((a, i) => !a.startsWith('--') && !skipIdx.has(i)) || '未命名';

  const source = loadBookSource(sourceFile);
  // CLI 直下模式：目录地址优先取书源显式配置（v2 书源可以没有 catalogUrl）
  if (!source.catalogUrl) {
    console.error('该书源未配置 catalogUrl，CLI 直下不可用；请用 Web 界面搜索下载。');
    process.exit(1);
  }
  const opt = { ...source.option, epub: wantEpub };

  const r = await downloadBook(source, bookName, opt, {
    onLog: (m) => console.log(m),
    onChapter: (ch, state, info) => {
      const mark = state === 'failed' ? '✗' : '✓';
      console.log(`  ${mark} 第${ch.n}章 ${ch.title}${info ? ' — ' + info : ''}`);
    }
  });

  console.log('──────────────────────────────');
  console.log(`完成 ${r.okCount}/${r.chapters.length} 章，失败 ${r.failedCount} 章`);
  console.log(`输出目录: ${r.dir}`);
  if (r.failedCount > 0) {
    console.log('存在失败章节：重跑本命令即只补抓失败章（断点续传）。');
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('致命错误:', e.message);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// 公共导出：供 Web UI（web-ui.js）等外部入口复用
// ---------------------------------------------------------------------------
/**
 * <p>换源章节标题匹配（2026-10-08 阅读器换源功能）：跨源目录的章节标题写法常有
 * 差异（空格/全半角数字/书名号/「第X章」与「第X节」），先归一化再匹配。</p>
 * <p>策略：归一化（小写、去空白、去书名号引号、全角转半角）后精确相等优先，
 * 其次互相包含；都未命中返回 null（调用方报「目标源未找到对应章节」）。</p>
 */
function normalizeChapterTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[《》「」『』""'']/g, '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    // 括号内多为副词缀差异（「（修订）」「（上）」），转换半角后连同括号一起删除
    .replace(/[（）()【】\[\]〔〕]/g, '');
}
function matchChapterByTitle(chapters, title) {
  const key = normalizeChapterTitle(title);
  if (!key) return null;
  let partial = null;
  for (const ch of chapters) {
    const k = normalizeChapterTitle(ch.title);
    if (!k) continue;
    if (k === key) return ch;
    if (!partial && (k.includes(key) || key.includes(k))) partial = ch;
  }
  return partial;
}

module.exports = {
  loadBookSource, loadBookSources, downloadBook, exportTxt, exportEpub,
  parseCatalog, extractContent, evalRule, searchBook, getBookInfo,
  httpRequest, fetchPage, fetchWithRetry, safeFsName, readCachedText,
  parseGenericToc, findNextTocPage, extractGenericContent, findNextContentPage, joinContentPages,
  filterTocNoise, cleanAdLines, makeIconPng,
  matchChapterByTitle, normalizeChapterTitle,
  zipEntry, buildZip,
  legadoAdapter,
  // 限速可视化与测试钩子（2026-10 迭代）：throttle 导出供单测直接驱动滑动窗口；
  // bumpHostPenalty 导出供单测构造 slow 快照场景
  throttle, getHostRate, bumpHostPenalty, __setThrottleWindowMs
};
