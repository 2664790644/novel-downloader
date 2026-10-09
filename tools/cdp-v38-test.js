/**
 * CDP v38 三功能验证：①书架继续阅读横幅 ②分组栏 chips ③阅读器换源弹层。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8737);
const DBG = 9296;
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, '--user-data-dir=' + process.env.TEMP + '/cdp-v38-test', '--no-first-run', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
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
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result && r.result.result ? r.result.result.value : undefined;
    }
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: UI });
    for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs('document.readyState') === 'complete') break; }
    await sleep(800);
    // ① 书架：继续阅读横幅 + 分组栏
    await evalJs("document.querySelector('#btnNavLibrary').click(); true");
    for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs("document.querySelectorAll('#libraryList .lib-card, #libraryList .lib-row').length") > 0) break; }
    const lib = await evalJs(`(function(){
      var cont = document.querySelector('#libContinue');
      return { bannerShown: cont && cont.style.display !== 'none',
        bannerName: document.querySelector('#lcName') ? document.querySelector('#lcName').textContent : null,
        bannerMeta: document.querySelector('#lcMeta') ? document.querySelector('#lcMeta').textContent : null,
        groupsShown: document.querySelector('#libGroups').style.display !== 'none',
        groupChips: [...document.querySelectorAll('#libGroups .chip')].map(function (c) { return c.textContent; }) };
    })()`);
    console.log('[cdp] 横幅+分组:', JSON.stringify(lib, null, 1));
    // ② 阅读器打开 → 换源弹层
    await evalJs("document.querySelector('#btnLibContinue').click(); true");
    await sleep(2500);
    await evalJs("document.querySelector('#btnReaderSource').click(); true");
    await sleep(1500);
    const pick = await evalJs(`(function(){
      return { maskShown: document.querySelector('#srcPickMask').style.display !== 'none',
        sources: [...document.querySelectorAll('#srcPickList button')].map(function (b) { return b.textContent; }).slice(0, 12) };
    })()`);
    console.log('[cdp] 换源弹层:', JSON.stringify(pick));
    // ③ 取消关闭
    await evalJs("document.querySelector('#btnSrcPickClose').click(); true");
    await sleep(400);
    await evalJs("document.querySelector('#btnReaderClose').click(); true");
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync('tools/_v38-visual.png', Buffer.from(shot.result.data, 'base64'));
    console.log('[cdp] 页面JS错误:', JSON.stringify(pageErrors.slice(0, 5)));
    console.log('[cdp] 截图: tools/_v38-visual.png');
  } finally { edge.kill(); }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
