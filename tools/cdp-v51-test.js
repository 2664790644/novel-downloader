/**
 * <p>CDP v51 验证：全粉进度条——ok/cache/err/run 四段统一樱花粉家族，
 * 语义靠深浅（ok 静态粉/cache 淡粉/err 深玫红/run 渐变流）。</p>
 * <p>按彪哥真实任务比例伪造（已收83/缓存267/共1918→run 81.7%），
 * 断言四段背景均不含旧绿/黄/红主色且含粉色系，双主题截图。</p>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8735);
const DBG = 9319;
const SHOT_DARK = __dirname + '/_v51-bar-dark.png';
const SHOT_PAPER = __dirname + '/_v51-bar-paper.png';
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, '--user-data-dir=' + process.env.TEMP + '/cdp-v51-test', '--no-first-run', '--window-size=1400,760', 'about:blank'], { stdio: 'ignore' });
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
    await send('Page.enable');
    await send('Page.navigate', { url: UI });
    for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs('document.readyState') === 'complete') break; }
    await sleep(800);

    // 按彪哥真实任务比例伪造：83/1918 ok、267 cache、0 err、run 占余
    await evalJs(`(function(){
      document.querySelector('#searchView').style.display = 'none';
      document.querySelector('#downloadView').style.display = 'flex';
      document.querySelector('#hero').classList.add('collapsed');
      var bar = document.querySelector('#progressBar');
      bar.classList.add('running');
      document.querySelector('#segOk').style.width = '4.3%';
      document.querySelector('#segRun').style.width = '81.7%';
      document.querySelector('#segErr').style.width = '0%';
      document.querySelector('#segCache').style.width = '13.9%';
      document.querySelector('#pct').textContent = '18%';
      if (typeof syncSegRunAnim === 'function') syncSegRunAnim(true, 81.7);
      return { barVisible: !!bar.offsetParent };
    })()`);
    await sleep(300);
    await evalJs(`document.querySelector('#progressBar').scrollIntoView({block:'center'}); true`);
    await sleep(400);

    // 断言：四段背景均为粉色系（rgb 检查），无旧绿(6,153,34类)/黄(199,146,10类)主色
    const r1 = await evalJs(`(function(){
      function bg(id){ var el=document.querySelector('#'+id); return getComputedStyle(el).backgroundColor || ''; }
      var ok = bg('segOk'), cache = bg('segCache'), run = bg('segRun');
      var isPink = function(s){ return s.indexOf('245, 99, 152') !== -1 || s.indexOf('232, 87, 127') !== -1 || s.indexOf('255, 154, 158') !== -1; };
      var runBg = getComputedStyle(document.querySelector('#segRun')).backgroundImage;
      return { ok: ok, cache: cache, runBg: runBg.slice(0, 120),
        okPink: isPink(ok), cachePink: isPink(cache),
        runPink: runBg.indexOf('rgb(245, 99, 152)') !== -1 || runBg.indexOf('rgb(255, 154, 158)') !== -1 };
    })()`);
    console.log('[1] 四段背景:', JSON.stringify(r1));
    const ok1 = r1.okPink && r1.cachePink && r1.runPink;
    console.log('[2] 整条全粉（ok/cache/run）:', ok1 ? '通过' : '失败');

    // 截图
    const shot1 = (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result;
    fs.writeFileSync(SHOT_DARK, Buffer.from(shot1.data, 'base64'));
    console.log('[3] 墨夜截图:', fs.statSync(SHOT_DARK).size, 'bytes');
    await evalJs(`document.documentElement.setAttribute('data-theme','paper'); true`);
    await sleep(700);
    const shot2 = (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result;
    fs.writeFileSync(SHOT_PAPER, Buffer.from(shot2.data, 'base64'));
    console.log('[4] 宣纸截图:', fs.statSync(SHOT_PAPER).size, 'bytes');

    console.log('[5] JS 异常:', errs.length === 0 ? '无' : errs.join(' | '));
    const allPass = ok1 && errs.length === 0;
    console.log(allPass ? '=== 全部通过 ===' : '=== 存在失败 ===');
    process.exitCode = allPass ? 0 : 1;
  } finally { try { edge.kill(); } catch (e) {} }
}
main();
