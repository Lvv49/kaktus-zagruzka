const PRODUCTION_SITE = 'https://kaktus-zagruzka.ru';
const apiUrl = PRODUCTION_SITE;

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

let currentUrl = '';
let videoData = null;

function isYoutube(url) {
  return /youtube\.com|youtu\.be/i.test(url);
}

function normalizeYoutubeUrl(url) {
  return (url || '').trim().replace(/\\+$/g, '');
}

function getCookies() {
  return cookiesInput.value.trim() || null;
}

async function loadAutoCookies() {
  const cookies = await syncYoutubeCookies();
  if (cookies) {
    cookiesInput.value = cookies;
    document.getElementById('cookies-status').textContent = '✓ YouTube cookies с вашего браузера';
    document.getElementById('cookies-status').classList.remove('hidden');
    cookiesBlock.classList.add('hidden');
  }
  return cookies;
}

chrome.storage.local.get(['ytCookies'], async (data) => {
  if (data.ytCookies) {
    cookiesInput.value = data.ytCookies;
    document.getElementById('cookies-status').textContent = '✓ YouTube cookies с вашего браузера';
    document.getElementById('cookies-status').classList.remove('hidden');
  }
  await loadAutoCookies();
});

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden', 'status-info');
}

function showProgress(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
  errorBox.classList.add('status-info');
}

function hideError() {
  errorBox.classList.add('hidden');
  errorBox.classList.remove('status-info');
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
    const res = await fetch(`${apiUrl}/api/ping`);
    if (res.ok) {
      serverStatus.textContent = 'Сайт подключён · YouTube через ваш ПК';
      serverStatus.className = 'status online';
      return true;
    }
  } catch {}
  serverStatus.textContent = 'Сайт недоступен';
  serverStatus.className = 'status offline';
  return false;
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

function triggerChromeDownload(url, filename, videoId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'download', url, filename, videoId }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (resp?.ok) resolve();
      else reject(new Error(resp?.error || 'Не удалось начать скачивание'));
    });
  });
}

function sanitizeFilename(name) {
  return (name || 'video').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 120) || 'video';
}

function defaultFormatIndex(formats) {
  let idx = formats.findIndex((f) => f.format_id === 'b');
  if (idx >= 0) return idx;
  idx = formats.findIndex((f) => f.recommended);
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

  formatSelect.selectedIndex = defaultFormatIndex(data.formats);
  resultEl.classList.remove('hidden');
}

async function analyzeYoutubeLocal(url) {
  const data = await chrome.runtime.sendMessage({ type: 'youtubeAnalyze', url });
  if (!data?.ok) {
    throw new Error(data?.error || 'Не удалось получить видео');
  }
  return data;
}

async function analyzeCloud(url) {
  const res = await fetch(`${apiUrl}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, cookies: getCookies() }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.detail || 'Не удалось обработать ссылку');
  }
  return data;
}

async function analyze() {
  const url = normalizeYoutubeUrl(urlInput.value.trim());
  urlInput.value = url;
  if (!url) {
    showError('Вставьте ссылку на видео');
    return;
  }

  hideError();
  setLoading(analyzeBtn, true);
  resultEl.classList.add('hidden');

  if (isYoutube(url)) {
    await loadAutoCookies();
  }

  try {
    const data = isYoutube(url) ? await analyzeYoutubeLocal(url) : await analyzeCloud(url);
    currentUrl = url;
    videoData = data;
    renderResult(data);
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(analyzeBtn, false);
  }
}

async function downloadYoutubeLocal() {
  showProgress('Получаем свежую ссылку и скачиваем...');
  const data = await chrome.runtime.sendMessage({
    type: 'youtubeDownloadAndSave',
    url: currentUrl,
    formatId: formatSelect.value,
  });
  if (!data?.ok) {
    throw new Error(data?.error || 'Ошибка скачивания');
  }
  if (data.note) {
    showProgress(`Готово! (${data.note}) Файл в папке «Загрузки».`);
  } else {
    showProgress('Готово! Файл в папке «Загрузки» Chrome.');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollDownloadReady(token, onProgress) {
  for (let i = 0; i < 180; i++) {
    const res = await fetch(`${apiUrl}/api/download/status/${token}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || 'Ошибка подготовки файла');
    }
    if (data.status === 'ready') return data;
    if (data.status === 'error') {
      throw new Error(data.error || 'Ошибка скачивания');
    }
    const secs = i * 2;
    const msg = data.message || (data.status === 'processing' ? 'Готовим файл...' : 'Запускаем...');
    if (onProgress) onProgress(`${msg} (${secs}с)`);
    await sleep(2000);
  }
  throw new Error('Слишком долго. Выберите «Авто» и попробуйте снова.');
}

async function downloadCloud() {
  showProgress('Подключаемся к сайту...');

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

  const ready = await pollDownloadReady(data.token, showProgress);
  const filename = ready.filename || `${sanitizeFilename(videoData?.title)}.mp4`;
  showProgress('Запускаем скачивание в Chrome...');
  await triggerChromeDownload(`${apiUrl}${data.url}`, filename);
  showProgress('Готово! Файл в папке «Загрузки» Chrome.');
}

async function download() {
  if (!currentUrl || !formatSelect.value) return;

  hideError();
  setLoading(downloadBtn, true);

  try {
    if (isYoutube(currentUrl)) {
      await loadAutoCookies();
      await downloadYoutubeLocal();
    } else {
      await downloadCloud();
    }
  } catch (err) {
    showError(err.message);
  } finally {
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
  const siteLink = document.querySelector('.footer a');
  if (siteLink) siteLink.href = PRODUCTION_SITE;
  await checkServer();
  await grabCurrentTab();
})();
