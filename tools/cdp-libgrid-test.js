/**
 * CDP 书架管理模式验证（2026-10-08，番茄书架式交互重做）：
 * 默认零选择干扰 → 进管理模式出勾圈 → 点卡选中 → 全选 → 退出清空。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8737);
const DBG = 9294;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DBG}`,
    '--user-data-dir=' + process.env.TEMP + '/cdp-libmanage-test',
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
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: UI });
    for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs('document.readyState') === 'complete') break; }
    await sleep(600);
    await evalJs("document.querySelector('#btnNavLibrary').click(); true");
    await sleep(1200);
    await evalJs("document.querySelector('#btnLibGridView').click(); true");
    await sleep(600);
    // ① 默认态：无勾圈、无 checkbox、批量按钮不可见
    const idle = await evalJs(`(function(){
      return { cards: document.querySelectorAll('#libraryList .lib-card').length,
        picks: document.querySelectorAll('#libraryList .lib-pick').length,
        cks: document.querySelectorAll('#libraryList .lib-check').length,
        zoneShown: document.querySelector('#libManageZone').style.display !== 'none',
        manageText: document.querySelector('#btnLibManage').textContent };
    })()`);
    console.log('[cdp] 默认态:', JSON.stringify(idle));
    // ② 进入管理模式
    await evalJs("document.querySelector('#btnLibManage').click(); true");
    await sleep(400);
    const manage = await evalJs(`(function(){
      return { picks: document.querySelectorAll('#libraryList .lib-pick').length,
        zoneShown: document.querySelector('#libManageZone').style.display !== 'none',
        manageText: document.querySelector('#btnLibManage').textContent };
    })()`);
    console.log('[cdp] 管理模式:', JSON.stringify(manage));
    // ③ 点第一张卡选中（不应触发阅读）
    const sel = await evalJs(`(function(){
      document.querySelector('#libraryList .lib-card').click();
      var s = document.querySelectorAll('#libraryList .lib-card.selecting').length;
      var delBtn = document.querySelector('#btnLibDeleteBatch');
      return { selecting: s, delText: delBtn ? delBtn.textContent.trim() : null,
        readerOpen: !!document.querySelector('#readerMask.show') };
    })()`);
    console.log('[cdp] 点卡选中:', JSON.stringify(sel));
    // ④ 全选
    const selAll = await evalJs(`(function(){
      var sa = document.querySelector('#libSelectAll');
      sa.checked = true; sa.dispatchEvent(new Event('change'));
      return document.querySelectorAll('#libraryList .lib-card.selecting').length;
    })()`);
    console.log('[cdp] 全选选中卡数:', selAll);
    const shot1 = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync('tools/_libmanage-visual.png', Buffer.from(shot1.result.data, 'base64'));
    // ⑤ 退出管理模式
    await evalJs("document.querySelector('#btnLibManage').click(); true");
    await sleep(400);
    const exit = await evalJs(`(function(){
      return { picks: document.querySelectorAll('#libraryList .lib-pick').length,
        selecting: document.querySelectorAll('#libraryList .lib-card.selecting').length,
        zoneShown: document.querySelector('#libManageZone').style.display !== 'none',
        manageText: document.querySelector('#btnLibManage').textContent };
    })()`);
    console.log('[cdp] 退出管理:', JSON.stringify(exit));
    console.log('[cdp] 截图: tools/_libmanage-visual.png');
  } finally { edge.kill(); }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
