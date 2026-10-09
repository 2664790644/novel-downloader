/**
 * CDP 封面复现：真实搜索「骇夜」→ 等渲染完 → 检查卡片封面 img 数量/加载状态/
 * 网络请求结果。只读诊断。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8735);
const DBG = 9291;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DBG}`,
    '--user-data-dir=' + process.env.TEMP + '/cdp-cover-test',
    '--no-first-run', '--window-size=1400,900', 'about:blank'
  ], { stdio: 'ignore' });
  try {
    let targets = null;
    for (let i = 0; i < 30; i++) { await sleep(500); try { targets = await getJson(`http://127.0.0.1:${DBG}/json`); break; } catch (e) {} }
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let mid = 0; const pend = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise((resolve) => { const id = ++mid; pend.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
    async function evalJs(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 200));
      return r.result && r.result.result ? r.result.result.value : undefined;
    }
    await send('Page.enable'); await send('Runtime.enable');
    // 网络事件监听：抓 /api/cover 的真实请求结果（response / loadingFailed 原因）
    const netEvents = [];
    await send('Network.enable');
    // CDP 事件经 onmessage 分发：挂一个旁路收集器
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Network.responseReceived') {
        const r = m.params.response;
        if (r.url.includes('/api/cover')) netEvents.push({ type: 'resp', url: r.url.slice(0, 70), status: r.status });
      }
      if (m.method === 'Network.loadingFailed') {
        netEvents.push({ type: 'fail', err: m.params.errorText, blocked: m.params.canceled, url: (m.params.requestId) });
      }
    });
    await send('Page.navigate', { url: UI });
    for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs('document.readyState') === 'complete') break; }
    await sleep(800);
    console.log('[cdp] 版本:', await evalJs("document.querySelector('.version') ? document.querySelector('.version').textContent : (document.body.innerHTML.match(/v\\d+ · [\\d-]+/)||['?'])[0]"));

    // 真实搜索
    await evalJs("document.querySelector('#keyword').value = '骇夜'; true");
    await evalJs("document.querySelector('#btnSearch').click(); true");
    // 等搜索完成（按钮文案恢复「搜索」且非加载态）
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const done = await evalJs("document.querySelector('#btnSearch').textContent.indexOf('搜索') >= 0 && !document.querySelector('#searchView .empty-state')");
      if (done) {
        const hasCards = await evalJs("document.querySelectorAll('#searchView .book-card').length");
        if (hasCards > 0) break;
      }
    }
    await sleep(4000);   // 给 lazy img 留加载时间
    const probe = await evalJs(`(function(){
      var cards = document.querySelectorAll('#searchView .book-card');
      var imgs = document.querySelectorAll('#searchView .cover-img');
      var detail = [];
      imgs.forEach(function (im) {
        detail.push({ src: im.src.slice(0, 80), complete: im.complete, nw: im.naturalWidth, loaded: im.classList.contains('loaded') });
      });
      // 第一张卡的封面组内容
      var c0 = cards[0];
      return { cards: cards.length, imgCount: imgs.length, detail: detail.slice(0, 5),
        firstCardHasImg: c0 ? !!c0.querySelector('.cover-img') : null,
        firstCardTitle: c0 ? c0.querySelector('.b-name') && c0.querySelector('.b-name').textContent : '' };
    })()`);
    console.log('[cdp] 封面探针:', JSON.stringify(probe, null, 1));
    console.log('[cdp] 徽标:', await evalJs("var b=document.querySelector('#coverBadge'); b ? b.textContent + ' | class=' + b.className + ' | __stats=' + JSON.stringify(window.__coverStats && { ok: window.__coverStats.ok, fail: window.__coverStats.fail, mounted: window.__coverStats.mounted }) : 'null'"));
    // 视觉可见性验证（2026-10-08 封面被渐变遮挡实锤后新增）：加载成功≠可见，
    // elementFromPoint 命中 img 才证明它画在了渐变背景之上；再抓整页截图人工复核
    const visual = await evalJs(`(function(){
      var im = document.querySelector('#searchView .cover-img.loaded');
      if (!im) return { hit: 'no-loaded-img' };
      var r = im.getBoundingClientRect();
      var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { hit: hit === im ? 'img-topmost' : (hit ? hit.className : 'null'),
        coverZ: getComputedStyle(im.closest('.cover')).zIndex,
        rect: Math.round(r.width) + 'x' + Math.round(r.height) };
    })()`);
    console.log('[cdp] 视觉探针:', JSON.stringify(visual));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(process.env.SHOT || 'tools/_cover-visual.png', Buffer.from(shot.result.data, 'base64'));
    console.log('[cdp] 截图: tools/_cover-visual.png');
    console.log('[cdp] 网络事件(/api/cover):', JSON.stringify(netEvents.slice(0, 12)));
    // 直接在页面里 fetch 一张封面代理，看响应
    const fetchTest = await evalJs(`fetch('/api/cover?u=' + encodeURIComponent('http://api.jmlldsc.com/751/751234.jpg'))
      .then(function (r) { return r.status + ' ' + r.headers.get('content-type'); })
      .catch(function (e) { return 'fetch-fail: ' + e.message; })`);
    console.log('[cdp] 页内代理 fetch:', fetchTest);
  } finally { edge.kill(); }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
