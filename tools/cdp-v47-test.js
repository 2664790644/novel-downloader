/**
 * <p>CDP v47 验证：搜索历史自绘下拉（替换原生 datalist）。</p>
 * <p>①聚焦唤起下拉（条目=历史数）②输入过滤 ③↑ 高亮回填 ④点击条目即搜 ⑤清空按钮 ⑥截图留证</p>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8736);
const DBG = 9313;
const SHOT = __dirname + '/_v47-drop.png';
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, '--user-data-dir=' + process.env.TEMP + '/cdp-v47-test', '--no-first-run', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
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
    // 预置搜索历史（模拟老用户存量数据）
    await evalJs(`localStorage.setItem('nd-kwhistory', JSON.stringify(['夜无过失期','我不是戏神',' race to 不朽','阔别到天明时份','仙道尽头'])); true`);

    // ① 聚焦唤起（无头下 el.focus() 不派发 focus 事件——显式派发模拟真实点击聚焦）
    const r1 = await evalJs(`(function(){
      var kw = document.querySelector('#keyword');
      kw.dispatchEvent(new Event('focus'));
      return new Promise(function (res) {
        setTimeout(function () {
          var drop = document.querySelector('#kwDrop');
          var items = drop.querySelectorAll('.kw-item');
          res({ hidden: drop.hidden, items: items.length,
            head: !!(drop.querySelector('.kw-head')),
            clearBtn: !!document.querySelector('#btnKwClearAll'),
            firstTxt: items[0] && items[0].querySelector('.kw-txt').textContent });
        }, 400);
      });
    })()`);
    console.log('[1] 聚焦唤起:', JSON.stringify(r1));

    // ② 输入过滤（「我」应只剩「我不是戏神」）
    const r2 = await evalJs(`(function(){
      var kw = document.querySelector('#keyword');
      kw.value = '我';
      kw.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise(function (res) {
        setTimeout(function () {
          var drop = document.querySelector('#kwDrop');
          var items = [...drop.querySelectorAll('.kw-item')];
          res({ hidden: drop.hidden, items: items.length, texts: items.map(function (x) { return x.querySelector('.kw-txt').textContent; }) });
        }, 300);
      });
    })()`);
    console.log('[2] 输入过滤:', JSON.stringify(r2));

    // ③ 清空输入回全量 + ↑ 高亮回填
    const r3 = await evalJs(`(function(){
      var kw = document.querySelector('#keyword');
      kw.value = '';
      kw.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise(function (res) {
        setTimeout(function () {
          kw.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
          setTimeout(function () {
            var act = document.querySelector('.kw-item.kw-active');
            res({ inputVal: kw.value, activeTxt: act && act.querySelector('.kw-txt').textContent,
              clearShown: document.querySelector('#btnClearKw').style.display !== 'none' });
          }, 200);
        }, 300);
      });
    })()`);
    console.log('[3] ↓高亮回填:', JSON.stringify(r3));

    // ④ 点击条目即搜（触发 doSearch：搜索态变化/结果区渲染）
    const r4 = await evalJs(`(function(){
      return new Promise(function (res) {
        var it = document.querySelectorAll('#kwDrop .kw-item')[1];
        var kwBefore = it ? it.dataset.kw : '';
        if (it) it.click();
        setTimeout(function () {
          var drop = document.querySelector('#kwDrop');
          var kw = document.querySelector('#keyword');
          // doSearch 会发起 /api/search，搜素中 btnSearch 文案仍是「搜索」但 searchLoading 内部态——
          // 用可观测信号：hero 收起（结果视图切换）或输入框值=条目词
          res({ kwBefore: kwBefore, kwNow: kw.value, dropClosed: drop.hidden,
            heroCollapsed: document.querySelector('#hero').classList.contains('collapsed') });
        }, 1200);
      });
    })()`);
    console.log('[4] 点击即搜:', JSON.stringify(r4));

    // ⑤ 清空按钮（重开下拉 → 点清空 → localStorage 空）
    const r5 = await evalJs(`(function(){
      return new Promise(function (res) {
        var kw = document.querySelector('#keyword');
        kw.value = ''; kw.dispatchEvent(new Event('input', { bubbles: true })); kw.focus();
        setTimeout(function () {
          var btn = document.querySelector('#btnKwClearAll');
          if (btn) btn.click();
          setTimeout(function () {
            res({ historyAfter: JSON.parse(localStorage.getItem('nd-kwhistory') || '[]').length,
              dropClosed: document.querySelector('#kwDrop').hidden });
          }, 300);
        }, 400);
      });
    })()`);
    console.log('[5] 清空历史:', JSON.stringify(r5));

    // ⑥ 截图：重新预置历史 + 聚焦展开下拉
    await evalJs(`localStorage.setItem('nd-kwhistory', JSON.stringify(['夜无过失期','我不是戏神','阔别到天明时份','仙道尽头'])); document.querySelector('#keyword').value=''; document.querySelector('#keyword').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#keyword').focus(); true`);
    await sleep(700);
    const shotMsg = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const shot = shotMsg.result || {};   // send 返回整个 CDP message，data 在 result 里
    if (!shot.data) { console.log('[6] 截图原始响应:', JSON.stringify(shotMsg).slice(0, 300)); throw new Error('截图无数据'); }
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('[6] 截图:', SHOT, fs.statSync(SHOT).size, 'bytes');
    console.log('[cdp] JS 异常:', errs.length ? errs.join(' | ') : '无');
  } finally {
    try { edge.kill(); } catch (e) {}
  }
}
main().catch((e) => { console.error('[cdp] 失败:', e.message); process.exit(1); });
