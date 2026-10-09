/**
 * CDP 实测脚本：复现「下载页预览区翻章不回顶」。
 * 流程：headless Edge 打开 8736 → 手动链接解析 mock /book/1/ → 进入目录 → 下载完成
 *       → 激活第 1 章 → 滚到底 → 点「下一章」→ 读 #preview.scrollTop。
 * 只读诊断，不改任何业务代码；书名带 qa- 前缀便于事后清理。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8736);
const MOCK = 'http://127.0.0.1:' + (process.env.MOCK_PORT || 8734);
const DBG = 9290;

function getJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    });
    req.on('error', reject);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DBG}`,
    '--user-data-dir=' + process.env.TEMP + '/cdp-scroll-test',
    '--no-first-run', '--window-size=1400,900', 'about:blank'
  ], { stdio: 'ignore' });

  try {
    // 等 CDP 端口就绪
    let targets = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try { targets = await getJson(`http://127.0.0.1:${DBG}/json`); break; } catch (e) { /* 重试 */ }
    }
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let mid = 0;
    const pend = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++mid;
      pend.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
    async function evalJs(expr, awaitPromise = false) {
      const r = await send('Runtime.evaluate', {
        expression: expr, awaitPromise, returnByValue: true
      });
      if (r.result && r.result.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result && r.result.result ? r.result.result.value : undefined;
    }
    await send('Page.enable');
    await send('Runtime.enable');

    // 打开 UI 并等就绪
    await send('Page.navigate', { url: UI });
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (await evalJs('document.readyState') === 'complete') break;
    }
    await sleep(800);
    const ver = await evalJs("document.querySelector('meta[name=api-token]') ? 'token-ok' : 'no-token'");
    console.log('[cdp] 页面就绪:', ver);

    // ① 手动链接解析 → 进入目录
    await evalJs("document.querySelector('#btnManualToggle').click(); true");
    await evalJs("document.querySelector('#manualUrl').value = '" + MOCK + "/book/1/'; true");
    await evalJs("document.querySelector('#btnParseLink').click(); true");
    // 等解析完成（进入目录按钮出现/可用）
    let startReady = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      startReady = await evalJs("var b=document.querySelector('#btnManualStart'); !!b && !b.disabled && b.offsetParent !== null");
      if (startReady) break;
    }
    if (!startReady) throw new Error('解析未完成，btnManualStart 不可用');
    console.log('[cdp] 解析完成，进入目录');
    await evalJs("document.querySelector('#btnManualStart').click(); true");
    await sleep(1200);

    // ② 开始下载（均衡档默认），等任务完成：下载按钮恢复可用且 pct 稳定
    const startBtn = await evalJs("var b=document.querySelector('#btnStart'); b ? b.id : 'none'");
    console.log('[cdp] 下载按钮:', startBtn);
    await evalJs("document.querySelector('#btnStart').click(); true");
    let done = false;
    let sawRunning = false;
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      done = await evalJs(`(function(){
        var pct = document.querySelector('#pct');
        var run = document.querySelector('#segRun');
        var cancel = document.querySelector('#btnCancelTask');
        var running = cancel && cancel.offsetParent !== null && !cancel.disabled;
        return pct && !running && run && run.style.width === '0%' && pct.textContent.indexOf('%') >= 0;
      })()`);
      // 进度条动态化检查：运行中 .bar 应带 .running 类（sheen 高光带挂载点）
      if (!done && !sawRunning) {
        sawRunning = await evalJs("document.querySelector('#progressBar').classList.contains('running')");
        if (sawRunning) console.log('[cdp] 进度条运行态 .running 类已挂载 ✅');
      }
      if (done) break;
    }
    console.log('[cdp] 下载完成:', done, '| 曾见运行态:', sawRunning);
    if (!done) throw new Error('下载未在超时内完成');

    // ③ 激活第 1 个已下载章 → 滚到底 → 点下一章 → 量 scrollTop
    await evalJs(`(function(){
      var rows = document.querySelectorAll('#chapterList .chapter-row');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute('data-n')) { rows[i].click(); return 'clicked n=' + rows[i].getAttribute('data-n'); }
      }
      return 'no-row';
    })()`);
    await sleep(1200);
    await evalJs("var p=document.querySelector('#preview'); p.scrollTop = p.scrollHeight; true");
    await sleep(300);
    const before = await evalJs(`(function(){
      var p = document.querySelector('#preview');
      var m = document.querySelector('.main');
      var cs = m ? getComputedStyle(m) : {};
      var info = { scrollTop: p.scrollTop, scrollHeight: p.scrollHeight, clientHeight: p.clientHeight,
        mainH: cs.height, mainDisplay: cs.display, mainRows: cs.gridTemplateRows,
        winH: window.innerHeight,
        docScroll: document.scrollingElement.scrollTop, docScrollH: document.scrollingElement.scrollHeight,
        docClientH: document.scrollingElement.clientHeight };
      var el = p, chain = [];
      while (el && el !== document.body) {
        if (el.scrollHeight > el.clientHeight + 2) chain.push((el.id || el.className) + ':' + el.scrollTop + '/' + el.scrollHeight);
        el = el.parentElement;
      }
      info.overflowChain = chain;
      return info;
    })()`);
    console.log('[cdp] 翻章前(滚到底):', JSON.stringify(before));
    await evalJs("document.querySelector('#btnNextCh').click(); true");
    await sleep(1500);
    const after = await evalJs(`(function(){
      var p = document.querySelector('#preview');
      return { scrollTop: p.scrollTop, scrollHeight: p.scrollHeight, clientHeight: p.clientHeight,
        firstText: (p.querySelector('h2')||{}).textContent || '' };
    })()`);
    console.log('[cdp] 翻章后:', JSON.stringify(after));
    const verdict = after.scrollTop < 5 ? '✅ 回顶生效' : '❌ 复现：翻章后停留在 ' + after.scrollTop + 'px（未回顶）';
    console.log('[cdp] 结论:', verdict);

    // ④ 同样测底部「下一章 ›」按钮路径
    await evalJs("var p=document.querySelector('#preview'); p.scrollTop = p.scrollHeight; true");
    await sleep(200);
    await evalJs(`(function(){
      var btns = document.querySelectorAll('#preview .reader-foot button');
      btns[btns.length - 1].click(); return true;
    })()`);
    await sleep(1500);
    const after2 = await evalJs(`(function(){
      var p = document.querySelector('#preview');
      return { scrollTop: p.scrollTop };
    })()`);
    console.log('[cdp] 底部翻章条路径 scrollTop:', after2.scrollTop, after2.scrollTop < 5 ? '✅' : '❌ 未回顶');
  } finally {
    edge.kill();
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
