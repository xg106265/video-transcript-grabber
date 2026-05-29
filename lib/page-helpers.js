// 注入到 YouTube 标签页「隔离世界」运行的两个工具：
//   1) scrapeVideos —— 在频道/播放列表页扫描整页视频（含 Shorts）
//   2) buildAndDownloadZip —— 在页面里打包并触发 zip 下载（原生 deflate，零依赖）
// 字幕抓取不在这里——它需要 MAIN world 读页面全局，由 background.js 的 grabInPage 完成。
(() => {
  if (globalThis.__YTG) return; // 幂等
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // 扫描当前页面的视频列表（频道 /videos、/shorts、播放列表 /playlist 等）
  // ---------------------------------------------------------------------------
  async function scrapeVideos(maxScrollMs) {
    maxScrollMs = maxScrollMs || 60000;
    const scroller = document.scrollingElement || document.documentElement;
    let lastCount = -1;
    let stable = 0;
    const start = Date.now();
    while (Date.now() - start < maxScrollMs) {
      const n = collect().length;
      if (n === lastCount) {
        if (++stable >= 3) break;
      } else {
        stable = 0;
        lastCount = n;
      }
      window.scrollTo(0, scroller.scrollHeight);
      await sleep(700);
    }
    window.scrollTo(0, 0);
    return collect();
  }

  function collect() {
    // 注意：每个视频卡片通常有【两个】同 href 的链接——缩略图链接(文字是时长 12:49)
    // 和标题链接(文字是标题)。必须取标题，并拒绝纯时长字符串。
    const map = new Map(); // id -> {id, title}，保持文档顺序
    const sel = 'a[href*="watch?v="], a[href*="/shorts/"]';
    const isDur = (s) => /^[\d:]+$/.test(s); // 纯数字+冒号 = 时长，不是标题
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const idOf = (a) => {
      const m = (a.getAttribute('href') || '').match(/(?:[?&]v=|\/shorts\/)([\w-]{11})/);
      return m ? m[1] : null;
    };

    // 第一遍：优先取「标题类」链接的文字
    for (const a of document.querySelectorAll(sel)) {
      const id = idOf(a);
      if (!id) continue;
      if (!map.has(id)) map.set(id, { id, title: '' });
      const e = map.get(id);
      if (e.title) continue;
      const cls = a.getAttribute('class') || '';
      if (/Title/i.test(cls) || a.id === 'video-title' || a.id === 'video-title-link') {
        const t = clean(a.getAttribute('title') || a.textContent);
        if (t && !isDur(t)) e.title = t;
      }
    }

    // 第二遍：还没标题的，去卡片里找标题元素（兼容新旧版式 + Shorts）
    for (const a of document.querySelectorAll(sel)) {
      const id = idOf(a);
      if (!id) continue;
      const e = map.get(id);
      if (!e || e.title) continue;
      const card = a.closest(
        'ytd-rich-item-renderer, yt-lockup-view-model, ytd-grid-video-renderer, ' +
          'ytd-playlist-video-renderer, ytd-video-renderer, ytd-compact-video-renderer, ' +
          'ytd-reel-item-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2'
      );
      const tEl =
        card &&
        card.querySelector(
          'a.ytLockupMetadataViewModelTitle, .ytLockupMetadataViewModelTitle, ' +
            '#video-title, #video-title-link, .shortsLockupViewModelHostMetadataTitle, h3 a'
        );
      let t = clean(tEl && (tEl.getAttribute('title') || tEl.textContent));
      if (t && !isDur(t)) e.title = t;
      if (!e.title) {
        const at = clean(a.getAttribute('title') || a.getAttribute('aria-label'));
        if (at && !isDur(at)) e.title = at;
      }
    }

    for (const v of map.values()) if (!v.title) v.title = v.id;
    return [...map.values()];
  }

  // ---------------------------------------------------------------------------
  // B站：扫描 UP主投稿页的视频列表（分页，逐页点「下一页」累积）
  // ---------------------------------------------------------------------------
  async function scrapeBili(maxPages) {
    maxPages = maxPages || 40;
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const map = new Map();
    const merge = () => {
      for (const v of collectBili()) if (!map.has(v.id)) map.set(v.id, v);
    };
    let dry = 0;
    for (let page = 0; page < maxPages; page++) {
      // 等卡片渲染
      for (let i = 0; i < 16 && !document.querySelector('a[href*="/video/BV"]'); i++) await sleep(500);
      const before = map.size;
      merge();
      if (map.size === before) {
        if (++dry >= 2) break; // 连续两页没新增 → 结束
      } else dry = 0;
      // 找「下一页」按钮
      let next = null;
      for (const el of document.querySelectorAll('button, a')) {
        if (clean(el.textContent) === '下一页') {
          next = el;
          break;
        }
      }
      const disabled =
        next && (next.disabled || /disabled/.test(next.className || '') || next.getAttribute('aria-disabled') === 'true');
      if (!next || disabled) break;
      next.click();
      await sleep(1600); // 等翻页加载
    }
    return [...map.values()];
  }

  function collectBili() {
    const map = new Map();
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // 去掉数字/单位/常见徽标后还剩 <2 个字符 → 是播放量/时长之类，不是标题
    const statsy = (s) =>
      clean(s).replace(/[\d.,:：\s%]|万|亿|小时|分钟|播放|弹幕|最新|合作|联合投稿/g, '').length < 2;
    for (const a of document.querySelectorAll('a[href*="/video/BV"]')) {
      const m = (a.getAttribute('href') || a.href || '').match(/(BV[\w]+)/);
      if (!m) continue;
      const id = m[1];
      if (!map.has(id)) map.set(id, { id, title: '' });
      const e = map.get(id);
      const cls = a.getAttribute('class') || '';
      if (/cover|mask/i.test(cls)) continue; // 跳过封面链接（文字是播放/时长）
      const t = clean(a.getAttribute('title') || a.textContent);
      if (t && t.length >= 3 && !statsy(t) && t.length > e.title.length) e.title = t;
    }
    for (const v of map.values()) if (!v.title) v.title = v.id;
    return [...map.values()];
  }

  // ---------------------------------------------------------------------------
  // 打包 zip 并触发下载（原生 CompressionStream deflate-raw + CRC32）
  // ---------------------------------------------------------------------------
  async function buildAndDownloadZip(files, zipName) {
    const enc = new TextEncoder();
    const table = makeCrcTable();
    const chunks = [];
    const records = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const dataBytes = enc.encode(f.data);
      const crc = crc32(dataBytes, table);
      const compressed = await deflateRaw(dataBytes);
      const useComp = compressed.length < dataBytes.length;
      const body = useComp ? compressed : dataBytes;
      const method = useComp ? 8 : 0;

      const local = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true); // UTF-8 文件名
      dv.setUint16(8, method, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, body.length, true);
      dv.setUint32(22, dataBytes.length, true);
      dv.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);

      chunks.push(local, body);
      records.push({ nameBytes, crc, method, compSize: body.length, uncompSize: dataBytes.length, offset });
      offset += local.length + body.length;
    }

    const central = [];
    let cdSize = 0;
    for (const r of records) {
      const cd = new Uint8Array(46 + r.nameBytes.length);
      const dv = new DataView(cd.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, r.method, true);
      dv.setUint32(16, r.crc, true);
      dv.setUint32(20, r.compSize, true);
      dv.setUint32(24, r.uncompSize, true);
      dv.setUint16(28, r.nameBytes.length, true);
      dv.setUint32(42, r.offset, true);
      cd.set(r.nameBytes, 46);
      central.push(cd);
      cdSize += cd.length;
    }

    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, records.length, true);
    edv.setUint16(10, records.length, true);
    edv.setUint32(12, cdSize, true);
    edv.setUint32(16, offset, true);

    const blob = new Blob([...chunks, ...central, eocd], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = zipName || 'youtube-transcripts.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { ok: true, count: files.length };
  }

  async function deflateRaw(bytes) {
    const cs = new CompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  function makeCrcTable() {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  }

  function crc32(bytes, table) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  globalThis.__YTG = { scrapeVideos, scrapeBili, buildAndDownloadZip, version: '2.1.0' };
})();
