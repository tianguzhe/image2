// Backup export, validation and import. Uses storage.js, filesystem.js and settings.js.

// Browsers start the download asynchronously after click(); revoking at once can cancel it.
const EXPORT_URL_TTL_MS = 30000;
const CONVERSATION_TURN_KINDS = ['seed', 'user', 'generate', 'edit'];

// Inlines local-folder images so the backup is self-contained. Unreadable files are
// skipped and counted: an empty b64_json would make the import reject the whole record.
async function inlineLocalImages(filenames, failures) {
  const images = [];
  for (const fname of filenames) {
    if (!(useLocalFS && dirHandle)) { failures.count++; continue; }
    try {
      const fh = await dirHandle.getFileHandle(fname);
      const file = await fh.getFile();
      // FileReader encodes in native code; the old per-byte string
      // concatenation froze the page on large files
      images.push({ b64_json: await blobToBase64(file) });
    } catch (e) {
      console.warn('export: cannot read local file', fname, e);
      failures.count++;
    }
  }
  return images;
}

async function exportAll() {
  if (!beginStorageMaintenance()) return;
  try {
    const history = await loadHistory({ strict: true });
    const conversations = await loadConversations({ strict: true });
    // API key deliberately NOT exported: backup files may be shared.
    // Import still accepts old backups that carry an apiKey field.
    const settings = {
      baseUrl: localStorage.getItem(BASEURL_KEY) || '',
      form: JSON.parse(localStorage.getItem(PERSIST_KEY) || '{}')
    };
    const failures = { count: 0 };
    const exportHistory = [];
    for (const item of history) {
      if (!item.filenames || item.images) { exportHistory.push(item); continue; }
      const { filenames, ...rest } = item;
      const images = await inlineLocalImages(filenames, failures);
      if (images.length) exportHistory.push({ ...rest, images });
    }
    const exportConversations = [];
    for (const conv of conversations) {
      const turns = [];
      for (const turn of conv.turns) {
        if (!turn.filenames?.length) { turns.push(turn); continue; }
        const { filenames, ...rest } = turn;
        const images = await inlineLocalImages(filenames, failures);
        turns.push({ ...rest, images: images.length ? images : null });
      }
      exportConversations.push({ ...conv, turns });
    }
    const backup = { settings, history: exportHistory, conversations: exportConversations };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gpt-image-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), EXPORT_URL_TTL_MS);
    if (failures.count) showError(`匯出完成，但有 ${failures.count} 張圖片無法讀取，未包含在備份中`);
  } catch (e) {
    console.error('Export failed:', e);
    showError('匯出失敗');
  } finally {
    storageMaintenance = false;
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
  // Optional: backups made before conversations were exported omit it.
  if (data.conversations != null && !Array.isArray(data.conversations)) return 'conversations 必須是陣列';
  return null;
}

function validateImage(img, label) {
  if (!img || typeof img !== 'object') return `${label}：不是有效物件`;
  if (!img.b64_json && !img.url) return `${label}：缺少 b64_json 或 url`;
  if (img.b64_json && (typeof img.b64_json !== 'string' || img.b64_json.length > MAX_B64_LENGTH)) return `${label}：b64_json 無效或過大`;
  if (img.b64_json) {
    const value = img.b64_json;
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    const contentLength = value.length - padding;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || contentLength % 4 === 1
        || (value.includes('=') && value.length % 4 !== 0)) return `${label}：Base64 格式無效`;
  }
  if (img.url && typeof img.url !== 'string') return `${label}：url 無效`;
  if (img.url && !sanitizeUrl(img.url)) return `${label}：url 不允許的協定`;
  return null;
}

function validateHistoryItem(item, index) {
  if (!item || typeof item !== 'object') return `第 ${index + 1} 筆：不是有效物件`;
  if (!Number.isSafeInteger(item.id) || item.id <= 0 || item.id >= Number.MAX_SAFE_INTEGER) return `第 ${index + 1} 筆：id 無效`;
  if (!VALID_TYPES.includes(item.type)) return `第 ${index + 1} 筆：type 必須是 generate 或 edit`;
  if (typeof item.prompt !== 'string' || !item.prompt.trim()) return `第 ${index + 1} 筆：prompt 無效`;
  if (item.fmt != null && !VALID_FORMATS.includes(item.fmt)) return `第 ${index + 1} 筆：fmt 必須是 png/jpeg/webp`;
  if (typeof item.time !== 'string') return `第 ${index + 1} 筆：time 無效`;
  if (!Array.isArray(item.images) || item.images.length === 0) return `第 ${index + 1} 筆：缺少 images`;
  if (item.images.length > MAX_IMAGES_PER_ITEM) return `第 ${index + 1} 筆：images 數量超過上限`;
  for (let i = 0; i < item.images.length; i++) {
    const err = validateImage(item.images[i], `第 ${index + 1} 筆圖片 ${i + 1}`);
    if (err) return err;
  }
  return null;
}

function sanitizeImages(images) {
  return images.map(img => {
    const clean = {};
    if (img.b64_json) clean.b64_json = img.b64_json;
    if (img.url) clean.url = img.url;
    return clean;
  });
}

function sanitizeHistoryItem(item) {
  return {
    id: item.id,
    type: item.type,
    prompt: item.prompt,
    images: sanitizeImages(item.images),
    fmt: item.fmt || 'png',
    time: item.time
  };
}

