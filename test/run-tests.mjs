// 轻量测试（无框架）。Node 18+ 自带 CompressionStream / Blob。
// 用法：node test/run-tests.mjs
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0,
  fail = 0;
function ok(name, cond) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.error('  ✗ ' + name);
  }
}

// ---- 加载 lib/format.js ----
new Function(readFileSync(join(here, '..', 'lib', 'format.js'), 'utf8'))();
const FMT = globalThis.__FMT;

console.log('dedupeRows');
{
  const rows = [
    { ts: '0:01', text: 'a' },
    { ts: '0:01', text: 'a' }, // 重复面板副本
    { ts: '0:05', text: 'b' },
    { ts: '0:09', text: '' }, // 空行丢弃
    { ts: '0:12', text: 'a' }, // 同文本不同时间戳 → 保留
  ];
  const out = FMT.dedupeRows(rows);
  ok('去掉重复副本 + 空行，保留同文本不同时间戳', out.length === 3 && out[0].text === 'a' && out[2].ts === '0:12');
  ok('null 安全', FMT.dedupeRows(null).length === 0);
}

console.log('rowsToText');
{
  const rows = [{ ts: '0:01', text: '第一句' }, { ts: '1:05', text: '第二句' }];
  ok('纯文本', FMT.rowsToText(rows, false) === '第一句\n第二句');
  ok('带时间戳', FMT.rowsToText(rows, true) === '[0:01] 第一句\n[1:05] 第二句');
}

console.log('fmtNum / fmtDate / sanitize');
{
  ok('观看数千分位', FMT.fmtNum('48516611') === '48,516,611');
  ok('观看数缺失', FMT.fmtNum('') === '—');
  ok('日期裁剪到天', FMT.fmtDate('2008-03-07T17:17:20-08:00') === '2008-03-07');
  ok('日期缺失', FMT.fmtDate('') === '—');
  ok('文件名清洗非法字符', FMT.sanitize('a/b:c*d?\ne') === 'a b c d e');
}

console.log('toMd');
{
  const md = FMT.toMd({
    videoId: 'abc12345678',
    title: '我的标题',
    author: '某频道',
    publishDate: '2024-03-15T00:00:00-07:00',
    viewCount: '12345',
    comments: '1,234',
    description: '描述行1\n描述行2',
    text: '字幕第一句\n字幕第二句',
  });
  ok('含全部字段且无字幕语言行', /# 我的标题/.test(md) && /作者：某频道/.test(md) && /发布时间：2024-03-15/.test(md) && /观看数：12,345/.test(md) && /评论数：1,234/.test(md) && !/字幕语言/.test(md));
  ok('描述与字幕分区', /## 视频描述/.test(md) && /## 字幕文案/.test(md) && /字幕第一句\n字幕第二句/.test(md));
  ok('评论数缺失显示不可用', /评论数：不可用/.test(FMT.toMd({ videoId: 'x', title: 't', text: '' })));
}

console.log('fmtUnixDate / toMdBili（B站）');
{
  ok('unix 秒转日期', FMT.fmtUnixDate(1780023600) === FMT.fmtUnixDate(1780023600) && /^\d{4}-\d{2}-\d{2}$/.test(FMT.fmtUnixDate(1780023600)));
  ok('unix 为 0 显示横线', FMT.fmtUnixDate(0) === '—');
  const md = FMT.toMdBili({
    bvid: 'BV1jgVc6aEaW',
    title: '【罗翔】测试',
    author: '罗翔说刑法',
    pubdate: 1780023600,
    stat: { view: 23805, danmaku: 13, reply: 71, like: 2846 },
    desc: '简介内容',
    text: '字幕第一句\n字幕第二句',
  });
  ok('含 B站 字段（播放/弹幕/评论/点赞）', /UP主：罗翔说刑法/.test(md) && /播放：23,805/.test(md) && /弹幕：13/.test(md) && /评论：71/.test(md) && /点赞：2,846/.test(md));
  ok('B站 链接 + 分区 + 字幕', /bilibili\.com\/video\/BV1jgVc6aEaW/.test(md) && /## 视频简介/.test(md) && /字幕第一句\n字幕第二句/.test(md));
}

// ---- 加载 lib/page-helpers.js（zip 构建器）----
let capturedBlob = null;
let downloadName = null;
globalThis.document = {
  body: { appendChild() {} },
  createElement() {
    return { set href(_) {}, set download(v) { downloadName = v; }, click() {}, remove() {} };
  },
};
globalThis.URL = { createObjectURL(b) { capturedBlob = b; return 'blob:test'; }, revokeObjectURL() {} };
new Function(readFileSync(join(here, '..', 'lib', 'page-helpers.js'), 'utf8'))();
const YTG = globalThis.__YTG;

console.log('buildAndDownloadZip（真实 unzip 校验）');
{
  const files = [
    { name: '标题一.md', data: '# 标题一\n\n' + '这是一段中文字幕内容。'.repeat(200) },
    { name: '标题二.md', data: 'short' },
  ];
  await YTG.buildAndDownloadZip(files, 'out.zip');
  ok('下载文件名正确', downloadName === 'out.zip');
  const buf = Buffer.from(await capturedBlob.arrayBuffer());
  const dir = mkdtempSync(join(tmpdir(), 'ytgzip-'));
  const zipPath = join(dir, 'out.zip');
  writeFileSync(zipPath, buf);

  let integrity = false;
  try {
    integrity = /No errors detected/.test(execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' }));
  } catch (e) {}
  ok('unzip -t 通过（CRC/结构正确）', integrity);

  const exdir = join(dir, 'ex');
  execFileSync('ditto', ['-x', '-k', zipPath, exdir]);
  const names = readdirSync(exdir).filter((n) => n.endsWith('.md')).sort();
  ok('解出两个 .md', names.length === 2);
  ok('压缩内容完整还原（含中文）', readFileSync(join(exdir, '标题一.md'), 'utf8') === files[0].data);
  ok('STORE 短文件还原', readFileSync(join(exdir, '标题二.md'), 'utf8') === files[1].data);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
