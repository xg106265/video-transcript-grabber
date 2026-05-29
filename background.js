// 后台批量任务引擎。
//
// 2026 年的现实：YouTube 的 timedtext / get_transcript 接口都被 poToken 风控封死，
// 唯一可行的是抓 YouTube 自己渲染的「转写文稿」面板 DOM（它内部处理了 poToken）。
// 所以这里为每个视频开一个【后台标签页】真实导航过去，等转写面板渲染出来再扒 DOM。
// 实测后台/隐藏标签页(document.hidden=true)也能加载转写面板，因此不打扰用户。

importScripts('lib/format.js'); // → globalThis.__FMT

let JOB = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === 'START') {
    startJob(msg.payload);
    sendResponse({ ok: true });
  } else if (msg.type === 'STATUS') {
    sendResponse({ job: serialize(JOB) });
  } else if (msg.type === 'CANCEL') {
    if (JOB && JOB.status === 'running') JOB.cancelled = true;
    sendResponse({ ok: true });
  }
  return false;
});

// ---------------------------------------------------------------------------
// 在视频页（MAIN world）执行：打开转写面板 → 抓字幕段 → 读元信息。
// 必须自包含（会被序列化注入页面）。返回 {ok, rows:[{ts,text}], meta, error}。
// ---------------------------------------------------------------------------
async function grabInPage(opts) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();

  const getSegs = () => {
    const m = [...document.querySelectorAll('transcript-segment-view-model')];
    if (m.length) return { type: 'modern', segs: m };
    return { type: 'standard', segs: [...document.querySelectorAll('ytd-transcript-segment-renderer')] };
  };

  // ---- 元信息（即使没字幕也尽量返回）----
  const pr = window.ytInitialPlayerResponse || {};
  const vd = pr.videoDetails || {};
  const mf = (pr.microformat && pr.microformat.playerMicroformatRenderer) || {};
  const txt = (o) => (!o ? '' : o.simpleText || (o.runs || []).map((x) => x.text || '').join(''));
  const findCC = (root) => {
    if (!root || typeof root !== 'object') return '';
    const st = [root];
    let n = 0;
    while (st.length && n < 200000) {
      const x = st.pop();
      n++;
      if (!x || typeof x !== 'object') continue;
      if (x.commentsEntryPointHeaderRenderer) {
        const t = txt(x.commentsEntryPointHeaderRenderer.commentCount);
        if (t) return t;
      }
      if (x.commentCount) {
        const t = txt(x.commentCount);
        if (t) return t;
      }
      for (const k in x) {
        const v = x[k];
        if (v && typeof v === 'object') st.push(v);
      }
    }
    return '';
  };
  const meta = {
    title: vd.title || txt(mf.title) || '',
    author: vd.author || mf.ownerChannelName || '',
    publishDate: mf.publishDate || mf.uploadDate || '',
    viewCount: vd.viewCount || mf.viewCount || '',
    description: vd.shortDescription || txt(mf.description) || '',
    comments: findCC(window.ytInitialData),
  };

  const status = pr.playabilityStatus && pr.playabilityStatus.status;
  const gated = status && status !== 'OK' && status !== 'LIVE_STREAM_OFFLINE';

  try {
    // ---- 关键：静音播放视频 ----
    // 实测有些视频的转写内容只有在「视频实际播放」时才会加载（播放才生成 poToken），
    // 暂停时面板会一直转圈。所以先静音开播。
    const playVideo = () => {
      try {
        const v = document.querySelector('video');
        if (v) {
          v.muted = true;
          const p = v.play();
          if (p && p.catch) p.catch(() => {});
        }
      } catch (e) {}
    };

    // ---- 打开转写面板 ----
    // 转写面板渲染可快可慢（实测有的视频要 30s+ 才返回），所以超时给得很宽：
    // 找不到「打开按钮」≈ 没字幕，~15s 就放弃；找到了按钮则最多等 60s 让内容加载。
    window.scrollTo(0, 800); // 触发描述区懒加载
    playVideo();
    let btn = null;
    while (Date.now() - t0 < 15000) {
      if (getSegs().segs.length) break;
      btn = document.querySelector('ytd-video-description-transcript-section-renderer button');
      if (btn) break;
      await sleep(500);
    }
    if (!getSegs().segs.length) {
      if (!btn) {
        return {
          ok: false,
          meta,
          error: gated ? '无法访问：' + ((pr.playabilityStatus && pr.playabilityStatus.reason) || status) : '该视频没有字幕',
        };
      }
      btn.click();
      let tabClicked = false;
      let polls = 0;
      while (Date.now() - t0 < 60000) {
        if (getSegs().segs.length) break;
        if (polls++ % 6 === 0) playVideo(); // 每 ~3s 重试播放，防止首次 play 被拦
        if (!tabClicked) {
          // 仅点「转写文稿」tab；务必排除「关闭转写文稿」这种关闭按钮
          for (const e of document.querySelectorAll('yt-tab-shape, tp-yt-paper-tab, [role="tab"], button')) {
            const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
            if ((t === '转写文稿' || /^transcript$/i.test(t)) && !/关闭|close/i.test(t)) {
              e.click();
              tabClicked = true;
              break;
            }
          }
        }
        await sleep(500);
      }
    }

    const g = getSegs();
    if (!g.segs.length) return { ok: false, meta, error: '转写面板加载超时（可能该视频无字幕）' };

    const rowOf = (s) => {
      if (g.type === 'modern') {
        const c = s.cloneNode(true);
        c.querySelectorAll(
          '.ytwTranscriptSegmentViewModelTimestamp, .ytwTranscriptSegmentViewModelTimestampA11yLabel'
        ).forEach((e) => e.remove());
        return {
          ts: ((s.querySelector('.ytwTranscriptSegmentViewModelTimestamp') || {}).textContent || '').trim(),
          text: (c.textContent || '').replace(/\s+/g, ' ').trim(),
        };
      }
      return {
        ts: ((s.querySelector('.segment-timestamp') || {}).textContent || '').trim(),
        text: ((s.querySelector('.segment-text') || {}).textContent || '').replace(/\s+/g, ' ').trim(),
      };
    };
    const rows = g.segs.map(rowOf).filter((r) => r.text);
    return { ok: true, meta, rows };
  } catch (e) {
    return { ok: false, meta, error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// 在 B站标签页（MAIN world）执行：取 view（元信息）+ player/v2（字幕地址）。
// 这两个接口从 bilibili.com 页面发是 CORS 放行 + 带登录 cookie 的（已实测）。
// 字幕本体在 hdslb CDN，页面跨域被挡，所以这里只返回 subtitleUrl 交后台抓。
// 必须自包含（会被序列化注入页面）。
// ---------------------------------------------------------------------------
async function biliFetchVideo(bvid, mixin) {
  try {
    const vr = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, { credentials: 'include' });
    const vj = await vr.json();
    if (vj.code !== 0) return { ok: false, error: 'view接口 code=' + vj.code + (vj.message ? '（' + vj.message + '）' : '') };
    const d = vj.data || {};
    const meta = {
      bvid: bvid,
      title: d.title || '',
      author: (d.owner && d.owner.name) || '',
      pubdate: d.pubdate || 0,
      desc: d.desc || '',
      stat: d.stat
        ? { view: d.stat.view, danmaku: d.stat.danmaku, reply: d.stat.reply, like: d.stat.like }
        : {},
    };
    // 用 wbi 签名接口：非签名的 player/v2 对部分视频会把 subtitle_url 返回空（已实测）
    const wbi = globalThis.__BILIWBI;
    let url, q;
    if (mixin && wbi) {
      q = wbi.sign({ aid: d.aid, cid: d.cid, bvid: bvid }, mixin);
      url = 'https://api.bilibili.com/x/player/wbi/v2?' + q;
    } else {
      url = 'https://api.bilibili.com/x/player/v2?aid=' + d.aid + '&cid=' + d.cid + '&bvid=' + bvid;
    }
    const pj = await (await fetch(url, { credentials: 'include' })).json();
    const subs = (pj.data && pj.data.subtitle && pj.data.subtitle.subtitles) || [];
    if (!subs.length) return { ok: false, meta, error: '该视频没有字幕（B站未生成 AI 字幕或需登录）' };
    const pick =
      subs.find((s) => /^(ai-)?zh/i.test(s.lan)) ||
      subs.find((s) => /zh|chi|中/i.test(s.lan)) ||
      subs[0];
    let u = pick.subtitle_url || '';
    if (u.startsWith('//')) u = 'https:' + u;
    if (!u) return { ok: false, meta, error: '字幕地址为空（该视频字幕可能尚未生成完成）' };
    return { ok: true, meta, subtitleUrl: u, lang: pick.lan };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// 任务调度
// ---------------------------------------------------------------------------
async function startJob({ platform, videos, opts, zipName }) {
  JOB = {
    total: videos.length,
    done: 0,
    ok: 0,
    fail: 0,
    status: 'running',
    error: null,
    cancelled: false,
    items: videos.map((v) => ({ id: v.id, title: v.title, status: 'pending', error: null })),
    zipName,
  };
  broadcast();

  let workTabId = null;
  try {
    workTabId = await createWorkTab();
  } catch (e) {
    JOB.status = 'error';
    JOB.error = '无法创建工作标签页：' + (e.message || e);
    broadcast();
    return;
  }

  let results;
  let files;
  if (platform === 'bilibili') {
    await navigateAndWait(workTabId, 'https://www.bilibili.com/');
    results = await runBiliWorkers(workTabId, videos, opts);
    files = buildBiliFiles(results);
  } else {
    results = await runYouTubeLoop(workTabId, videos, opts);
    files = buildFiles(results, opts);
  }

  // ---- 打包下载（两个平台共用）----
  if (!files.length) {
    JOB.status = JOB.cancelled ? 'cancelled' : 'empty';
    broadcast();
    await closeTab(workTabId);
    return;
  }
  if (!JOB.cancelled) {
    JOB.status = 'zipping';
    broadcast();
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: workTabId }, files: ['lib/page-helpers.js'] });
    await chrome.scripting.executeScript({
      target: { tabId: workTabId },
      func: (f, z) => globalThis.__YTG.buildAndDownloadZip(f, z),
      args: [files, zipName || '文案.zip'],
    });
    JOB.status = JOB.cancelled ? 'cancelled' : 'finished';
    broadcast();
    await sleep(2500); // 等下载真正开始再关标签页
  } catch (e) {
    JOB.status = 'error';
    JOB.error = '打包下载失败：' + ((e && e.message) || e);
    broadcast();
  }
  await closeTab(workTabId);
}