function validateConversation(conv, index) {
  const label = `第 ${index + 1} 個對話`;
  if (!conv || typeof conv !== 'object') return `${label}：不是有效物件`;
  if (!Number.isSafeInteger(conv.id) || conv.id <= 0 || conv.id >= Number.MAX_SAFE_INTEGER) return `${label}：id 無效`;
  if (!Array.isArray(conv.turns)) return `${label}：缺少 turns 陣列`;
  for (let t = 0; t < conv.turns.length; t++) {
    const turn = conv.turns[t];
    if (!turn || typeof turn !== 'object') return `${label}第 ${t + 1} 輪：不是有效物件`;
    if (!CONVERSATION_TURN_KINDS.includes(turn.kind)) return `${label}第 ${t + 1} 輪：kind 無效`;
    if (turn.prompt != null && typeof turn.prompt !== 'string') return `${label}第 ${t + 1} 輪：prompt 無效`;
    if (turn.fmt != null && !VALID_FORMATS.includes(turn.fmt)) return `${label}第 ${t + 1} 輪：fmt 無效`;
    // Image turns whose files were lost on export carry images: null and render as missing.
    if (turn.images == null) continue;
    if (!Array.isArray(turn.images) || turn.images.length > MAX_IMAGES_PER_ITEM) return `${label}第 ${t + 1} 輪：images 無效`;
    for (let i = 0; i < turn.images.length; i++) {
      const err = validateImage(turn.images[i], `${label}第 ${t + 1} 輪圖片 ${i + 1}`);
      if (err) return err;
    }
  }
  return null;
}

function sanitizeConversation(conv) {
  const text = v => (typeof v === 'string' ? v : '');
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : conv.id);
  return {
    id: conv.id,
    title: text(conv.title),
    time: text(conv.time),
    createdAt: num(conv.createdAt),
    updatedAt: num(conv.updatedAt),
    turns: conv.turns.map(turn => turn.kind === 'user'
      ? { kind: 'user', prompt: text(turn.prompt), time: text(turn.time) }
      : { kind: turn.kind, prompt: text(turn.prompt), time: text(turn.time), fmt: turn.fmt || 'png',
        images: turn.images ? sanitizeImages(turn.images) : null, filenames: null }),
  };
}

async function importAll(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  if (!beginStorageMaintenance()) return;
  let imported = 0, convImported = 0;
  try {
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('JSON 解析失敗'); }

    const structErr = validateImportData(data);
    if (structErr) throw new Error(structErr);

    const s = data.settings;
    let credentialsCleared = false;
    if (s.baseUrl) {
      const nextBase = normalizeBaseUrl(s.baseUrl);
      let currentBase = '';
      try { currentBase = getBaseUrl(); } catch {}
      // A shared backup must never silently redirect an existing bearer token.
      if (nextBase !== currentBase) {
        localStorage.removeItem(APIKEY_KEY);
        apiKeyEl.value = '';
        credentialsCleared = !s.apiKey;
      }
      localStorage.setItem(BASEURL_KEY, nextBase);
      baseUrlEl.value = nextBase;
    }
    if (s.apiKey) { localStorage.setItem(APIKEY_KEY, s.apiKey); apiKeyEl.value = s.apiKey; }
    if (s.form) { localStorage.setItem(PERSIST_KEY, JSON.stringify(s.form)); loadFormState(); }

    let skipped = 0;
    for (let idx = 0; idx < data.history.length; idx++) {
      const raw = data.history[idx];
      const itemErr = validateHistoryItem(raw, idx);
      if (itemErr) { console.warn('匯入跳過：' + itemErr); skipped++; continue; }
      await importRecord(DB_STORE, sanitizeHistoryItem(raw));
      imported++;
    }

    const conversations = data.conversations || [];
    for (let idx = 0; idx < conversations.length; idx++) {
      const convErr = validateConversation(conversations[idx], idx);
      if (convErr) { console.warn('匯入跳過：' + convErr); skipped++; continue; }
      await importRecord(DB_CONV, sanitizeConversation(conversations[idx]));
      convImported++;
    }
    let msg = `已匯入 ${imported} 筆記錄、${convImported} 個對話`;
    if (skipped) msg += `，跳過 ${skipped} 筆無效資料`;
    if (credentialsCleared) msg += '；API 地址已變更，請重新填寫 API Key';
    document.getElementById('status').textContent = msg;
  } catch (e) {
    console.error('Import failed:', e);
    showError(`匯入失敗（已保留 ${imported} 筆記錄、${convImported} 個對話）：` + e.message);
  } finally {
    storageMaintenance = false;
    await renderGallery();
    if (currentView === 'chat') await renderChat();
  }
}

async function importRecord(storeName, record) {
  const previous = await readRecord(storeName, record.id);
  const directory = useLocalFS ? dirHandle : null;
  const isConversation = storeName === DB_CONV;
  const parts = isConversation ? record.turns : [record];
  const previousParts = previous ? (isConversation ? previous.turns : [previous]) : [];
  const written = [];
  // Even a new record can collide with an unrelated file already in the chosen folder.
  const suffix = directory ? `_import_${crypto.randomUUID()}` : '';
  try {
    if (directory) {
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part.images?.length) continue;
        const prefix = isConversation ? `conv_${record.id}_${i}${suffix}` : `${record.id}${suffix}`;
        part.filenames = await persistImages(part.images, part.fmt, prefix);
        written.push(...part.filenames);
        if (isConversation) part.images = null;
        else delete part.images;
      }
    }
    const db = await openDB();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(record);
    await transactionDone(tx);
  } catch (error) {
    for (const name of written) await removeLocalFile(name, directory);
    throw error;
  }
  lastRecordId = Math.max(lastRecordId, record.id);
  if (directory) {
    for (const part of previousParts) {
      for (const name of part.filenames || []) await removeLocalFile(name, directory);
    }
  }
  if (isConversation) {
    revokeChatBlobs();
    if (activeConv?.id === record.id) activeConv = record;
  } else invalidateGalleryCache(record.id);
}
