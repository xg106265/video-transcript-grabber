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

console.log('fmtUnixDate');
{
  ok('unix 秒转日期格式', /^\d{4}-\d{2}-\d{2}$/.test(FMT.fmtUnixDate(1780023600)));
  ok('unix 为 0 显示横线', FMT.fmtUnixDate(0) === '—');
}

console.log('yamlStr / sanitizeTag');
{
  ok('yaml 转义引号与换行', FMT.yamlStr('a"b\nc') === '"a\\"b\\nc"');
  ok('标签去空格→连字符', FMT.sanitizeTag('Mark Rober') === 'Mark-Rober');
  ok('标签保留中文', FMT.sanitizeTag('罗翔说刑法') === '罗翔说刑法');
}

console.log('toMdObsidian（Obsidian frontmatter 版式）');
{
  const md = FMT.toMdObsidian({
    fm: [
      { k: '标题', v: '我的"标题"', q: true },
      { k: '来源', v: 'https://www.bilibili.com/video/BVxxx', q: true },
      { k: '作者', v: '罗翔说刑法', q: true },
      { k: '发布时间', v: '2024-03-15', q: false },
      { k: '播放', v: '23,805', q: false },
      { k: '简介', v: '第一行\n第二行', q: true },
    ],
    tags: ['罗翔说刑法'],
    text: '字幕第一句\n字幕第二句',
  });
  ok('以 frontmatter 开头 + 标题引号转义', md.startsWith('---\n标题: "我的\\"标题\\""'));
  ok('简介多行转义后放进 frontmatter', /简介: "第一行\\n第二行"/.test(md));
  ok('日期/数字为纯标量不加引号', /发布时间: 2024-03-15\n/.test(md) && /播放: 23,805\n/.test(md));
  ok('tags 只放作者名', /tags:\n  - 罗翔说刑法\n---/.test(md));
  ok('frontmatter 之后正文只有字幕', md.includes('---\n\n字幕第一句\n字幕第二句\n'));
  ok('空 tags 渲染为 []', /tags: \[\]/.test(FMT.toMdObsidian({ fm: [], tags: [], text: 'x' })));

  // 来源裸 URL（可点外链）+ 作者双链（Obsidian 内链）
  const md2 = FMT.toMdObsidian({
    fm: [
      { k: '来源', v: 'https://www.bilibili.com/video/BVxxx', q: false },
      { k: '作者', v: '[[罗翔说刑法]]', q: true },
    ],
    tags: ['罗翔说刑法'],
    text: 'x',
  });
  ok('来源为裸 URL（无引号 → 可点外链）', /来源: https:\/\/www\.bilibili\.com\/video\/BVxxx\n/.test(md2));
  ok('作者为 Obsidian 双链', /作者: "\[\[罗翔说刑法\]\]"\n/.test(md2));
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
