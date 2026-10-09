/**
 * Legado（阅读3.0）书源规则解释器 —— JS 子集实现。
 *
 * <p>支持的语法（覆盖书源生态中占多数的静态规则形态）：</p>
 * <ul>
 *   <li>链式选择器：{@code class.bookbox@tag.h3@tag.a@text}、{@code id.content@html}、
 *       {@code tag.dd.0@text}（末段数字为同类型兄弟索引）</li>
 *   <li>取值后缀：{@code @text}（textContent）、{@code @html}（innerHTML）、
 *       {@code @href}/{@code @src}（属性，链上任意属性名均可）</li>
 *   <li>JSONPath 子集：{@code $.data.list[0].name}、{@code $..content}（递归取首个命中）</li>
 *   <li>{@code @JSon:} 前缀视同 JSONPath</li>
 *   <li>{@code ##正则} 或 {@code ##匹配##替换}：结果后过滤（链尾）</li>
 * </ul>
 * <p>不支持（静默按失败处理，调用方标注书源"部分兼容"）：@js:、<js> 脚本、XPath、
 * @get/@put 变量。java.* API 中仅 java.aesBase64DecodeToString 例外——由适配层
 * compileRule 仿真（AES 解密章节地址，猫眼看书等曦灵类 APP 源依赖，2026-10-08）。</p>
 */
'use strict';

/** 判断规则串是否为 JSONPath 形态 */
function isJsonPath(rule) {
  const r = rule.trim();
  return r.startsWith('$.') || r.startsWith('$[') || r.startsWith('$..') || r.startsWith('@JSon:');
}

/**
 * 简化 JSONPath 取值。
 * 支持：$.a.b.c、$.a[0].b、$..key（深度优先取第一个命中）、数组直接下标。
 * 返回原始值（字符串/数组/对象）；未命中返回 null。
 */
function jsonPath(obj, path) {
  let p = path.trim().replace(/^@JSon:/i, '');
  // $..key 递归取首个命中
  const deep = p.match(/^\$\.\.(.+)$/);
  if (deep) {
    // $..bookVo.bookId 这类规则要先递归找到 bookVo，再对命中对象继续取 bookId；
    // 只返回首个命中对象会让模板展开成整个 bookVo。
    const deepPath = deep[1];
    const key = deepPath.split('.')[0].split('[')[0];
    const foundList = [];
    (function dig(o) {
      if (o === null || typeof o !== 'object') return;
      if (key in o) foundList.push(o[key]);
      for (const k of Object.keys(o)) {
        dig(o[k]);
      }
    })(obj);
    if (!foundList.length) return null;
    const rest = deepPath.slice(key.length).replace(/^\./, '');
    if (!rest) return foundList[0];
    const mapped = foundList.map(item => jsonPath(item, '$.' + rest)).filter(v => v !== null && v !== undefined);
    if (!mapped.length) return null;
    // $..bookChapters[*] 需要把每卷的 chapter 数组继续摊平成章节对象；
    // 普通深层字段（$..bookVo.bookId）保持单值语义。
    if (rest.endsWith('[*]') || rest.includes('[*]')) {
      const flat = mapped.flatMap(item => Array.isArray(item) ? item : [item]);
      return flat.length === 1 ? flat[0] : flat;
    }
    return mapped[0];
  }
  if (!p.startsWith('$')) return null;
  p = p.slice(1);
  let cur = obj;
  const tokens = p.match(/(\.[^.\[\]]+)|(\[[^\]]+\])/g) || [];
  let wildcard = false;
  for (const tk of tokens) {
    if (cur === null || cur === undefined) return null;
    if (tk.startsWith('.')) {
      const key = tk.slice(1);
      if (key === '*') {
        // .* 通配：对象取全部属性值 / 数组取全部元素，后续链对每个元素求值
        wildcard = true;
        cur = Array.isArray(cur) ? cur.slice() : Object.values(cur);
        continue;
      }
      if (wildcard || Array.isArray(cur)) {
        cur = cur.map((el) => (el && typeof el === 'object') ? el[key] : undefined);
      } else {
        cur = cur[key];
      }
    } else {
      const idx = tk.slice(1, -1).replace(/'/g, '');
      if (idx === '*' || idx === '') {
        wildcard = true;
        // 前一段字段可能返回“每卷一个 chapter 数组”，此处必须摊平，
        // 否则 $.a[*].b[*].id 会在下一层变成数组而不是单个章节。
        cur = Array.isArray(cur)
          ? cur.flatMap(item => Array.isArray(item) ? item : [item])
          : [cur];
        continue;
      }
      // 数字下标：直接索引（无论是否处于通配摊平态）
      if (/^\d+$/.test(idx)) {
        cur = Array.isArray(cur) ? cur[Number(idx)] : cur[Number(idx)];
      } else if (wildcard) {
        cur = cur.map((el) => (el && typeof el === 'object') ? el[idx] : undefined);
      } else {
        cur = cur[idx];
      }
    }
  }
  return cur === undefined ? null : cur;
}

