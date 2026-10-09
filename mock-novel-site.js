/**
 * 本地模拟小说站 —— 下载器联调专用测试夹具。
 *
 * <p>业务目的：在不接触任何真实站点的前提下，复刻中文小说站的四类典型技术干扰，
 * 用于验证下载器引擎的健壮性：</p>
 * <ul>
 *   <li>GBK 编码：目录与正文均以 GBK 字节返回，HTTP 头不声明 charset，逼下载器走 meta 探测</li>
 *   <li>gzip 传输：部分响应按 Accept-Encoding 返回 gzip 压缩流</li>
 *   <li>瞬时 500：第 7 章前两次请求返回服务端错误，验证重试与指数退避</li>
 *   <li>限流 503：请求间隔低于 80ms 时拒绝服务并返回 Retry-After，验证全局限速</li>
 * </ul>
 *
 * <p>数据来源：章节文本全部为本地自创占位内容，无版权材料。
 * 结果去向：仅监听 127.0.0.1:8734，供 novel-downloader.js 抓取；进程结束即消失。</p>
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = 8734;
// 书库：3 本书，各 12/6/9 章——验证"搜索 → 多本书 → 任意下载"。
// searchKeys：GB2312 基本区只收简体字形，繁体书名无法被简体关键词命中；
// 每本书提供简体别名数组（书名/作者各一），与繁体名一起参与子串匹配
const BOOKS = [
  { id: 1, name: '雲海之書', author: '測試作者甲', chapters: 12, searchKeys: ['云海之书', '测试作者甲'] },
  { id: 2, name: '風月記', author: '測試作者乙', chapters: 6, searchKeys: ['风月记', '测试作者乙'] },
  { id: 3, name: '書海拾遺', author: '測試作者甲', chapters: 9, searchKeys: ['书海拾遗', '测试作者甲'] }
];
const TOTAL_CHAPTERS = 12;

// 每章的累计请求次数：错误注入的计数依据，键为 `${bookId}-${n}`
const chapterHits = new Map();
// 上次响应的绝对时间戳：全局限流的判定基准（毫秒）
let lastServedAt = 0;

/** GBK 编码：优先读构建期预生成的 gbk-table.json（打包进 exe，零外部依赖）；
 *  表文件缺失时（仅裸源码运行且未构建）回退到运行时 iconv 动态建表。 */
const { execFileSync } = require('child_process');
let gbkTable = null;
function gbkBuffer(str) {
  if (!gbkTable) {
    const tableFile = path.join(__dirname, 'gbk-table.json');
    if (fs.existsSync(tableFile)) {
      const raw = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
      gbkTable = new Map(Object.entries(raw).map(([k, v]) => [k, Buffer.from(v)]));
    } else {
      // 回退分支（仅裸源码运行且未构建 gbk-table.json 时触达）：
      // 优先用 Node 原生 ICU 反向建表（遍历 GBK 双字节空间解码取有效映射），
      // Windows 无 iconv 命令，旧实现直接调 iconv 在该场景必挂
      try {
        const dec = new TextDecoder('gbk');
        gbkTable = new Map();
        for (let i = 0x20; i < 0x7f; i++) gbkTable.set(String.fromCharCode(i), Buffer.from([i]));
        for (let b0 = 0x81; b0 <= 0xfe; b0++) {
          for (let b1 = 0x40; b1 <= 0xfe; b1++) {
            if (b1 === 0x7f) continue;
            const s = dec.decode(Buffer.from([b0, b1]));
            if (s.length === 1 && s !== '�') gbkTable.set(s, Buffer.from([b0, b1]));
          }
        }
      } catch (e) {
        // ICU 被裁剪（pkg）且表文件缺失：再尝试系统 iconv，仍失败给明确指引
        try {
          const chars = [];
          for (let i = 0x20; i < 0x7f; i++) chars.push(String.fromCharCode(i));
          for (let c = 0x4e00; c <= 0x9fa5; c++) chars.push(String.fromCharCode(c));
          chars.push('，。！？：；\u201c\u201d\u2018\u2019（）——…《》、');
          const joined = chars.join('');
          const bytes = execFileSync('iconv', ['-f', 'UTF-8', '-t', 'GBK'],
            { input: joined, maxBuffer: 16 * 1024 * 1024 });
          gbkTable = new Map();
          let bi = 0;
          for (const ch of joined) {
            const cp = ch.codePointAt(0);
            if (cp < 0x80) { gbkTable.set(ch, Buffer.from([cp])); bi += 1; }
            else { gbkTable.set(ch, bytes.subarray(bi, bi + 2)); bi += 2; }
          }
        } catch (e2) {
          throw new Error('GBK 编码表缺失且本机无 iconv/ICU：请先运行 node gen-gbk-table.js 生成 gbk-table.json');
        }
      }
    }
  }
  const out = [];
  for (const ch of str) {
    const b = gbkTable.get(ch);
    if (b) { out.push(b); }
    else { out.push(Buffer.from('?', 'binary')); } // 表外字符统一替问号，不产生半字垃圾
  }
  return Buffer.concat(out);
}

