const KAKTUS_EXT = 'kaktus-ext';

localStorage.setItem('kaktus_extension', '1');
window.dispatchEvent(new CustomEvent('kaktus-extension-ready'));

async function applyCookiesToPage() {
  const cookies = await syncYoutubeCookies();
  if (!cookies) return;

  const input = document.getElementById('cookies-input');
  if (input) {
    input.value = cookies;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  localStorage.setItem('yt_cookies', cookies);

  const status = document.getElementById('cookies-status');
  if (status) {
    status.textContent = '✓ YouTube cookies подключены через расширение';
    status.classList.remove('hidden');
  }

  window.dispatchEvent(new CustomEvent('kaktus-cookies', { detail: cookies }));
}

applyCookiesToPage();
setInterval(applyCookiesToPage, 15000);

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.channel !== KAKTUS_EXT) return;

  const { requestId, action, payload } = event.data;

  if (action === 'ping') {
    window.postMessage({ channel: KAKTUS_EXT, requestId, pong: true }, '*');
    return;
  }

  if (action === 'youtubeAnalyze') {
    chrome.runtime.sendMessage({ type: 'youtubeAnalyze', url: payload.url }, (resp) => {
      if (chrome.runtime.lastError) {
        window.postMessage({
          channel: KAKTUS_EXT,
          requestId,
          ok: false,
          error: chrome.runtime.lastError.message,
        }, '*');
        return;
      }
      window.postMessage({ channel: KAKTUS_EXT, requestId, ...resp }, '*');
    });
    return;
  }

  if (action === 'youtubeDownload') {
    chrome.runtime.sendMessage({
      type: 'youtubeDownloadAndSave',
      url: payload.url,
      formatId: payload.formatId,
    }, (resp) => {
      if (chrome.runtime.lastError) {
        window.postMessage({
          channel: KAKTUS_EXT,
          requestId,
          ok: false,
          error: chrome.runtime.lastError.message,
        }, '*');
        return;
      }
      window.postMessage({ channel: KAKTUS_EXT, requestId, ...resp }, '*');
    });
    return;
  }

  window.postMessage({
    channel: KAKTUS_EXT,
    requestId,
    ok: false,
    error: 'Неизвестное действие',
  }, '*');
});

const urlInput = document.getElementById('url-input');
if (urlInput) {
  urlInput.addEventListener('input', () => {
    if (/youtube\.com|youtu\.be/i.test(urlInput.value)) {
      applyCookiesToPage();
    }
  });
}

const extBannerLink = document.getElementById('ext-banner-link');
if (extBannerLink) {
  extBannerLink.addEventListener('click', (e) => {
    e.preventDefault();
    const modal = document.getElementById('ext-modal');
    if (modal) modal.classList.remove('hidden');
  });
}
