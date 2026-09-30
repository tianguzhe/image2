// IndexedDB connection, gallery records and conversation records. Uses state.js and filesystem.js.

function nextRecordId() {
  // Generation and editing can finish in the same millisecond; clocks can also move back.
  lastRecordId = Math.max(Date.now(), lastRecordId + 1);
  return lastRecordId;
}

function storageAvailable() {
  if (!storageMaintenance) return true;
  showError('正在處理儲存資料，請完成後再試');
  return false;
}

function beginStorageMaintenance() {
  if (storageMaintenance || storageActivity || genController || editController || chatBusy || chatDeleting
      || document.getElementById('editBtn').disabled) {
    showError('請等待目前的生成、儲存或刪除完成後再試');
    return false;
  }
  storageMaintenance = true;
  return true;
}

// Settles when a write transaction commits. Browsers abort (not error) transactions that
// exceed the storage quota, so onabort must reject too or callers wait forever.
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 交易已中止'));
  });
}

async function writeTransaction(db, stores, write) {
  const tx = db.transaction(stores, 'readwrite');
  const done = transactionDone(tx);
  try {
    write(tx);
  } catch (error) {
    // A synchronous DataCloneError does not automatically roll back earlier requests.
    tx.abort();
    try { await done; } catch {}
    throw error;
  }
  await done;
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(DB_SETTINGS)) {
        db.createObjectStore(DB_SETTINGS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(DB_CONV)) {
        db.createObjectStore(DB_CONV, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Reopen lazily if the browser force-closes the connection
      db.onclose = () => { dbPromise = null; };
      // Other tabs must be able to upgrade or reset the database without waiting
      // indefinitely for this tab's cached connection.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => showError('資料庫更新被其他頁面阻擋，請關閉其他墨境工坊分頁');
  });
  return dbPromise;
}

async function loadHistory({ strict = false } = {}) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const store = tx.objectStore(DB_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const list = req.result.sort((a, b) => gallerySortAsc ? a.id - b.id : b.id - a.id);
        resolve(list);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('IndexedDB loadHistory failed:', e);
    if (strict) throw e;
    const errMsg = e.name === 'QuotaExceededError'
      ? '儲存空間不足，請清理瀏覽器資料或使用本地資料夾模式'
      : '無法讀取歷史記錄，可能是瀏覽器處於無痕模式';
    showError(errMsg);
    return [];
  }
}

async function addToHistory(type, prompt, images, fmt) {
  try {
    const db = await openDB();
    const id = nextRecordId();
    const time = new Date().toLocaleString('zh-TW');
    const item = { id, type, prompt, fmt, time };
    if (useLocalFS && dirHandle) {
      item.filenames = await persistImages(images, fmt, String(id));
    } else {
      item.images = images;
    }
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).add(item);
    await transactionDone(tx);
    await renderGallery();
    return true;
  } catch (e) {
    console.error('IndexedDB addToHistory failed:', e);
    const errMsg = e.name === 'QuotaExceededError'
      ? '儲存空間已滿，請清理瀏覽器資料或切換到本地資料夾模式'
      : '無法儲存歷史記錄';
    showError(errMsg);
    return false;
  }
}

async function deleteHistoryItem(id) {
  if (!storageAvailable()) return;
  storageActivity++;
  try {
    const db = await openDB();
    const directory = useLocalFS ? dirHandle : null;
    const record = await readRecord(DB_STORE, id);
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(id);
    await transactionDone(tx);
    // The database is the source of truth. An aborted transaction must leave files intact.
    if (directory) for (const fname of record?.filenames || []) await removeLocalFile(fname, directory);
    invalidateGalleryCache(id);
    await renderGallery();
  } catch (e) {
    console.error('IndexedDB deleteHistoryItem failed:', e);
    showError('刪除失敗');
  } finally {
    storageActivity--;
  }
}

