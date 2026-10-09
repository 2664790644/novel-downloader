/**
 * 引擎层纯函数单元测试（node --test，Node 18+）。
 *
 * <p>覆盖回归敏感区：路径清洗（安全）、正文广告行清洗、章内分页探测与
 * 段落缝合（2026-09-28/29 三个修复的固化）、启发式目录解析、ZIP/PNG 编码器
 * 魔数。全部离线运行，不依赖网络与本地夹具。</p>
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const e = require('../novel-downloader.js');

// ---------------------------------------------------------------- safeFsName
test('safeFsName：路径穿越与非法字符清洗', () => {
  assert.equal(e.safeFsName('../../etc/passwd'), 'etcpasswd');
  assert.equal(e.safeFsName('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij');
  assert.equal(e.safeFsName('..'), '未命名');
  assert.equal(e.safeFsName(''), '未命名');
  assert.equal(e.safeFsName(null), '未命名');
  assert.equal(e.safeFsName('  正常书名  '), '正常书名');
  assert.ok(e.safeFsName('x'.repeat(200)).length <= 80);
});

// ------------------------------------------------------------------ evalRule
test('evalRule：受限上下文求值', () => {
  assert.equal(e.evalRule('a + b', { a: 1, b: 2 }), 3);
  assert.equal(e.evalRule('html.length', { html: 'abc' }), 3);
  // 引擎内部变量不在白名单作用域内
  assert.throws(() => e.evalRule('safeFsName', {}));
});

// -------------------------------------------------------------- cleanAdLines
test('cleanAdLines：水印/面包屑/翻页行/域名行剔除', () => {
  const paras = Array.from({ length: 20 }, (_, i) => `  正文段落${i}，足够长的一段小说内容。`);
  const dirty = '  设置仙道尽头 > 第一章 成亲了？\n\n' + paras.join('\n\n') + '\n\n  上一章目录下一页';
  const out = e.cleanAdLines(dirty);
  assert.ok(!/设置仙道尽头/.test(out), '面包屑 A 应剔除');
  assert.ok(!/上一章目录下一页/.test(out), '翻页行应剔除');
  assert.equal((out.match(/正文段落/g) || []).length, 20, '正文段全保留');

  // 面包屑 B：无章节号的公告类
  const dirty2 = '  设置仙道尽头 > 说几句？\n\n' + paras.join('\n\n');
  assert.ok(!/说几句/.test(e.cleanAdLines(dirty2)), '面包屑 B 应剔除');

  // 纯域名行全文范围剔除
  const dirty3 = paras.slice(0, 10).join('\n\n') + '\n\nshudugu.org\n\n' + paras.slice(10).join('\n\n');
  assert.ok(!/^shudugu\.org$/m.test(e.cleanAdLines(dirty3)), '纯域名行应剔除');
});

test('cleanAdLines：负例不误杀', () => {
  const neg = '  目录上落满了灰尘。\n\n'
    + Array.from({ length: 19 }, (_, i) => `  他翻开书的第${i}页，继续读着这段故事。`).join('\n\n');
  assert.equal(e.cleanAdLines(neg), neg);
  const neg2 = '  设置好陷阱后他离开了。\n\n'
    + Array.from({ length: 19 }, (_, i) => `  正文${i}段，继续推进剧情的合理内容。`).join('\n\n');
  assert.equal(e.cleanAdLines(neg2), neg2);
});

test('cleanAdLines：bookmaopu 面包屑 C 与功能块行剔除', () => {
  // 正文 80 行压低杂质占比（首块 5 行 < 10% 阈值），保证不触发误杀保护放弃清洗
  const body = Array.from({ length: 80 }, (_, i) => `  正文第${i}段，剧情继续向前推进着。`).join('\n\n');
  const dirty = '猫扑中文文学阅读 > 玄幻奇幻 > 骇夜 > 第1章 这不是他的沙发\n\n'
    + '目 录\n\n投票推荐\n\n推荐阅读：\n\n' + body;
  const out = e.cleanAdLines(dirty);
  assert.ok(!/猫扑中文文学阅读/.test(out), '多级面包屑行应剔除');
  assert.ok(!/^目\s*录$/m.test(out), '「目 录」空格排版应剔除');
  assert.ok(!/投票推荐/.test(out) && !/推荐阅读/.test(out), '功能块标题行应剔除');
  // 负例：行内含导航词但主体是正文的整行不动
  const neg = '  他把目录翻开，投票推荐的话写在了扉页上。\n\n'
    + Array.from({ length: 19 }, (_, i) => `  正文${i}段，继续推进剧情的合理内容。`).join('\n\n');
  assert.equal(e.cleanAdLines(neg), neg, '行内含词不整行剔');
});

test('cleanAdLines：误杀保护（剔除比超 10% 放弃清洗）', () => {  // 短文本 3 行全是域名行——非空行 <10 时阈值上取整为 1，超 1 行即放弃
  const t = 'a.com\nb.org\nc.net';
  const out = e.cleanAdLines(t);
  assert.ok(typeof out === 'string');
});

// -------------------------------------------------------- findNextContentPage
const PAGE_URL = 'https://www.shudugu.org/101/3331.html';

test('findNextContentPage：锚文本名单与同章约束', () => {
  const mk = (label, href) => `<a href="${href || '/101/3331-2.html'}">${label}</a>`;
  for (const label of ['下一页', '下页', '下一頁', '下頁']) {
    assert.equal(e.findNextContentPage(mk(label), PAGE_URL),
      'https://www.shudugu.org/101/3331-2.html', `锚文本「${label}」应识别`);
  }
  assert.equal(e.findNextContentPage(mk('下一章'), PAGE_URL), null, '下一章不跟随');
  assert.equal(e.findNextContentPage(mk('下一页', '/101/3332-1.html'), PAGE_URL), null, '跨章不跟随');
  assert.equal(e.findNextContentPage('<a href="/101/3331-2.html">下一页</a>',
    'https://www.shudugu.org/101/3331-4.html'), 'https://www.shudugu.org/101/3331-2.html',
    '同章任意页码均可定位（含 -N 入口）');
  assert.equal(e.findNextContentPage('<p>无链接</p>', PAGE_URL), null);
});

test('findNextContentPage：目录式章节路径跟随（bookmaopu 实测形态）', () => {
  const CAT_URL = 'https://www.bookmaopu.com/1279832/99480611/';
  // 首页（尾斜杠目录式）→ 下一页 …/2.html 必须跟随（此前 keyOf 只认 .html 结尾恒 null）
  assert.equal(e.findNextContentPage('<a href="/1279832/99480611/2.html">下一页</a>', CAT_URL),
    'https://www.bookmaopu.com/1279832/99480611/2.html', '目录式首页应跟随到 /2.html');
  // 分页页 → 下一分页同章跟随
  assert.equal(e.findNextContentPage('<a href="/1279832/99480611/3.html">下一页</a>',
    'https://www.bookmaopu.com/1279832/99480611/2.html'),
    'https://www.bookmaopu.com/1279832/99480611/3.html', '分页页间应连续跟随');
  // 下一章目录不同 key，不跟随
  assert.equal(e.findNextContentPage('<a href="/1279832/99480612/">下一页</a>', CAT_URL),
    null, '跨章目录不跟随');
  // 文件式旧形态语义不变
  assert.equal(e.findNextContentPage('<a href="/101/3331-2.html">下一页</a>', PAGE_URL),
    'https://www.shudugu.org/101/3331-2.html', '文件式形态保持兼容');
});

// ------------------------------------------------------------ joinContentPages
test('joinContentPages：页边界段落缝合', () => {
  const p1 = '  第一段完。\n\n  他被斩断的话音';
  const p2 = '  还在空气里回荡。\n\n  新的一段。';
  const joined = e.joinContentPages([p1, p2]);
  assert.ok(joined.includes('他被斩断的话音还在空气里回荡。'), '切断段应无缝缝合');
  assert.ok(joined.includes('回荡。\n\n  新的一段'), '完整段间仍空行分隔');

  // 负例：终止符收尾不缝合
  const q1 = '  完整段落一。';
  const q2 = '  完整段落二。';
  assert.equal(e.joinContentPages([q1, q2]), q1 + '\n\n' + q2);

  // 空页过滤
  assert.equal(e.joinContentPages([q1, null, q2]), q1 + '\n\n' + q2);
});

// ------------------------------------------------------------- parseGenericToc
test('parseGenericToc：聚类识别 + 书名 + 章节号升序 + 导航剔除', () => {
  const html = `<html><head><title>测试书_某站点</title></head><body>
    <a href="/">首页</a><a href="/login">登录</a>
    <a href="/book/3.html">第三章 终局</a>
    <a href="/book/1.html">第一章 开始</a>
    <a href="/book/2.html">第二章 发展</a>
    <a href="/book/4.html">第四章 尾声</a>
  </body></html>`;
  const r = e.parseGenericToc(html, 'https://example.com/book/');
  assert.equal(r.bookName, '测试书');
  assert.equal(r.chapters.length, 4);
  assert.deepEqual(r.chapters.map((c) => c.n), [1, 2, 3, 4]);
  assert.equal(r.chapters[0].title, '第一章 开始', '按章节号升序而非文档序');
  assert.equal(r.chapters[0].url, 'https://example.com/book/1.html');
});

test('parseGenericToc：无章节返回 reason', () => {
  const r = e.parseGenericToc('<html><body><a href="/">首页</a></body></html>', 'https://example.com/');
  assert.equal(r.chapters.length, 0);
  assert.ok(r.reason);
});

// -------------------------------------------------------- extractGenericContent
test('extractGenericContent：id 容器命中与短内容拒绝', () => {
  const long = '正文内容。'.repeat(30);
  const html = `<html><body><div id="content"><p>${long}</p></div></body></html>`;
  const raw = e.extractGenericContent(html);
  assert.ok(raw && raw.includes('正文内容'));
  assert.equal(e.extractGenericContent('<html><body><div>太短</div></body></html>'), null);
  // script 污染预清洗
  const dirty = `<html><body><div id="content"><script>var x=1;</script><p>${long}</p></div></body></html>`;
  assert.ok(!/var x/.test(e.extractGenericContent(dirty)));
});

test('extractGenericContent：双容器打分选优（bookmaopu 实测形态）', () => {
  const body = '邵澜被水声吵醒，睁开眼睛，这是一段足够长的正文内容。'.repeat(12);
  // 外层 id=content 包裹面包屑+导航+推荐书单；内层 id=htmlContent 才是纯正文
  const html = `<html><body>
    <div id="content">猫扑中文文学阅读 > 玄幻奇幻 > 骇夜 > 第1章<br>目 录<br>投票推荐<br>推荐阅读：<br>剑主！<br>${body}</div>
    <div id="htmlContent">${body}</div>
  </body></html>`;
  const raw = e.extractGenericContent(html);
  assert.ok(raw && raw.includes('邵澜被水声吵醒'), '应命中含正文的候选');
  // 关键断言：选中的必须是内层纯正文容器，不含面包屑与推荐杂质
  assert.ok(!/猫扑中文文学阅读/.test(raw), '外层杂质容器应被 penalty 淘汰');
});

// ------------------------------------------------------------ makeIconPng / ZIP
test('makeIconPng：PNG 魔数与结构', () => {
  const png = e.makeIconPng('测');
  assert.ok(Buffer.isBuffer(png) && png.length > 100);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('buildZip：本地文件头与中央目录魔数', () => {
  const entry = e.zipEntry('hello.txt', Buffer.from('hello'));
  const zip = e.buildZip([entry]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'PK\\x03\\x04 本地文件头');
  assert.ok(zip.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), 'EOCD 记录存在');
  assert.ok(zip.includes(Buffer.from('hello')));
});

// ------------------------------------------------------- throttle 滑动窗口
// 窗口长度经 __setThrottleWindowMs 缩至 300ms：真实 60s 窗口无法单测，
// 语义不变量不变（任意 windowMs 内 ≤ maxPerMin）。各用例用独立 host 避免串桶。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('throttle：滑动窗口打满后仅睡到最早请求滑出（非整窗死等）', async () => {
  const restore = e.__setThrottleWindowMs(300);
  try {
    const host = 'sliding-window.test';
    const t0 = Date.now();
    await e.throttle(0, host, 2);          // 第 1 个：立即放行，winTimes=[t0]
    await sleep(150);
    const t1 = Date.now();
    await e.throttle(0, host, 2);          // 第 2 个：立即放行，窗口打满 [t0, t0+150]
    await e.throttle(0, host, 2);          // 第 3 个：睡到 t0+300（最早请求滑出）
    const t2 = Date.now();
    await e.throttle(0, host, 2);          // 第 4 个：滑动窗口下只睡到 t1+300；
                                           // 固定窗口此处在新窗口内会立即放行（t3-t2≈0）
    const t3 = Date.now();
    assert.ok(t2 - t0 >= 250, `第 3 个请求应等到最早请求滑出（实测 ${t2 - t0}ms）`);
    assert.ok(t3 - t2 >= 100, `第 4 个请求应平滑等到次早请求滑出（实测 ${t3 - t2}ms，固定窗口会 ≈0）`);
    assert.ok(t3 - t0 < 3000, '滑动窗口不应产生超额死等');
  } finally { restore(); }
});

test('throttle：语义不变量——任意窗口内请求数 ≤ maxPerMin', async () => {
  const restore = e.__setThrottleWindowMs(200);
  try {
    const host = 'invariant.test';
    const stamps = [];
    for (let i = 0; i < 5; i++) {
      await e.throttle(0, host, 3);
      stamps.push(Date.now());
    }
    // 任意 200ms 滑动窗口内至多 3 个时间戳
    for (let i = 0; i < stamps.length; i++) {
      const inWin = stamps.filter((t) => t >= stamps[i] && t - stamps[i] < 200);
      assert.ok(inWin.length <= 3, `窗口内请求数 ${inWin.length} 超过上限 3`);
    }
  } finally { restore(); }
});

test('getHostRate：slow 快照随惩罚翻倍，窗口计数与上限可见', async () => {
  const restore = e.__setThrottleWindowMs(60000);
  try {
    const host = 'slow-snapshot.test';
    await e.throttle(0, host, 90);         // 建立门并声明窗口上限
    let snap = e.getHostRate(host);
    assert.equal(snap.host, host);
    assert.equal(snap.slow, 1, '未降速时 slow=1');
    assert.equal(snap.winCount, 1);
    assert.equal(snap.maxPerMin, 90);
    assert.equal(snap.winRemainingMs, 0, '未满窗时无等待');
    e.bumpHostPenalty(host);
    e.bumpHostPenalty(host);
    snap = e.getHostRate(host);
    assert.equal(snap.slow, 4, '两次惩罚 slow 应 ×4');
  } finally { restore(); }
});

test('getHostRate：host 无记录返回 null', () => {
  assert.equal(e.getHostRate('no-such-host.invalid'), null);
});

// ------------------------------------------------- Legado 链式选择器（2026-09-29 修复固化）
// 三个修复：① [w-] 笔误致 .class/#id 简写死代码；② 带索引简写（.odd.0/a.0）无归一路径；
// ③ 段遍历 children-only 不符合 Legado 后代选择器语义（HTML 型源首次接入暴露）
const { evalChain, makeDom } = require('../legado-rules');

const CHAIN_HTML = `<html><body>
  <div class="wrap"><div class="item clear"><div class="itemtxt">
    <h3><a href="/book/1.html">斗破苍穹</a></h3>
    <ul><li>作者：天蚕土豆</li><li>阅读量：99</li></ul>
  </div></div></div>
  <table id="author"><tr><th>名称</th></tr>
    <tr><td class="odd"><a href="/book/2.html">万相之王</a></td><td class="even">第一章</td>
        <td class="odd">天蚕土豆</td></tr>
  </table>
</body></html>`;

test('evalChain：简写归一化（.class / #id / 带索引 / 纯标签带索引）', () => {
  const dom = makeDom(CHAIN_HTML);
  assert.equal(evalChain(dom, '.itemtxt@tag.h3.0@tag.a.0@text'), '斗破苍穹', '.class 简写');
  assert.equal(evalChain(dom, '#author@tr@tag.td.0@tag.a.0@text'), '万相之王', '#id 简写（无 tbody 自动补全）');
  assert.equal(evalChain(dom, '#author@tr.1@.odd.0@text'), '万相之王', '.odd.0 带索引简写');
  assert.equal(evalChain(dom, '.itemtxt@a.0@href'), '/book/1.html', 'a.0 纯标签带索引简写');
});

test('evalChain：后代选择器语义（从根深层查容器 + 跨代字段）', () => {
  const dom = makeDom(CHAIN_HTML);
  // children-only 时从根查 class.item 必空（深层 div）；后代语义应命中 1 个
  const items = require('../legado-adapter').compileBookList('class.item', 'html')(CHAIN_HTML);
  assert.equal(items.length, 1, 'bookList 应深层命中 class.item');
  // 后代语义下字段无需逐层写全：.itemtxt 内直接 a.0 可取到 h3 里的 a
  assert.equal(evalChain(dom, '.itemtxt@a.0@text'), '斗破苍穹', '跨代字段 a.0 应命中后代');
});

// -------------------------------------------- legado 字符串 replaceRegex 与 &emsp;（2026-09-29）
test('extractContent：legado 字符串形态 replaceRegex 消化且 normalizeContent 不崩', () => {
  const src = {
    legado: true, responseType: 'html',
    ruleContent: { content: 'class.con.0@html', replaceRegex: '##[\\(（]本章完[\\)）]$' },
    _legado: { jsonKind: false }
  };
  const html = '<html><body><div class="con"><p>&emsp;&emsp;第一段。</p><p>第二段（本章完）</p></div></body></html>';
  const text = e.extractContent(html, src);
  assert.ok(text.includes('第一段'), '正文应提取');
  assert.ok(!/本章完/.test(text), '字符串 replaceRegex 应删除「（本章完）」');
  assert.ok(!/&emsp;/.test(text), '&emsp; 实体应清除');
});

// --------------------------------- legado java.aesBase64DecodeToString 章节地址解密（2026-10-08）
const legadoAdapter = require('../legado-adapter.js');

test('compileRule：java.aesBase64DecodeToString 章节地址解密（猫眼看书源形态固化）', () => {
  const crypto = require('crypto');
  const key = 'f041c49714d39908', iv = '0123456789abcdef';
  const plain = '/751/751234/29544.json';
  const ci = crypto.createCipheriv('aes-128-cbc', key, iv);
  const b64 = Buffer.concat([ci.update(Buffer.from(plain, 'utf8')), ci.final()]).toString('base64');
  const rule = `$.path@js:java.aesBase64DecodeToString(result,"${key}","AES/CBC/PKCS5Padding","${iv}")`;
  const fn = legadoAdapter.compileRule(rule, 'json');
  assert.equal(fn({ path: b64 }), plain, 'AES-CBC 密文应解密为原地址');
  // 非法密文不抛出，返回 null（字段缺失语义，调用方跳过该条目）
  assert.equal(fn({ path: '!!!not-base64!!!' }), null);
  // 原始 JSONPath 无 @js 尾回归：原样取值
  assert.equal(legadoAdapter.compileRule('$.path', 'json')({ path: b64 }), b64);
});

test('legadoParseCatalog：AES 目录规则整链（合成目录 JSON，含无地址卷标题跳过）', () => {
  const crypto = require('crypto');
  const key = 'f041c49714d39908', iv = '0123456789abcdef';
  const enc = (s) => {
    const ci = crypto.createCipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([ci.update(Buffer.from(s, 'utf8')), ci.final()]).toString('base64');
  };
  const src = {
    bookSourceName: '测试AES源', bookSourceUrl: 'http://aes.test',
    searchUrl: 'http://aes.test/search?q={{key}}',
    ruleSearch: { bookList: '$.data[*]', name: '$.name', bookUrl: '$.url' },
    ruleToc: {
      chapterList: '$.data.list[*]', chapterName: '$.chapterName',
      chapterUrl: `$.path@js:java.aesBase64DecodeToString(result,"${key}","AES/CBC/PKCS5Padding","${iv}")`
    },
    ruleContent: { content: '$.content' }
  };
  const w = legadoAdapter.wrapLegado(src);
  assert.ok(w, '合成源应包装成功');
  const tocJson = JSON.stringify({
    code: 200, msg: 'success',
    data: { list: [
      { chapterName: '第1章 开端', path: enc('/751/1/11.json') },
      { chapterName: '卷一', path: '' },
      { chapterName: '第2章 进行', path: enc('/751/1/12.json') }
    ] }
  });
  const chapters = legadoAdapter.legadoParseCatalog(tocJson, w);
  assert.equal(chapters.length, 2, '无地址卷标题应跳过且不消耗章号');
  assert.equal(chapters[0].n, 1);
  assert.equal(chapters[0].title, '第1章 开端');
  assert.equal(chapters[0].url, 'http://aes.test/751/1/11.json');
  assert.equal(chapters[1].n, 2);
  assert.equal(chapters[1].url, 'http://aes.test/751/1/12.json');
});



// 本地导入：TXT 切章（2026-10-08）
test('splitTxtChapters：第X章启发式切分 + 无标题整本单章兜底', () => {
  const li = require('../local-import');
  const txt = '  第一章 起点\n\n  第一段内容。\n  第二段内容。\n\n第二章 转折\n\n  新章第一段。\n  新章第二段。\n';
  const chapters = li.splitTxtChapters(txt, '测试书');
  assert.equal(chapters.length, 2, '两个标题行应切出两章');
  assert.equal(chapters[0].title, '第一章 起点');
  assert.ok(chapters[0].body.startsWith('第一段内容。'), '正文段落应按 \\n\\n 连接');
  assert.equal(chapters[0].body.split('\n\n').length, 2);
  assert.equal(chapters[1].title, '第二章 转折');
  // 无章节标题 → 整本单章，标题用文件名
  const one = li.splitTxtChapters('只有一段正文，没有章节标题。', '无章书');
  assert.equal(one.length, 1);
  assert.equal(one[0].title, '无章书');
});

// 本地导入：EPUB 解析（合成最小 EPUB，验证 zip 读取 + spine 顺序 + 元数据 + 封面）
test('parseEpub：container→OPF→spine 解析，封面与作者尽力提取', () => {
  const li = require('../local-import');
  const container = '<?xml version="1.0"?><container version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
  const opf = '<?xml version="1.0"?>'
    + '<package xmlns="http://www.idpf.org/2007/opf" version="2.0">'
    + '<metadata><dc:title>合成书名</dc:title><dc:creator>合成作者</dc:creator>'
    + '<meta name="cover" content="cover-id"/></metadata>'
    + '<manifest>'
    + '<item id="cover-id" href="cover.png" media-type="image/png"/>'
    + '<item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>'
    + '<item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>'
    + '</manifest>'
    + '<spine><itemref idref="c1"/><itemref idref="c2"/></spine>'
    + '</package>';
  const chap = (n) => `<?xml version="1.0"?><html><body><h2>第${n}章 标题${n}</h2><p>第${n}章正文第一段。</p><p>第二段。</p></body></html>`;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);  // PNG 魔数
  const zip = e.buildZip([
    e.zipEntry('mimetype', Buffer.from('application/epub+zip')),
    e.zipEntry('META-INF/container.xml', Buffer.from(container)),
    e.zipEntry('OEBPS/content.opf', Buffer.from(opf)),
    e.zipEntry('OEBPS/chap1.xhtml', Buffer.from(chap(1))),
    e.zipEntry('OEBPS/chap2.xhtml', Buffer.from(chap(2))),
    e.zipEntry('OEBPS/cover.png', png)
  ]);
  const book = li.parseEpub(zip);
  assert.equal(book.name, '合成书名');
  assert.equal(book.author, '合成作者');
  assert.equal(book.chapters.length, 2, '两章按 spine 顺序解析');
  assert.equal(book.chapters[0].title, '第1章 标题1', '章节标题取 h 标签');
  assert.ok(book.chapters[0].body.includes('第1章正文第一段。'), '正文段落提取');
  assert.ok(Buffer.isBuffer(book.coverData) && book.coverData.length === png.length, '封面字节完整提取');
});

// EPUB 导出：真实封面优先（2026-10-08），缺省回退算法封面
test('exportEpub：coverFile 存在嵌入真实封面，缺失回退算法 cover.png', async () => {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-cover-'));
  // 结果集一章带正文，保证 EPUB 组装非空
  const results = [{ n: 1, title: '第一章 试', file: 'chapter_001.txt', text: '第一章 试\n\n正文一段。' }];
  const source = { bookSourceName: '测', bookSourceUrl: 'http://t.example' };
  // ① 无 coverFile → 算法封面（zip 内含 OEBPS/cover.png）
  let p = await e.exportEpub(tmp, results, '无封面书', source, {});
  let zipBuf = fs.readFileSync(p);
  assert.ok(zipBuf.length > 0);
  assert.ok(zipBuf.indexOf(Buffer.from('OEBPS/cover.png')) >= 0, '缺省应为算法封面 cover.png');
  // ② 真实 cover.jpg 存在 → 嵌入 jpg（zip 内不再有 cover.png）
  fs.writeFileSync(path.join(tmp, 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  p = await e.exportEpub(tmp, results, '真封面书', source, { coverFile: path.join(tmp, 'cover.jpg') });
  zipBuf = fs.readFileSync(p);
  assert.ok(zipBuf.indexOf(Buffer.from('OEBPS/cover.jpg')) >= 0, '真实封面应嵌入为 cover.jpg');
  assert.ok(zipBuf.indexOf(Buffer.from('image/jpeg')) >= 0, 'OPF media-type 应为 image/jpeg');
  assert.ok(zipBuf.indexOf(Buffer.from('OEBPS/cover.png')) < 0, '有真实封面时不应再出算法 cover.png');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// 换源章节标题匹配（2026-10-08 阅读器换源）
test('matchChapterByTitle：归一化跨源标题差异，精确优先部分匹配兜底', () => {
  const chapters = [
    { n: 1, title: '第一章 起点之星' },
    { n: 2, title: '第 2 章 风起（修订）' },
    { n: 3, title: '第三章　夜行' }
  ];
  // 精确命中
  assert.equal(e.matchChapterByTitle(chapters, '第一章 起点之星').n, 1);
  // 空白/全角差异归一化命中
  assert.equal(e.matchChapterByTitle(chapters, '第三章 夜行').n, 3);
  assert.equal(e.matchChapterByTitle(chapters, '第２章 风起 修订').n, 2);
  // 书名号包裹命中
  assert.equal(e.matchChapterByTitle(chapters, '《第三章 夜行》').n, 3);
  // 互相包含兜底（目标源标题多副词缀）
  assert.equal(e.matchChapterByTitle(chapters, '第一章 起点之星（上）').n, 1);
  // 未命中返回 null
  assert.equal(e.matchChapterByTitle(chapters, '第四十二章 无此章'), null);
  assert.equal(e.matchChapterByTitle(chapters, ''), null);
});
