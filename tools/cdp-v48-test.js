/**
 * <p>CDP v48 验证：历史下拉 fixed 定位——打开下拉不得撑出页面滚动条，内部滚动。</p>
 * <p>①预置 10 条历史 ②打开前后 document.scrollHeight 对比（核心断言：不变）
 * ③drop 位置/宽度对齐胶囊、maxHeight 不超视口 ④内部可滚（scrollHeight>clientHeight 时 scrollTop 可动）⑤截图</p>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8735);
const DBG = 9317;
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, '--user-data-dir=' + process.env.TEMP + '/cdp-v48-test', '--no-first-run', '--window-size=1400,760', 'about:blank'], { stdio: 'ignore' });
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
    await send('Page.enable');
    await send('Page.navigate', { url: UI });
    for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs('document.readyState') === 'complete') break; }
    await sleep(800);
    // 10 条历史撑满触发内滚
    await evalJs(`localStorage.setItem('nd-kwhistory', JSON.stringify(['夜无过失期一','夜无过失期二','我不是戏神','阔别到天明时份','仙道尽头','凡人修仙传','诡秘之主','庆余年','斗破苍穹','遮天'])); true`);
    // 核心：打开前后页面 scrollHeight / clientHeight 对比
    const r1 = await evalJs(`(function(){
      var doc = document.documentElement;
      var before = { sh: doc.scrollHeight, ch: doc.clientHeight, sw: doc.scrollWidth };
      var kw = document.querySelector('#keyword');
      kw.dispatchEvent(new Event('focus'));
      return new Promise(function (res) {
        setTimeout(function () {
          var drop = document.querySelector('#kwDrop');
          var wrap = document.querySelector('.search-wrap');
          var wr = wrap.getBoundingClientRect();
          var dr = drop.getBoundingClientRect();
          var after = { sh: doc.scrollHeight, ch: doc.clientHeight, sw: doc.scrollWidth };
          var items = drop.querySelectorAll('.kw-item');
          // 内滚探测：内容超出限高时 scrollTop 可滚动
          var inner = { sh: drop.scrollHeight, ch: drop.clientHeight, scrollTop: drop.scrollTop };
          if (inner.sh > inner.ch) drop.scrollTop = 10;
          inner.scrolled = drop.scrollTop;
          res({
            pageUnchanged: before.sh === after.sh && before.sw === after.sw,
            before: before, after: after,
            hidden: drop.hidden, items: items.length,
            fixed: getComputedStyle(drop).position === 'fixed',
            alignLeft: Math.abs(dr.left - wr.left) < 2,
            alignWidth: Math.abs(dr.width - wr.width) < 2,
            withinViewport: dr.bottom <= window.innerHeight + 1,
            inner: inner
          });
        }, 400);
      });
    })()`);
    console.log('[1] 核心断言:', JSON.stringify(r1));

    // ② 滚动页面 → 下拉自动关闭（防脱锚）
    const r2 = await evalJs(`(function(){
      return new Promise(function (res) {
        window.scrollTo(0, 40);
        setTimeout(function () {
          res({ dropClosed: document.querySelector('#kwDrop').hidden });
        }, 300);
      });
    })()`);
    console.log('[2] 滚动关闭:', JSON.stringify(r2));

    // ③ 重新打开 + 截图（scrollTo 的 scroll 事件异步到达会关下拉，先等它消化完再聚焦）
    await evalJs(`window.scrollTo(0,0); true`);
    await sleep(400);
    await evalJs(`document.querySelector('#keyword').dispatchEvent(new Event('focus')); true`);
    await sleep(600);
    const shot = (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result;
    fs.writeFileSync(__dirname + '/_v48-drop.png', Buffer.from(shot.data, 'base64'));
    console.log('[3] 截图:', __dirname + '/_v48-drop.png', fs.statSync(__dirname + '/_v48-drop.png').size, 'bytes');
    console.log('[cdp] JS 异常:', errs.length ? errs.join(' | ') : '无');
  } finally {
    try { edge.kill(); } catch (e) {}
  }
}
main().catch((e) => { console.error('[cdp] 失败:', e.message); process.exit(1); });
