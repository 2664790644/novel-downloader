/** cleanAdLines 合成样本单测（2026-10-09 v61）：新模式命中 + 不误杀正文 */
'use strict';
const eng = require('../novel-downloader.js');
const filler = [];
for (let i = 0; i < 80; i++) filler.push('第' + i + '段正文，他说道：“今天天气不错。”众人纷纷点头称是，故事继续向前推进着。');
const lines = [
  '骇夜：我在恐怖游戏里暴富',
  '“师弟，你确定要走这条路？”邵澜看向远方，眼神复杂。',
  '请记住本站域名www.xxx.com',
  ...filler.slice(0, 30),
  '手机用户请浏览m.xxx.com阅读，更流畅的体验',
  '一秒记住【笔趣阁】www.biquge.com，无弹窗，更新快，无错章节！',
  ...filler.slice(30, 60),
  'PS：求推荐票月票，谢谢大家支持',
  '新域名 xxxx.com 敬请收藏',
  '（本章完）',
  '又是一段正文，他说“www.救援.com 是个网址吗”她笑了笑没有回答这个问题。',
  ...filler.slice(60),
  '上一章目录下一页',
  '结尾正文，他转身离去，再也没有回头。'
];
const out = eng.cleanAdLines(lines.join('\n'));
const checks = [
  ['域名行剔除', !out.includes('请记住本站域名')],
  ['手机行剔除', !out.includes('手机用户请浏览')],
  ['一秒记住剔除', !out.includes('一秒记住')],
  ['PS求票剔除', !out.includes('求推荐票')],
  ['含URL短行剔除', !out.includes('新域名 xxxx.com')],
  ['本章完剔除', !out.includes('本章完')],
  ['翻页行剔除', !out.includes('上一章目录下一页')],
  ['正文含URL对话保留', out.includes('www.救援.com')],
  ['正文段落保留', out.includes('师弟，你确定要走这条路') && out.includes('转身离去')],
  ['填充段保留', out.includes('第40段正文')]
];
let fail = 0;
for (const [name, ok] of checks) { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name); if (!ok) fail++; }
// 误杀保护验证：全书 90% 都是水印行时应放弃清洗返回原文
const flood = Array.from({ length: 20 }, (_, i) => i < 18 ? '请记住本站域名www.xxx.com' : '正文段落' + i).join('\n');
const flooded = eng.cleanAdLines(flood);
const keepOriginal = flooded.split('\n').length === 20;
console.log((keepOriginal ? 'PASS' : 'FAIL') + ' 10% 误杀保护（全水印放弃清洗）');
if (!keepOriginal) fail++;
process.exit(fail ? 1 : 0);
