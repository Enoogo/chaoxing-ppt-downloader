/* 学习通课件下载器 - 后台服务
 *
 * 核心机制（全部实测验证过）：
 *  1. d0.cldisk.com/download/<objectId> 直链校验 Referer，必须由 pan-yz.chaoxing.com
 *     预览页发起点击（<a>.click() 会自动带上该 Referer）。
 *  2. 预览页的直链藏在页面主世界的 JS 变量 window.fileinfo.download 里，签名短时效。
 *  3. 内容脚本在隔离世界读不到 window.fileinfo，所以下载动作用
 *     chrome.scripting.executeScript({ world: 'MAIN' }) 在页面主世界里执行。
 */

const AUTO_MARK = '#cxdl';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------- 课件信息补全：抓取预览器 HTML ---------- */

async function enrichDoc(doc) {
  if (doc.enriched) return doc;

  const base = (doc.viewerUrl || '').split('#')[0];
  const candidates = [];
  if (base) candidates.push(base);
  if (doc.objectId) {
    candidates.push('https://pan-yz.chaoxing.com/screen/v2/file_' + doc.objectId);
    candidates.push('https://pan-yz.chaoxing.com/screen/v2/file_' + doc.objectId + '.pptx');
    if (doc.type) candidates.push('https://pan-yz.chaoxing.com/screen/v2/file_' + doc.objectId + '.' + doc.type);
  }

  for (const url of candidates) {
    let html = '';
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) continue;
      html = await res.text();
    } catch (e) { continue; }
    if (!/fileinfo|download/i.test(html)) continue;

    if (!doc.name) {
      const m = html.match(/id="fileInfoNameInput"[^>]*value="([^"]*)"/);
      if (m && m[1]) doc.name = m[1];
    }
    if (!doc.pagenum) {
      const m = html.match(/['"]pagenum['"]\s*:\s*['"]?(\d+)/);
      if (m) doc.pagenum = parseInt(m[1], 10) || 0;
    }
    if (!doc.size) {
      const m = html.match(/['"]filesize['"]\s*:\s*['"]?(\d+)/);
      if (m) doc.size = parseInt(m[1], 10) || 0;
    }
    const imgs = [];
    const re = /https?:\/\/s3\.cldisk\.com\/sv-[^"'\s\\]+\/thumb\/\d+\.png/g;
    let mm;
    while ((mm = re.exec(html))) {
      const u = mm[0].replace(/\\u002F/g, '/');
      if (imgs.indexOf(u) < 0) imgs.push(u);
    }
    if (imgs.length && (!doc.imageUrls || !doc.imageUrls.length)) {
      doc.imageUrls = imgs.sort((a, b) => {
        const na = parseInt((a.match(/(\d+)\.png$/) || [0, 0])[1], 10);
        const nb = parseInt((b.match(/(\d+)\.png$/) || [0, 0])[1], 10);
        return na - nb;
      });
    }
    doc.viewerUrl = url;
    break;
  }

  doc.enriched = true;
  return doc;
}

/* ---------- 在页面主世界里点击下载（唯一可行的下载方式） ---------- */

async function pageWorldDownload(tabId, objectId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      args: [objectId || ''],
      func: (wantId) => {
        try {
          const info = window.fileinfo;
          if (!info || !info.download) return null;
          if (wantId && info.objectId && info.objectId !== wantId) return null;
          const a = document.createElement('a');
          a.href = info.download;
          if (info.name) a.download = info.name;
          (document.body || document.documentElement).appendChild(a);
          a.click();
          setTimeout(() => a.remove(), 3000);
          return { ok: true, name: info.name || '', objectId: info.objectId || '' };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
    });
  } catch (e) {
    return null;
  }
  for (const r of results || []) {
    if (r && r.result && r.result.ok) return r.result;
  }
  return null;
}

/* 依次尝试若干标签页（预览可能已经在某个标签页里打开着） */
async function tryExistingTabs(doc, hintTabId) {
  const tried = new Set();
  const order = [];
  if (hintTabId) order.push(hintTabId);
  if (doc.viewerTabId) order.push(doc.viewerTabId);
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.chaoxing.com/*' });
    tabs.forEach((t) => order.push(t.id));
  } catch (e) { /* 忽略 */ }

  for (const id of order) {
    if (!id || tried.has(id)) continue;
    tried.add(id);
    const r = await pageWorldDownload(id, doc.objectId);
    if (r) return r;
  }
  return null;
}

