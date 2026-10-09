/**
 * CDP v42 验证：真开书动画三段式（飞到中央→绕书脊翻开178°→正文淡入）+
 * 关书三段式（正文淡出→合书→飞回卡片）。采样 flipper rotateY 中间态。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8736);
const DBG = 9305;
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, '--user-data-dir=' + process.env.TEMP + '/cdp-v42-test', '--no-first-run', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
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
    // 开书：单次 evalJs 内多点采样（100ms 舞台在飞 / 520ms 翻页中 / 1000ms 清场完成）
    const open = await evalJs(`(function(){
      return new Promise(function (res) {
        var btns = [...document.querySelectorAll('#libraryList .lib-actions button')];
        var rb = btns.find(function (b) { return b.textContent.indexOf('阅读') >= 0; });
        if (rb) rb.click();
        var s = {};
        setTimeout(function () {
          var w = document.querySelector('.reader-flip');
          s.t100 = { stage: !!w, mask: document.querySelector('#readerMask').style.display !== 'none',
            hasFlipper: !!(w && w.firstElementChild), hasBack: !!(w && w.querySelector('[style*="rotateY(180deg)"]')) };
        }, 100);
        setTimeout(function () {
          var w = document.querySelector('.reader-flip');
          var f = w && w.firstElementChild;
          var tr = f ? getComputedStyle(f).transform : 'none';
          s.t520 = { stage: !!w, flipTransform: tr !== 'none' };
        }, 520);
        setTimeout(function () {
          s.t1000 = { stageGone: !document.querySelector('.reader-flip'),
            readerShown: document.querySelector('#readerMask').style.display !== 'none' };
          res(s);
        }, 1000);
      });
    })()`);
    console.log('[cdp] 开书三段:', JSON.stringify(open));
    await sleep(400);
    // 关书：100ms 采样（合书起步）→ 1100ms 终态
    const close = await evalJs(`(function(){
      return new Promise(function (res) {
        document.querySelector('#btnReaderClose').click();
        var s = {};
        setTimeout(function () {
          var w = document.querySelector('.reader-flip');
          var f = w && w.firstElementChild;
          s.t100 = { stage: !!w, flipStyle: !!(f && (f.style.transform || '').indexOf('rotateY') >= 0) };
        }, 100);
        setTimeout(function () {
          s.t1100 = { stageGone: !document.querySelector('.reader-flip'),
            maskHidden: document.querySelector('#readerMask').style.display === 'none' };
          res(s);
        }, 1100);
      });
    })()`);
    console.log('[cdp] 关书三段:', JSON.stringify(close));
    // 重开+再关（重复触发守卫）
    const reopen = await evalJs(`(function(){
      return new Promise(function (res) {
        var btns = [...document.querySelectorAll('#libraryList .lib-actions button')];
        var rb = btns.find(function (b) { return b.textContent.indexOf('阅读') >= 0; });
        if (rb) rb.click();
        setTimeout(function () {
          var ok1 = document.querySelector('#readerMask').style.display !== 'none';
          document.querySelector('#btnReaderClose').click();
          setTimeout(function () {
            res({ reopened: ok1, closedAgain: document.querySelector('#readerMask').style.display === 'none' });
          }, 1000);
        }, 1000);
      });
    })()`);
    console.log('[cdp] 重开+再关:', JSON.stringify(reopen));
    console.log('[cdp] 页面JS错误:', JSON.stringify(errs.slice(0, 5)));
  } finally { edge.kill(); }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
