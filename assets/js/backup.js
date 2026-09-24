// Backup export, validation and import. Uses storage.js, filesystem.js and settings.js.

async function exportAll() {
  try {
    const history = await loadHistory();
    // API key deliberately NOT exported: backup files may be shared.
    // Import still accepts old backups that carry an apiKey field.
    const settings = {
      baseUrl: localStorage.getItem(BASEURL_KEY) || '',
      form: JSON.parse(localStorage.getItem(PERSIST_KEY) || '{}')
    };
    const exportHistory = history.map(item => {
      if (!useLocalFS || !dirHandle || !item.filenames || item.images) return item;
      return { ...item, _needsRead: true };
    });
    for (const item of exportHistory) {
      if (!item._needsRead) continue;
      delete item._needsRead;
      const images = [];
      for (const fname of item.filenames) {
        try {
          const fh = await dirHandle.getFileHandle(fname);
          const file = await fh.getFile();
          // FileReader encodes in native code; the old per-byte string
          // concatenation froze the page on large files
          images.push({ b64_json: await blobToBase64(file) });
        } catch {
          images.push({ b64_json: '' });
        }
      }
      item.images = images;
      delete item.filenames;
    }
    const blob = new Blob([JSON.stringify({ settings, history: exportHistory }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gpt-image-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error('Export failed:', e);
    showError('匯出失敗');
  }
}

function validateImportData(data) {
  if (!data || typeof data !== 'object') return '檔案內容不是有效的 JSON 物件';
  if (!data.settings || typeof data.settings !== 'object') return '缺少 settings 欄位';
  if (!Array.isArray(data.history)) return '缺少 history 陣列';
  const s = data.settings;
  if (s.baseUrl != null && typeof s.baseUrl !== 'string') return 'settings.baseUrl 必須是字串';
  if (s.apiKey != null && typeof s.apiKey !== 'string') return 'settings.apiKey 必須是字串';
  if (s.form != null && typeof s.form !== 'object') return 'settings.form 必須是物件';
  if (s.form) {
    for (const [k, v] of Object.entries(s.form)) {
      if (!PERSIST_FIELDS.includes(k)) return `settings.form 含有未知欄位：${k}`;
      if (typeof v !== 'string') return `settings.form.${k} 必須是字串`;
    }
  }
  return null;
}

function validateHistoryItem(item, index) {
  if (!item || typeof item !== 'object') return `第 ${index + 1} 筆：不是有效物件`;
  if (typeof item.id !== 'number' || !Number.isFinite(item.id) || item.id <= 0) return `第 ${index + 1} 筆：id 無效`;
  if (!VALID_TYPES.includes(item.type)) return `第 ${index + 1} 筆：type 必須是 generate 或 edit`;
  if (typeof item.prompt !== 'string' || !item.prompt.trim()) return `第 ${index + 1} 筆：prompt 無效`;
  if (item.fmt != null && !VALID_FORMATS.includes(item.fmt)) return `第 ${index + 1} 筆：fmt 必須是 png/jpeg/webp`;
  if (typeof item.time !== 'string') return `第 ${index + 1} 筆：time 無效`;
  if (!Array.isArray(item.images) || item.images.length === 0) return `第 ${index + 1} 筆：缺少 images`;
  if (item.images.length > MAX_IMAGES_PER_ITEM) return `第 ${index + 1} 筆：images 數量超過上限`;
  for (let i = 0; i < item.images.length; i++) {
    const img = item.images[i];
    if (!img || typeof img !== 'object') return `第 ${index + 1} 筆圖片 ${i + 1}：不是有效物件`;
    if (!img.b64_json && !img.url) return `第 ${index + 1} 筆圖片 ${i + 1}：缺少 b64_json 或 url`;
    if (img.b64_json && (typeof img.b64_json !== 'string' || img.b64_json.length > MAX_B64_LENGTH)) return `第 ${index + 1} 筆圖片 ${i + 1}：b64_json 無效或過大`;
    if (img.url && typeof img.url !== 'string') return `第 ${index + 1} 筆圖片 ${i + 1}：url 無效`;
    if (img.url && !sanitizeUrl(img.url)) return `第 ${index + 1} 筆圖片 ${i + 1}：url 不允許的協定`;
  }
  return null;
}

function sanitizeHistoryItem(item) {
  return {
    id: item.id,
    type: item.type,
    prompt: item.prompt,
    images: item.images.map(img => {
      const clean = {};
      if (img.b64_json) clean.b64_json = img.b64_json;
      if (img.url) clean.url = img.url;
      return clean;
    }),
    fmt: item.fmt || 'png',
    time: item.time
  };
}

async function importAll(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('JSON 解析失敗'); }

    const structErr = validateImportData(data);
    if (structErr) throw new Error(structErr);

    const s = data.settings;
    if (s.baseUrl) { localStorage.setItem(BASEURL_KEY, s.baseUrl); baseUrlEl.value = s.baseUrl; }
    if (s.apiKey) { localStorage.setItem(APIKEY_KEY, s.apiKey); apiKeyEl.value = s.apiKey; }
    if (s.form) { localStorage.setItem(PERSIST_KEY, JSON.stringify(s.form)); loadFormState(); }

    const db = await openDB();
    let imported = 0, skipped = 0;
    for (let idx = 0; idx < data.history.length; idx++) {
      const raw = data.history[idx];
      const itemErr = validateHistoryItem(raw, idx);
      if (itemErr) { console.warn('匯入跳過：' + itemErr); skipped++; continue; }
      let item = sanitizeHistoryItem(raw);

      if (useLocalFS && dirHandle && item.images) {
        const ext = imageExtension(item.fmt);
        const filenames = [];
        for (let i = 0; i < item.images.length; i++) {
          const img = item.images[i];
          if (!img.b64_json) continue;
          const fname = `${item.id}_${i}.${ext}`;
          await writeLocalFile(fname, base64ToBytes(img.b64_json));
          filenames.push(fname);
        }
        item = { id: item.id, type: item.type, prompt: item.prompt, filenames, fmt: item.fmt, time: item.time };
      }
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(item);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      invalidateGalleryCache(item.id);
      imported++;
    }
    renderGallery();
    const msg = skipped ? `已匯入 ${imported} 筆，跳過 ${skipped} 筆無效記錄` : `已匯入 ${imported} 筆記錄`;
    document.getElementById('status').textContent = msg;
  } catch (e) {
    console.error('Import failed:', e);
    showError('匯入失敗：' + e.message);
  }
}