/** 生成第 n 章的标题：固定词组合，避免运行时随机导致断点文件名漂移 */
function chapterTitle(n) {
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
  const WORDS = ['雲海之起', '風月之源', '書記之試', '測試之章'];
  return `第${CN[n - 1]}章 ${WORDS[n % WORDS.length]}`;
}

/** 生成第 n 章正文：固定段落 + 两类干扰行（广告行、导航行），验证正文清洗规则。
 *  正文嵌入书名以区分来源书（"少年"角色名随书变化），验证"下载任意书"链路真实生效 */
function chapterBody(n, book) {
  const lines = [];
  const hero = { 1: '少年', 2: '少女', 3: '老者' }[book.id];
  // MOCK_LONG_CHAPTERS=1：生成 400 段长章，供滚动类 UI 缺陷复现（如翻章回顶），
  // 默认 8 段不受影响（既有测试与常规冒烟均用默认值）
  const paraCount = process.env.MOCK_LONG_CHAPTERS ? 400 : 8;
  for (let i = 1; i <= paraCount; i++) {
    lines.push(`  《${book.name}》第${n}章第${i}段。${hero}抬起头，远处雲海翻涌，風从月下吹来。`);
  }
  lines.push('    本站最新网址为 example-novel-mock.test 请牢记');
  lines.push('  （本章完）返回书页继续阅读下一章');
  return lines.join('\n');
}

/** 搜索结果页：关键词与 [书名, 作者, searchKeys...] 逐一子串匹配（繁/简均可命中）；
 *  无结果时输出空列表。bookitem 结构与书源 ruleSearch.bookList 正则一一对应 */
function searchHtml(keyword) {
  const k = keyword.trim();
  const items = BOOKS
    .filter((b) => [b.name, b.author, ...(b.searchKeys || [])].some((t) => t.includes(k)))
    .map((b) => `<div class="bookitem"><a href="/book/${b.id}/info">${b.name}</a><span>${b.author}</span></div>`)
    .join('');
  return `<html><head><meta charset="gbk"><title>搜索 ${keyword}</title></head>
<body><div id="result">${items}</div></body></html>`;
}

/** 书籍详情页：书名、作者、总章数、"开始阅读"链接指向目录 */
function bookInfoHtml(book) {
  return `<html><head><meta charset="gbk"><title>${book.name}</title></head>
<body>
<h1>${book.name}</h1>
<p>作者：${book.author}</p>
<p>共 ${book.chapters} 章</p>
<a id="readnow" href="/book/${book.id}/">开始阅读</a>
</body></html>`;
}

/** 目录页：listmain 列表区含该书全部章节链接；前面混入 3 条干扰链接 */
function catalogHtml(book) {
  let dd = '';
  dd += '<dd><a href="/index.html">返回首页</a></dd>';
  dd += `<dd><a href="/book/${BOOKS.find((b) => b.id !== book.id).id}/">另一本书</a></dd>`;
  dd += '<dd><a href="javascript:bookmark()">加入书签</a></dd>';
  for (let i = 1; i <= book.chapters; i++) {
    dd += `<dd><a href="/book/${book.id}/chapter_${i}.html">${chapterTitle(i)}</a></dd>`;
  }
  return `<html><head><meta charset="gbk"><title> ${book.name} </title></head>
<body><div id="listmain"><dl>${dd}</dl></div></body></html>`;
}

/** 章节页 HTML：正文放在 #content 内；外部穿插广告 div 与导航链接 */
function chapterHtml(n, book) {
  return `<html><head><meta charset="gbk"><title>${chapterTitle(n)}</title></head>
<body>
<div class="top-ad">广告位招租</div>
<h1>${chapterTitle(n)}</h1>
<div id="content">${chapterBody(n, book).replace(/\n/g, '<br/>')}</div>
<div class="bottom-ad">点击注册领取福利</div>
<a href="/book/${book.id}/">上一页</a><a href="/book/${book.id}/">目录</a>
</body></html>`;
}

