// Settings persistence and form controls. initSettings() runs after all feature files load.

function getBaseUrl() {
  let url = baseUrlEl.value.trim();
  if (!url) return '';
  url = url.replace(/\/+$/, '');
  // Forgiving normalization (borrowed from the SSE tester): a bare origin like
  // https://api.openai.com gets /v1 appended; URLs that already carry a path
  // (custom proxies) are left untouched.
  try {
    const u = new URL(url);
    if (u.pathname === '' || u.pathname === '/') url = u.origin + '/v1';
  } catch {}
  return url;
}

function requireBaseUrl() {
  const url = getBaseUrl();
  if (!url) { alert('請先填寫 Base URL'); baseUrlEl.focus(); return ''; }
  return url;
}

function loadFormState() {
  try {
    const saved = JSON.parse(localStorage.getItem(PERSIST_KEY) || '{}');
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
  localStorage.setItem(PERSIST_KEY, JSON.stringify(state));
}

function saveFormState() {
  clearTimeout(formSaveTimer);
  formSaveTimer = setTimeout(() => { formSaveTimer = null; persistFormState(); }, 300);
}

function getSize(sizeId = 'size', customSizeId = 'customSize') {
  const v = document.getElementById(sizeId).value;
  if (v === 'custom') {
    const c = document.getElementById(customSizeId).value.trim();
    if (!/^\d+x\d+$/.test(c)) { alert('自訂尺寸格式錯誤，請用 寬x高'); return null; }
    const problem = customSizeProblem(...c.split('x').map(Number));
    if (problem) { alert('自訂尺寸不符合模型限制：' + problem); return null; }
    return c;
  }
  return v;
}

// GPT Image 2.5 custom resolution rules; the API rejects sizes outside them.
function customSizeProblem(w, h) {
  if (w % 16 || h % 16) return '寬高都必須是 16 的倍數';
  if (Math.max(w, h) > 3840) return '單邊不可超過 3840';
  if (Math.max(w, h) > Math.min(w, h) * 3) return '長短邊比例不可超過 3:1';
  if (w * h < 655360 || w * h > 8294400) return '總像素須介於 655,360 與 8,294,400 之間';
  return '';
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
  baseUrlEl.value = localStorage.getItem(BASEURL_KEY) || DEFAULT_BASE_URL;
  baseUrlEl.addEventListener('input', function() {
    localStorage.setItem(BASEURL_KEY, this.value);
  });

  apiKeyEl.value = localStorage.getItem(APIKEY_KEY) || '';
  apiKeyEl.addEventListener('input', function() {
    localStorage.setItem(APIKEY_KEY, this.value);
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
