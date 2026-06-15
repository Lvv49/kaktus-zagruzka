const urlInput = document.getElementById('url-input');
const cookiesInput = document.getElementById('cookies-input');
const cookiesBlock = document.getElementById('cookies-block');
const analyzeBtn = document.getElementById('analyze-btn');
const downloadBtn = document.getElementById('download-btn');
const errorBox = document.getElementById('error-box');
const resultSection = document.getElementById('result-section');
const formatsList = document.getElementById('formats-list');

let currentUrl = '';
let selectedFormatId = null;
let videoData = null;

const savedCookies = localStorage.getItem('yt_cookies') || '';
if (savedCookies) cookiesInput.value = savedCookies;

cookiesInput.addEventListener('input', () => {
  localStorage.setItem('yt_cookies', cookiesInput.value);
});

function getCookies() {
  return cookiesInput.value.trim() || null;
}

function isYoutube(url) {
  return /youtube\.com|youtu\.be/i.test(url);
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

function renderVideoInfo(data) {
  document.getElementById('video-title').textContent = data.title;
  document.getElementById('video-uploader').textContent = data.uploader;
  document.getElementById('video-duration').textContent = data.duration;
  document.getElementById('video-platform').textContent = data.platform;

  const thumb = document.getElementById('thumbnail');
  const placeholder = document.getElementById('thumbnail-placeholder');

  if (data.thumbnail) {
    thumb.src = data.thumbnail;
    thumb.classList.remove('hidden');
    placeholder.classList.add('hidden');
  } else {
    thumb.classList.add('hidden');
    placeholder.classList.remove('hidden');
  }
}

function renderFormats(formats) {
  formatsList.innerHTML = '';
  selectedFormatId = null;
  downloadBtn.disabled = true;

  formats.forEach((fmt, i) => {
    const item = document.createElement('label');
    item.className = 'format-item' + (i === 0 ? ' selected' : '');
    const badge = fmt.recommended ? '<span class="format-badge">рекомендуем</span>' : '';
    item.innerHTML = `
      <input type="radio" name="format" value="${fmt.format_id}" ${i === 0 ? 'checked' : ''}>
      <span class="format-label">${fmt.label}${badge}</span>
      <span class="format-size">${fmt.filesize}</span>
    `;

    const radio = item.querySelector('input');
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

  try {
    const res = await fetch('/api/analyze', {
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
    renderVideoInfo(data);
    renderFormats(data.formats);
    resultSection.classList.remove('hidden');
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(analyzeBtn, false);
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
      body: JSON.stringify({
        url: currentUrl,
        format_id: selectedFormatId,
        cookies: getCookies(),
      }),
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

urlInput.addEventListener('input', () => {
  if (isYoutube(urlInput.value)) cookiesBlock.open = true;
});

urlInput.addEventListener('paste', () => {
  setTimeout(() => {
    if (urlInput.value.trim()) analyze();
  }, 100);
});

const extInstallBtn = document.getElementById('ext-install-btn');
const extModal = document.getElementById('ext-modal');
const extModalClose = document.getElementById('ext-modal-close');

extInstallBtn.addEventListener('click', (e) => {
  e.preventDefault();
  extModal.classList.remove('hidden');
});

extModalClose.addEventListener('click', () => extModal.classList.add('hidden'));
extModal.querySelector('.ext-modal-backdrop').addEventListener('click', () => extModal.classList.add('hidden'));