// ---- YouTube：逐个导航 + 播放 + 抓转写面板（串行）----
async function runYouTubeLoop(workTabId, videos, opts) {
  const results = new Array(videos.length);
  for (let i = 0; i < videos.length; i++) {
    if (JOB.cancelled) break;
    const v = videos[i];
    JOB.items[i].status = 'fetching';
    broadcast();
    let r;
    try {
      await navigateAndWait(workTabId, 'https://www.youtube.com/watch?v=' + v.id + '&hl=en');
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId: workTabId },
        world: 'MAIN',
        func: grabInPage,
        args: [{ timestamps: !!opts.timestamps }],
      });
      r = inj && inj.result;
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }
    if (!r) r = { ok: false, error: '未知错误' };
    results[i] = { videoId: v.id, fallbackTitle: v.title, ...r };
    JOB.done++;
    if (r.ok) {
      JOB.ok++;
      JOB.items[i].status = 'done';
    } else {
      JOB.fail++;
      JOB.items[i].status = 'fail';
      JOB.items[i].error = r.error;
    }
    broadcast();
  }
  return results;
}

// ---- B站：纯 API（可并行）。view + player/v2 在 B站 tab 里取，字幕本体在后台取（绕 CORS）----
async function runBiliWorkers(workTabId, videos, opts) {
  const results = new Array(videos.length);
  const concurrency = Math.max(1, Math.min(5, opts.concurrency || 5));

  // 注入 wbi 签名工具到 MAIN world，并取一次当日 mixin key（拿不到就退回非签名接口）
  let mixin = '';
  try {
    await chrome.scripting.executeScript({ target: { tabId: workTabId }, world: 'MAIN', files: ['lib/bili-wbi.js'] });
    const [mk] = await chrome.scripting.executeScript({
      target: { tabId: workTabId },
      world: 'MAIN',
      func: async () => await globalThis.__BILIWBI.mixinKey(),
    });
    mixin = (mk && mk.result) || '';
  } catch (e) {}

  let next = 0;
  async function worker() {
    while (!JOB.cancelled) {
      const i = next++;
      if (i >= videos.length) return;
      const v = videos[i];
      JOB.items[i].status = 'fetching';
      broadcast();
      let r;
      try {
        const [inj] = await chrome.scripting.executeScript({
          target: { tabId: workTabId },
          world: 'MAIN',
          func: biliFetchVideo,
          args: [v.id, mixin],
        });
        r = inj && inj.result;
        if (r && r.ok && r.subtitleUrl) {
          const text = await biliFetchSubtitle(r.subtitleUrl, !!opts.timestamps);
          if (text && text.trim()) r.text = text;
          else {
            r.ok = false;
            r.error = '字幕内容为空';
          }
        }
      } catch (e) {
        r = { ok: false, error: String((e && e.message) || e) };
      }
      if (!r) r = { ok: false, error: '未知错误' };
      results[i] = { bvid: v.id, fallbackTitle: v.title, ...r };
      JOB.done++;
      if (r.ok) {
        JOB.ok++;
        JOB.items[i].status = 'done';
      } else {
        JOB.fail++;
        JOB.items[i].status = 'fail';
        JOB.items[i].error = r.error;
      }
      broadcast();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, videos.length) }, worker));
  return results;
}

