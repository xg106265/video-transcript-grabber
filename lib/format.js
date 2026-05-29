// 纯格式化逻辑（无 DOM / 无 chrome 依赖），后台 service worker 通过 importScripts 加载，
// 单元测试直接 eval。对外暴露 globalThis.__FMT。
(() => {
  // 按 (时间戳|文本) 去重——YouTube 转写面板在 DOM 里常有多份副本，段数会翻倍
  function dedupeRows(rows) {
    const seen = new Set();
    const out = [];
    for (const r of rows || []) {
      if (!r || !r.text) continue;
      const k = (r.ts || '') + '|' + r.text;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out;
  }

  function rowsToText(rows, withTs) {
    return (rows || [])
      .map((r) => (withTs && r.ts ? '[' + r.ts + '] ' + r.text : r.text))
      .join('\n');
  }

  function sanitize(name) {
    return (name || '')
      .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  function fmtNum(s) {
    const d = String(s == null ? '' : s).replace(/[^\d]/g, '');
    if (!d) return s ? String(s) : '—';
    return Number(d).toLocaleString('en-US');
  }

  function fmtDate(d) {
    if (!d) return '—';
    const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[1] + '-' + m[2] + '-' + m[3] : String(d);
  }

  // r: {videoId, title, author, publishDate, viewCount, comments, description, text}
  function toMd(r) {
    const url = 'https://www.youtube.com/watch?v=' + r.videoId;
    return [
      '# ' + (r.title || r.videoId),
      '',
      '- 链接：' + url,
      '- 作者：' + (r.author || '—'),
      '- 发布时间：' + fmtDate(r.publishDate),
      '- 观看数：' + fmtNum(r.viewCount),
      '- 评论数：' + (r.comments || '不可用'),
      '',
      '## 视频描述',
      '',
      r.description ? r.description : '（无描述）',
      '',
      '## 字幕文案',
      '',
      r.text || '',
      '',
    ].join('\n');
  }

  function fmtUnixDate(sec) {
    const n = Number(sec);
    if (!n) return '—';
    const d = new Date(n * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // B站：r = {bvid, title, author, pubdate(unix秒), stat:{view,danmaku,reply,like}, desc, text}
  function toMdBili(r) {
    const url = 'https://www.bilibili.com/video/' + r.bvid;
    const s = r.stat || {};
    return [
      '# ' + (r.title || r.bvid),
      '',
      '- 链接：' + url,
      '- UP主：' + (r.author || '—'),
      '- 发布时间：' + fmtUnixDate(r.pubdate),
      '- 播放：' + fmtNum(s.view),
      '- 弹幕：' + fmtNum(s.danmaku),
      '- 评论：' + fmtNum(s.reply),
      '- 点赞：' + fmtNum(s.like),
      '',
      '## 视频简介',
      '',
      r.desc ? r.desc : '（无简介）',
      '',
      '## 字幕文案',
      '',
      r.text || '',
      '',
    ].join('\n');
  }

  const api = { dedupeRows, rowsToText, sanitize, fmtNum, fmtDate, fmtUnixDate, toMd, toMdBili };
  if (typeof globalThis !== 'undefined') globalThis.__FMT = api;
})();
