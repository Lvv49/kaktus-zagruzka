const urlInput = document.getElementById('url-input');
const analyzeBtn = document.getElementById('analyze-btn');
const downloadBtn = document.getElementById('download-btn');
const errorBox = document.getElementById('error-box');
const resultSection = document.getElementById('result-section');
const formatsList = document.getElementById('formats-list');

let currentUrl = '';
let selectedFormatId = null;
let videoData = null;

function normalizeYoutubeUrl(url) {
  let u = (url || '').trim().replace(/\\+$/g, '');
  if (u.startsWith('//')) u = `https:${u}`;
  if (/^www\./i.test(u)) u = `https://${u}`;
  return u;
}

function isYoutube(url) {
  return /youtube\.com|youtu\.be/i.test(url);
}

function getCookies() {
  return localStorage.getItem('yt_cookies') || null;
}

function requestBody(url, extra = {}) {
  const body = { url, ...extra };
  const cookies = getCookies();
  if (isYoutube(url) && cookies) {
    body.cookies = cookies;
  }
  return body;
}

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

function setThumbnail(thumb, placeholder, data) {
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
    placeholder.classList.remove('hidden');
    return;
  }

  let index = 0;
  thumb.referrerPolicy = 'no-referrer';

  function tryNext() {
    if (index >= urls.length) {
      thumb.classList.add('hidden');
      placeholder.classList.remove('hidden');
      return;
    }
    thumb.src = urls[index++];
  }

  thumb.onload = () => {
    thumb.classList.remove('hidden');
    placeholder.classList.add('hidden');
  };
  thumb.onerror = tryNext;
  tryNext();
}