/** 手工展开 URL 中的 %XX 十六进制字节为原始字节序列。
 *  为什么不用 decodeURIComponent：它按 UTF-8 语义解码 %XX，GBK 字节序列（如 %B7%E7）
 *  不是合法 UTF-8 会直接抛 URIError——这是搜索链路的编码陷阱 */
function parsePercentBytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(s.substring(i + 1, i + 3))) {
      out.push(parseInt(s.substring(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(s.charCodeAt(i) & 0xFF);
    }
  }
  return Buffer.from(out);
}

/** 中文数字串（一/二/…/十二）转阿拉伯数字：模拟 API 章节页名反查章号用 */
function cnToNumber(cn) {
  const DIG = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  if (cn === '十') return 10;
  if (cn.startsWith('十')) return 10 + (DIG[cn[1]] || 0);
  if (cn.endsWith('十')) return (DIG[cn[0]] || 0) * 10;
  if (cn.includes('十')) {
    const [a, b] = cn.split('十');
    return (DIG[a] || 0) * 10 + (DIG[b] || 0);
  }
  return DIG[cn] || 0;
}

const server = http.createServer((req, res) => {
  const now = Date.now();
  // ---- 全局限流：距上次响应不足 80ms 的请求按过载处理，与真实站点的反爬策略同构 ----
  if (now - lastServedAt < 80) {
    res.writeHead(503, { 'Retry-After': '1' });
    res.end('too fast');
    return;
  }
  lastServedAt = now;

  // ---- 模拟 MediaWiki JSON API（离线联调维基文库书源规则）：本站为 UTF-8 JSON ----
  if (req.url.startsWith('/w/api.php')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const action = u.searchParams.get('action');
    const title = u.searchParams.get('page') || u.searchParams.get('srsearch') || '';
    let payload = null;
    if (action === 'query' && u.searchParams.get('list') === 'search') {
      // 按关键词过滤书库（简体关键词命中 searchKeys/书名）
      const items = BOOKS.filter((b) =>
        [b.name, b.author, ...(b.searchKeys || [])].some((t) => t.includes(title)))
        .map((b) => ({ title: b.name, snippet: `${b.author} · 共 ${b.chapters} 章` }));
      payload = { query: { search: items } };
    } else if (action === 'parse' && u.searchParams.get('prop') === 'sections') {
      const book = BOOKS.find((b) => b.name === title);
      if (!book) { res.writeHead(404); res.end('{}'); return; }
      const sections = [];
      for (let i = 1; i <= book.chapters; i++) {
        sections.push({ index: String(i), level: '1', line: book.name + ' ' + chapterTitle(i) });
      }
      payload = { parse: { title: book.name, sections } };
    } else if (action === 'parse' && u.searchParams.get('prop') === 'wikitext') {
      // 页名反查书与章号：页名可能是 '書名 第一章 …'（带前缀）或 '第一章 …'（sections.line 原样）
      const nMatch = title.match(/第([一二三四五六七八九十]+)章/);
      const book = BOOKS.find((b) => title.startsWith(b.name)) || null;
      const n = nMatch ? cnToNumber(nMatch[1]) : 0;
      if (!book || !n || n > book.chapters) { res.writeHead(404); res.end('{}'); return; }
      const hero = { 1: '少年', 2: '少女', 3: '老者' }[book.id];
      const paragraphs = [];
      for (let i = 1; i <= 4; i++) {
        paragraphs.push(`《${book.name}》第${n}章第${i}段。${hero}抬起头，远处雲海翻涌，風从月下吹来。`);
      }
      payload = { parse: { title, wikitext: { '*': paragraphs.join('\n\n') } } };
    }
    if (payload === null) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return;
  }

  // ---- 搜索页：/search?q=关键词，GBK 编码 ----
  const sm = req.url.match(/^\/search\?q=([^&]+)$/);
  if (sm) {
    // 不能用 decodeURIComponent：它按 UTF-8 解码 %XX，GBK 字节序列会抛 URIError。
    // 手工展开十六进制字节后按 GBK 解码；UTF-8 编码的请求也能容错处理
    const raw = parsePercentBytes(sm[1]);
    let keyword;
    try {
      keyword = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch (e) {
      keyword = new TextDecoder('gbk').decode(raw);
    }
    const body = gbkBuffer(searchHtml(keyword));
    const enc = (req.headers['accept-encoding'] || '').includes('gzip');
    const out = enc ? zlib.gzipSync(body) : body;
    res.writeHead(200, {
      'Content-Type': 'text/html',
      ...(enc && { 'Content-Encoding': 'gzip' })
    });
    res.end(out);
    return;
  }

  // ---- 书籍详情页：/book/:id/info（书名/作者/总章数/开始阅读链接）----
  const bm = req.url.match(/^\/book\/(\d+)\/info$/);
  if (bm) {
    const book = BOOKS.find((b) => b.id === Number(bm[1]));
    if (!book) { res.writeHead(404); res.end('not found'); return; }
    const body = gbkBuffer(bookInfoHtml(book));
    const enc = (req.headers['accept-encoding'] || '').includes('gzip');
    const out = enc ? zlib.gzipSync(body) : body;
    res.writeHead(200, {
      'Content-Type': 'text/html',
      ...(enc && { 'Content-Encoding': 'gzip' })
    });
    res.end(out);
    return;
  }

  // ---- 目录页：/book/:id/ 与 /book/:id/index.html|.htm；GBK 字节 + gzip，头不声明 charset ----
  const cm = req.url.match(/^\/book\/(\d+)\/(index\.html?)?$/);
  if (cm) {
    const book = BOOKS.find((b) => b.id === Number(cm[1]));
    if (!book) { res.writeHead(404); res.end('not found'); return; }
    const body = gbkBuffer(catalogHtml(book));
    const enc = (req.headers['accept-encoding'] || '').includes('gzip');
    const out = enc ? zlib.gzipSync(body) : body;
    res.writeHead(200, {
      'Content-Type': 'text/html',
      ...(enc && { 'Content-Encoding': 'gzip' })
    });
    res.end(out);
    return;
  }

  const m = req.url.match(/^\/book\/(\d+)\/chapter_(\d+)\.html$/);
  if (m) {
    const book = BOOKS.find((b) => b.id === Number(m[1]));
    const n = Number(m[2]);
    if (!book) { res.writeHead(404); res.end('not found'); return; }
    const hitKey = `${book.id}-${n}`;
    const hits = (chapterHits.get(hitKey) || 0) + 1;
    chapterHits.set(hitKey, hits);

    // ---- 错误注入：1 号书第 7 章前两次请求返回 500，第三次才成功 ----
    if (book.id === 1 && n === 7 && hits <= 2) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('internal error (injected)');
      return;
    }
    if (n > book.chapters) {
      res.writeHead(404); res.end('not found'); return;
    }
    const body = gbkBuffer(chapterHtml(n, book));
    // ---- 传输编码注入：偶数章走 gzip，覆盖解压分支 ----
    const enc = n % 2 === 0 && (req.headers['accept-encoding'] || '').includes('gzip');
    const out = enc ? zlib.gzipSync(body) : body;
    res.writeHead(200, {
      'Content-Type': 'text/html',
      ...(enc && { 'Content-Encoding': 'gzip' })
    });
    res.end(out);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

/** 以模块方式启动模拟站（web-ui.js 与打包 exe 同进程复用）；已在运行时直接返回。
 *  端口被外部程序占用时向后换端口（最多 20 次），不再让 EADDRINUSE 杀死宿主。 */
function start(port = PORT) {
  return new Promise((resolve, reject) => {
    // 先探活：端口已被占用（可能已在本进程或外部运行）视为成功
    const probe = http.get(`http://127.0.0.1:${port}/book/1/`, (res) => {
      res.resume();
      resolve({ alreadyRunning: true, port });
    });
    probe.on('error', () => {
      let current = port;
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && current < port + 20) {
          current += 1;
          server.listen(current, '127.0.0.1');
        } else {
          reject(e);
        }
      });
      server.listen(current, '127.0.0.1', () => {
        console.log(`[mock] 模拟小说站已启动: http://127.0.0.1:${current}/book/1/ （共 ${TOTAL_CHAPTERS} 章，GBK+gzip+500/503 干扰已注入）`);
        resolve({ alreadyRunning: false, port: current });
      });
    });
  });
}

function stop() {
  return new Promise((resolve) => server.close(() => resolve()));
}

module.exports = { start, stop };

// 直接以 node mock-novel-site.js 运行时保持旧行为：启动并驻留
if (require.main === module) {
  start();
}
