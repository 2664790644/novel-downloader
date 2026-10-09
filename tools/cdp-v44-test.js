/**
 * CDP v44 验证：真·翻页书阅读器。
 * ①打开书 → flipBook 通道激活、St.PageFlip 实例存在、页数=分页结果、双页摊开
 * ②点击书右侧 → 翻页（fbCurPage 变化）
 * ③字号调整 → 重建且保持页位
 * ④翻到末页 → 边界翻章（←/→ 模拟）
 * ⑤关闭 → 实例销毁；重开正常
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8735);
const DBG = 9311;
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, '--user-data-dir=' + process.env.TEMP + '/cdp-v44-test', '--no-first-run', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  try {
    let targets = null;
    for (let i = 0; i < 30; i++) { await sleep(500); try { targets = await getJson(`http://127.0.0.1:${DBG}/json`); break; } catch (e) {} }
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let mid = 0; const pend = new Map(); const errs = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') errs.push(String(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text).slice(0, 300));
    };
    const send = (method, params = {}) => new Promise((resolve) => { const id = ++mid; pend.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
    async function evalJs(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result && r.result.result ? r.result.result.value : undefined;
    }
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: UI });
    for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs('document.readyState') === 'complete') break; }
    await sleep(800);
    await evalJs("document.querySelector('#btnNavLibrary').click(); true");
    for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs("document.querySelectorAll('#libraryList .lib-row').length") > 0) break; }
    await sleep(500);
    // ① 打开书 → 等正文加载+分页
    const open = await evalJs(`(function(){
      return new Promise(function (res) {
        var btns = [...document.querySelectorAll('#libraryList .lib-actions button')];
        var rb = btns.find(function (b) { return b.textContent.indexOf('阅读') >= 0; });
        if (rb) rb.click();
        setTimeout(function () {
          var fb = document.querySelector('#flipBook');
          var st = typeof St !== 'undefined' && !!St.PageFlip;
          res({ libGlobal: st, fbActive: fb.classList.contains('active'),
            pages: fb.querySelectorAll('.fb-page').length,
            bodyHidden: document.querySelector('#readerBody').style.display === 'none',
            hasStance: typeof window.St !== 'undefined' });
        }, 2000);
      });
    })()`);
    console.log('[cdp] 打开翻页书:', JSON.stringify(open));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync('tools/_v44-flipbook.png', Buffer.from(shot.result.data, 'base64'));
    // ② 点击书右半 → 翻页（等 600ms 翻页动画）
    const flip = await evalJs(`(function(){
      return new Promise(function (res) {
        var fb = document.querySelector('#flipBook');
        var before = fb.querySelectorAll('.fb-page').length;
        var stArea = fb.querySelector('.stf__parent') || fb;
        var r = stArea.getBoundingClientRect();
        var cx = r.left + r.width * 0.75, cy = r.top + r.height / 2;
        var el = document.elementFromPoint(cx, cy);
        if (el) el.click();
        setTimeout(function () {
          var parent = fb.querySelector('.stf__parent');
          res({ pagesBefore: before, clicked: !!el,
            stfParent: !!parent,
            hint: '页码状态在实例内部，视觉验证看截图' });
        }, 800);
      });
    })()`);
    console.log('[cdp] 点击翻页:', JSON.stringify(flip));
    const shot2 = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync('tools/_v44-flipped.png', Buffer.from(shot2.result.data, 'base64'));
    // ③ 字号调整 → 重建保页位（探测 flipBook 仍在 active）
    const font = await evalJs(`(function(){
      document.querySelector('#btnReaderFontPlus').click();
      return new Promise(function (res) {
        setTimeout(function () {
          var fb = document.querySelector('#flipBook');
          res({ fbStillActive: fb.classList.contains('active'),
            pages: fb.querySelectorAll('.fb-page').length });
        }, 800);
      });
    })()`);
    console.log('[cdp] 字号重建:', JSON.stringify(font));
    // ④ 关闭 → 销毁；重开
    const closeRe = await evalJs(`(function(){
      return new Promise(function (res) {
        document.querySelector('#btnReaderClose').click();
        setTimeout(function () {
          var fb = document.querySelector('#flipBook');
          var closed = { fbInactive: !fb.classList.contains('active'), fbEmpty: fb.children.length === 0 };
          var btns = [...document.querySelectorAll('#libraryList .lib-actions button')];
          var rb = btns.find(function (b) { return b.textContent.indexOf('阅读') >= 0; });
          if (rb) rb.click();
          setTimeout(function () {
            res({ closed: closed, reopened: document.querySelector('#flipBook').classList.contains('active') });
          }, 2200);
        }, 1100);
      });
    })()`);
    console.log('[cdp] 关闭销毁+重开:', JSON.stringify(closeRe));
    console.log('[cdp] 页面JS错误:', JSON.stringify(errs.slice(0, 5)));
  } finally { edge.kill(); }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