function renderVideoInfo(data) {
  document.getElementById('video-title').textContent = data.title;
  document.getElementById('video-uploader').textContent = data.uploader;
  document.getElementById('video-duration').textContent = data.duration;
  document.getElementById('video-platform').textContent = data.platform;

  const thumb = document.getElementById('thumbnail');
  const placeholder = document.getElementById('thumbnail-placeholder');
  setThumbnail(thumb, placeholder, data);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollDownloadReady(token, onProgress) {
  for (let i = 0; i < 180; i++) {
    const res = await fetch(`/api/download/status/${token}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || 'Ошибка подготовки файла');
    }
    if (data.status === 'ready') return data;
    if (data.status === 'error') {
      throw new Error(data.error || 'Ошибка скачивания');
    }
    const secs = i * 2;
    const msg = data.message || (data.status === 'processing' ? 'Готовим файл на сервере...' : 'Запускаем...');
    if (onProgress) onProgress(`${msg} (${secs}с)`);
    await sleep(2000);
  }
  throw new Error('Слишком долго. Выберите «Авто» и попробуйте снова.');
}

function startBrowserDownload(downloadUrl, filename) {
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = filename || '';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function defaultFormatIndex(formats) {
  let idx = formats.findIndex((f) => f.format_id === 'b');
  if (idx >= 0) return idx;
  idx = formats.findIndex((f) => f.recommended);
  if (idx >= 0) return idx;
  return 0;
}

function renderFormats(formats) {
  formatsList.innerHTML = '';
  selectedFormatId = null;
  downloadBtn.disabled = true;

  const countEl = document.getElementById('formats-count');
  if (countEl) {
    countEl.textContent = `Найдено форматов: ${formats.length}`;
  }

  const defaultIndex = defaultFormatIndex(formats);

  formats.forEach((fmt, i) => {
    const item = document.createElement('label');
    item.className = 'format-item' + (i === defaultIndex ? ' selected' : '');

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'format';
    radio.value = fmt.format_id;
    radio.checked = i === defaultIndex;

    const label = document.createElement('span');
    label.className = 'format-label';
    const res = fmt.resolution && fmt.resolution !== '—' ? ` · ${fmt.resolution}` : '';
    label.textContent = fmt.label + res;
    if (fmt.recommended) {
      const badge = document.createElement('span');
      badge.className = 'format-badge';
      badge.textContent = 'рекомендуем';
      label.appendChild(badge);
    }

    const size = document.createElement('span');
    size.className = 'format-size';
    size.textContent = fmt.filesize || '—';

    item.append(radio, label, size);

    radio.addEventListener('change', () => {
      document.querySelectorAll('.format-item').forEach((el) => el.classList.remove('selected'));
      item.classList.add('selected');
      selectedFormatId = fmt.format_id;
      downloadBtn.disabled = false;
    });

    item.addEventListener('click', (e) => {
      if (e.target !== radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change'));
      }
    });

    formatsList.appendChild(item);

    if (i === defaultIndex) {
      selectedFormatId = fmt.format_id;
      downloadBtn.disabled = false;
    }
  });
}

const KAKTUS_EXT = 'kaktus-ext';

let extensionAvailable = localStorage.getItem('kaktus_extension') === '1';

window.addEventListener('kaktus-extension-ready', () => {
  extensionAvailable = true;
  const status = document.getElementById('cookies-status');
  if (status) {
    status.textContent = '✓ Расширение подключено — YouTube с вашего ПК';
    status.classList.remove('hidden');
  }
});

function extCall(action, payload = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('Расширение не отвечает'));
    }, timeoutMs);

    function onMessage(event) {
      if (event.source !== window || !event.data || event.data.channel !== KAKTUS_EXT) return;
      if (event.data.requestId !== requestId) return;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      if (event.data.pong) {
        resolve({ ok: true });
        return;
      }
      if (event.data.ok === false) {
        reject(new Error(event.data.error || 'Ошибка расширения'));
        return;
      }
      resolve(event.data);
    }

    window.addEventListener('message', onMessage);
    window.postMessage({ channel: KAKTUS_EXT, requestId, action, payload }, '*');
  });
}

async function pingExtension() {
  if (!extensionAvailable) return false;
  try {
    await extCall('ping', {}, 2500);
    return true;
  } catch {
    extensionAvailable = false;
    return false;
  }
}

async function analyzeYoutube(url) {
  if (await pingExtension()) {
    showProgress('Ищем форматы через расширение...');
    const data = await extCall('youtubeAnalyze', { url }, 45000);
    return data;
  }
  showProgress('Ищем форматы...');
  return analyzeCloud(url);
}

async function downloadYoutubeViaExtension() {
  showProgress('Скачиваем через расширение...');
  const data = await extCall('youtubeDownload', {
    url: currentUrl,
    formatId: selectedFormatId,
  }, 120000);
  const note = data.note ? ` (${data.note})` : '';
  showProgress(`Готово!${note} Файл сохраняется в папку загрузок.`);
}

function fetchWithTimeout(url, options = {}, timeoutMs = 35000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function analyzeCloud(url) {
  const res = await fetchWithTimeout('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody(url)),
  }, 55000);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.detail || 'Не удалось обработать ссылку');
  }
  return data;
}

async function analyze() {
  const url = normalizeYoutubeUrl(urlInput.value);
  urlInput.value = url;
  if (!url) {
    showError('Вставьте ссылку на видео');
    return;
  }

  hideError();
  setLoading(analyzeBtn, true);
  resultSection.classList.add('hidden');
  analyzeBtn.querySelector('.btn-text').textContent = 'Ищем...';
  showProgress('Ищем форматы...');

  try {
    const data = isYoutube(url) ? await analyzeYoutube(url) : await analyzeCloud(url);
    hideError();
    currentUrl = url;
    videoData = data;
    renderVideoInfo(data);
    renderFormats(data.formats);
    resultSection.classList.remove('hidden');
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? 'Сервер не отвечает. Подождите минуту и нажмите «Найти форматы» снова.'
      : err.message;
    showError(msg);
  } finally {
    setLoading(analyzeBtn, false);
    analyzeBtn.querySelector('.btn-text').textContent = 'Найти форматы';
  }
}

async function downloadYoutubeDirect() {
  showProgress('Получаем ссылку на файл...');
  const res = await fetchWithTimeout('/api/youtube/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: currentUrl,
      format_id: selectedFormatId,
    }),
  }, 40000);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.detail || 'Ошибка скачивания YouTube');
  }
  showProgress('Скачиваем файл...');
  startBrowserDownload(data.url, data.filename || 'video.mp4');
  const note = data.note ? ` (${data.note})` : '';
  showProgress(`Готово!${note} Файл сохраняется в папку загрузок.`);
}

async function downloadCloud() {
  showProgress('Подключаемся к серверу...');

  const prep = await fetch('/api/download/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody(currentUrl, {
      format_id: selectedFormatId,
    })),
  });

  const data = await prep.json();
  if (!prep.ok) {
    throw new Error(data.detail || 'Ошибка скачивания');
  }

  const ready = await pollDownloadReady(data.token, showProgress);
  showProgress('Скачиваем файл...');
  startBrowserDownload(data.url, ready.filename || 'video.mp4');
  showProgress('Готово! Файл сохраняется в папку загрузок.');
}

async function download() {
  if (!currentUrl || !selectedFormatId) return;

  hideError();
  setLoading(downloadBtn, true);

  try {
    if (isYoutube(currentUrl) && await pingExtension()) {
      await downloadYoutubeViaExtension();
    } else if (isYoutube(currentUrl)) {
      await downloadYoutubeDirect();
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

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') analyze();
});

const extInstallBtn = document.getElementById('ext-install-btn');
const extModal = document.getElementById('ext-modal');
const extModalClose = document.getElementById('ext-modal-close');

if (extInstallBtn && extModal) {
  extInstallBtn.addEventListener('click', (e) => {
    e.preventDefault();
    extModal.classList.remove('hidden');
  });

  extModalClose.addEventListener('click', () => extModal.classList.add('hidden'));
  extModal.querySelector('.ext-modal-backdrop').addEventListener('click', () => {
    extModal.classList.add('hidden');
  });
}

window.addEventListener('kaktus-cookies', (e) => {
  if (e.detail) {
    localStorage.setItem('yt_cookies', e.detail);
    const input = document.getElementById('cookies-input');
    if (input) input.value = e.detail;
  }
});
