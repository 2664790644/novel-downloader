/**
 * 本地导入（TXT/EPUB → 书架）。
 *
 * <p>把用户已有的本地整本小说收编进书架，统一走阅读/管理/导出流程。
 * 典型场景：番茄 SVIP 权益章无法在站内获取全本，用户用外部工具下好
 * TXT/EPUB 后一键导入。产出与引擎下载完全同构的书架目录结构
 * （manifest.json + chapter_NNN.txt + book.json），预览/阅读/导出零改动复用。</p>
 *
 * <p>TXT：编码探测（BOM → UTF-8 严格 → GBK 兜底）+ 「第X章」启发式切章；
 * 全书无章节标题时整本为单章。EPUB：零依赖最小 ZIP 读取器（Node 内置
 * zlib.inflateRawSync 解 deflate）+ container→OPF→spine 解析；封面与元数据
 * 尽力提取，取不到不致命。</p>
 *
 * <p>约束：导入书不含 tocUrl（无追更能力，与历史书一致）；目录重名时
 * 书名追加序号，不与既有书架目录合并。</p>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { decodeGbk, nativeGbkSupported } = require('./gbk-decoder');
const { safeFsName } = require('./novel-downloader');

const MAX_CHAPTERS = 20000;          // 与手动链接模式章节上限一致
const TXT_MAX_BYTES = 30 * 1024 * 1024;
const EPUB_MAX_BYTES = 80 * 1024 * 1024;

/** 文本编码探测：BOM 优先 → UTF-8 严格解码（失败即非 UTF-8）→ GBK 兜底。
 *  与引擎 decodeBody 同思路，本地文件没有 HTTP 头可参考，只能内容自证 */
function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) { /* 非 UTF-8，落 GBK 兜底 */ }
  return nativeGbkSupported() ? new TextDecoder('gbk').decode(buf) : decodeGbk(buf);
}

// 「第X章」标题行：限 40 字内、禁止句读（正文行如「他翻到第二章节的内容。」
// 会带标点与陈述语气，实测可被宽松规则误切——标题行本质是短标签非句子）
const TXT_CH_RE = /^[ \t\u3000]*(第[0-9零一二三四五六七八九十百千万两〇0-9]+[章节卷回集部][^。！？；，\n]{0,30})[ \t\u3000]*$/;

/** TXT 切章：标题行命中即切；正文行 trim 后以 \n\n 连接（与引擎章节文件口径一致，
 *  readCachedText 按 \n\n 剥首行书名行）。无命中 → 整本单章（文件名做标题） */
function splitTxtChapters(text, fallbackTitle) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chapters = [];
  let title = null;
  let body = [];
  const flush = () => {
    const paras = body.map((s) => s.trim()).filter(Boolean).join('\n\n');
    if (title !== null || paras) {
      chapters.push({ title: (title || fallbackTitle || '全文').trim(), body: paras });
    }
    body = [];
  };
  for (const line of lines) {
    const m = line.match(TXT_CH_RE);
    if (m) {
      flush();
      title = m[1].trim();
    } else {
      body.push(line);
    }
    if (chapters.length > MAX_CHAPTERS) break;
  }
  flush();
  if (!chapters.length) chapters.push({ title: fallbackTitle || '全文', body: text.trim() });
  return chapters;
}

// ---------------------------------------------------------------------------
// 最小 ZIP 读取器（EPUB 专用）：只解 deflate/store，不建通用解压能力
// ---------------------------------------------------------------------------

