// IndexedDB connection, gallery records and conversation records. Uses state.js and filesystem.js.

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
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

async function loadHistory() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
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
    const id = Date.now();
    const time = new Date().toLocaleString('zh-TW');
    const item = { id, type, prompt, fmt, time };
    if (useLocalFS && dirHandle) {
      item.filenames = await persistImages(images, fmt, String(id));
    } else {
      item.images = images;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).add(item);
      tx.oncomplete = () => { renderGallery(); resolve(); };
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('IndexedDB addToHistory failed:', e);
    const errMsg = e.name === 'QuotaExceededError'
      ? '儲存空間已滿，請清理瀏覽器資料或切換到本地資料夾模式'
      : '無法儲存歷史記錄';
    showError(errMsg);
  }
}

async function deleteHistoryItem(id) {
  try {
    const db = await openDB();
    if (useLocalFS && dirHandle) {
      const record = await new Promise((res, rej) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(id);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      if (record?.filenames) {
        for (const fname of record.filenames) {
          try { await dirHandle.removeEntry(fname); } catch {}
        }
      }
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(id);
      tx.oncomplete = () => {
        invalidateGalleryCache(id);
        renderGallery().then(resolve, reject);
      };
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('IndexedDB deleteHistoryItem failed:', e);
    showError('刪除失敗');
  }
}

async function deleteSingleImage(historyId, imageIndex) {
  if (!confirm('確定刪除這張圖片？')) return;
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

    if (isFS && dirHandle) {
      try { await dirHandle.removeEntry(arr[imageIndex]); } catch {}
    }
    arr.splice(imageIndex, 1);

    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    invalidateGalleryCache(historyId);
    await renderGallery();
  } catch (e) {
    console.error('deleteSingleImage failed:', e);
    showError('刪除失敗');
  }
}

async function clearHistory() {
  if (!confirm('確定重置所有設定？本地資料夾的圖片不會被刪除。')) return;
  try {
    dirHandle = null;
    useLocalFS = false;
    localStorage.removeItem(BASEURL_KEY);
    localStorage.removeItem(APIKEY_KEY);
    localStorage.removeItem(PERSIST_KEY);
    // Close our cached connection first, otherwise deleteDatabase stays blocked
    if (dbPromise) {
      try { (await dbPromise).close(); } catch {}
      dbPromise = null;
    }
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
      req.onblocked = resolve; // another tab holds it; reload proceeds anyway
    });
    location.reload();
  } catch (e) {
    console.error('Reset failed:', e);
    showError('重置失敗');
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
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

async function saveConversation(conv) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_CONV, 'readwrite');
    tx.objectStore(DB_CONV).put(conv);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function loadConversations() {
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
    return [];
  }
}

async function loadConversation(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_CONV, 'readonly');
    const req = tx.objectStore(DB_CONV).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteConversation(id) {
  const db = await openDB();
  const conv = await loadConversation(id);
  if (conv && useLocalFS && dirHandle) {
    for (const turn of conv.turns) {
      if (!turn.filenames) continue;
      for (const fname of turn.filenames) {
        try { await dirHandle.removeEntry(fname); } catch {}
      }
    }
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_CONV, 'readwrite');
    tx.objectStore(DB_CONV).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
