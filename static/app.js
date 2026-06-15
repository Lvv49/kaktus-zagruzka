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

window.addEventListener('kaktus-cookies', () => {});

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

function renderFormats(formats) {
  formatsList.innerHTML = '';
  selectedFormatId = null;
  downloadBtn.disabled = true;

  const countEl = document.getElementById('formats-count');
  if (countEl) {
    countEl.textContent = `Найдено форматов: ${formats.length}`;
  }

  formats.forEach((fmt, i) => {
    const item = document.createElement('label');
    item.className = 'format-item' + (i === 0 ? ' selected' : '');

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'format';
    radio.value = fmt.format_id;
    radio.checked = i === 0;

    const label = document.createElement('span');
    label.className = 'format-label';
    label.textContent = fmt.label;
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

    if (i === 0) {
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

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(currentUrl, {
        format_id: selectedFormatId,
      })),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || 'Ошибка скачивания');
    }

    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
    const filename = match ? decodeURIComponent(match[1]) : 'video.mp4';

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
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

urlInput.addEventListener('paste', () => {
  setTimeout(() => {
    if (urlInput.value.trim()) analyze();
  }, 100);
});