/** 遍历 ZIP 中央目录：EOCD 定位 → 逐条目产出 {name, data}。跳过目录项与
 *  不支持的压缩方法（如 bz2/ppmd 的 EPUB 极罕见，属损坏边缘场景） */
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 EPUB 文件（ZIP 目录缺失）');
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < total && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const flags = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const rawName = buf.subarray(off + 46, off + 46 + nameLen);
    const name = (flags & 0x800) ? rawName.toString('utf8') : decodeZipName(rawName);
    off += 46 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith('/')) continue;
    // 本地头：数据区 = localOff + 30 + 名长 + 额外长（本地头与中央目录长度可能不一致，各自读）
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    try {
      const data = method === 0 ? comp : method === 8 ? zlib.inflateRawSync(comp) : null;
      if (data) entries.set(name, data);
    } catch (e) { /* 单条目损坏跳过，不毁整本 */ }
  }
  return entries;
}

/** ZIP 文件名编码：UTF-8 失败时按 GBK 尽力解码（中文制 EPUB 常见） */
function decodeZipName(raw) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch (e) { /* 落 GBK */ }
  return nativeGbkSupported() ? new TextDecoder('gbk').decode(raw) : decodeGbk(raw);
}

/** XHTML → 纯文本段落：块级标签转行、去标签、解基本实体（正文白名单口径，
 *  与引擎 cleanAdLines/normalizeContent 的输出形态保持一致） */
function htmlToText(html) {
  let s = String(html)
    .replace(/<\s*(script|style)[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|blockquote)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  return s.split('\n').map((x) => x.trim()).filter(Boolean).join('\n\n');
}

const attr = (s, k) => {
  const m = s.match(new RegExp(k + '\\s*=\\s*"([^"]*)"')) || s.match(new RegExp(k + "\\s*=\\s*'([^']*)'"));
  return m ? m[1] : '';
};

/** EPUB 解析：container.xml → OPF → spine 顺序章节 + 元数据 + 封面（尽力提取） */
function parseEpub(buf) {
  const entries = zipEntries(buf);
  const containerXml = entries.get('META-INF/container.xml');
  if (!containerXml) throw new Error('EPUB 缺少 container.xml（文件可能损坏）');
  const opfPath = attr(containerXml.toString('utf8'), 'full-path');
  const opfRaw = entries.get(opfPath);
  if (!opfRaw) throw new Error('EPUB 缺少 OPF 描述文件');
  const opf = opfRaw.toString('utf8');
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const items = new Map();   // id -> {href, mediaType, properties}
  for (const m of opf.matchAll(/<item\s[^>]*>/g)) {
    const tag = m[0];
    if (attr(tag, 'id')) {
      items.set(attr(tag, 'id'), {
        href: attr(tag, 'href'), mediaType: attr(tag, 'media-type'), properties: attr(tag, 'properties')
      });
    }
  }
  const spineIds = [];
  for (const m of opf.matchAll(/<itemref\s[^>]*>/g)) {
    const idref = attr(m[0], 'idref');
    if (idref) spineIds.push(idref);
  }
  const title = (opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1];
  const creator = (opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i) || [])[1];
  // 封面：properties="cover-image" 优先，其次 meta[name=cover] 指向的 manifest 项
  let coverData = null, coverExt = '';
  for (const it of items.values()) {
    if (/\bcover-image\b/.test(it.properties) && it.mediaType.startsWith('image/')) {
      coverData = entries.get(baseDir + it.href) || entries.get(it.href);
      coverExt = (it.href.split('.').pop() || 'jpg').toLowerCase();
      break;
    }
  }
  if (!coverData) {
    const coverId = (opf.match(/<meta\s[^>]*name\s*=\s*"cover"[^>]*>/i) || [''])[0];
    const it = items.get(attr(coverId, 'content'));
    if (it && it.mediaType.startsWith('image/')) {
      coverData = entries.get(baseDir + it.href) || entries.get(it.href);
      coverExt = (it.href.split('.').pop() || 'jpg').toLowerCase();
    }
  }
  // 兜底：部分制作工具既不写 properties 也不写 meta 标记，仅有一张 cover.* 图片项
  if (!coverData) {
    for (const it of items.values()) {
      if (it.mediaType.startsWith('image/') && /^cover\./i.test(it.href.split('/').pop() || '')) {
        coverData = entries.get(baseDir + it.href) || entries.get(it.href);
        coverExt = (it.href.split('.').pop() || 'jpg').toLowerCase();
        if (coverData) break;
      }
    }
  }

  const chapters = [];
  for (const id of spineIds) {
    const it = items.get(id);
    if (!it || !/x?html/.test(it.mediaType)) continue;
    const raw = entries.get(decodeURIComponent(baseDir + it.href)) || entries.get(baseDir + it.href);
    if (!raw) continue;
    const body = htmlToText(raw.toString('utf8'));
    if (!body) continue;   // 空排版页（封面页/版权页无文本内容）不计章
    // 章节标题：首个 body 内 <h1-3> 优先，缺省取正文第一行
    const hRaw = raw.toString('utf8').match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    const hTitle = hRaw ? htmlToText(hRaw[1]) : '';
    const firstLine = body.split('\n\n')[0];
    chapters.push({ title: (hTitle || firstLine || `第${chapters.length + 1}章`).slice(0, 120), body });
    if (chapters.length >= MAX_CHAPTERS) break;
  }
  if (!chapters.length) throw new Error('EPUB 内未解析出正文章节');
  return {
    name: (title || '').trim(),
    author: (creator || '').replace(/<[^>]+>/g, '').trim(),
    coverData, coverExt,
    chapters
  };
}

