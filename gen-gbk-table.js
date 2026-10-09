/**
 * 构建期工具：生成 GBK 编码映射表 JSON（构建时执行一次，运行时零外部依赖）。
 *
 * <p>为什么存在：mock 模拟站需要把自创文本编码为 GBK 字节，原实现运行时调用
 * 系统 iconv——打包成 exe 后目标机器没有 iconv 必挂。故改为构建期用 iconv
 * 生成全量表（gbk-table.json），运行时只读表不调外部命令。</p>
 *
 * <p>产物：gbk-table.json，格式 { "字符": [b0, b1], ... }；ASCII 单字节。</p>
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const chars = [];
for (let i = 0x20; i < 0x7f; i++) chars.push(String.fromCharCode(i));
for (let c = 0x4e00; c <= 0x9fa5; c++) chars.push(String.fromCharCode(c));
chars.push('，。！？：；\u201c\u201d\u2018\u2019（）——…《》、');

const joined = chars.join('');
const bytes = execFileSync('iconv', ['-f', 'UTF-8', '-t', 'GBK'], {
  input: joined, maxBuffer: 16 * 1024 * 1024
});

const table = {};
let bi = 0;
for (const ch of joined) {
  const cp = ch.codePointAt(0);
  if (cp < 0x80) {
    table[ch] = [cp];
    bi += 1;
  } else {
    table[ch] = [bytes[bi], bytes[bi + 1]];
    bi += 2;
  }
}

const out = path.join(__dirname, 'gbk-table.json');
fs.writeFileSync(out, JSON.stringify(table));
console.log(`[gen-gbk-table] ${Object.keys(table).length} 字符 -> ${out} (${fs.statSync(out).size} bytes)`);
