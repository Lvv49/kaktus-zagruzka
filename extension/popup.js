const PRODUCTION_SITE = 'https://kaktus-zagruzka.onrender.com';
const DEFAULT_API = PRODUCTION_SITE;

const urlInput = document.getElementById('url-input');
const analyzeBtn = document.getElementById('analyze-btn');
const downloadBtn = document.getElementById('download-btn');
const grabBtn = document.getElementById('grab-btn');
const errorBox = document.getElementById('error-box');
const resultEl = document.getElementById('result');
const formatSelect = document.getElementById('format-select');
const serverStatus = document.getElementById('server-status');

const cookiesInput = document.getElementById('cookies-input');
const cookiesBlock = document.getElementById('cookies-block');

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
  const siteLink = document.querySelector('.footer a');
  if (siteLink) siteLink.href = PRODUCTION_SITE;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) {
    try {
      const u = new URL(tab.url);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
        const base = `${u.protocol}//${u.host}`;
        chrome.storage.local.set({ apiUrl: base });
        return base;
      }
      if (u.hostname.endsWith('.onrender.com')) {
        const base = `${u.protocol}//${u.host}`;
        chrome.storage.local.set({ apiUrl: base });
        return base;
      }
    } catch {}
  }
  return getApiUrl();
}

function getCookies() {
  return cookiesInput.value.trim() || null;
}

async function loadAutoCookies() {
  const cookies = await syncYoutubeCookies();
  if (cookies) {
    cookiesInput.value = cookies;
    document.getElementById('cookies-status').textContent = '✓ YouTube cookies подключены автоматически';
    document.getElementById('cookies-status').classList.remove('hidden');
    cookiesBlock.classList.add('hidden');
  }
  return cookies;
}

chrome.storage.local.get(['ytCookies'], async (data) => {
  if (data.ytCookies) {
    cookiesInput.value = data.ytCookies;
    document.getElementById('cookies-status').textContent = '✓ YouTube cookies подключены автоматически';
    document.getElementById('cookies-status').classList.remove('hidden');
  }
  await loadAutoCookies();
});

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

function setThumbnail(thumb, data) {
  const urls = [];
  if (data.thumbnail) {
    urls.push(data.thumbnail);
    if (data.thumbnail.includes('.webp')) {
      urls.push(data.thumbnail.replace('vi_webp/', 'vi/').replace('.webp', '.jpg'));
    }
  }
  if (data.video_id) {
    urls.push(`https://i.ytimg.com/vi/${data.video_id}/hqdefault.jpg`);
    urls.push(`https://i.ytimg.com/vi/${data.video_id}/mqdefault.jpg`);
  }

  if (!urls.length) {
    thumb.classList.add('hidden');
    return;
  }

  let index = 0;
  thumb.referrerPolicy = 'no-referrer';

  function tryNext() {
    if (index >= urls.length) {
      thumb.classList.add('hidden');
      return;
    }
    thumb.src = urls[index++];
  }

  thumb.onload = () => thumb.classList.remove('hidden');
  thumb.onerror = tryNext;
  tryNext();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollDownloadReady(token, onProgress) {
  for (let i = 0; i < 300; i++) {
    const res = await fetch(`${apiUrl}/api/download/status/${token}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || 'Ошибка подготовки файла');
    }
    if (data.status === 'ready') return data;
    if (data.status === 'error') {
      throw new Error(data.error || 'Ошибка скачивания');
    }
    if (onProgress) onProgress(i, data.status);
    await sleep(2000);
  }
  throw new Error('Слишком долго. Выберите формат «хорошее качество» (b) и попробуйте снова.');
}

function sanitizeFilename(name) {
  return (name || 'video').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 120) || 'video';
}

function defaultFormatIndex(formats) {
  let idx = formats.findIndex((f) => f.format_id === 'b');
  if (idx >= 0) return idx;
  idx = formats.findIndex((f) => f.recommended);
  if (idx >= 0) return idx;
  idx = formats.findIndex((f) => f.filesize && f.filesize !== '—');
  if (idx >= 0) return idx;
  return 0;
}

function renderResult(data) {
  document.getElementById('video-title').textContent = data.title;
  document.getElementById('video-meta').textContent =
    `${data.uploader} · ${data.duration} · ${data.platform}`;

  setThumbnail(document.getElementById('thumbnail'), data);

  formatSelect.innerHTML = '';
  data.formats.forEach((fmt) => {
    const opt = document.createElement('option');
    opt.value = fmt.format_id;
    const rec = fmt.recommended ? ' ★' : '';
    opt.textContent = `${fmt.label}${rec} — ${fmt.filesize}`;
    formatSelect.appendChild(opt);
  });

  let defaultIndex = defaultFormatIndex(data.formats);
  formatSelect.selectedIndex = defaultIndex;

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

  if (/youtube\.com|youtu\.be/i.test(url)) {
    await loadAutoCookies();
  }

  try {
    const res = await fetch(`${apiUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, cookies: getCookies() }),
    });

    const data = await res.json();
    if (!res.ok) {
      if (data.detail && /cookies|бот|bot|sign in/i.test(data.detail)) {
        cookiesBlock.open = true;
      }
      throw new Error(data.detail || 'Не удалось обработать ссылку');
    }

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
  const btnText = downloadBtn.querySelector('.btn-text');

  if (/youtube\.com|youtu\.be/i.test(currentUrl)) {
    await loadAutoCookies();
    if (!getCookies()) {
      showError('Зайдите на youtube.com в Chrome и войдите в аккаунт');
      setLoading(downloadBtn, false);
      return;
    }
  }

  try {
    if (btnText) btnText.textContent = 'Подключаемся...';
    try {
      await fetch(`${apiUrl}/`, { method: 'HEAD' });
    } catch {}

    const prep = await fetch(`${apiUrl}/api/download/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: currentUrl,
        format_id: formatSelect.value,
        cookies: getCookies(),
      }),
    });

    const data = await prep.json();
    if (!prep.ok) {
      throw new Error(data.detail || 'Ошибка скачивания');
    }

    const ready = await pollDownloadReady(data.token, (i, status) => {
      if (btnText) {
        btnText.textContent = status === 'processing' ? `Готовим... ${i * 2}с` : 'Ожидаем...';
      }
    });

    const filename = ready.filename || `${sanitizeFilename(videoData?.title)}.mp4`;
    const downloadUrl = `${apiUrl}${data.url}`;

    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'download', url: downloadUrl, filename },
        (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (resp?.ok) resolve();
          else reject(new Error(resp?.error || 'Не удалось начать скачивание'));
        },
      );
    });

    showError('Файл готов — скачивание в панели Chrome.');
  } catch (err) {
    showError(err.message);
  } finally {
    if (btnText) btnText.textContent = '⬇ Скачать';
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
