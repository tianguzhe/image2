// Settings persistence and form controls. initSettings() runs after all feature files load.

function readSetting(key, fallback = '') {
  try { return localStorage.getItem(key) || fallback; }
  catch (error) {
    console.warn('Cannot read saved settings:', error);
    return fallback;
  }
}

function writeSetting(key, value) {
  try { localStorage.setItem(key, value); }
  catch (error) {
    console.warn('Cannot save settings:', error);
    showError('瀏覽器無法保存設定；目前輸入仍可使用，關閉頁面後需重新填寫');
  }
}

function getBaseUrl() {
  return normalizeBaseUrl(baseUrlEl.value);
}

function normalizeBaseUrl(value) {
  if (!value.trim()) return '';
  try {
    const u = new URL(value.trim());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error();
    if (u.username || u.password || u.search || u.hash) throw new Error();
    const path = u.pathname.replace(/\/+$/, '') || '/v1';
    return u.origin + path;
  } catch {
    throw new Error('Base URL 須為 HTTPS（本機可用 HTTP），且不可包含帳密、查詢參數或片段');
  }
}

function requireBaseUrl() {
  try {
    const url = getBaseUrl();
    if (url) return url;
    alert('請先填寫 Base URL');
  } catch (e) { alert(e.message); }
  baseUrlEl.focus();
  return '';
}

function loadFormState() {
  try {
    const saved = JSON.parse(readSetting(PERSIST_KEY, '{}'));
    PERSIST_FIELDS.forEach(id => {
      if (saved[id] == null) return;
      const el = document.getElementById(id);
      if (!el) return;
      el.value = saved[id];
      el.dispatchEvent(new Event('change'));
      el.dispatchEvent(new Event('input'));
    });
  } catch (e) {
    console.warn('loadFormState: ignoring unreadable saved form state:', e);
  }
}

function persistFormState() {
  const state = {};
  PERSIST_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) state[id] = el.value;
  });
  writeSetting(PERSIST_KEY, JSON.stringify(state));
}

function saveFormState() {
  clearTimeout(formSaveTimer);
  formSaveTimer = setTimeout(() => { formSaveTimer = null; persistFormState(); }, 300);
}

function getSize(sizeId = 'size', customSizeId = 'customSize') {
  const v = document.getElementById(sizeId).value;
  if (v === 'custom') {
    const c = document.getElementById(customSizeId).value.trim();
    const match = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(c);
    if (!match) { alert('自訂尺寸格式錯誤，請用 寬x高，例如 1580×996'); return null; }
    const [w, h] = match.slice(1).map(Number);
    if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0) {
      alert('自訂尺寸的寬高須為有效的正整數');
      return null;
    }
    // A configurable proxy may have different size rules from the official API.
    // Preserve the requested dimensions and let the selected service validate them.
    return `${w}x${h}`;
  }
  return v;
}

// Transparency needs an alpha channel, which JPEG lacks.
function checkBackgroundFormat(background, fmt) {
  if (background === 'transparent' && fmt === 'jpeg') {
    alert('透明背景只支援 PNG 或 WebP，請更換格式');
    return false;
  }
  return true;
}

function getPartialImageCount() {
  const count = Number(document.getElementById('partials').value);
  return Number.isInteger(count) && count >= 0 && count <= 3 ? count : 0;
}

function switchTab(name) {
  const allowed = ['generate', 'edit'];
  if (!allowed.includes(name)) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[onclick*="${name}"]`).classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
  document.getElementById('status').textContent = '';
}

function showLoading(msg) {
  const el = document.getElementById('status');
  el.innerHTML = '<span class="spinner"></span> ';
  el.appendChild(document.createTextNode(msg));
}

function showError(msg) {
  const el = document.getElementById('status');
  const span = document.createElement('span');
  span.style.color = 'var(--danger)';
  span.textContent = '錯誤：' + msg;
  el.innerHTML = '';
  el.appendChild(span);
}

function toggleSettingsPanel() {
  document.getElementById('settingsPanel').classList.toggle('open');
}

const baseUrlEl = document.getElementById('baseUrl');
const apiKeyEl = document.getElementById('apiKey');

function initSettings() {
  baseUrlEl.value = readSetting(BASEURL_KEY, DEFAULT_BASE_URL);
  baseUrlEl.addEventListener('input', function() {
    writeSetting(BASEURL_KEY, this.value);
  });

  apiKeyEl.value = readSetting(APIKEY_KEY);
  apiKeyEl.addEventListener('input', function() {
    writeSetting(APIKEY_KEY, this.value);
  });

  // Flush a pending debounced write so the last keystrokes survive page close
  window.addEventListener('beforeunload', () => {
    if (formSaveTimer) { clearTimeout(formSaveTimer); persistFormState(); }
  });
  PERSIST_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', saveFormState);
    if (el && el.tagName === 'SELECT') el.addEventListener('change', saveFormState);
  });


  // ===== Form controls =====
  document.getElementById('size').addEventListener('change', function() {
    document.getElementById('customSizeGroup').style.display = this.value === 'custom' ? '' : 'none';
  });
  document.getElementById('editSize').addEventListener('change', function() {
    document.getElementById('editCustomSizeGroup').style.display = this.value === 'custom' ? '' : 'none';
  });
  document.getElementById('format').addEventListener('change', function() {
    document.getElementById('compressionGroup').style.display = (this.value === 'jpeg' || this.value === 'webp') ? '' : 'none';
  });
  document.getElementById('compression').addEventListener('input', function() {
    document.getElementById('compressionVal').textContent = this.value + '%';
  });
  document.getElementById('editFormat').addEventListener('change', function() {
    document.getElementById('editCompressionGroup').style.display = (this.value === 'jpeg' || this.value === 'webp') ? '' : 'none';
  });
  document.getElementById('editCompression').addEventListener('input', function() {
    document.getElementById('editCompressionVal').textContent = this.value + '%';
  });

  document.addEventListener('click', (e) => {
    const panel = document.getElementById('settingsPanel');
    if (!panel.classList.contains('open')) return;
    if (!e.target.closest('.settings-wrap')) panel.classList.remove('open');
  });

  loadFormState();
}
