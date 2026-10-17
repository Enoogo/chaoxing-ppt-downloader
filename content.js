/* 学习通课件下载器 - 内容脚本（只负责“发现”课件）
 *
 * 注意：内容脚本运行在隔离世界，读不到页面主世界的 JS 变量（如 window.fileinfo），
 * 所以下载动作统一交给后台 chrome.scripting.executeScript({world:'MAIN'}) 在页面
 * 主世界里执行——那里能读到 fileinfo，且 <a>.click() 自动带上 pan-yz 预览页的
 * Referer，直链才不会 403。
 */

function parseData(el) {
  const raw = el.getAttribute('data');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) {
    try { return JSON.parse(raw.replace(/&quot;/g, '"')); } catch (e2) { return null; }
  }
}

function abs(u) {
  try { return new URL(u, location.href).href; } catch (e) { return u || ''; }
}

function cleanName(s) {
  return (s || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/\s+/g, ' ').trim();
}

/* ---------- 收集课件 ---------- */

function collectDocs() {
  const docs = [];
  const push = (d) => {
    if (!d.objectId) return;
    if (docs.some((x) => x.objectId === d.objectId)) return;
    docs.push(d);
  };

  // 1) 课件卡片 iframe[objectid]，data 属性里有 objectid/name/type/size/pagenum
  document.querySelectorAll('iframe[objectid], iframe[data-objectid]').forEach((f) => {
    const d = parseData(f) || {};
    push({
      objectId: f.getAttribute('objectid') || f.getAttribute('data-objectid') || d.objectid || '',
      name: cleanName(d.name || ''),
      type: (d.type || '').toLowerCase(),
      size: d.size || 0,
      pagenum: d.pagenum || 0,
      viewerUrl: abs(f.getAttribute('src') || ''),
    });
  });

  // 2) 预览器页本身（页面主世界才有 window.fileinfo，隔离世界取不到就跳过）
  try {
    const el = document.getElementById('fileInfoNameInput');
    const m = location.pathname.match(/file_([0-9a-f]+)/i);
    if (m) {
      push({
        objectId: m[1],
        name: cleanName((el && el.value) || ''),
        type: '',
        size: 0,
        pagenum: 0,
        viewerUrl: location.href.split('#')[0],
      });
    }
  } catch (e) { /* 忽略 */ }

  // 3) a[href] 链接里带 objectId 的兜底
  document.querySelectorAll('a[href*="file_"], a[href*="objectId="], a[href*="objectid="]').forEach((a) => {
    const href = abs(a.getAttribute('href'));
    let id = '';
    try {
      const u = new URL(href);
      id = u.searchParams.get('objectId') || u.searchParams.get('objectid') || '';
      if (!id) {
        const mm = u.pathname.match(/file_([0-9a-f]{16,})/i);
        if (mm) id = mm[1];
      }
    } catch (e) { }
    if (!id) return;
    push({ objectId: id, name: cleanName(a.textContent), type: '', size: 0, pagenum: 0, viewerUrl: href });
  });

  return docs;
}

function collectImages() {
  const urls = [];
  document.querySelectorAll('img').forEach((img) => {
    const u = img.currentSrc || img.src || img.getAttribute('data-src') || '';
    if (/s3\.cldisk\.com\/sv-[^/]+\/doc\//.test(u) && urls.indexOf(u) < 0) urls.push(u);
  });
  return urls;
}

function send(payload) {
  try {
    chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
  } catch (e) { }
}

function report() {
  const docs = collectDocs();
  const imgs = collectImages();
  if (!docs.length && !imgs.length) return;
  send({ type: 'CX_PAGE', payload: { docs, images: imgs } });
  docs.forEach((doc) => send({ type: 'CX_RESOLVED', payload: Object.assign({}, doc) }));
}

report();
setTimeout(report, 1500);
setTimeout(report, 4000);
setTimeout(report, 8000);

try {
  new MutationObserver(() => report()).observe(document.documentElement, {
    childList: true, subtree: true,
  });
} catch (e) { }
