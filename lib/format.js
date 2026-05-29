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

  // 秒 → 视频长度：<1 小时显示 M:SS，≥1 小时显示 H:MM:SS
  function fmtDuration(sec) {
    const s = Math.floor(Number(sec) || 0);
    if (!s) return '—';
    const p = (n) => String(n).padStart(2, '0');
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return (h > 0 ? h + ':' + p(m) : String(m)) + ':' + p(s % 60);
  }

  function fmtUnixDate(sec) {
    const n = Number(sec);
    if (!n) return '—';
    const d = new Date(n * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // YAML 双引号字符串，转义 \ " 换行 制表符——简介这类长文本/多行也能安全放进 frontmatter
  function yamlStr(s) {
    return (
      '"' +
      String(s == null ? '' : s)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, '\\n')
        .replace(/\t/g, ' ') +
      '"'
    );
  }

  // Obsidian 标签不能含空格：空格→连字符，去掉 # , [ ] 等会破坏标签的字符
  function sanitizeTag(t) {
    return String(t == null ? '' : t)
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[#,\[\]"'`]/g, '');
  }

  // Obsidian 风格：YAML frontmatter（含简介）+ 正文只放字幕。
  // o = { fm: [{k, v, q}], tags: [...], text }
  //   fm 为有序字段；q=true 的值用 YAML 双引号转义（标题/来源/作者/简介等文本），
  //   q=false 直接作为纯标量（日期、数字）。
  function toMdObsidian(o) {
    const L = ['---'];
    for (const f of o.fm || []) {
      const v = f.q ? yamlStr(f.v) : f.v === '' || f.v == null ? '""' : String(f.v);
      L.push(f.k + ': ' + v);
    }
    const tags = (o.tags || []).map(sanitizeTag).filter(Boolean);
    if (tags.length) {
      L.push('tags:');
      for (const t of tags) L.push('  - ' + t);
    } else {
      L.push('tags: []');
    }
    L.push('---', '', o.text || '', '');
    return L.join('\n');
  }

  const api = { dedupeRows, rowsToText, sanitize, fmtNum, fmtDate, fmtUnixDate, fmtDuration, yamlStr, sanitizeTag, toMdObsidian };
  if (typeof globalThis !== 'undefined') globalThis.__FMT = api;
})();
