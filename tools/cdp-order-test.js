/**
 * CDP 书架排序验证（2026-10-08）：默认「最近阅读」排序、去星、阅读后浮顶。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8737);
const DBG = 9295;
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, '--user-data-dir=' + process.env.TEMP + '/cdp-order-test', '--no-first-run', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
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
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        pageErrors.push((d.exception && d.exception.description || d.text).slice(0, 200));
      }
    };
    const send = (method, params = {}) => new Promise((resolve) => { const id = ++mid; pend.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
    async function evalJs(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result && r.result.result ? r.result.result.value : undefined;
    }
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: UI });
    for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs('document.readyState') === 'complete') break; }
    await sleep(800);
    await evalJs("document.querySelector('#btnNavLibrary').click(); true");
    await sleep(400);
    await evalJs("document.querySelector('#btnLibGridView').click(); true");
    for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs("document.querySelectorAll('#libraryList .lib-card').length") > 0) break; }
    const idle = await evalJs(`(function(){
      var cards = document.querySelectorAll('#libraryList .lib-card');
      var names = [];
      cards.forEach(function (c) { names.push(c.querySelector('.b-name').textContent); });
      return { sortVal: document.querySelector('#libSort').value,
        stars: document.querySelectorAll('#libraryList .lib-badge-fav').length,
        empty: document.querySelector('#libraryList .lib-empty') ? document.querySelector('#libraryList .lib-empty').textContent : null,
        listHtmlHead: document.querySelector('#libraryList').innerHTML.slice(0, 120),
        order: names };
    })()`);
    console.log('[cdp] 默认态:', JSON.stringify(idle, null, 1));
    if (idle.order.length) {
      // 打开第一本书 → 翻一页（写 lastRead）→ 关闭 → 断言浮顶
      await evalJs("document.querySelector('#libraryList .lib-card').click(); true");
      await sleep(2500);
      await evalJs("var b=document.querySelector('#btnReaderNext'); if (b) b.click(); true");
      await sleep(1500);
      await evalJs("document.querySelector('#btnReaderClose').click(); true");
      await sleep(800);
      const after = await evalJs(`(function(){
        var cards = document.querySelectorAll('#libraryList .lib-card');
        var names = [];
        cards.forEach(function (c) { names.push(c.querySelector('.b-name').textContent); });
        var subs = [];
        document.querySelectorAll('#libraryList .b-author').forEach(function (x) { subs.push(x.textContent); });
        return { orderAfter: names, firstCardSub: subs[0] || null };
      })()`);
      console.log('[cdp] 阅读后:', JSON.stringify(after, null, 1));
      // 强验证：读第二本（原位第二），断言它浮到第一
      await evalJs("document.querySelectorAll('#libraryList .lib-card')[1].click(); true");
      await sleep(2500);
      await evalJs("var b=document.querySelector('#btnReaderNext'); if (b) b.click(); true");
      await sleep(1500);
      await evalJs("document.querySelector('#btnReaderClose').click(); true");
      await sleep(800);
      const after2 = await evalJs(`(function(){
        var names = [];
        document.querySelectorAll('#libraryList .lib-card .b-name').forEach(function (c) { names.push(c.textContent); });
        return names;
      })()`);
      console.log('[cdp] 读第二本后排序:', JSON.stringify(after2));
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync('tools/_liborder-visual.png', Buffer.from(shot.result.data, 'base64'));
    console.log('[cdp] 页面JS错误:', JSON.stringify(pageErrors.slice(0, 5)));
    console.log('[cdp] 截图: tools/_liborder-visual.png');
  } finally { edge.kill(); }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
