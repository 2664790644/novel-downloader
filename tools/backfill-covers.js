/**
 * <p>存量书架补封面（2026-10-08）：v31 之前下载的书没有 coverUrl（引擎当时不抓封面），
 * 书架只剩渐变底。本脚本扫 outputRoot/output/ 下各书目录，对 coverUrl 为空且无本地
 * cover.* 的书，用书名（目录名首个 '-' 之后）调引擎 searchBook 全源搜索，取书名匹配
 * 结果的首个封面地址写回 book.json（无 book.json 的历史书补建，tocUrl 留空不可追更）。
 *
 * 用法：
 *   node tools/backfill-covers.js [outputRoot]
 *   缺省 outputRoot = 项目根（开发态数据）；传 dist 则处理 exe 侧数据（dist/output）
 *
 * 注意：运行中的 exe 与本脚本并发写 book.json 理论上可能互覆（最后写赢），
 * 建议先退出 exe 再跑。封面死链（如 cread 部分书目）无解，写回前不校验图片可达性——
 * 书架 /api/cover 代理失败时自动回退渐变，无副作用。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const engine = require('../novel-downloader.js');

const root = path.resolve(process.argv[2] || __dirname + '/..');
const libDir = path.join(root, 'output');
if (!fs.existsSync(libDir)) { console.error(`目录不存在: ${libDir}`); process.exit(1); }

// ---- 书源加载：与 web-ui.js 同口径（内置 JSON 源 + 用户导入源） ----
const sources = engine.loadBookSources(path.join(__dirname, '..', 'book-source.json'));
for (const f of [path.join(root, 'user-book-sources.json'), path.join(__dirname, '..', 'output', 'user-book-sources.json')]) {
  try {
    const arr = JSON.parse(fs.readFileSync(f, 'utf8')).bookSources || [];
    for (const lg of arr) {
      if (sources.some((s) => s.bookSourceName === lg.bookSourceName && s.bookSourceUrl === lg.bookSourceUrl)) continue;
      const w = engine.legadoAdapter.wrapLegado(lg);
      if (w) sources.push(w);
    }
    break;
  } catch (e) { /* 该位置无用户源文件 */ }
}
const candidates = sources.filter((s) => s.enabled !== false && s.searchUrl);
console.log(`[补封面] outputRoot=${root}，可用源 ${candidates.length}/${sources.length}`);

// 书名匹配：双向包含（搜索结果常带副标题/书名号差异），均去空白后比较
function nameMatch(a, b) {
  const x = String(a || '').replace(/\s/g, '');
  const y = String(b || '').replace(/\s/g, '');
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

async function main() {
  const dirs = fs.readdirSync(libDir).filter((d) => {
    const full = path.join(libDir, d);
    return fs.statSync(full).isDirectory() && d !== '_回收站';
  });
  let fixed = 0, skipped = 0, miss = 0;
  for (const d of dirs) {
    const dir = path.join(libDir, d);
    const dash = d.indexOf('-');
    const bookName = dash > 0 ? d.slice(dash + 1) : d;
    const srcName = dash > 0 ? d.slice(0, dash) : '';
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8')); } catch (e) { meta = null; }
    const hasCoverFile = fs.readdirSync(dir).some((f) => /^cover\.[a-z0-9]+$/i.test(f));
    if ((meta && meta.coverUrl) || hasCoverFile) { skipped++; continue; }

    // 全源并发搜书名，取首个书名匹配且带封面的结果
    let cover = '', author = '', foundSrc = '';
    const results = await Promise.allSettled(candidates.map((s) => engine.searchBook(s, bookName, { timeout: 12000 })));
    outer:
    for (const r of results) {
      if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
      for (const b of r.value) {
        if (b.cover && nameMatch(b.name, bookName)) {
          cover = b.cover; author = b.author || ''; foundSrc = b.sourceName || '';
          break outer;
        }
      }
    }
    if (!cover) { miss++; console.log(`  [未找到] ${d}`); continue; }

    // 写回：有 book.json 合并保留原字段；无则补建（tocUrl 留空 → 书架判不可追更）
    const next = Object.assign({
      sourceName: srcName, bookName, tocUrl: '', author: '', coverUrl: '', updatedAt: 0
    }, meta || {});
    next.coverUrl = cover;
    if (!next.author && author) next.author = author;
    next.updatedAt = Date.now();
    fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify(next, null, 2));
    fixed++;
    console.log(`  [已补] ${bookName} ← ${foundSrc} ${cover.slice(0, 70)}`);
  }
  console.log(`[补封面] 完成：补 ${fixed} 本，已有封面跳过 ${skipped} 本，未匹配 ${miss} 本`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e); process.exit(1); });
