/**
 * CDP 波奇主题目检截图（2026-10-09，v60）：
 * 切 bocchi 主题截搜索页 + 书架页，验证壁纸叠纱可读性与令牌生效。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8735);
const DBG = 9297;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DBG}`,
    '--user-data-dir=' + process.env.TEMP + '/cdp-bocchi-theme',
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
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result && r.result.result ? r.result.result.value : undefined;
    }
    async function shot(name) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync('tools/' + name, Buffer.from(r.result.data, 'base64'));
      console.log('[cdp] 截图 tools/' + name);
    }
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: UI });
    for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs('document.readyState') === 'complete') break; }
    await sleep(800);
    // 切波奇主题（走真实入口 applyTheme）
    await evalJs("localStorage.setItem('nd-theme','bocchi'); location.reload(); true");
    for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs('document.readyState') === 'complete') break; }
    await sleep(1200);
    const check = await evalJs(`(function(){
      var cs = getComputedStyle(document.documentElement);
      var bf = getComputedStyle(document.body, '::before');
      return { theme: document.documentElement.getAttribute('data-theme'),
        accent: cs.getPropertyValue('--accent').trim(),
        bg0: cs.getPropertyValue('--bg-0').trim(),
        hasWall: bf.backgroundImage.indexOf('bocchi-bg') >= 0,
        btnLabel: document.querySelector('#btnTheme').textContent };
    })()`);
    console.log('[cdp] 主题状态:', JSON.stringify(check));
    await shot('_v60-bocchi-search.png');
    // 书架页
    await evalJs("document.querySelector('#btnNavLibrary').click(); true");
    await sleep(1200);
    await shot('_v60-bocchi-library.png');
    ws.close();
  } finally {
    edge.kill();
  }
}
main().catch((e) => { console.error('[cdp] 失败:', e.message); process.exit(1); });
