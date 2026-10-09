/**
 * Legado 书源接入适配层：把 Legado 格式书源包装成引擎可用形态。
 *
 * <p>判定与包装规则：</p>
 * <ul>
 *   <li>识别：含 bookSourceUrl + ruleSearch 即视为 Legado 源</li>
 *   <li>兼容性评级：full（纯链式/JSONPath，解释器可执行）/
 *       partial（含 @js: 或 XPath，搜索可能失败）/ none</li>
 *   <li>受限 @js 尾：除「字面 + result + 字面」拼接外，另仿真
 *       java.aesBase64DecodeToString(result,key,transformation,iv)——曦灵类 APP 源
 *       把章节地址 AES 加密进 path 字段（猫眼看书实测），不仿真则全部章节无地址被跳过</li>
 *   <li>searchUrl 支持 {{key}}/{{page}} 占位与 GET 参数附加形式
 *       （`url,{'method':...}` 中 JSON 选项被剥离，仅按 GET 处理）</li>
 *   <li>规则执行：searchBook/getBookInfo/downloadBook 各阶段把 Legado 规则
 *       经本模块 translate 成"值提取函数"，由引擎在拿到 html/json 后调用</li>
 * </ul>
 */
'use strict';

const crypto = require('crypto');

const { isJsonPath, jsonPath, jsonPathAll, evalChain, makeDom } = require('./legado-rules');
// 受限 @js 尾与 JSONPath 编译产物在下载链路字段求值中复用
// （compileRule 来自本模块，底部导出，无循环依赖问题）

/** 兼容性评级：供 UI 标注与搜索前过滤 */
function rateCompatibility(source) {
  const probe = JSON.stringify([
    source.ruleSearch && source.ruleSearch.bookList,
    source.ruleToc && source.ruleToc.chapterList,
    source.ruleContent && source.ruleContent.content
  ]) || '';
  if (probe.includes('@js:') || probe.includes('<js>') || probe.includes('@CSS:')) {
    return /@js:|<js>/.test(JSON.stringify([source.ruleToc && source.ruleToc.chapterList, source.ruleContent && source.ruleContent.content])) ? 'none' : 'partial';
  }
  if (probe.includes('//') || probe.includes('@XPath:')) return 'partial';
  return 'full';
}

/** 从 Legado searchUrl 提取真实请求 URL（剥离 GET 选项 JSON 串） */
function buildSearchUrl(source, keyword, page) {
  const p = parseSearchUrl(source, keyword, page);
  return p ? p.url : null;
}

/** 解析 Legado searchUrl：{url, method, body, headers}；剥离选项 JSON 并替换占位符。
 *  完整形态：url,{'method':'post','body':'k={{key}}'}；简单形态：url（GET） */
