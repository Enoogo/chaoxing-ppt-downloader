/* 学习通课件下载器 - 弹窗脚本 */

const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");

let tabId = null;
let docs = [];

function fmtSize(s) {
  const n = Number(s);
  if (!n) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function extOf(d) {
  if (d.suffix) return d.suffix.replace(/^\./, "");
  const m = (d.name || "").match(/\.([a-z0-9]+)$/i);
  return m ? m[1] : "";
}

function displayName(d) {
  return d.name || "课件 " + String(d.objectId || "").slice(0, 10);
}

function outName(d, ext) {
  const base = displayName(d).replace(/\.[a-z0-9]+$/i, "");
  return base + (ext ? "." + ext : "");
}

async function load() {
  statusEl.textContent = "正在读取当前页面…";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;
  const res = await chrome.runtime.sendMessage({ type: "CX_LIST", tabId });
  docs = (res && res.docs) || [];
  render();
}

function render() {
  listEl.innerHTML = "";

  if (!docs.length) {
    statusEl.textContent =
      "当前标签页还没发现课件。请打开学习通课程里包含 PPT/文档的章节页面，稍等 1~2 秒再点「刷新检测」。";
    return;
  }

  statusEl.textContent = "发现 " + docs.length + " 个课件：";

  docs.forEach((d) => {
    const item = document.createElement("div");
    item.className = "item";

    const meta = [extOf(d), fmtSize(d.filesize || d.size), d.pages ? d.pages + " 页" : ""]
      .filter(Boolean)
      .join(" · ");

    item.innerHTML =
      '<div class="name"></div><div class="meta"></div><div class="btns"></div>';
    item.querySelector(".name").textContent = displayName(d);
    item.querySelector(".meta").textContent = meta || d.objectId;

    const btns = item.querySelector(".btns");

    const dlBtn = document.createElement("button");
    dlBtn.className = "primary";
    dlBtn.textContent = "⬇️ 下载原件";
    dlBtn.addEventListener("click", () => downloadOriginal(d, dlBtn));
    btns.appendChild(dlBtn);

    if (d.images && d.images.length) {
      const imgBtn = document.createElement("button");
      imgBtn.textContent = "🖼️ 页面图片(" + d.images.length + ")";
      imgBtn.addEventListener("click", () => downloadImages(d, imgBtn));
      btns.appendChild(imgBtn);
    }

    listEl.appendChild(item);
  });
}

async function downloadOriginal(d, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "处理中…";
  try {
    const res = await chrome.runtime.sendMessage({
      type: "CX_DOWNLOAD_ORIGINAL",
      tabId,
      objectId: d.objectId,
    });
    if (res && res.error) throw new Error(res.error);
    btn.textContent =
      res && res.via === "auto-tab" ? "✅ 已打开预览页自动下载" : "✅ 已开始下载";
  } catch (e) {
    btn.textContent = "❌ " + e.message;
  }
  setTimeout(() => {
    btn.textContent = label;
    btn.disabled = false;
  }, 3000);
}

async function downloadImages(d, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const imgs = d.images || [];
    for (let i = 0; i < imgs.length; i++) {
      btn.textContent = "下载中 " + (i + 1) + "/" + imgs.length;
      const m = imgs[i].match(/\.([a-z0-9]+)(\?|$)/i);
      const ext = m ? m[1] : "png";
      const res = await chrome.runtime.sendMessage({
        type: "CX_DOWNLOAD_IMAGE",
        url: imgs[i],
        docName: outName(d, ""),
        index: i + 1,
        filename: outName(d, "") + "_p" + String(i + 1).padStart(2, "0") + "." + ext,
      });
      if (!res || !res.ok) throw new Error((res && res.message) || "下载失败");
    }
    btn.textContent = "✅ 全部已下载";
  } catch (e) {
    btn.textContent = "❌ " + e.message;
  }
  setTimeout(() => {
    btn.textContent = label;
    btn.disabled = false;
  }, 3000);
}

refreshBtn.addEventListener("click", load);
load();
