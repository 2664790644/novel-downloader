/**
 * CDP v40 验证：①真封面隐藏书名/作者/印章（.cover.real）②阅读器章节导航第二行右对齐
 * ③开书动画增强 + 关书 bookClose 帧 ④首页甲板 deck-in 入场动画。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8735);
const DBG = 9298;
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, '--user-data-dir=' + process.env.TEMP + '/cdp-v40-test', '--no-first-run', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
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

    // ④ 甲板入场：进搜索页（未搜索）→ homeDeck 应显示且带 deck-in 类 + fadeUp 动画
    const deck = await evalJs(`(function(){
      return new Promise(function (res) {
        setTimeout(function () {
          var d = document.querySelector('#homeDeck');
          var cs = getComputedStyle(d);
          res({ shown: d.style.display !== 'none', hasDeckIn: d.classList.contains('deck-in'),
            animName: cs.animationName, dur: cs.animationDuration });
        }, 700);
      });
    })()`);
    console.log('[cdp] 甲板入场:', JSON.stringify(deck));

    // ① 真封面：书架网格卡封面 img loaded 后 .cover 应有 real 类 → 子元素 display:none
    await evalJs("document.querySelector('#btnNavLibrary').click(); true");
    for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs("document.querySelectorAll('#libraryList .lib-card, #libraryList .lib-row').length") > 0) break; }
    await evalJs("document.querySelector('#btnLibGridView').click(); true");
    await sleep(2500);   // 等封面图网络加载
    const real = await evalJs(`(function(){
      var covers = [...document.querySelectorAll('#libraryList .lib-card .cover')];
      var withImg = covers.filter(function (c) { return c.querySelector('img.cover-img.loaded'); });
      var realCnt = covers.filter(function (c) { return c.classList.contains('real'); }).length;
      var hiddenCnt = 0;
      withImg.forEach(function (c) {
        var t = c.querySelector('.c-title');
        if (t && getComputedStyle(t).display === 'none') hiddenCnt++;
      });
      var noImg = covers.length - covers.filter(function (c) { return c.querySelector('img.cover-img'); }).length;
      return { covers: covers.length, withLoadedImg: withImg.length, realClass: realCnt,
        titleHidden: hiddenCnt, fallbackNoImg: noImg };
    })()`);
    console.log('[cdp] 真封面real类(带图卡应real且title隐藏,无图卡回退):', JSON.stringify(real));
    await sleep(600);
    const shot1 = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync('tools/_v40-covers.png', Buffer.from(shot1.result.data, 'base64'));

    // ②③ 阅读器：nav2 第二行右对齐 + 开书动画 bookOpen(.55s) + 关书 bookClose(.32s)
    const read = await evalJs(`(function(){
      return new Promise(function (res) {
        var btns = [...document.querySelectorAll('#libraryList .lib-actions button')];
        var rb = btns.find(function (b) { return b.textContent.indexOf('阅读') >= 0; });
        if (rb) rb.click();
        setTimeout(function () {
          var r = document.querySelector('.reader');
          var cs = getComputedStyle(r);
          var nav2 = document.querySelector('.reader-nav2');
          var ncs = nav2 ? getComputedStyle(nav2) : null;
          res({ animName: cs.animationName, dur: cs.animationDuration,
            nav2Exists: !!nav2, nav2Basis: ncs && ncs.flexBasis, nav2Justify: ncs && ncs.justifyContent,
            btnsInNav2: nav2 ? nav2.querySelectorAll('button').length : 0 });
        }, 500);
      });
    })()`);
    console.log('[cdp] 开书动画+第二行导航:', JSON.stringify(read));
    // 关书：点关闭 → mask 应挂 overlay-closing，reader computed 动画名 bookClose
    const closing = await evalJs(`(function(){
      return new Promise(function (res) {
        document.querySelector('#btnReaderClose').click();
        setTimeout(function () {
          var mask = document.querySelector('#readerMask');
          var r = mask.querySelector('.reader');
          res({ closing: mask.classList.contains('overlay-closing'),
            closeAnim: getComputedStyle(r).animationName, closeDur: getComputedStyle(r).animationDuration });
        }, 120);
      });
    })()`);
    console.log('[cdp] 关书动画:', JSON.stringify(closing));
    console.log('[cdp] 页面JS错误:', JSON.stringify(pageErrors.slice(0, 5)));
    console.log('[cdp] 截图: tools/_v40-covers.png');
  } finally { edge.kill(); }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