function parseSearchUrl(source, keyword, page) {
  let su = source.searchUrl || '';
  if (su.startsWith('@js:')) return null;   // 脚本型不支持
  let url = su.replace(/\{\{key\}\}/g, encodeURIComponent(keyword))
    .replace(/\{\{page\}\}/g, String(page || 1));
  let options = {};
  const optIdx = url.indexOf(',{');
  if (optIdx > 0 && url.endsWith('}')) {
    const optStr = url.substring(optIdx + 1);
    url = url.substring(0, optIdx);
    try { options = JSON.parse(optStr.replace(/'/g, '"')); } catch (e) { options = {}; }
  }
  let body = options.body || '';
  body = body.replace(/\{\{key\}\}/g, encodeURIComponent(keyword))
    .replace(/\{\{page\}\}/g, String(page || 1));
  return {
    url,
    method: (options.method || 'GET').toUpperCase(),
    body: options.method && options.method.toLowerCase() === 'post' ? body : undefined,
    headers: options.headers || {}
  };
}

/** java.aesBase64DecodeToString 仿真：AES 解密 base64 密文（曦灵类 APP 源章节地址场景）。
 *  transformation 仅支持 AES/{CBC,ECB}/{PKCS5Padding,NoPadding}（与 Node crypto 原生形态对应），
 *  key/iv 为 UTF-8 字符串；任何失败（非法密文/不支持的变换/密钥长度）返回 null 不抛出，
 *  与「字段取值失败」语义一致，调用方按无地址跳过处理 */
function aesDecryptText(b64, key, transformation, iv) {
  try {
    const t = String(transformation || '').toUpperCase();
    const m = t.match(/^AES\/(CBC|ECB)\/(PKCS5PADDING|NOPADDING)$/);
    if (!m) return null;
    const alg = 'aes-' + (Buffer.byteLength(key, 'utf8') * 8) + '-' + m[1].toLowerCase();
    const d = crypto.createDecipheriv(alg, Buffer.from(key, 'utf8'),
      m[1] === 'CBC' ? Buffer.from(iv, 'utf8') : null);
    if (m[2] === 'NOPADDING') d.setAutoPadding(false);
    return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

/** 单条 Legado 规则 → 值提取函数 fn(html或json) => string|null */
function compileRule(rule, kind) {
  // kind: 'text'(HTML) | 'json'
  if (rule === undefined || rule === null) return null;
  if (typeof rule !== 'string') return null;
  const r = rule.trim();
  // JSONPath+@js 拼接混合形态：'$.book_id@js:"prefix" + result + ".txt"'
  // 取 @js 前的 JSONPath 主规则，@js 段中的 result 用取值结果代入，支持 "..." 字符串拼接
  const jsTail = r.match(/@js:(.+)$/);
  // 主规则剥离 ## 后过滤段（## 段由下方后过滤逻辑处理，不能混入 JSONPath/选择器）
  const hashCut = jsTail ? r.substring(0, r.indexOf('@js:')) : r;
  const mainRule = (hashCut.indexOf('##') >= 0 ? hashCut.substring(0, hashCut.indexOf('##')) : hashCut).trim();
  const jsExpr = jsTail ? jsTail[1].trim() : null;
  if (kind === 'json' || isJsonPath(mainRule)) {
    return function (input) {
      let obj = input;
      if (typeof input === 'string') {
        try { obj = JSON.parse(input); } catch (e) { return null; }
      }
      let v = jsonPath(obj, mainRule);
      if (v === null || v === undefined) return null;
      if (typeof v === 'object') v = JSON.stringify(v);
      v = String(v);
      // ## 后过滤（Legado 语义：##正则 删除命中部分；##正则##替换 替换）
      const hashIdx = mainRule.indexOf('##');
      if (hashIdx >= 0) {
        const parts = mainRule.substring(hashIdx + 2).split('##');
        const reStr = parts[0], repStr = parts[1];
        try {
          const re = new RegExp(reStr, 'g');
          v = repStr !== undefined ? v.replace(re, repStr) : v.replace(re, '');
        } catch (e) { /* 非法正则忽略 */ }
      }
      // 受限 @js 尾巴：优先识别 java.aesBase64DecodeToString(result,key,trans,iv)
      // （猫眼看书等曦灵类 APP 源把章节地址 AES 加密进 path 字段，规则形如
      //   $.path@js:java.aesBase64DecodeToString(result,"k","AES/CBC/PKCS5Padding","iv")；
      //   不仿真则解出 null → 全部章节无地址被跳过，实测 264 章全灭）；
      // 其余仅支持 "字面" + result + "字面" 的拼接
      if (jsExpr) {
        const aesM = jsExpr.match(/^java\.aesBase64DecodeToString\(\s*result\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)$/);
        if (aesM) {
          v = aesDecryptText(v, aesM[1], aesM[2], aesM[3]);
          if (v === null || v === '') return null;
        } else {
          const parts = jsExpr.split('+').map((x) => x.trim());
          let out = '';
          for (const part of parts) {
            const lit = part.match(/^\"([^\"]*)\"$|^'([^']*)'$/);
            if (lit) out += (lit[1] !== undefined ? lit[1] : lit[2]);
            else if (part === 'result') out += v;
            else return null;   // 复杂表达式不支持
          }
          v = out;
        }
      }
      return v;
    };
  }
  // HTML 链式
  return function (html) {
    const dom = makeDom(html);
    // 链首若为 class/id/tag 从 #root 开始查
    const v = evalChain(dom, r);
    return v === null ? null : String(v).trim();
  };
}

/** bookList 规则 → 节点数组提取。HTML 链式返回 DOM 节点数组（后续字段规则需在其上求值） */
function compileBookList(rule, kind) {
  if (typeof rule !== 'string') return null;
  const r = rule.trim();
  if (r.startsWith('@js:') || r.startsWith('<js>')) return null;
  if (kind === 'json' || isJsonPath(r)) {
    return function (input) {
      let obj = input;
      if (typeof input === 'string') {
        try { obj = JSON.parse(input); } catch (e) { return []; }
      }
      const v = jsonPath(obj, r);
      return Array.isArray(v) ? v : (v ? [v] : []);
    };
  }
  return function (html) {
    const dom = makeDom(html);
    const out = [];
    // 与 evalChain 相同的选择器逻辑，但收集节点数组
    const segs = r.split('@')
      .filter((x) => !/^(text|html)$/i.test(x))
      .map((x) => {
        // 与 legado-rules.normSeg 同口径（2026-09-29 同步修复 [w-] 笔误并补索引简写）
        const short = x.match(/^([.#])([\w-]+)(?:\.(-?\d+))?$/);
        if (short) {
          return (short[1] === '.' ? 'class.' : 'id.') + short[2]
            + (short[3] !== undefined ? '.' + short[3] : '');
        }
        if (!/^(class|id|tag)[.]/i.test(x) && /^[a-zA-Z][a-zA-Z0-9]*(?:\.-?\d+)?$/.test(x)) return 'tag.' + x;
        return x;
      });
    let nodes = [dom];
    for (const seg of segs) {
      const m = seg.match(/^(class|id|tag)\.([^.]+?)(?:\.(-?\d+))?$/i);
      if (!m) return out;
      const [, kind2, key, idxStr] = m;
      let next = [];
      // 与 legado-rules.evalChain 同口径（2026-09-29）：后代选择器语义，
      // 按文档序深度优先收集，不再限于直接子节点
      for (const n of nodes) {
        (function walk(node) {
          for (const c of node.children) {
            if (kind2 === 'class' && (c.attrs.class || '').split(/\s+/).includes(key)) next.push(c);
            else if (kind2 === 'id' && c.attrs.id === key) next.push(c);
            else if (kind2 === 'tag' && c.tag.toLowerCase() === key.toLowerCase()) next.push(c);
            walk(c);
          }
        })(n);
      }
      if (idxStr !== undefined) {
        const idx = Number(idxStr);
        next = [next[idx >= 0 ? idx : next.length + idx]].filter(Boolean);
      }
      nodes = next;
    }
    out.push(...nodes);
    return out;
  };
}

/**
 * 把 Legado 书源包装为引擎兼容书源对象。
 * 返回 { ...engineSource, legado: true, compatibility } 或 null（完全不可用）。
 */
function wrapLegado(source) {
  if (!source.bookSourceUrl || !source.ruleSearch) return null;
  const compatibility = rateCompatibility(source);
  if (compatibility === 'none') return null;

  // 规则类型判定：ruleContent.content 以 $. 开头或 searchUrl 含 api → json 形态
  const contentRule = (source.ruleContent && source.ruleContent.content) || '';
  const jsonKind = isJsonPath(contentRule) || /^@JSon:/i.test(contentRule);

  const listRule = compileBookList(
    source.ruleSearch.bookList || '',
    jsonKind ? 'json' : 'html');
  if (!listRule) return null;

  // bookList 为 HTML 链式时，字段规则需在"列表节点"上求值；
  // 引擎的统一约定：search 阶段用 searchItems(html) 拿 [{m:node, name, author, url}]
  function extractItems(html) {
    const nodes = listRule(html);
    if (!nodes || !nodes.length) return [];
    // Legado 字段名是 name/bookUrl；兼容我们的 bookName
    const nameRule = source.ruleSearch.name || source.ruleSearch.bookName || '';
    const authorRule = source.ruleSearch.author || '';
    const urlRule = source.ruleSearch.bookUrl || '';
    // 封面（2026-10-08）：coverUrl 规则可选；XPath 形态的规则 evalChain 求值失败按空串
    // 回退渐变封面，不阻断搜索
    const coverRule = source.ruleSearch.coverUrl || source.ruleSearch.cover || '';
    const coverF = coverRule ? compileRule(coverRule, jsonKind ? 'json' : 'html') : null;
    const nameF = compileRule(nameRule, jsonKind ? 'json' : 'html');
    const authorF = compileRule(authorRule, jsonKind ? 'json' : 'html');
    const urlF = compileRule(urlRule, jsonKind ? 'json' : 'html');
    return nodes.map((node) => {
      const evalField = (ruleStr) => {
        if (!ruleStr) return '';
        // || 回退：左规则无值时取右规则
        for (const part of ruleStr.split('||')) {
          const rr = part.trim();
          if (!rr) continue;
          try {
            const v = evalChain(node, rr);
            if (v) return v;
          } catch (e) { /* 忽略 */ }
        }
        return '';
      };
      // {{$.path}} 模板：字段值内嵌 JSONPath 变量（相对当前列表项）。
      // 原正则 {{($.[^}]+)}} 中 $ 被解析为锚导致永远不匹配（模板从未展开过，实测实锤），
      // 改用 [$] 字面类；精确路径未命中时按 $.. 递归语义深度查找——部分源
      // （如酷我）bookList 取父对象，模板键挂在更深的列表元素里，直接 $.path 取空
      const applyTpl = (str) => str.replace(/{{([$][^}]+)}}/g, (_, jp) => {
        const v = jsonPath(node, jp) ?? jsonPath(node, jp.replace(/^\$\.?/, '$..'));
        return v === null || v === undefined ? '' : String(v);
      });
      // legado 的 {{book.xxx}} 模板：引用 ruleSearch 已求值的字段（企鹅浏览 bookUrl
      // 用 {{book.kind}} 挂资源ID，搜索阶段不展开则详情/目录接口地址残缺）
      const applyBookTpl = (str) => {
        const ctx = {};
        for (const key of ['name', 'author', 'kind', 'lastChapter', 'intro', 'coverUrl', 'wordCount']) {
          const rule = source.ruleSearch ? source.ruleSearch[key] : null;
          if (rule) { const v = evalLegadoField(node, rule, jsonKind); if (v) ctx[key] = v; }
        }
        return str.replace(/{{\s*book\.([\w]+)\s*}}/g, (_, k) => ctx[k] || '');
      };
      const pick = (ruleStr, fn) => {
        if (!ruleStr) return '';
        // {{book.xxx}} 模板优先走 book 上下文展开（$. 形式则由 applyTpl 按条目内取值）
        if (/{{\s*book\./.test(ruleStr)) return applyBookTpl(ruleStr);
        // 节点级优先：字段规则（tag.a@text 等）语义上应基于当前书籍节点求值。
        // 旧实现先以整页 html 求值，规则若在根层命中（如 tag.div@text）会让
        // 所有书籍得到同一个整页值（整页劫持，实测可复现），且每本书都重复
        // makeDom 整页 DOM；先节点级、取空才整页兜底，兼容少数依赖整页上下文的规则
        if (!jsonKind) { const v = evalField(ruleStr); if (v) return v; }
        if (fn) { const v = fn(jsonKind ? node : html); if (v) return v; }
        if (ruleStr.includes('{{')) return applyTpl(ruleStr);
        if (jsonKind) return '';
        return evalField(ruleStr);
      };
      return {
        _node: node,
        name: pick(nameRule, nameF),
        author: pick(authorRule, authorF),
        url: pick(urlRule, urlF),
        cover: coverRule ? pick(coverRule, coverF) : ''
      };
    });
  }

  return {
    bookSourceName: source.bookSourceName || source.bookSourceUrl,
    bookSourceGroup: source.bookSourceGroup || 'legado',
    bookSourceUrl: source.bookSourceUrl,
    enabled: source.enabled !== false,
    legado: true,
    compatibility,
    responseType: jsonKind ? 'json' : 'html',
    searchUrl: source.searchUrl,
    ruleToc: source.ruleToc || {},
    ruleContent: source.ruleContent || {},
    ruleBookInfo: source.ruleBookInfo || {},   // tocUrl/{{book.xxx}} 模板依赖此对象，漏透传会静默回退 bookUrl
    // header 预求值进 option：引擎 fetchPage 对每次请求展开 option.headers，
    // 下载/详情/目录链路与搜索同享站点要求的 Referer、UA、设备头
    option: { concurrency: 2, minIntervalMs: 200, maxRetries: 1, retryBaseDelayMs: 400, timeoutMs: 12000, headers: buildHeader(source) },
    _legado: {
      source,
      parseSearchUrl: (kw, page) => parseSearchUrl(source, kw, page),
      buildSearchUrl: (kw, page) => buildSearchUrl(source, kw, page),
      extractItems,
      jsonKind
    }
  };
}

/** 从 Legado header 字段求值请求头。
 *  三种形态：字符串 JSON / @js:JSON.stringify({...}) 表达式（企鹅浏览等源用它注入
 *  Referer 与设备头，缺了会被接口以 incorrect referer 拒绝，实测复现）——
 *  以受限上下文 eval 求值，仅暴露 source/java/cookie，与引擎 evalRule 同思路；
 *  其余脚本形态（含函数体语句流）无法安全求值，返回空头由调用方按默认头继续 */
function buildHeader(source) {
  const raw = source.header;
  if (!raw || typeof raw !== 'string') return {};
  try {
    if (raw.startsWith('@js:')) {
      const body = raw.slice(4).trim();
      if (!/^JSON\.stringify\(/.test(body)) return {};   // 复杂语句流不求值
      const fn = new Function('source', 'java', 'cookie',
        `"use strict"; return eval(${JSON.stringify(body)});`);
      const out = fn({ bookSourceUrl: source.bookSourceUrl }, undefined, '');
      return typeof out === 'string' ? JSON.parse(out) : out;
    }
    return JSON.parse(raw.replace(/'/g, '"'));
  } catch (e) { return {}; }
}

/**
 * Legado 书源搜索：buildSearchUrl → 引擎抓取 → extractItems → 引擎书对象数组。
 * engineFns = { fetchWithRetry, httpRequest } 由引擎注入，避免循环 require。
 */
async function searchViaLegado(source, keyword, opt, engineFns) {
  const L = source._legado;
  const parsed = L.parseSearchUrl(keyword, 1);
  if (!parsed) throw new Error('该书源使用 @js: 搜索脚本，暂不支持');
  const full = new URL(parsed.url, source.bookSourceUrl).href;
  // POST 搜索需要引擎暴露 httpRequest；GET 走 fetchWithRetry；header 注入来源求值结果
  const html = await engineFns.fetchWithRetry(full, {
    ...opt, responseType: L.jsonKind ? 'json' : 'html',
    method: parsed.method, body: parsed.body,
    headers: { ...buildHeader(source), ...(opt.headers || {}), ...(parsed.headers || {}) }
  });
  const items = L.extractItems(html);
  // 规则错位/反爬页会解析出空名或空链接种子，这类结果进入列表即"无名书"，
  // 进入下载即站点首页；在此按"名称+地址双非空"准入，保证下游拿到的都是可点击书籍
  return items
    .map((it) => {
      let cover = '';
      if (it.cover) {
        try { cover = new URL(it.cover, source.bookSourceUrl).href; } catch (e) { /* 非法封面按无封面 */ }
      }
      return {
        bookUrl: it.url ? new URL(it.url, source.bookSourceUrl).href : '',
        name: it.name,
        author: it.author,
        cover,
        sourceName: source.bookSourceName
      };
    })
    .filter((b) => b.name && b.bookUrl && !/^https?:\/\/[^/]+\/?$/.test(b.bookUrl));
}

// ---------------------------------------------------------------------------
// 下载链路的 legado 规则翻译：详情 tocUrl、目录清单、正文提取
// 搜索翻译只覆盖 searchBook；downloadBook 走 parseCatalog/extractContent 时
// 规则是 legado DSL 而非 JS 表达式，必须经下列翻译函数求值，否则必抛语法错误
// ---------------------------------------------------------------------------

/** 在列表节点上求值字段规则：HTML 链式走 evalChain（内置 ## 过滤），
 *  JSONPath 走 compileRule 产物（支持 ## 与受限 @js 尾）；|| 分段回退取首个非空值 */
function expandJsonTemplate(rule, node) {
  return String(rule).replace(/(\{\{([^{}]+)\}\}|\{([^{}]+)\})/g, (_, whole, doubleExpr, singleExpr) => {
    const path = (doubleExpr !== undefined ? doubleExpr : singleExpr).trim();
    if (!path.startsWith('$')) return whole;
    const v = jsonPath(node, path);
    if (v === null || v === undefined) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

function evalLegadoField(node, rule, jsonKind, variables = {}) {
  if (!rule) return '';
  const prepared = String(rule).replace(/@get:\{([^}]+)\}/g, (_, key) => variables[key] || '');
  for (const part of prepared.split('||')) {
    const rr = part.trim();
    if (!rr) continue;
    try {
      if (jsonKind) {
        const putMatch = rr.match(/@put:\{([^:}]+):([^}]+)\}$/);
        const mainRule = putMatch ? rr.slice(0, rr.indexOf('@put:')).trim() : rr;
        let v;
        if (putMatch) {
          const putFn = compileRule(putMatch[2].trim(), 'json');
          const putValue = putFn ? putFn(node) : null;
          if (putValue !== null && putValue !== undefined) variables[putMatch[1].trim()] = String(putValue);
          const fn = compileRule(mainRule, 'json');
          v = fn ? fn(node) : null;
        } else if (/\{\{?\s*\$/.test(mainRule)) {
          v = expandJsonTemplate(mainRule, node);
        } else {
          const fn = compileRule(mainRule, 'json');
          v = fn ? fn(node) : null;
        }
        if (v !== null && v !== undefined && v !== '') return String(v);
      } else {
        const v = evalChain(node, rr);
        if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
      }
    } catch (e) { /* 单段规则非法时继续尝试下一段回退 */ }
  }
  return '';
}

/** legado 详情页：求值 ruleBookInfo.tocUrl 得目录页地址；规则缺失或求值失败
 *  回退 bookUrl 本身（大量站点详情与目录同页），与引擎 getBookInfo 的缺省语义一致 */
function legadoGetBookInfo(html, source, bookUrl) {
  const rb = source.ruleBookInfo || {};
  const jsonKind = source.responseType === 'json';
  const variables = {};
  let node = html;
  if (jsonKind) { try { node = JSON.parse(html); } catch (e) { node = null; } }
  else node = makeDom(html);
  // ruleBookInfo.init 把接口响应先收敛到业务书籍对象；酷我等源的 book_id 挂在
  // $.data 里，跳过这一步会让后续 tocUrl 求值拿空值，最终生成含空 ID 的 404 地址
  if (jsonKind && rb.init && isJsonPath(rb.init) && node) {
    const scopedNode = jsonPath(node, rb.init);
    if (scopedNode !== null && scopedNode !== undefined && typeof scopedNode === 'object') {
      node = scopedNode;
    }
  }
  // 先按 ruleBookInfo 各字段规则求值，构建 legado 的 book 上下文——
  // tocUrl 里的 {{book.xxx}} 模板引用这些字段（如 {{book.kind}} 挂资源ID），
  // 不先求值就展开会拿到空串，目录接口地址残缺导致目录 0 章（企鹅浏览实测复现）
  const bookCtx = {};
  if (node) {
    for (const key of ['name', 'author', 'kind', 'lastChapter', 'intro', 'coverUrl', 'wordCount']) {
      const rule = rb[key];
      if (rule) {
      const v = evalLegadoField(node, rule, jsonKind, variables);
        if (v) bookCtx[key] = v;
      }
    }
  }
  // @put 变量可能只在详情阶段出现，但目录阶段的 @get 还要用；
  // 挂在包装源上，供本次书源对象的目录解析阶段复用。
  if (source._legado) source._legado.variables = variables;

  let tocUrl = bookUrl;
  if (rb.tocUrl) {
    let v = evalLegadoField(node, rb.tocUrl, jsonKind, variables);
    // 选择器求值无结果时按 {{book.xxx}} 模板展开；两者都失败保持 bookUrl 回退
    if (v) {
      tocUrl = v;
    } else if (/{{\s*book\./.test(rb.tocUrl)) {
      tocUrl = rb.tocUrl.replace(/{{\s*book\.([\w]+)\s*}}/g, (_, k) => bookCtx[k] || '');
    }
  }
  return {
    tocUrl: new URL(tocUrl, source.bookSourceUrl).href,
    chapterTotal: null,
    // 简介/封面透出（2026-10-09 头卡简介需求）：bookCtx 已按 ruleBookInfo 求值，
    // 此前只用于 tocUrl 模板展开便丢弃，web 头卡/详情弹层无简介可用
    intro: bookCtx.intro || '',
    // 相对封面地址绝对化（92xs 等站返回 /files/... 相对路径，前端直连会 404）；
    // 非法地址 try 留空不炸详情主流程
    coverUrl: (() => { try { return bookCtx.coverUrl ? new URL(bookCtx.coverUrl, source.bookSourceUrl).href : ''; } catch (e) { return ''; } })()
  };
}

/** legado 目录页：chapterList 规则取条目序列，逐条求值章节名/地址，按索引编章号。
 *  返回与引擎 parseCatalog 同构的 [{n,url,title}]；不支持分页目录（nextTocUrl），
 *  只解析当前页——首期覆盖单页目录站点，分页站点目录会缺章，属已知边界 */
function legadoParseCatalog(html, source) {
  const rt = source.ruleToc || {};
  const jsonKind = source.responseType === 'json';
  const variables = source._legado && source._legado.variables ? source._legado.variables : {};
  const listRule = compileBookList(rt.chapterList || '', jsonKind ? 'json' : 'html');
  if (!listRule) throw new Error('目录规则无法解析（chapterList 含脚本或为空）');
  // compileBookList/compileRule 产物内部自带 JSON.parse 或 makeDom，
  // 必须传原始 html 字符串；传入已解析 DOM 会被二次解析成空树（实测 0 节点）
  const items = listRule(jsonKind ? (() => { try { return JSON.parse(html); } catch (e) { return null; } })() : html) || [];
  const chapters = [];
  for (const node of items) {
    const title = evalLegadoField(node, rt.chapterName || rt.name || 'text', jsonKind, variables);
    let url = evalLegadoField(node, rt.chapterUrl || 'href', jsonKind, variables);
    if (!url) continue;   // 无地址的条目（如卷标题行）跳过且不消耗章节号
    // 章号从 1 起编：与引擎断点续传/追更比对/前端「只看失败」的 1 起惯例一致；
    // 旧实现从 0 起会生成 chapter_000.txt 并使前端章节号显示错位（酷我源实测受影响）
    chapters.push({ n: chapters.length + 1, url: new URL(url, source.bookSourceUrl).href, title });
  }
  // legado 无章节号概念，目录顺序即章序；引擎按 n 升序输出，此处保持页面顺序即可
  return chapters;
}

/** legado 正文页：content 规则取正文（HTML 片段或 API 纯文本），
 *  应用 legado 格式 replaceRegex（[{regex,replacement}]）后交引擎统一清洗标签 */
function legadoExtractContent(html, source) {
  const rc = source.ruleContent || {};
  const rule = rc.content;
  if (!rule) return null;
  const jsonKind = source.responseType === 'json';
  let node = html;
  if (jsonKind) { try { node = JSON.parse(html); } catch (e) { node = null; } }
  else node = makeDom(html);
  if (!node) return null;
  let v;
  if (jsonKind) {
    // 米读等正文接口把一章拆成多个段落对象；深层规则必须收集全部段落，
    // 若沿用“首个命中”的取值语义，下载文件只会有第一句。
    const hashIdx = rule.indexOf('##');
    const mainRule = hashIdx >= 0 ? rule.substring(0, hashIdx).trim() : rule.trim();
    if (mainRule.startsWith('$..')) {
      v = jsonPathAll(node, mainRule)
        .filter((item) => item !== null && item !== undefined)
        .map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item)))
        .join('\n') || null;
    } else {
      const fn = compileRule(mainRule, 'json');
      v = fn ? fn(node) : null;
    }
  } else {
    v = evalChain(node, rule);
  }
  if (!v) return null;
  v = String(v);
  // legado 的 replaceRegex 有两种形态：对象数组 [{regex,replacement,modifier}]（官方格式）
  // 与字符串 "##re##rep"（XIU2 包常见的老式简写，语义同 ## 过滤：##re 删除 / ##re##rep 替换）。
  // 两种形态都必须在此层消化——字符串形态透传到引擎 normalizeContent 会被当
  // 字符串数组调用 .map 抛 TypeError（2026-09-29 速读谷源实测复现）
  const rawReps = rc.replaceRegex;
  const reps = Array.isArray(rawReps) ? rawReps : [];
  for (const r of reps) {
    try {
      const re = new RegExp(r.regex, r.modifier || 'g');
      v = v.replace(re, r.replacement || '');
    } catch (e) { /* 非法正则跳过，不阻断正文 */ }
  }
  if (typeof rawReps === 'string' && rawReps.trim()) {
    for (const line of rawReps.split('\n')) {
      const f = line.trim();
      if (!f.startsWith('##')) continue;
      const parts = f.slice(2).split('##');
      try {
        const re = new RegExp(parts[0], 'g');
        v = v.replace(re, parts[1] !== undefined ? parts[1] : '');
      } catch (e) { /* 非法正则跳过，不阻断正文 */ }
    }
  }
  return v;
}

module.exports = { wrapLegado, rateCompatibility, buildSearchUrl, parseSearchUrl, compileRule, compileBookList, searchViaLegado, legadoGetBookInfo, legadoParseCatalog, legadoExtractContent, buildHeader };
