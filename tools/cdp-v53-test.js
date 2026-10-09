/**
 * <p>CDP v53 验证：进度条语义反转——粉色渐变流只跟「已收部分」（ok+cache 段），
 * 剩余段（run）透明还原中性轨道，进度多少亮多少。</p>
 * <p>按彪哥真实任务比例伪造（18% 完成：ok 4.3% + cache 13.9%，run 81.7%），
 * 断言 ①segRun 无任何背景（空轨道）②segOk/segCache 樱花粉渐变 ③running 下流动动画在
 * ④页面进度条实际着色宽度≈18%（不是 100%）⑤双主题截图</p>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8735);
const DBG = 9320;
const SHOT_DARK = __dirname + '/_v53-bar-dark.png';
const SHOT_PAPER = __dirname + '/_v53-bar-paper.png';
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, '--user-data-dir=' + process.env.TEMP + '/cdp-v53-test', '--no-first-run', '--window-size=1400,760', 'about:blank'], { stdio: 'ignore' });
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

    // 伪造 18% 完成运行态
    await evalJs(`(function(){
      document.querySelector('#searchView').style.display = 'none';
      document.querySelector('#downloadView').style.display = 'flex';
      document.querySelector('#hero').classList.add('collapsed');
      document.querySelector('#segOk').style.width = '4.3%';
      document.querySelector('#segRun').style.width = '81.7%';
      document.querySelector('#segErr').style.width = '0%';
      document.querySelector('#segCache').style.width = '13.9%';
      document.querySelector('#pct').textContent = '18%';
      document.querySelector('#progressBar').classList.add('running');
      return true;
    })()`);
    await sleep(300);
    await evalJs(`document.querySelector('#progressBar').scrollIntoView({block:'center'}); true`);
    await sleep(400);

    const r1 = await evalJs(`(function(){
      function st(id){ return getComputedStyle(document.querySelector('#'+id)); }
      var run = st('segRun'), ok = st('segOk'), cache = st('segCache');
      var bar = document.querySelector('#progressBar');
      var barW = bar.getBoundingClientRect().width;
      var okW = document.querySelector('#segOk').getBoundingClientRect().width;
      var cacheW = document.querySelector('#segCache').getBoundingClientRect().width;
      var pinkGrad = 'linear-gradient(90deg, rgb(255, 154, 158), rgb(245, 99, 152) 50%, rgb(255, 154, 158))';
      return {
        runBgEmpty: run.backgroundImage === 'none' && (run.backgroundColor === 'rgba(0, 0, 0, 0)'),
        okPink: ok.backgroundImage.indexOf('rgb(245, 99, 152)') !== -1,
        cachePink: cache.backgroundImage.indexOf('rgb(245, 99, 152)') !== -1,
        coloredRatio: +(((okW + cacheW) / barW) * 100).toFixed(1),
        anims: (document.querySelector('#segOk').getAnimations ? document.querySelector('#segOk').getAnimations().length : -1),
        cssAnim: ok.animationName
      };
    })()`);
    console.log('[1] 断言:', JSON.stringify(r1));
    const ok1 = r1.runBgEmpty;
    const ok2 = r1.okPink && r1.cachePink;
    const ok3 = r1.coloredRatio <= 19;   // 着色宽度≈18%，绝不是 100%
    const ok4 = r1.anims >= 1 || r1.cssAnim === 'flow';
    console.log('[2] run 段空轨道（无底色）:', ok1 ? '通过' : '失败');
    console.log('[3] 已收段樱花粉渐变:', ok2 ? '通过' : '失败');
    console.log('[4] 着色宽度=18%（非铺满）:', ok3 ? '通过 (' + r1.coloredRatio + '%)' : '失败 (' + r1.coloredRatio + '%)');
    console.log('[5] 下载中流动动画:', ok4 ? '通过' : '失败');

    const shot1 = (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result;
    fs.writeFileSync(SHOT_DARK, Buffer.from(shot1.data, 'base64'));
    console.log('[6] 墨夜截图:', fs.statSync(SHOT_DARK).size, 'bytes');
    await evalJs(`document.documentElement.setAttribute('data-theme','paper'); true`);
    await sleep(700);
    const shot2 = (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result;
    fs.writeFileSync(SHOT_PAPER, Buffer.from(shot2.data, 'base64'));
    console.log('[7] 宣纸截图:', fs.statSync(SHOT_PAPER).size, 'bytes');

    console.log('[8] JS 异常:', errs.length === 0 ? '无' : errs.join(' | '));
    const allPass = ok1 && ok2 && ok3 && ok4 && errs.length === 0;
    console.log(allPass ? '=== 全部通过 ===' : '=== 存在失败 ===');
    process.exitCode = allPass ? 0 : 1;
  } finally { try { edge.kill(); } catch (e) {} }
}
main();