// B站字幕本体在 *.hdslb.com，网页跨域被 CORS 挡，必须在后台用 host 权限抓。
async function biliFetchSubtitle(url, withTs) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) return '';
  const j = await r.json();
  const body = (j && j.body) || [];
  const fmtTs = (sec) => {
    const s = Math.floor(sec || 0);
    const p = (n) => String(n).padStart(2, '0');
    const h = Math.floor(s / 3600);
    return (h > 0 ? p(h) + ':' : '') + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60);
  };
  const lines = [];
  for (const seg of body) {
    const t = (seg.content || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    lines.push(withTs ? '[' + fmtTs(seg.from) + '] ' + t : t);
  }
  return lines.join('\n');
}

function buildFiles(results, opts) {
  const files = [];
  const used = new Set();
  for (const r of results) {
    if (!r || !r.ok) continue;
    const meta = r.meta || {};
    const rows = __FMT.dedupeRows(r.rows);
    const text = __FMT.rowsToText(rows, !!opts.timestamps);
    const base = __FMT.sanitize(meta.title) || r.videoId;
    let name = base + '.md';
    let n = 2;
    while (used.has(name.toLowerCase())) name = base + ' (' + n++ + ').md';
    used.add(name.toLowerCase());
    const fm = [
      { k: '标题', v: meta.title || r.videoId, q: true },
      { k: '来源', v: 'https://www.youtube.com/watch?v=' + r.videoId, q: false }, // 裸 URL → Obsidian 渲染为可点外链
      { k: '作者', v: meta.author ? '[[' + meta.author + ']]' : '', q: true }, // 双链 → 聚合同作者
      { k: '发布时间', v: __FMT.fmtDate(meta.publishDate), q: false },
      { k: '观看数', v: __FMT.fmtNum(meta.viewCount), q: false },
      { k: '评论数', v: meta.comments || '不可用', q: false },
      { k: '简介', v: meta.description || '', q: true },
    ];
    files.push({ name, data: __FMT.toMdObsidian({ fm, tags: [meta.author].filter(Boolean), text }) });
  }
  const fails = results.filter((r) => r && !r.ok);
  if (fails.length) {
    const lines = ['# 未能抓取的视频（共 ' + fails.length + ' 个）', ''];
    for (const r of fails) {
      const title = (r.meta && r.meta.title) || r.fallbackTitle || r.videoId;
      lines.push('- ' + title + '  (https://youtu.be/' + r.videoId + ') — ' + (r.error || '未知错误'));
    }
    files.push({ name: '_未抓取列表.md', data: lines.join('\n') + '\n' });
  }
  return files;
}

