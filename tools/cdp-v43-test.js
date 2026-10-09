/**
 * CDP v43 验证：对称摊书动画（书脊居中、书缩到真实比例）。采样飞行/翻页/摊开停顿/
 * 清场四点 + 中间帧截图人工复核；关书反向。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8735);
const DBG = 9306;
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, '--user-data-dir=' + process.env.TEMP + '/cdp-v43-test', '--no-first-run', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
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
    // 开书：点阅读 → 500ms 截翻页中帧
    await evalJs(`(function(){
      var btns = [...document.querySelectorAll('#libraryList .lib-actions button')];
      var rb = btns.find(function (b) { return b.textContent.indexOf('阅读') >= 0; });
      if (rb) rb.click(); return true;
    })()`);
    await sleep(480);
    const midFlip = await evalJs(`(function(){
      var w = document.querySelector('.reader-flip');
      if (!w) return { stage: false };
      var r = w.getBoundingClientRect();
      return { stage: true, w: Math.round(r.width), h: Math.round(r.height),
        under: !!w.querySelector('[style*="left:-100%"]'),
        flipperStyle: (w.lastElementChild.style.transform || '') };
    })()`);
    const shot1 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('tools/_v43-midflip.png', Buffer.from(shot1.result.data, 'base64'));
    console.log('[cdp] 翻页中480ms:', JSON.stringify(midFlip));
    // 760ms 摊开停顿帧
    await sleep(280);
    const openPose = await evalJs(`(function(){
      var w = document.querySelector('.reader-flip');
      var f = w && w.lastElementChild;
      return { stage: !!w, flipAt: f ? (f.style.transform || getComputedStyle(f).transform).slice(0, 40) : null };
    })()`);
    const shot2 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('tools/_v43-openpose.png', Buffer.from(shot2.result.data, 'base64'));
    console.log('[cdp] 摊开760ms:', JSON.stringify(openPose));
    await sleep(500);
    const cleaned = await evalJs(`({ stageGone: !document.querySelector('.reader-flip'),
      readerShown: document.querySelector('#readerMask').style.display !== 'none' })`);
    console.log('[cdp] 清场后:', JSON.stringify(cleaned));
    // 关书：采样起步 + 终态
    const close = await evalJs(`(function(){
      return new Promise(function (res) {
        document.querySelector('#btnReaderClose').click();
        setTimeout(function () {
          var w = document.querySelector('.reader-flip');
          res({ stage: !!w, flipStyle: !!(w && (w.lastElementChild.style.transform || '').indexOf('rotateY') >= 0) });
        }, 120);
        setTimeout(function () {
          res.stageGone = !document.querySelector('.reader-flip');
          res.maskHidden = document.querySelector('#readerMask').style.display === 'none';
        }, 1250);
      });
    })()`);
    await sleep(700);
    const fin = await evalJs(`({ stageGone: !document.querySelector('.reader-flip'),
      maskHidden: document.querySelector('#readerMask').style.display === 'none' })`);
    console.log('[cdp] 关书起步120ms:', JSON.stringify(close), '终态:', JSON.stringify(fin));
    console.log('[cdp] 页面JS错误:', JSON.stringify(errs.slice(0, 5)));
  } finally { edge.kill(); }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
