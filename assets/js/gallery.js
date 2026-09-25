// Gallery rendering, filtering, lightbox and gallery interactions. Uses storage.js and utils.js.

function invalidateGalleryCache(historyId) {
  const prefix = `${historyId}_`;
  for (const [key, url] of blobUrlCache) {
    if (!key.startsWith(prefix)) continue;
    URL.revokeObjectURL(url);
    blobUrlCache.delete(key);
  }
}

async function renderGallery() {
  // Renders overlap (new image, resize, filter, delete); only the latest may touch the
  // cache or the DOM, otherwise cards duplicate and data-*-idx point at the wrong image.
  const version = ++galleryRenderVersion;
  const isStale = () => version !== galleryRenderVersion;
  const list = await loadHistory();
  if (isStale()) return;
  const grid = document.getElementById('galleryGrid');
  const empty = document.getElementById('galleryEmpty');
  const countEl = document.getElementById('galleryCount');

  const filtered = currentGalleryFilter === 'all' ? list : list.filter(h => h.type === currentGalleryFilter);

  // Drop object URLs whose backing record was deleted; keep the rest cached
  // across renders (filter/sort/resize) so FS files are read only once and
  // base64 decodes happen only once per image.
  const liveKeys = new Set();
  for (const item of list) {
    const ext = imageExtension(item.fmt);
    if (item.filenames) {
      for (const f of item.filenames) liveKeys.add(f);
    } else if (item.images) {
      for (let i = 0; i < item.images.length; i++) liveKeys.add(`${item.id}_${i}.${ext}`);
    }
  }
  for (const [key, url] of [...blobUrlCache]) {
    if (!liveKeys.has(key)) { URL.revokeObjectURL(url); blobUrlCache.delete(key); }
  }

  const entries = [];
  for (const item of filtered) {
    const mime = imageMimeType(item.fmt);
    const ext = imageExtension(item.fmt);

    if (item.filenames) {
      for (let i = 0; i < item.filenames.length; i++) {
        entries.push({ fname: item.filenames[i], prompt: item.prompt, time: item.time, isFS: true, historyId: item.id, imageIndex: i });
      }
    } else if (item.images) {
      for (let i = 0; i < item.images.length; i++) {
        const img = item.images[i];
        const filename = `${item.id}_${i}.${ext}`;
        const entry = { src: '', fname: filename, prompt: item.prompt, time: item.time, isFS: false, historyId: item.id, imageIndex: i };
        if (img.url) entry.src = sanitizeUrl(img.url);
        else if (img.b64_json) { entry.b64 = img.b64_json; entry.mime = mime; }
        entries.push(entry);
      }
    }
  }

  if (useLocalFS && dirHandle) {
    const toLoad = entries.filter(e => e.isFS && !blobUrlCache.has(e.fname));
    for (let i = 0; i < toLoad.length; i += BATCH_SIZE) {
      const batch = toLoad.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (entry) => {
        try {
          const fh = await dirHandle.getFileHandle(entry.fname);
          const file = await fh.getFile();
          blobUrlCache.set(entry.fname, URL.createObjectURL(file));
        } catch (e) {
          console.warn('gallery: cannot read local file', entry.fname, e);
        }
      }));
      if (isStale()) return;
    }
    for (const entry of entries) {
      if (entry.isFS) entry.src = blobUrlCache.get(entry.fname) || '';
    }
  }

  // Blob object URLs instead of data: URLs — one binary copy in memory
  // instead of base64 text duplicated into every <img>. Decode in batches,
  // yielding between them so a large first render doesn't freeze the page;
  // cached URLs make later renders free.
  const toDecode = entries.filter(e => e.b64 && !blobUrlCache.has(e.fname));
  for (let i = 0; i < toDecode.length; i += BATCH_SIZE) {
    for (const entry of toDecode.slice(i, i + BATCH_SIZE)) {
      try {
        blobUrlCache.set(entry.fname, b64ToObjectUrl(entry.b64, entry.mime));
      } catch (e) {
        console.warn('gallery: skip malformed image', entry.fname, e);
      }
    }
    if (i + BATCH_SIZE < toDecode.length) {
      await new Promise(r => setTimeout(r));
      if (isStale()) return;
    }
  }
  for (const entry of entries) {
    if (entry.b64) entry.src = blobUrlCache.get(entry.fname) || '';
  }

  function getColCount() {
    const w = window.innerWidth;
    if (w >= 1800) return 4;
    if (w >= 1400) return 3;
    return 2;
  }
  const colCount = getColCount();
  grid.innerHTML = '';
  galleryFlatList = [];
  const cols = [];
  for (let c = 0; c < colCount; c++) {
    const col = document.createElement('div');
    col.className = 'gallery-col';
    grid.appendChild(col);
    cols.push(col);
  }

  for (const entry of entries) {
    if (!entry.src) continue;
    const safeSrc = escapeHtml(entry.src);
    const idx = galleryFlatList.length;
    galleryFlatList.push({ src: entry.src, prompt: entry.prompt, filename: entry.fname, time: entry.time, historyId: entry.historyId, imageIndex: entry.imageIndex });
    const div = document.createElement('div');
    div.className = 'gallery-item';
    div.tabIndex = 0;
    div.setAttribute('role', 'button');
    div.setAttribute('aria-label', entry.prompt);
    div.onclick = (e) => { if (e.target.closest('button, a')) return; openLightbox(idx); };
    div.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); div.click(); } };
    div.innerHTML = `<img src="${safeSrc}" alt="" loading="lazy">
      <div class="gallery-overlay">
        <div class="prompt-preview">${escapeHtml(entry.prompt)}</div>
        <div class="meta-row">
          <span class="time">${escapeHtml(entry.time)}</span>
          <span class="meta-actions">
            <button data-chat-idx="${idx}" class="gallery-chat-btn">微調</button>
            <button data-copy-idx="${idx}">複製 Prompt</button>
            <a href="${safeSrc}" download="${escapeHtml(entry.fname)}" onclick="event.stopPropagation()">下載</a>
            <button data-del-idx="${idx}" class="gallery-del-btn">刪除</button>
          </span>
        </div>
      </div>`;
    cols[idx % colCount].appendChild(div);
  }
  const total = galleryFlatList.length;
  empty.style.display = total ? 'none' : '';
  countEl.textContent = total ? `${total} 張` : '';
  updateStorageUsage();
}

