const urlInput = document.getElementById('url-input');
const analyzeBtn = document.getElementById('analyze-btn');
const downloadBtn = document.getElementById('download-btn');
const errorBox = document.getElementById('error-box');
const resultSection = document.getElementById('result-section');
const formatsList = document.getElementById('formats-list');

let currentUrl = '';
let selectedFormatId = null;
let videoData = null;

function isYoutube(url) {
  return /youtube\.com|youtu\.be/i.test(url);
}

function getCookies() {
  return localStorage.getItem('yt_cookies') || null;
}

function updateCookiesStatus() {
  const status = document.getElementById('cookies-status');
  if (!status) return;
  if (getCookies()) {
    status.textContent = '✓ YouTube cookies подключены автоматически';
    status.classList.remove('hidden');
  } else {
    status.classList.add('hidden');
  }
}

window.addEventListener('kaktus-cookies', (e) => {
  if (e.detail) {
    localStorage.setItem('yt_cookies', e.detail);
    const input = document.getElementById('cookies-input');
    if (input) input.value = e.detail;
    updateCookiesStatus();
  }
});

function requestBody(url, extra = {}) {
  const body = { url, ...extra };
  if (isYoutube(url)) {
    const cookies = getCookies();
    if (cookies) body.cookies = cookies;
  }
  return body;
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

async function fetchPreparedFile(downloadUrl, filename, btnText) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (btnText) {
      btnText.textContent = attempt ? `Скачиваем... повтор ${attempt + 1}` : 'Скачиваем файл...';
    }
    try {
      const res = await fetch(downloadUrl);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Ошибка ${res.status}`);
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
      return;
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(2000);
    }
  }
}

async function pollDownloadReady(token, onProgress) {
  for (let i = 0; i < 300; i++) {
    const res = await fetch(`/api/download/status/${token}`);
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
  throw new Error('Слишком долго. Выберите формат «хорошее качество» и попробуйте снова.');
}

function defaultFormatIndex(formats) {
  let idx = formats.findIndex((f) => f.recommended);
  if (idx >= 0) return idx;
  idx = formats.findIndex((f) => f.format_id === 'b');
  if (idx >= 0) return idx;
  idx = formats.findIndex((f) => f.format_id && f.format_id.startsWith('q:720'));
  if (idx >= 0) return idx;
  idx = formats.findIndex((f) => f.filesize && f.filesize !== '—');
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

  let defaultIndex = defaultFormatIndex(formats);

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
      document.querySelectorAll('.format-item').forEach(el => el.classList.remove('selected'));
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

async function analyze() {
  const url = urlInput.value.trim();
  if (!url) {
    showError('Вставьте ссылку на видео');
    return;
  }

  hideError();
  setLoading(analyzeBtn, true);
  resultSection.classList.add('hidden');
  analyzeBtn.querySelector('.btn-text').textContent = 'Ищем...';

  if (isYoutube(url)) {
    updateCookiesStatus();
  }

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(url)),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.detail || 'Не удалось обработать ссылку');
    }

    currentUrl = url;
    videoData = data;
    renderVideoInfo(data);
    renderFormats(data.formats);

    if (data.formats_estimated && !getCookies()) {
      showError('Форматы примерные. Для YouTube установите расширение и войдите на youtube.com.');
    } else if (data.formats_estimated) {
      showError('Форматы примерные — обновите страницу youtube.com (F5) и попробуйте снова.');
    }

    resultSection.classList.remove('hidden');
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(analyzeBtn, false);
    analyzeBtn.querySelector('.btn-text').textContent = 'Найти форматы';
  }
}

async function download() {
  if (!currentUrl || !selectedFormatId) return;

  hideError();
  setLoading(downloadBtn, true);
  const btnText = downloadBtn.querySelector('.btn-text');

  if (isYoutube(currentUrl) && !getCookies()) {
    showError('Для YouTube установите расширение Chrome, зайдите на youtube.com и войдите в аккаунт.');
    setLoading(downloadBtn, false);
    return;
  }

  try {
    if (btnText) btnText.textContent = 'Подключаемся...';

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

    const ready = await pollDownloadReady(data.token, (i, status) => {
      if (btnText) {
        btnText.textContent = status === 'processing' ? `Готовим... ${i * 2}с` : 'Ожидаем...';
      }
    });

    await fetchPreparedFile(
      data.url,
      ready.filename || 'video.mp4',
      btnText,
    );

    hideError();
  } catch (err) {
    showError(err.message);
  } finally {
    if (btnText) btnText.textContent = 'Скачать';
    setLoading(downloadBtn, false);
  }
}

analyzeBtn.addEventListener('click', analyze);
downloadBtn.addEventListener('click', download);

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') analyze();
});

urlInput.addEventListener('paste', () => {
  setTimeout(() => {
    if (urlInput.value.trim()) analyze();
  }, 100);
});

urlInput.addEventListener('input', () => {
  if (isYoutube(urlInput.value)) updateCookiesStatus();
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

updateCookiesStatus();
