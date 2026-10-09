/**
 * 零依赖 GBK 解码器（纯 JS 查表实现）。
 *
 * <p>为什么存在：pkg 打包的 exe 默认裁剪了 Node 全量 ICU 数据，
 * TextDecoder('gbk') 抛 "encoding not supported"，杀死编码探测链的 GBK 兜底。
 * 本模块用构建期生成的 gbk-table.json 的反向映射做查表解码，无 ICU 依赖，
 * 作为 TextDecoder('gbk') 不可用时的运行时兜底。</p>
 *
 * <p>表来源：gen-gbk-table.js 产物；覆盖 ASCII 可打印区 + CJK 基本区 U+4E00–U+9FA5
 * + 常用中文标点。表外双字节序列按 U+FFFD 替换，不抛错。</p>
 */
'use strict';

const fs = require('fs');
const path = require('path');

let forward = null;   // 字符 -> 字节对（读表原序）
let revMap = null;    // "b0*256+b1" -> 字符（解码用反向映射）

function ensureTable() {
  if (revMap) return;
  const tableFile = path.join(__dirname, 'gbk-table.json');
  if (!fs.existsSync(tableFile)) {
    throw new Error('缺少 gbk-table.json（请先运行 npm run build:table）');
  }
  forward = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
  revMap = new Map();
  for (const [ch, pair] of Object.entries(forward)) {
    if (pair.length === 2) {
      revMap.set(pair[0] * 256 + pair[1], ch);
    } else if (pair.length === 1) {
      revMap.set(pair[0], ch);
    }
  }
}

/**
 * 解码 GBK 字节流为字符串。
 * 单字节 < 0x80 按 ASCII；双字节 (b0,b1) 联合查反向表；
 * 未命中或尾部悬挂字节替换 U+FFFD，与 TextDecoder 的容错语义一致。
 */
function decodeGbk(buf) {
  ensureTable();
  let out = '';
  for (let i = 0; i < buf.length;) {
    const b0 = buf[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
      continue;
    }
    if (i + 1 >= buf.length) {
      out += '\uFFFD';   // 尾部悬挂首字节
      break;
    }
    const ch = revMap.get(b0 * 256 + buf[i + 1]);
    out += ch !== undefined ? ch : '\uFFFD';
    i += 2;
  }
  return out;
}

/** 探测当前运行环境是否原生支持 GBK 解码（exe 内返回 false） */
function nativeGbkSupported() {
  try {
    new TextDecoder('gbk');
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { decodeGbk, nativeGbkSupported };
