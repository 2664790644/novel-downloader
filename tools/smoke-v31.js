/**
 * v31 冒烟：TXT/EPUB 导入 → 书架/预览 → 本地封面出图 → cover 代理校验。
 * 只用合成夹具与临时目录名（smoke- 前缀），结束自清理。UI_TOKEN 从页面 meta 读取。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const engine = require('../novel-downloader.js');
const { splitTxtChapters, parseEpub } = require('../local-import.js');

const PORT = Number(process.env.UI_PORT) || 8735;
function get(pathname, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
function post(pathname, data, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}
const ok = (name, cond, detail) => console.log((cond ? '✅' : '❌') + ' ' + name + (detail ? ' — ' + detail : ''));

(async () => {
  const page = await get('/');
  const token = /name="api-token" content="([0-9a-f]+)"/.exec(page.buf.toString('utf8'))[1];
  const binHeaders = { 'X-Token': token, 'Content-Type': 'application/octet-stream' };
  const jsonHeaders = { 'X-Token': token, 'Content-Type': 'application/json' };

  // ① GBK TXT 导入（含句读正文行，验证不误切）。Node 无 GBK 编码器，用项目内
  // gbk-table.json 正向表手工编码（exe/测试同源，不引外部依赖）
  const table = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gbk-table.json'), 'utf8'));
  const gbkEncode = (s) => {
    const bytes = [];
    for (const ch of s) {
      const pair = table[ch];
      if (pair) bytes.push(...pair);
      else bytes.push(...Buffer.from(ch, 'utf8'));
    }
    return Buffer.from(bytes);
  };
  const gbkTxt = gbkEncode(
    '第一章 起点\n\n这是GBK编码的第一段。\n\n第二章 展开\n\n第二章节的正文内容。\n他翻到第三章的目录页。\n');
  let r = await post('/api/library/import?kind=txt&name=' + encodeURIComponent('冒烟-GBK书.txt'),
    gbkTxt, binHeaders);
  const txtResult = JSON.parse(r.buf.toString('utf8'));
  ok('① TXT 导入 2 章（句读正文行不误切）', r.status === 200 && txtResult.chapters === 2,
    JSON.stringify(txtResult));
  const txtDir = txtResult.dirName;

  // ② 预览第 1 章
  r = await get('/api/library/preview?dir=' + encodeURIComponent(txtDir) + '&n=1');
  const prev = JSON.parse(r.buf.toString('utf8'));
  ok('② 导入书预览', r.status === 200 && !!prev.text && prev.text.includes('第一段'), prev.title);

  // ③ 合成 EPUB 导入（含封面 png）
  const container = '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
  const opf = '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0">'
    + '<metadata><dc:title>冒烟EPUB</dc:title><dc:creator>冒烟作者</dc:creator></metadata>'
    + '<manifest><item id="cover-id" href="cover.png" media-type="image/png"/>'
    + '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>'
    + '<spine><itemref idref="c1"/></spine></package>';
  const xhtml = '<html><body><h2>第一章 冒烟</h2><p>EPUB正文段落。</p></body></html>';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const epub = engine.buildZip([
    engine.zipEntry('mimetype', Buffer.from('application/epub+zip')),
    engine.zipEntry('META-INF/container.xml', Buffer.from(container)),
    engine.zipEntry('OEBPS/content.opf', Buffer.from(opf)),
    engine.zipEntry('OEBPS/c1.xhtml', Buffer.from(xhtml)),
    engine.zipEntry('OEBPS/cover.png', png)
  ]);
  r = await post('/api/library/import?kind=epub&name=' + encodeURIComponent('冒烟.epub'), epub, binHeaders);
  const epubResult = JSON.parse(r.buf.toString('utf8'));
  ok('③ EPUB 导入（含本地封面）', r.status === 200 && epubResult.chapters === 1 && epubResult.coverFile,
    JSON.stringify(epubResult));
  const epubDir = epubResult.dirName;

  // ④ 本地封面出图
  r = await get('/api/library/cover?dir=' + encodeURIComponent(epubDir));
  ok('④ 本地封面出图 PNG', r.status === 200 && r.headers['content-type'] === 'image/png'
    && r.buf.length === png.length, r.headers['content-type'] + ' ' + r.buf.length + 'B');

  // ⑤ cover 代理防线
  r = await get('/api/cover?u=javascript:alert(1)');
  ok('⑤ cover 非法地址 400', r.status === 400);
  r = await get('/api/cover?u=' + encodeURIComponent(`http://127.0.0.1:${PORT}/`));
  ok('⑤ cover 非图片 404', r.status === 404);

  // ⑥ 清理冒烟产物
  for (const dir of [txtDir, epubDir]) {
    await post('/api/library/delete', JSON.stringify({ dir }), jsonHeaders);
  }
  const lib = JSON.parse((await get('/api/library')).buf.toString('utf8'));
  const left = lib.books.filter((b) => b.dirName.startsWith('本地导入-冒烟')).length;
  ok('⑥ 冒烟产物清理', left === 0, '残留 ' + left);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