/* 兜底：后台开一个隐藏的预览标签页，等它加载好就自动下载，然后关掉 */
async function downloadViaAutoTab(doc) {
  const viewerUrl = doc.viewerUrl;
  if (!viewerUrl) throw new Error('未获取到预览地址，请手动点开课件预览一次，再点「下载原件」');

  const tab = await chrome.tabs.create({ url: viewerUrl.split('#')[0] + AUTO_MARK, active: false });
  try {
    for (let i = 0; i < 25; i++) {
      await sleep(700);
      const r = await pageWorldDownload(tab.id, doc.objectId);
      if (r) {
        setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 4000);
        return r;
      }
    }
    throw new Error('自动下载未触发，请把课件预览点开一次，再点「下载原件」');
  } finally {
    setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 60000);
  }
}

async function handleDownloadOriginal(msg) {
  const docs = await loadDocs(msg.tabId || 0);
  const stored = msg.objectId ? docs[msg.objectId] : null;
  const doc = await enrichDoc(Object.assign({}, stored || {}, msg.doc || {}));
  if (!doc.objectId) doc.objectId = msg.objectId || '';
  if (!doc.objectId) throw new Error('缺少 objectId');

  const direct = await tryExistingTabs(doc, msg.tabId);
  if (direct) {
    return { ok: true, via: 'viewer', name: direct.name || doc.name, message: '已触发下载：' + (direct.name || doc.name || '课件') };
  }

  const r = await downloadViaAutoTab(doc);
  return { ok: true, via: 'auto-tab', name: r.name || doc.name, message: '已自动打开预览并触发下载：' + (r.name || doc.name || '课件') };
}

/* ---------- 图片兜底下载（s3.cldisk.com 缩略图公开可直取） ---------- */

function handleDownloadImage(msg) {
  const url = msg.url;
  if (!url || !/^https:\/\/s3\.cldisk\.com\//.test(url)) {
    return Promise.resolve({ ok: false, message: '图片地址不合法' });
  }
  const safe = (s, dflt) => String(s || dflt).replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || dflt;
  const filename = msg.filename
    ? '课件图片/' + safe(msg.filename, 'page.png')
    : '课件图片/' + safe(msg.docName, '课件') + '_' + String(msg.index || 1).padStart(2, '0') + '.png';
  return chrome.downloads.download({ url, filename, saveAs: false }).then(
    (id) => ({ ok: true, id, message: '已下载 ' + filename }),
    (e) => ({ ok: false, message: String(e && e.message || e) })
  );
}

/* ---------- 存储 ---------- */

function storageKey(tabId) { return 'cxdocs_' + tabId; }

async function loadDocs(tabId) {
  const key = storageKey(tabId);
  const obj = await chrome.storage.local.get(key);
  return obj[key] || {};
}

async function saveDocs(tabId, docs) {
  await chrome.storage.local.set({ [storageKey(tabId)]: docs });
}

async function upsertDoc(tabId, doc) {
  const docs = await loadDocs(tabId);
  docs[doc.objectId] = Object.assign({}, docs[doc.objectId] || {}, doc, { updatedAt: Date.now() });
  await saveDocs(tabId, docs);
  return docs;
}

/* ---------- 消息 ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = (msg && msg.tabId) || (sender && sender.tab && sender.tab.id);
  if (!msg || !msg.type) return;

  if (msg.type === 'CX_PAGE' || msg.type === 'CX_RESOLVED') {
    const p = msg.payload || {};
    if (p.objectId) {
      upsertDoc(tabId, p).then(() => sendResponse({ ok: true }));
      return true;
    }
    (async () => {
      const docs = await loadDocs(tabId);
      const list = p.docs || [];
      for (const d of list) {
        if (!d.objectId) continue;
        docs[d.objectId] = Object.assign({}, docs[d.objectId] || {}, d, { updatedAt: Date.now() });
      }
      await saveDocs(tabId, docs);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'CX_LIST') {
    loadDocs(tabId).then((docs) => sendResponse({ ok: true, docs: Object.values(docs) }));
    return true;
  }

  if (msg.type === 'CX_DOWNLOAD_ORIGINAL') {
    handleDownloadOriginal(msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === 'CX_DOWNLOAD_IMAGE') {
    handleDownloadImage(msg).then(sendResponse);
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(storageKey(tabId));
});
