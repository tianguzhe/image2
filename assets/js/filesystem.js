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
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    dirHandle = handle;
    useLocalFS = true;
    await saveDirHandle(handle);
    updateFsUI();
    await migrateToFileSystem();
    renderGallery();
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('pickDirectory failed:', e);
      showError('無法設定資料夾');
    }
  }
}

async function migrateToFileSystem() {
  const list = await loadHistory();
  const toMigrate = list.filter(item => item.images && !item.filenames);
  if (!toMigrate.length) return;
  const db = await openDB();
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
      console.error(`Migration failed for item ${item.id}:`, e);
    }
  }
  document.getElementById('status').textContent = '';
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

async function writeLocalFile(filename, contents) {
  const handle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  await writable.write(contents);
  await writable.close();
}

// A missing file is already the desired end state; log anything else but keep deleting.
async function removeLocalFile(filename) {
  try {
    await dirHandle.removeEntry(filename);
  } catch (e) {
    if (e.name !== 'NotFoundError') console.warn('removeLocalFile failed:', filename, e);
  }
}

async function persistImages(images, fmt, prefix) {
  const ext = imageExtension(fmt);
  const filenames = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const filename = `${prefix}_${i}.${ext}`;
    if (img.b64_json) {
      await writeLocalFile(filename, base64ToBytes(img.b64_json));
    } else if (img.url) {
      const response = await fetch(img.url);
      await writeLocalFile(filename, await response.blob());
    }
    filenames.push(filename);
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