function filterGallery(type, btn) {
  currentGalleryFilter = type;
  document.querySelectorAll('.gallery-filter button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderGallery();
}

function toggleSort() {
  gallerySortAsc = !gallerySortAsc;
  document.getElementById('sortBtn').textContent = gallerySortAsc ? '舊→新 ↑' : '新→舊 ↓';
  renderGallery();
}

function showLightboxItem(idx) {
  const item = galleryFlatList[idx];
  if (!item) return;
  lightboxIndex = idx;
  const promptEl = document.getElementById('lightboxPrompt');
  promptEl.classList.remove('expanded');
  document.getElementById('lightboxImg').src = item.src;
  promptEl.textContent = item.prompt;
  const dl = document.getElementById('lightboxDl');
  dl.href = item.src; dl.download = item.filename;
  document.getElementById('lightboxCounter').textContent = `${idx + 1} / ${galleryFlatList.length}`;
  document.getElementById('lightboxPrev').disabled = idx === 0;
  document.getElementById('lightboxNext').disabled = idx === galleryFlatList.length - 1;
}

function openLightbox(idx) {
  showLightboxItem(idx);
  const lb = document.getElementById('lightbox');
  lb.classList.add('open');
  lb.setAttribute('role', 'dialog');
  lb.setAttribute('aria-modal', 'true');
  document.body.style.overflow = 'hidden';
  document.querySelector('.lightbox-close').focus();
}

function lightboxNav(dir) {
  const next = lightboxIndex + dir;
  if (next >= 0 && next < galleryFlatList.length) showLightboxItem(next);
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.body.style.overflow = '';
}

function copyPrompt() {
  const text = document.getElementById('lightboxPrompt').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('lightboxCopy');
    btn.textContent = '已複製';
    setTimeout(() => btn.textContent = '複製提示詞', 1500);
  });
}

function copyText(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '已複製';
    setTimeout(() => btn.textContent = '複製 Prompt', 1500);
  });
}

async function deleteLightboxImage() {
  const item = galleryFlatList[lightboxIndex];
  if (!item) return;
  await deleteSingleImage(item.historyId, item.imageIndex);
  if (galleryFlatList.length === 0) { closeLightbox(); return; }
  const next = Math.min(lightboxIndex, galleryFlatList.length - 1);
  showLightboxItem(next);
}

function initGallery() {
  window.addEventListener('resize', () => {
    clearTimeout(galleryResizeTimer);
    galleryResizeTimer = setTimeout(() => {
      if (currentView === 'gallery') renderGallery();
    }, 200);
  });

  document.getElementById('galleryGrid').addEventListener('click', function(e) {
    const chatBtn = e.target.closest('[data-chat-idx]');
    if (chatBtn) {
      e.stopPropagation();
      const item = galleryFlatList[parseInt(chatBtn.dataset.chatIdx)];
      if (item) startChatFromImage(item);
      return;
    }
    const copyBtn = e.target.closest('[data-copy-idx]');
    if (copyBtn) {
      e.stopPropagation();
      const item = galleryFlatList[parseInt(copyBtn.dataset.copyIdx)];
      if (item) copyText(copyBtn, item.prompt);
      return;
    }
    const delBtn = e.target.closest('[data-del-idx]');
    if (delBtn) {
      e.stopPropagation();
      const item = galleryFlatList[parseInt(delBtn.dataset.delIdx)];
      if (item) deleteSingleImage(item.historyId, item.imageIndex);
    }
  });

  document.addEventListener('keydown', e => {
    const lb = document.getElementById('lightbox');
    if (!lb.classList.contains('open')) return;
    if (e.key === 'Escape') { closeLightbox(); return; }
    if (e.key === 'ArrowLeft') { lightboxNav(-1); return; }
    if (e.key === 'ArrowRight') { lightboxNav(1); return; }
    if (e.key === 'Tab') {
      const focusable = lb.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
  });
}