async function deleteSingleImage(historyId, imageIndex) {
  if (!storageAvailable() || storageActivity) return;
  if (!confirm('確定刪除這張圖片？')) return;
  storageActivity++;
  try {
    const db = await openDB();
    const record = await new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(historyId);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    if (!record) return;

    const isFS = !!record.filenames;
    const arr = isFS ? record.filenames : record.images;
    if (!arr || imageIndex < 0 || imageIndex >= arr.length) return;

    if (arr.length <= 1) {
      await deleteHistoryItem(historyId);
      return;
    }

    const directory = useLocalFS ? dirHandle : null;
    const removedFilename = isFS ? arr[imageIndex] : null;
    arr.splice(imageIndex, 1);

    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(record);
    await transactionDone(tx);
    if (removedFilename && directory) await removeLocalFile(removedFilename, directory);
    invalidateGalleryCache(historyId);
    await renderGallery();
  } catch (e) {
    console.error('deleteSingleImage failed:', e);
    showError('刪除失敗');
  } finally {
    storageActivity--;
  }
}

async function clearHistory() {
  if (!confirm('確定重置？將清除所有設定、畫廊記錄與對話；未設定本地資料夾時，圖片本身也會一併刪除。'
    + '本地資料夾中的圖片檔不會被刪除。此操作無法復原，建議先匯出備份。')) return;
  if (!beginStorageMaintenance()) return;
  try {
    // Close our cached connection first, otherwise deleteDatabase stays blocked
    if (dbPromise) {
      try { (await dbPromise).close(); } catch (e) { console.warn('closing IndexedDB before reset failed:', e); }
      dbPromise = null;
    }
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
      req.onblocked = () => showError('重置被其他頁面阻擋，請關閉其他墨境工坊分頁以繼續');
    });
    dirHandle = null;
    useLocalFS = false;
    clearTimeout(formSaveTimer);
    formSaveTimer = null;
    for (const key of [BASEURL_KEY, APIKEY_KEY, PERSIST_KEY, STORAGE_KEY]) localStorage.removeItem(key);
    location.reload();
  } catch (e) {
    console.error('Reset failed:', e);
    showError('重置失敗');
  } finally {
    storageMaintenance = false;
  }
}

async function migrateFromLocalStorage() {
  try {
    const old = localStorage.getItem(STORAGE_KEY);
    if (!old) return;
    const list = JSON.parse(old);
    if (!list.length) { localStorage.removeItem(STORAGE_KEY); return; }
    const db = await openDB();
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    for (const item of list) store.put(item);
    await transactionDone(tx);
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    // Keep the legacy data in localStorage so the next load can retry.
    console.error('migrateFromLocalStorage failed:', e);
  }
}

async function saveConversation(conv) {
  const db = await openDB();
  const tx = db.transaction(DB_CONV, 'readwrite');
  tx.objectStore(DB_CONV).put(conv);
  await transactionDone(tx);
}

async function loadConversations({ strict = false } = {}) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_CONV, 'readonly');
      const req = tx.objectStore(DB_CONV).getAll();
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.updatedAt - a.updatedAt));
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('loadConversations failed:', e);
    if (strict) throw e;
    return [];
  }
}

async function loadConversation(id) {
  return readRecord(DB_CONV, id);
}

async function readRecord(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteConversation(id) {
  const db = await openDB();
  const directory = useLocalFS ? dirHandle : null;
  const conv = await loadConversation(id);
  const tx = db.transaction(DB_CONV, 'readwrite');
  tx.objectStore(DB_CONV).delete(id);
  await transactionDone(tx);
  chatCacheVersion++;
  for (const turn of conv?.turns || []) {
    for (const fname of turn.filenames || []) {
      if (chatBlobCache.has(fname)) {
        URL.revokeObjectURL(chatBlobCache.get(fname));
        chatBlobCache.delete(fname);
      }
      if (directory) await removeLocalFile(fname, directory);
    }
  }
}
