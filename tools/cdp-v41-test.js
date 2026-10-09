/**
 * CDP v41 验证：①甲板 WAAPI 方向滑入（getAnimations 实证）②开书 FLIP（.reader-flip 克隆
 * 出现→消失、reader.style.animation=none）③关书 FLIP 反向收回 ④关闭后重开正常。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8735);
const DBG = 9301;
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, '--user-data-dir=' + process.env.TEMP + '/cdp-v41-test', '--no-first-run', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
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
      if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text).slice(0, 300));
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

    // ① 切到书架再回搜索 → 甲板显示且 100ms 内有运行中 WAAPI 动画
    const deck = await evalJs(`(function(){
      return new Promise(function (res) {
        document.querySelector('#btnNavLibrary').click();
        setTimeout(function () {
          document.querySelector('#btnNavSearch').click();
          setTimeout(function () {
            var d = document.querySelector('#homeDeck');
            res({ shown: d.style.display !== 'none', anims: d.getAnimations().length });
          }, 120);
        }, 900);
      });
    })()`);
    console.log('[cdp] 甲板WAAPI滑入:', JSON.stringify(deck));

    // ② 开书 FLIP：列表视图点阅读 → 120ms 内应有 .reader-flip 克隆 + reader 动画禁用
    await evalJs("document.querySelector('#btnNavLibrary').click(); true");
    for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs("document.querySelectorAll('#libraryList .lib-row').length") > 0) break; }
    await sleep(500);
    const open = await evalJs(`(function(){
      return new Promise(function (res) {
        var btns = [...document.querySelectorAll('#libraryList .lib-actions button')];
        var rb = btns.find(function (b) { return b.textContent.indexOf('阅读') >= 0; });
        if (rb) rb.click();
        setTimeout(function () {
          var mask = document.querySelector('#readerMask');
          var reader = mask.querySelector('.reader');
          var clone = document.querySelector('.reader-flip');
          res({ clicked: !!rb, maskShown: mask.style.display !== 'none',
            cloneAlive: !!clone, readerAnimDisabled: (reader.style.animation || '').indexOf('none') >= 0,
            cloneRect: clone ? { l: Math.round(parseFloat(clone.style.left)), t: Math.round(parseFloat(clone.style.top)) } : null });
        }, 130);
      });
    })()`);
    console.log('[cdp] 开书FLIP:', JSON.stringify(open));
    await sleep(700);   // 等 420ms 动画播完克隆移除
    const cloneGone = await evalJs("!document.querySelector('.reader-flip')");
    console.log('[cdp] 开书克隆已移除:', cloneGone);

    // ③ 关书 FLIP：点关闭 → 120ms 内反向克隆出现；400ms 后 mask 隐藏
    const close = await evalJs(`(function(){
      return new Promise(function (res) {
        var mask = document.querySelector('#readerMask');
        document.querySelector('#btnReaderClose').click();
        setTimeout(function () {
          var clone = document.querySelector('.reader-flip');
          res({ cloneAlive: !!clone, closing: mask.classList.contains('overlay-closing') });
        }, 120);
      });
    })()`);
    console.log('[cdp] 关书FLIP:', JSON.stringify(close));
    await sleep(600);
    const closed = await evalJs(`({ hidden: document.querySelector('#readerMask').style.display === 'none',
      cloneGone: !document.querySelector('.reader-flip') })`);
    console.log('[cdp] 关书终态:', JSON.stringify(closed));

    // ④ 重开正常 + 再次关闭（重复关闭守卫路径顺带覆盖）
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
          }, 600);
        }, 800);
      });
    })()`);
    console.log('[cdp] 重开+再关:', JSON.stringify(reopen));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync('tools/_v41-visual.png', Buffer.from(shot.result.data, 'base64'));
    console.log('[cdp] 页面JS错误:', JSON.stringify(errs.slice(0, 5)));
  } finally { edge.kill(); }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
