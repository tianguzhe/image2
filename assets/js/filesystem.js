// Folder permissions, image files, migration and storage usage. Uses storage.js and utils.js.

async function saveDirHandle(handle) {
  const db = await openDB();
  const tx = db.transaction(DB_SETTINGS, 'readwrite');
  tx.objectStore(DB_SETTINGS).put({ key: 'dirHandle', handle });
  await transactionDone(tx);
}

async function loadDirHandle() {
  if (!FS_SUPPORTED) return;
  try {
    const db = await openDB();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_SETTINGS, 'readonly');
      const req = tx.objectStore(DB_SETTINGS).get('dirHandle');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!record?.handle) return;
    dirHandle = record.handle;
    const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      useLocalFS = true;
    }
    updateFsUI();
  } catch (e) {
    console.error('loadDirHandle failed:', e);
  }
}

async function requestDirPermission() {
  if (!storageAvailable()) return false;
  if (!dirHandle) return false;
  try {
    const perm = await dirHandle.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      useLocalFS = true;
      updateFsUI();
      renderGallery();
      return true;
    }
  } catch (e) {
    console.error('requestDirPermission failed:', e);
  }
  return false;
}

async function pickDirectory() {
  if (!beginStorageMaintenance()) return;
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await changeStorageDirectory(handle);
    updateFsUI();
    await migrateToFileSystem();
    await renderGallery();
    if (currentView === 'chat') await renderChat();
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('pickDirectory failed:', e);
      showError('無法設定資料夾：' + e.message);
    }
  } finally {
    storageMaintenance = false;
  }
}

async function changeStorageDirectory(handle) {
  const previous = dirHandle;
  const sameDirectory = previous && await previous.isSameEntry(handle);
  const copied = [];
  let history = [], conversations = [];
  try {
    if (previous && !sameDirectory) {
      history = await loadHistory({ strict: true });
      conversations = await loadConversations({ strict: true });
      const names = new Map();
      const suffix = crypto.randomUUID();
      const copyNames = async (filenames, prefix) => {
        const result = [];
        for (const name of filenames) {
          if (!names.has(name)) {
            const file = await (await previous.getFileHandle(name)).getFile();
            const dot = name.lastIndexOf('.');
            const target = `${prefix}_${suffix}_${result.length}${name.slice(dot)}`;
            copied.push(target);
            await writeLocalFile(target, file, handle);
            names.set(name, target);
          }
          result.push(names.get(name));
        }
        return result;
      };
      for (const item of history) {
        if (item.filenames) item.filenames = await copyNames(item.filenames, String(item.id));
      }
      for (const conv of conversations) {
        for (let i = 0; i < conv.turns.length; i++) {
          const turn = conv.turns[i];
          if (turn.filenames) turn.filenames = await copyNames(turn.filenames, `conv_${conv.id}_${i}`);
        }
      }
    }
    // Publish the new references and directory together, only after every copy succeeds.
    const db = await openDB();
    await writeTransaction(db, [DB_STORE, DB_CONV, DB_SETTINGS], tx => {
      for (const item of history) tx.objectStore(DB_STORE).put(item);
      for (const conv of conversations) tx.objectStore(DB_CONV).put(conv);
      tx.objectStore(DB_SETTINGS).put({ key: 'dirHandle', handle });
    });
  } catch (error) {
    for (const name of copied) await removeLocalFile(name, handle);
    throw error;
  }
  dirHandle = handle;
  useLocalFS = true;
  galleryRenderVersion++;
  blobUrlCache.forEach(url => URL.revokeObjectURL(url));
  blobUrlCache.clear();
  revokeChatBlobs();
  const updated = conversations.find(conv => conv.id === activeConv?.id);
  if (updated) activeConv = updated;
  closeLightbox();
}

