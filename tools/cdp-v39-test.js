/**
 * CDP v39 验证：①卡片无源标签 ②搜索残留修复（清空后回搜索页无空面板）③列表行封面 ④阅读器开书动画帧。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8737);
const DBG = 9297;
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, '--user-data-dir=' + process.env.TEMP + '/cdp-v39-test', '--no-first-run', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  try {
    let targets = null;
    for (let i = 0; i < 30; i++) { await sleep(500); try { targets = await getJson(`http://127.0.0.1:${DBG}/json`); break; } catch (e) {} }
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let mid = 0; const pend = new Map(); const pageErrors = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') pageErrors.push((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text).slice(0, 200));
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
    // ① 书架列表视图：行封面 + 无源标签（列表 meta 里的源文字保留，只看网格卡）
    await evalJs("document.querySelector('#btnNavLibrary').click(); true");
    for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs("document.querySelectorAll('#libraryList .lib-row, #libraryList .lib-card').length") > 0) break; }
    await evalJs("document.querySelector('#btnLibGridView').click(); true");
    await sleep(600);
    const grid = await evalJs(`(function(){
      var subs = [];
      document.querySelectorAll('#libraryList .lib-card .b-sub').forEach(function (x) { subs.push(x.textContent.trim()); });
      return { cards: document.querySelectorAll('#libraryList .lib-card').length,
        srcChips: document.querySelectorAll('#libraryList .b-sub .src, #libraryList .b-sub .b-srcs').length,
        sampleSub: subs[0] };
    })()`);
    console.log('[cdp] 网格卡:', JSON.stringify(grid));
    // ② 列表视图封面
    await evalJs("document.querySelector('#btnLibListView').click(); true");
    await sleep(600);
    const listV = await evalJs(`(function(){
      return { rows: document.querySelectorAll('#libraryList .lib-row').length,
        covers: document.querySelectorAll('#libraryList .lib-cover').length,
        coverImgs: document.querySelectorAll('#libraryList .lib-cover img').length,
        seals: document.querySelectorAll('#libraryList .lib-seal').length };
    })()`);
    console.log('[cdp] 列表行封面:', JSON.stringify(listV));
    // ③ 残留修复（UI 路径，IIFE 内变量不可直调）：本会话未搜索 → 切搜索视图面板应隐藏
    const residual = await evalJs(`(function(){
      document.querySelector('#btnNavSearch').click();
      return new Promise(function (res) {
        setTimeout(function () {
          res({ searchViewShown: document.querySelector('#searchView').style.display !== 'none',
            homeDeckShown: document.querySelector('#homeDeck').style.display !== 'none' });
        }, 600);
      });
    })()`);
    console.log('[cdp] 未搜索回搜索页(应藏面板):', JSON.stringify(residual));
    // ④ 回书架点行内「阅读」按钮 → 读 reader computed animation-name
    const anim = await evalJs(`(function(){
      document.querySelector('#btnNavLibrary').click();
      return new Promise(function (res) {
        setTimeout(function () {
          var btns = [...document.querySelectorAll('#libraryList .lib-actions button')];
          var read = btns.find(function (b) { return b.textContent.indexOf('阅读') >= 0; });
          if (read) read.click();
          setTimeout(function () {
            var r = document.querySelector('.reader');
            var cs = getComputedStyle(r);
            res({ animName: cs.animationName, dur: cs.animationDuration, origin: cs.transformOrigin,
              readerShown: document.querySelector('#readerMask').style.display !== 'none' });
          }, 500);
        }, 800);
      });
    })()`);
    console.log('[cdp] 开书动画:', JSON.stringify(anim));
    await sleep(800);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync('tools/_v39-visual.png', Buffer.from(shot.result.data, 'base64'));
    console.log('[cdp] 页面JS错误:', JSON.stringify(pageErrors.slice(0, 5)));
    console.log('[cdp] 截图: tools/_v39-visual.png');
  } finally { edge.kill(); }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