/**
 * 深层 JSONPath 取全部命中。
 * 正文源常用数组包裹的段落对象；`$..content` 若只返回首段，正文会被截断，
 * 因此这里专门给正文阶段保留“收集完整序列”的语义。
 */
function jsonPathAll(obj, path) {
  let p = path.trim().replace(/^@JSon:/i, '');
  const deep = p.match(/^\$\.\.(.+)$/);
  if (!deep) {
    const v = jsonPath(obj, p);
    return v === null || v === undefined ? [] : (Array.isArray(v) ? v : [v]);
  }
  const deepPath = deep[1];
  const key = deepPath.split('.')[0].split('[')[0];
  const foundList = [];
  (function dig(o) {
    if (o === null || typeof o !== 'object') return;
    if (key in o) foundList.push(o[key]);
    for (const k of Object.keys(o)) {
      dig(o[k]);
    }
  })(obj);
  if (!foundList.length) return [];
  const rest = deepPath.slice(key.length).replace(/^\./, '');
  if (!rest) return foundList;
  return foundList
    .flatMap(item => jsonPathAll(item, '$.' + rest))
    .filter(item => item !== null && item !== undefined);
}

/**
 * 链式选择器求值。dom 为简易 DOM 节点（见 makeDom）。
 * 返回字符串（取值后缀）或节点数组（无后缀的中间链）。
 */
