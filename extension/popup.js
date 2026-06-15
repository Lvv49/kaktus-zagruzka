const DEFAULT_API = 'http://127.0.0.1:8081';

const urlInput = document.getElementById('url-input');
const analyzeBtn = document.getElementById('analyze-btn');
const downloadBtn = document.getElementById('download-btn');
const grabBtn = document.getElementById('grab-btn');
const errorBox = document.getElementById('error-box');
const resultEl = document.getElementById('result');
const formatSelect = document.getElementById('format-select');
const serverStatus = document.getElementById('server-status');

let apiUrl = DEFAULT_API;
let currentUrl = '';
let videoData = null;

async function getApiUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['apiUrl'], (data) => {
      resolve(data.apiUrl || DEFAULT_API);
    });
  });
}

async function detectApiUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) {
    try {
      const u = new URL(tab.url);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.endsWith('.onrender.com')) {
        const base = `${u.protocol}//${u.host}`;
        chrome.storage.local.set({ apiUrl: base });
        document.querySelector('.footer a').href = base;
        return base;
      }
    } catch {}
  }
  return getApiUrl();
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}

function hideError() {
  errorBox.classList.add('hidden');
}

function setLoading(btn, loading) {
  const text = btn.querySelector('.btn-text');
  const loader = btn.querySelector('.btn-loader');
  btn.disabled = loading;
  if (text) text.classList.toggle('hidden', loading);
  if (loader) loader.classList.toggle('hidden', !loading);
}

async function checkServer() {
  try {
    const res = await fetch(`${apiUrl}/`, { method: 'HEAD' });
    serverStatus.textContent = 'Сервер подключён';
    serverStatus.className = 'status online';
    return res.ok;
  } catch {
    serverStatus.textContent = 'Сервер недоступен';
    serverStatus.className = 'status offline';
    return false;
  }
}

async function grabCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https?:\/\//.test(tab.url)) {
    urlInput.value = tab.url;
    hideError();
  } else {
    showError('На этой вкладке нет ссылки');
  }
}

function renderResult(data) {
  document.getElementById('video-title').textContent = data.title;
  document.getElementById('video-meta').textContent =
    `${data.uploader} · ${data.duration} · ${data.platform}`;

  const thumb = document.getElementById('thumbnail');
  if (data.thumbnail) {
    thumb.src = data.thumbnail;
    thumb.classList.remove('hidden');
  } else {
    thumb.classList.add('hidden');
  }

  formatSelect.innerHTML = '';
  data.formats.forEach((fmt) => {
    const opt = document.createElement('option');
    opt.value = fmt.format_id;
    const rec = fmt.recommended ? ' ★' : '';
    opt.textContent = `${fmt.label}${rec} — ${fmt.filesize}`;
    formatSelect.appendChild(opt);
  });

  resultEl.classList.remove('hidden');
}

async function analyze() {
  const url = urlInput.value.trim();
  if (!url) {
    showError('Вставьте ссылку на видео');
    return;
  }

  hideError();
  setLoading(analyzeBtn, true);
  resultEl.classList.add('hidden');

  try {
    const res = await fetch(`${apiUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Не удалось обработать ссылку');

    currentUrl = url;
    videoData = data;
    renderResult(data);
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(analyzeBtn, false);
  }
}

async function download() {
  if (!currentUrl || !formatSelect.value) return;

  hideError();
  setLoading(downloadBtn, true);

  try {
    const params = new URLSearchParams({
      url: currentUrl,
      format_id: formatSelect.value,
    });

    const downloadUrl = `${apiUrl}/api/download?${params}`;
    const title = videoData?.title || 'video';
    const ext = formatSelect.selectedOptions[0]?.textContent?.includes('M4A') ? '.m4a'
      : formatSelect.selectedOptions[0]?.textContent?.includes('WEBM') ? '.webm' : '.mp4';
    const filename = `${title.slice(0, 80)}${ext}`.replace(/[<>:"/\\|?*]/g, '');

    chrome.runtime.sendMessage(
      { type: 'download', url: downloadUrl, filename },
      (resp) => {
        if (!resp?.ok) {
          showError(resp?.error || 'Ошибка скачивания');
        }
        setLoading(downloadBtn, false);
      }
    );
  } catch (err) {
    showError(err.message);
    setLoading(downloadBtn, false);
  }
}

analyzeBtn.addEventListener('click', analyze);
downloadBtn.addEventListener('click', download);
grabBtn.addEventListener('click', grabCurrentTab);

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') analyze();
});

(async () => {
  apiUrl = await detectApiUrl();
  await checkServer();
  await grabCurrentTab();
})();
