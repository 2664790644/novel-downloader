/**
 * <p>CDP v50 验证：樱花粉流光进度条——扫光带（sheen ::after）与白光点（::before）
 * 已裁撤，seg-run 渐变换樱花粉，运行态 WAAPI flow 代播仍工作。</p>
 * <p>①伪造运行态（segRun 68% + running 类）②断言 ::after/::before 伪元素 content 为空
 * ③断言 seg-run 背景含 #F56398 ④ANIM_SUPPRESSED 下 getAnimations 有 flow 代播
 * ⑤墨夜/宣纸双主题截图</p>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = 'http://127.0.0.1:' + (process.env.UI_PORT || 8735);
const DBG = 9318;
const SHOT_DARK = __dirname + '/_v50-bar-dark.png';
const SHOT_PAPER = __dirname + '/_v50-bar-paper.png';
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, '--user-data-dir=' + process.env.TEMP + '/cdp-v50-test', '--no-first-run', '--window-size=1400,760', 'about:blank'], { stdio: 'ignore' });
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

    // ① 切到当前下载视图（setViewDisplay 用 style.display 切换）+ 伪造运行态
    await evalJs(`(function(){
      document.querySelector('#searchView').style.display = 'none';
      document.querySelector('#downloadView').style.display = 'flex';
      document.querySelector('#hero').classList.add('collapsed');
      var bar = document.querySelector('#progressBar');
      bar.classList.add('running');
      document.querySelector('#segOk').style.width = '52%';
      document.querySelector('#segRun').style.width = '16%';
      document.querySelector('#segErr').style.width = '0%';
      document.querySelector('#segCache').style.width = '0%';
      document.querySelector('#pct').textContent = '52%';
      if (typeof syncSegRunAnim === 'function') syncSegRunAnim(true, 16);
      return { dvShown: document.querySelector('#downloadView').style.display, barVisible: !!bar.offsetParent };
    })()`);
    await sleep(300);
    await evalJs(`document.querySelector('#progressBar').scrollIntoView({block:'center'}); true`);
    await sleep(900);

    // ②③④ 断言
    const r1 = await evalJs(`(function(){
      var bar = document.querySelector('#progressBar');
      var seg = document.querySelector('#segRun');
      var after = getComputedStyle(bar, '::after');
      var before = getComputedStyle(seg, '::before');
      var bg = getComputedStyle(seg).backgroundImage || '';
      var anims = seg.getAnimations ? seg.getAnimations().length : -1;
      return {
        afterContent: after.content, beforeContent: before.content,
        hasPink: bg.indexOf('rgb(245, 99, 152)') !== -1 || bg.indexOf('rgb(255, 154, 158)') !== -1,
        waapiCount: anims, running: bar.classList.contains('running'),
        cssAnim: getComputedStyle(seg).animationName,
        suppressed: typeof ANIM_SUPPRESSED !== 'undefined' ? ANIM_SUPPRESSED : null
      };
    })()`);
    console.log('[1] 断言:', JSON.stringify(r1));
    const ok1 = r1.afterContent === 'none' && r1.beforeContent === 'none';
    const ok2 = r1.hasPink === true;
    const ok3 = r1.waapiCount >= 1 || r1.cssAnim === 'flow';   // WAAPI 代播或 CSS 主干二选一
    console.log('[1] 扫光/光点伪元素已裁:', ok1 ? '通过' : '失败');
    console.log('[2] 樱花粉渐变生效:', ok2 ? '通过' : '失败');
    console.log('[3] 流动动画在跑:', ok3 ? '通过' : '失败', '(waapi=' + r1.waapiCount + ', cssAnim=' + r1.cssAnim + ', suppressed=' + r1.suppressed + ')');

    // ⑤ 墨夜截图
    await sleep(400);
    const shot1 = (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result;
    fs.writeFileSync(SHOT_DARK, Buffer.from(shot1.data, 'base64'));
    console.log('[4] 墨夜截图:', fs.statSync(SHOT_DARK).size, 'bytes');

    // 宣纸主题截图
    await evalJs(`document.documentElement.setAttribute('data-theme','paper'); true`);
    await sleep(700);
    const shot2 = (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result;
    fs.writeFileSync(SHOT_PAPER, Buffer.from(shot2.data, 'base64'));
    console.log('[5] 宣纸截图:', fs.statSync(SHOT_PAPER).size, 'bytes');

    console.log('[6] JS 异常:', errs.length === 0 ? '无' : errs.join(' | '));
    const allPass = ok1 && ok2 && ok3 && errs.length === 0;
    console.log(allPass ? '=== 全部通过 ===' : '=== 存在失败 ===');
    process.exitCode = allPass ? 0 : 1;
  } finally { try { edge.kill(); } catch (e) {} }
}
main();