function buildBiliFiles(results) {
  const files = [];
  const used = new Set();
  for (const r of results) {
    if (!r || !r.ok) continue;
    const meta = r.meta || {};
    const s = meta.stat || {};
    const base = __FMT.sanitize(meta.title) || r.bvid;
    let name = base + '.md';
    let n = 2;
    while (used.has(name.toLowerCase())) name = base + ' (' + n++ + ').md';
    used.add(name.toLowerCase());
    const fm = [
      { k: '标题', v: meta.title || r.bvid, q: true },
      { k: '来源', v: 'https://www.bilibili.com/video/' + r.bvid, q: false }, // 裸 URL → 可点外链
      { k: '作者', v: meta.author ? '[[' + meta.author + ']]' : '', q: true }, // 双链 → 聚合同作者
      { k: '发布时间', v: __FMT.fmtUnixDate(meta.pubdate), q: false },
      { k: '播放', v: __FMT.fmtNum(s.view), q: false },
      { k: '弹幕', v: __FMT.fmtNum(s.danmaku), q: false },
      { k: '点赞', v: __FMT.fmtNum(s.like), q: false },
      { k: '评论', v: __FMT.fmtNum(s.reply), q: false },
      { k: '简介', v: meta.desc || '', q: true },
    ];
    files.push({ name, data: __FMT.toMdObsidian({ fm, tags: [meta.author].filter(Boolean), text: r.text }) });
  }
  const fails = results.filter((r) => r && !r.ok);
  if (fails.length) {
    const lines = ['# 未能抓取的视频（共 ' + fails.length + ' 个）', ''];
    for (const r of fails) {
      const title = (r.meta && r.meta.title) || r.fallbackTitle || r.bvid;
      lines.push('- ' + title + '  (https://www.bilibili.com/video/' + r.bvid + ') — ' + (r.error || '未知错误'));
    }
    files.push({ name: '_未抓取列表.md', data: lines.join('\n') + '\n' });
  }
  return files;
}

// ---------------------------------------------------------------------------
// 标签页工具
// ---------------------------------------------------------------------------
// 在当前窗口开一个后台标签页（不抢焦点）逐个抓取。
async function createWorkTab() {
  let windowId;
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    windowId = win && win.id;
  } catch (e) {}
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false, ...(windowId ? { windowId } : {}) });
  return tab.id;
}

async function closeTab(tabId) {
  if (tabId == null) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {}
}

function navigateAndWait(tabId, url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (tId, info) => {
      if (tId === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, 25000); // 兜底超时
    chrome.tabs.update(tabId, { url }).catch(finish);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function broadcast() {
  chrome.runtime.sendMessage({ type: 'PROGRESS', job: serialize(JOB) }).catch(() => {});
}

function serialize(j) {
  if (!j) return null;
  return {
    total: j.total,
    done: j.done,
    ok: j.ok,
    fail: j.fail,
    status: j.status,
    error: j.error,
    items: j.items,
    zipName: j.zipName,
  };
}