async function migrateToFileSystem() {
  const list = await loadHistory();
  const toMigrate = list.filter(item => item.images && !item.filenames);
  if (!toMigrate.length) return;
  const db = await openDB();
  let failed = 0;
  for (let mi = 0; mi < toMigrate.length; mi++) {
    const item = toMigrate[mi];
    showLoading(`正在遷移 ${mi + 1}/${toMigrate.length} 筆...`);
    try {
      const filenames = await persistImages(item.images, item.fmt, String(item.id));
      const updated = { id: item.id, type: item.type, prompt: item.prompt, filenames, fmt: item.fmt, time: item.time };
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(updated);
      await transactionDone(tx);
    } catch (e) {
      failed++;
      console.error(`Migration failed for item ${item.id}:`, e);
    }
  }
  if (failed) showError(`${failed} 筆圖片遷移失敗，原始資料已保留，可重新選擇此資料夾重試`);
  else document.getElementById('status').textContent = '';
}

function updateFsUI() {
  const btn = document.getElementById('fsDirBtn');
  const status = document.getElementById('fsDirStatus');
  const unlock = document.getElementById('fsUnlockOverlay');
  const modeEl = document.getElementById('storageMode');
  if (!FS_SUPPORTED) {
    if (modeEl) modeEl.textContent = '儲存：IndexedDB';
    return;
  }
  if (dirHandle && useLocalFS) {
    btn.textContent = '變更資料夾';
    btn.style.display = '';
    status.textContent = dirHandle.name;
    status.style.display = '';
    if (unlock) unlock.style.display = 'none';
    if (modeEl) modeEl.textContent = '儲存：本地 (' + dirHandle.name + ')';
  } else if (dirHandle && !useLocalFS) {
    btn.textContent = '設定資料夾';
    btn.style.display = '';
    status.style.display = 'none';
    if (unlock) unlock.style.display = 'flex';
    if (modeEl) modeEl.textContent = '儲存：未授權';
  } else {
    btn.textContent = '設定資料夾';
    btn.style.display = '';
    status.style.display = 'none';
    if (unlock) unlock.style.display = 'none';
    if (modeEl) modeEl.textContent = '儲存：IndexedDB';
  }
}

async function writeLocalFile(filename, contents, directory = dirHandle) {
  const handle = await directory.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(contents);
    await writable.close();
  } catch (error) {
    // Discard the uncommitted write and release the file lock, preserving the cause.
    try { await writable.abort(); } catch {}
    throw error;
  }
}

// A missing file is already the desired end state; log anything else but keep deleting.
async function removeLocalFile(filename, directory = dirHandle) {
  try {
    await directory.removeEntry(filename);
  } catch (e) {
    if (e.name !== 'NotFoundError') console.warn('removeLocalFile failed:', filename, e);
  }
}

async function persistImages(images, fmt, prefix) {
  const directory = dirHandle;
  const ext = imageExtension(fmt);
  const filenames = [];
  try {
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const filename = `${prefix}_${i}.${ext}`;
      let contents;
      if (img.b64_json) contents = base64ToBytes(img.b64_json);
      else if (img.url) contents = await fetchImageBlob(img.url);
      else throw new Error('圖片缺少內容或網址');
      filenames.push(filename);
      await writeLocalFile(filename, contents, directory);
    }
  } catch (error) {
    for (const name of filenames) await removeLocalFile(name, directory);
    throw error;
  }
  return filenames;
}

async function updateStorageUsage() {
  const el = document.getElementById('storageUsage');
  try {
    if (useLocalFS && dirHandle) {
      let totalSize = 0, fileCount = 0;
      for await (const [name, handle] of dirHandle) {
        if (handle.kind === 'file') {
          const file = await handle.getFile();
          totalSize += file.size;
          fileCount++;
        }
      }
      el.textContent = `${formatBytes(totalSize)}（${fileCount} 檔案）`;
      return;
    }
    const db = await openDB();
    const count = await new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).count();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      el.textContent = `${formatBytes(est.usage)} / ${formatBytes(est.quota)}（${count} 筆）`;
    } else {
      el.textContent = `${count} 筆`;
    }
  } catch (e) {
    console.warn('updateStorageUsage failed:', e);
    el.textContent = '';
  }
}