/** 导入主入口：解析 → 落盘标准书架目录。返回 {dirName, name, author, coverFile, chapters} */
function importBook({ outRoot, kind, buf, nameHint }) {
  const size = buf.length;
  const cap = kind === 'epub' ? EPUB_MAX_BYTES : TXT_MAX_BYTES;
  if (size === 0) throw new Error('文件内容为空');
  if (size > cap) throw new Error(`文件过大（上限 ${Math.round(cap / 1024 / 1024)}MB）`);

  let book;
  if (kind === 'epub') {
    book = parseEpub(buf);
  } else {
    const text = decodeText(buf);
    const base = (nameHint || '').replace(/\.[a-z0-9]+$/i, '').trim() || '未命名小说';
    book = { name: base, author: '', coverData: null, coverExt: '', chapters: splitTxtChapters(text, base) };
  }
  book.name = (book.name || nameHint || '未命名小说').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 80) || '未命名小说';
  book.author = (book.author || '').slice(0, 60);

  // 目录名与引擎 safeFsName 口径一致（书源名-书名）；重名追加序号不合并既有书
  let dirName = safeFsName(`本地导入-${book.name}`);
  let finalName = book.name;
  const outDir = path.join(outRoot, 'output');
  for (let i = 2; fs.existsSync(path.join(outDir, dirName)); i++) {
    finalName = `${book.name}_${i}`;
    dirName = safeFsName(`本地导入-${finalName}`);
  }
  const dir = path.join(outDir, dirName);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = {};
  book.chapters.forEach((ch, i) => {
    const file = `chapter_${String(i + 1).padStart(3, '0')}.txt`;
    fs.writeFileSync(path.join(dir, file), `《${book.name}》 ${ch.title}\n\n${ch.body}\n`, 'utf8');
    manifest[i + 1] = { file, title: ch.title, url: '' };   // url 空 = 本地章，无追更意义
  });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  let coverFile = null;
  if (book.coverData) {
    coverFile = `cover.${book.coverExt.replace(/[^a-z0-9]/gi, '') || 'jpg'}`;
    fs.writeFileSync(path.join(dir, coverFile), book.coverData);
  }

  fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify({
    sourceName: '本地导入', bookName: finalName, tocUrl: '',
    author: book.author, coverUrl: '', updatedAt: Date.now()
  }, null, 2));

  return { dirName, name: finalName, author: book.author, coverFile, chapters: book.chapters.length };
}

module.exports = { importBook, splitTxtChapters, parseEpub, decodeText, zipEntries, htmlToText };
