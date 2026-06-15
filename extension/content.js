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
    status.textContent = '✓ YouTube cookies подключены автоматически';
    status.classList.remove('hidden');
  }

  const block = document.getElementById('cookies-block');
  if (block) block.classList.add('hidden');

  window.dispatchEvent(new CustomEvent('kaktus-cookies', { detail: cookies }));
}

applyCookiesToPage();

const urlInput = document.getElementById('url-input');
if (urlInput) {
  urlInput.addEventListener('input', () => {
    if (/youtube\.com|youtu\.be/i.test(urlInput.value)) {
      applyCookiesToPage();
    }
  });
}
