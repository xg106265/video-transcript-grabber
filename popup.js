const $ = (s) => document.querySelector(s);

let tab = null;
let platform = null; // 'youtube' | 'bilibili'
let videos = []; // 扫描到的全部视频 [{id, title}]

document.addEventListener('DOMContentLoaded', init);

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || '';
  if (/^https?:\/\/(www|m)\.youtube\.com\//.test(url)) platform = 'youtube';
  else if (/^https?:\/\/(www|m|space)\.bilibili\.com\//.test(url)) platform = 'bilibili';

  if (!platform) {
    show('#not-yt');
    return;
  }

  // 若后台已有任务在跑（弹窗曾被关掉），直接进入进度界面
  const { job } = await chrome.runtime.sendMessage({ type: 'STATUS' });
  if (job && (job.status === 'running' || job.status === 'zipping')) {
    show('#progress');
    renderProgress(job);
  } else {
    show('#main');
  }

  await restoreOptions();
  bindEvents();
}

function show(sel) {
  for (const id of ['#not-yt', '#main', '#progress']) $(id).classList.add('hidden');
  $(sel).classList.remove('hidden');
}

function bindEvents() {
  $('#scan').addEventListener('click', onScan);
  $('#checkAll').addEventListener('change', (e) => {
    document.querySelectorAll('#list input[type=checkbox]').forEach((c) => (c.checked = e.target.checked));
  });
  $('#download').addEventListener('click', onDownload);
  $('#cancel').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CANCEL' });
  });
  $('#back').addEventListener('click', () => show('#main'));

  for (const id of ['#timestamps', '#zipName']) {
    $(id).addEventListener('change', saveOptions);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'PROGRESS' && msg.job) renderProgress(msg.job);
  });
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------
async function onScan() {
  const btn = $('#scan');
  btn.disabled = true;
  $('#scan-status').textContent =
    platform === 'bilibili' ? '正在逐页扫描 UP主投稿…' : '正在滚动加载并扫描…（最长约 1 分钟）';
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/page-helpers.js'] });
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (p) => (p === 'bilibili' ? globalThis.__YTG.scrapeBili() : globalThis.__YTG.scrapeVideos()),
      args: [platform],
    });
    videos = (inj && inj.result) || [];
  } catch (e) {
    $('#scan-status').textContent = '扫描失败：' + (e.message || e);
    btn.disabled = false;
    return;
  }
  btn.disabled = false;

  if (!videos.length) {
    $('#scan-status').textContent =
      platform === 'bilibili'
        ? '没扫描到视频，请确认停在 UP主的「投稿视频」列表页。'
        : '没扫描到视频，请确认页面停在频道/播放列表的视频列表上。';
    return;
  }
  $('#scan-status').textContent = '';
  $('#options').classList.remove('hidden');
  $('#list-head').classList.remove('hidden');
  $('#actions').classList.remove('hidden');
  if (!$('#zipName').value) $('#zipName').value = defaultZipName();
  renderList();
}

function renderList() {
  $('#count').textContent = '共 ' + videos.length + ' 个';
  const ul = $('#list');
  ul.innerHTML = '';
  for (const v of videos) {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.id = v.id;
    const span = document.createElement('span');
    span.className = 'title';
    span.textContent = v.title;
    span.title = v.title;
    li.append(cb, span);
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------
async function onDownload() {
  const selectedIds = new Set(
    [...document.querySelectorAll('#list input[type=checkbox]:checked')].map((c) => c.dataset.id)
  );
  const picked = videos.filter((v) => selectedIds.has(v.id));
  if (!picked.length) {
    alert('请至少勾选一个视频');
    return;
  }

  let zipName = $('#zipName').value.trim() || defaultZipName();
  if (!/\.zip$/i.test(zipName)) zipName += '.zip';

  const opts = {
    timestamps: $('#timestamps').checked,
  };

  await chrome.runtime.sendMessage({
    type: 'START',
    payload: { platform, videos: picked, opts, zipName },
  });

  show('#progress');
  renderProgress({ total: picked.length, done: 0, ok: 0, fail: 0, status: 'running', items: [] });
}

// ---------------------------------------------------------------------------
// 进度
// ---------------------------------------------------------------------------
function renderProgress(job) {
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  $('#bar-fill').style.width = pct + '%';

  const map = {
    running:
      platform === 'bilibili'
        ? '抓取中…（B站走接口，较快，可并行）'
        : '抓取中…（在后台标签页逐个打开视频，每个约 10–20 秒）',
    zipping: '正在打包…',
    finished: '完成 ✓ 文件已开始下载',
    cancelled: '已取消（已抓到的部分已打包下载）',
    empty: '没有抓到任何字幕',
    error: '出错：' + (job.error || ''),
  };
  $('#progress-text').textContent =
    (map[job.status] || '') + `  （成功 ${job.ok} / 失败 ${job.fail} / 共 ${job.total}）`;

  const done = ['finished', 'cancelled', 'empty', 'error'].includes(job.status);
  $('#cancel').classList.toggle('hidden', done);
  $('#back').classList.toggle('hidden', !done);

  const ul = $('#progress-list');
  ul.innerHTML = '';
  for (const it of job.items || []) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'title';
    span.textContent = it.title;
    span.title = it.title;
    const st = document.createElement('span');
    st.className = 'status ' + it.status;
    st.textContent =
      it.status === 'done'
        ? '✓'
        : it.status === 'fail'
        ? '✗ ' + (it.error || '')
        : it.status === 'fetching'
        ? '…'
        : '';
    if (it.status === 'fail') st.title = it.error || '';
    li.append(span, st);
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// 选项持久化 + 工具
// ---------------------------------------------------------------------------
function defaultZipName() {
  let t = (tab && tab.title) ? tab.title : '';
  t = t.replace(/\s*-\s*YouTube\s*$/i, '').replace(/[_\-]?哔哩哔哩.*$/, '').replace(/投稿视频.*$/, '').trim();
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const fallback = platform === 'bilibili' ? 'B站-文案' : 'youtube-文案';
  const base = (t || fallback).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${base}-${stamp}.zip`;
}

async function saveOptions() {
  await chrome.storage.local.set({
    opts: { timestamps: $('#timestamps').checked },
  });
}

async function restoreOptions() {
  const { opts } = await chrome.storage.local.get('opts');
  if (!opts) return;
  if (typeof opts.timestamps === 'boolean') $('#timestamps').checked = opts.timestamps;
}