function normSeg(seg) {
  // Legado 简写归一化：.xx[.n] → class.xx[.n]；#xx[.n] → id.xx[.n]；纯标签 → tag.xx。
  // 2026-09-29 修复：原正则 /^.[w-]+$/ 中 [w-] 漏写反斜杠（字符类只含字母 w 与 -），
  // 简写分支成死代码——.class/#id 简写原样落入段解析被判未知段，整条规则静默取空
  // （架构审查实测定位；XIU2 包中简写规则占比高，就爱文学等源直接全灭）。
  // 同时补齐带索引简写（.odd.0 → class.odd.0），否则索引简写同样无归一路径。
  const short = seg.match(/^([.#])([\w-]+)(?:\.(-?\d+))?$/);
  if (short) {
    return (short[1] === '.' ? 'class.' : 'id.') + short[2]
      + (short[3] !== undefined ? '.' + short[3] : '');
  }
  // 纯标签 → tag.xx（支持带索引 a.0 → tag.a.0；链尾裸属性名由 evalChain 调用方
  // 先行拦截保护，此处不会误伤 href/src——见 evalChain 段映射注释）
  if (!/^(class|id|tag)[.]/i.test(seg) && /^[a-zA-Z][a-zA-Z0-9]*(?:\.-?\d+)?$/.test(seg)) return 'tag.' + seg;
  return seg;
}

function evalChain(dom, rule) {
  // 拆掉 ## 后过滤段
  let body = rule;
  let postFilters = [];
  const hashIdx = rule.indexOf('##');
  if (hashIdx >= 0) {
    body = rule.substring(0, hashIdx);
    const rest = rule.substring(hashIdx + 2).split('##');
    postFilters = rest;
  }
  const segs = body.split('@')
    // 段内空白=后代组合器（2026-10-09 实锤）：Legado 允许 `#bookintro p.-1` 空格
    // 分隔的 CSS 式写法，旧实现整段含空格归一失败 → 落未知段静默取空
    // （就爱文学简介规则 `#bookintro p.-1@html` 实测全灭定位）；@ 与空格同义展平
    .flatMap((x) => x.trim().split(/\s+/))
    .filter(Boolean)
    .map((x, i, arr) => (i === arr.length - 1 && /^(text|textNodes|html|innerHtml)$/i.test(x)) ? x
      // 链尾裸属性名（href/src/data-xx 等）：normSeg 会把纯字母误归一为 tag.xx，
      // 导致 tag.a@href 取不到属性（实测复现）；此处保持原样交属性分支处理
      : (i === arr.length - 1 && /^[a-zA-Z][\w-]*$/.test(x) && x.toLowerCase() !== 'text' ? x : normSeg(x)));
  let nodes = Array.isArray(dom) ? dom : [dom];
  let value = null;

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    // 取值后缀
    if (/^(text|textNodes)$/i.test(seg)) {
      value = nodes.map((n) => n.text).join('\n').trim();
      continue;
    }
    if (/^(html|innerHtml)$/i.test(seg)) {
      value = nodes.map((n) => n.html).join('\n').trim();
      continue;
    }
    const attr = seg.match(/^(?:@)?([\w-]+)$/) && !/^(class|id|tag)$/.test(seg) ? seg : null;
    if (attr && i > 0 && nodes[0] && nodes[0].attrs && attr in nodes[0].attrs) {
      value = nodes.map((n) => n.attrs[attr] || '').join('\n').trim();
      continue;
    }
    // 选择器段：class.xx / id.xx / tag.xx [.index]
    const m = seg.match(/^(class|id|tag)\.([^.]+?)(?:\.(-?\d+))?$/i);
    if (m) {
      const [, kind, key, idxStr] = m;
      let next = [];
      // Legado 语义是后代选择器（Jsoup select）：段匹配须按文档序在整棵后代树收集，
      // 而非仅直接子节点——children-only 时 bookList 从根永远查不到深层容器，跨代字段
      // 规则（a.0、img@src 等 XIU2 常见写法）也静默取空（2026-09-29 接入 HTML 型源实测）
      for (const n of nodes) {
        (function walk(node) {
          for (const c of node.children) {
            if (kind === 'class' && (c.attrs.class || '').split(/\s+/).includes(key)) next.push(c);
            else if (kind === 'id' && c.attrs.id === key) next.push(c);
            else if (kind === 'tag' && c.tag.toLowerCase() === key.toLowerCase()) next.push(c);
            walk(c);
          }
        })(n);
      }
      if (idxStr !== undefined) {
        const idx = Number(idxStr);
        nodes = [next[idx >= 0 ? idx : next.length + idx]].filter(Boolean);
      } else {
        nodes = next;
      }
      continue;
    }
    // 纯属性名（如 href/src）——当前节点属性直接取
    if (nodes[0] && nodes[0].attrs && seg in nodes[0].attrs) {
      value = nodes.map((n) => n.attrs[seg] || '').join('\n').trim();
      continue;
    }
    // 未知段：视为失败
    return null;
  }

  // 无取值后缀且链走完：默认取 text
  if (value === null) value = nodes.map((n) => n.text).join('\n').trim();

  // ## 后过滤：##正则 删除命中部分；##正则##替换文本
  for (const f of postFilters) {
    if (!f) continue;
    try {
      if (f.includes('$')) {
        const [re, rep] = f.split('$');
        value = value.replace(new RegExp(re, 'g'), rep || '');
      } else {
        value = value.replace(new RegExp(f, 'g'), '');
      }
    } catch (e) { /* 非法正则忽略 */ }
  }
  return value;
}

/** 把一段 HTML 解析为极简 DOM（无外部依赖，仅够链式选择器使用） */
function makeDom(html) {
  let seq = 0;
  function parse(tagHtml, tag, parent) {
    const node = { tag: (tag || '').toLowerCase(), attrs: {}, children: [], text: '', parent, _id: seq++ };
    const attrRe = /([a-zA-Z-]+)\s*=\s*"([^"]*)"|([a-zA-Z-]+)\s*=\s*'([^']*)'/g;
    const head = tagHtml.match(/^<[^>]*>/) || [];
    let am;
    const ar = new RegExp(attrRe.source, 'g');
    while ((am = ar.exec(head[0] || '')) !== null) {
      node.attrs[(am[1] || am[3] || '').toLowerCase()] = am[2] !== undefined ? am[2] : (am[4] || '');
    }
    return node;
  }
  const root = { tag: '#root', attrs: {}, children: [], text: '', parent: null, _id: seq++, html: '' };
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)/g;
  const stack = [root];
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[2]) {
      const close = m[1] === '/';
      const tag = m[2].toLowerCase();
      if (close) {
        // 回退到最近的同名开标签；出栈时按闭标签位置回切源串，重建该节点的 innerHTML
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tag === tag) {
            stack[i].html = html.slice(stack[i]._start, m.index);
            stack.length = i; break;
          }
        }
      } else {
        const selfClosing = /\/>$/.test(m[3]) || ['br', 'img', 'meta', 'input', 'hr', 'link'].includes(tag);
        const node = parse(m[0], tag, stack[stack.length - 1]);
        node._start = m.index + m[0].length;   // 开标签结束处即 innerHTML 起点
        stack[stack.length - 1].children.push(node);
        if (!selfClosing) stack.push(node);
      }
    } else {
      const txt = m[4];
      if (txt && stack.length) {
        const top = stack[stack.length - 1];
        top.text += txt.replace(/<[^>]*>/g, '');
      }
    }
  }
  // 汇总子孙文本：子孙文本与节点直接文本合并而非覆盖——
  // 覆盖写法在"文本+<br>+文本"结构下会把 br 前后已积累的文本清空（实测正文变空串）
  (function fillText(n) {
    if (n.children.length === 0) return;
    let t = n.text || '';
    for (const c of n.children) { fillText(c); t += (c.text || ''); }
    n.text = t;
  })(root);
  return root;
}

module.exports = { isJsonPath, jsonPath, jsonPathAll, evalChain, makeDom };
