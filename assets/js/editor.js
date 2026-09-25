// Image generation, uploaded-image editing and progress previews. Uses api.js and storage.js.

function setupDropZone(zoneId, fileInputId, previewId, textId, fileArr, multi) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(fileInputId);
  const preview = document.getElementById(previewId);
  const text = document.getElementById(textId);
  const previewUrls = new Map();

  function releasePreviewUrls() {
    previewUrls.forEach(url => URL.revokeObjectURL(url));
    previewUrls.clear();
  }
  window.addEventListener('beforeunload', releasePreviewUrls);

  // Reject up front what the API would refuse only after a full upload.
  function addFiles(newFiles) {
    const rejected = [];
    for (const f of newFiles) {
      if (!EDIT_IMAGE_TYPES.includes(f.type)) { rejected.push(`${f.name}（僅支援 PNG / JPEG / WebP）`); continue; }
      if (f.size >= MAX_EDIT_IMAGE_BYTES) { rejected.push(`${f.name}（須小於 50MB）`); continue; }
      if (!multi) fileArr.length = 0;
      else if (fileArr.length >= MAX_EDIT_IMAGES) { rejected.push(`${f.name}（最多 ${MAX_EDIT_IMAGES} 張）`); continue; }
      fileArr.push(f);
    }
    if (rejected.length) alert('以下檔案未加入：\n' + rejected.join('\n'));
    renderPreviews();
  }

  function renderPreviews() {
    preview.innerHTML = '';
    // Reuse URLs for retained files; release removed/replaced previews.
    const retainedFiles = new Set(fileArr);
    for (const [file, url] of previewUrls) {
      if (retainedFiles.has(file)) continue;
      URL.revokeObjectURL(url);
      previewUrls.delete(file);
    }
    if (fileArr.length) {
      text.style.display = 'none';
      fileArr.forEach((f, i) => {
        const wrap = document.createElement('span');
        wrap.className = 'thumb-wrap';
        const img = document.createElement('img');
        if (!previewUrls.has(f)) previewUrls.set(f, URL.createObjectURL(f));
        img.src = previewUrls.get(f);
        const btn = document.createElement('button');
        btn.className = 'thumb-remove';
        btn.textContent = '×';
        btn.onclick = (e) => { e.stopPropagation(); fileArr.splice(i, 1); renderPreviews(); };
        wrap.appendChild(img);
        wrap.appendChild(btn);
        preview.appendChild(wrap);
      });
    } else {
      text.style.display = '';
    }
  }

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('dragover');
    addFiles(e.dataTransfer.files);
  });

  zone.addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') files.push(item.getAsFile());
    }
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });
}

// PNG dimensions and whether the file can carry transparency: an alpha color type
// (4 grey+alpha, 6 RGBA) or a tRNS chunk, which must appear before the first IDAT.
async function readPngInfo(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || signature.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colorType = bytes[25];
  let hasAlpha = colorType === 4 || colorType === 6;
  for (let pos = 8; !hasAlpha && pos + 8 <= bytes.length; pos += 12 + view.getUint32(pos)) {
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (type === 'tRNS') hasAlpha = true;
    if (type === 'IDAT' || type === 'IEND') break;
  }
  return { width: view.getUint32(16), height: view.getUint32(20), hasAlpha };
}

async function readImageSize(file) {
  const bitmap = await createImageBitmap(file);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

// The API applies the mask to the first image and requires a PNG with alpha of the
// same dimensions; fully transparent areas mark what to change. Returns '' when valid.
async function maskProblem(mask, image) {
  try {
    const info = await readPngInfo(mask);
    if (!info) return '必須是 PNG 檔';
    if (!info.hasAlpha) return '必須含透明通道（alpha），透明區域代表要修改的部分';
    const size = await readImageSize(image);
    if (size.width !== info.width || size.height !== info.height) {
      return `尺寸須與第一張圖相同（遮罩 ${info.width}×${info.height}，圖片 ${size.width}×${size.height}）`;
    }
    return '';
  } catch (e) {
    console.error('maskProblem: cannot read mask or image', e);
    return '無法讀取遮罩或圖片';
  }
}

function stopEdit() {
  if (editController) editController.abort();
}

function stopGenerate() {
  if (genController) {
    genUserStopped = true;
    genController.abort();
  }
}

function showStreamPreview() {
  document.getElementById('streamPreview').style.display = '';
  document.getElementById('streamStage').textContent = '等待串流事件…';
  document.getElementById('streamElapsed').textContent = '0.0s';
  const img = document.getElementById('streamImg');
  img.hidden = true;
  img.removeAttribute('src');
}

function hideStreamPreview() {
  document.getElementById('streamPreview').style.display = 'none';
  document.getElementById('streamImg').removeAttribute('src');
  if (streamObjectUrl) { URL.revokeObjectURL(streamObjectUrl); streamObjectUrl = null; }
}

function showStreamPartial(b64, fmt) {
  try {
    const mime = imageMimeType(fmt);
    // Object URL instead of data: URL — avoids holding a second base64 copy in the DOM
    if (streamObjectUrl) URL.revokeObjectURL(streamObjectUrl);
    streamObjectUrl = b64ToObjectUrl(b64, mime);
    const img = document.getElementById('streamImg');
    img.src = streamObjectUrl;
    img.hidden = false;
  } catch (e) {
    console.warn('skip malformed partial image:', e);
  }
}

async function generate() {
  if (genController) return; // already in flight (keyboard shortcut can re-enter)
  const prompt = document.getElementById('prompt').value.trim();
  if (!prompt) { alert('請輸入提示詞'); return; }
  const size = getSize();
  if (!size) return;
  const quality = document.getElementById('quality').value;
  const background = document.getElementById('background').value;
  const fmt = document.getElementById('format').value;
  if (!checkBackgroundFormat(background, fmt)) return;
  const partials = getPartialImageCount();
  // Single image per request by design; SSE streaming is the primary path
  const useStream = partials > 0;
  const btn = document.getElementById('generateBtn');
  const stopBtn = document.getElementById('stopGenBtn');

  const body = { model: IMAGE_MODEL, prompt, n: 1 };
  if (size !== 'auto') body.size = size;
  if (quality !== 'auto') body.quality = quality;
  if (background !== 'auto') body.background = background;
  if (fmt !== 'png') {
    body.output_format = fmt;
    body.output_compression = parseInt(document.getElementById('compression').value);
  }

  const base = requireBaseUrl();
  if (!base) return;
  btn.disabled = true;
  stopBtn.style.display = '';
  genUserStopped = false;
  genController = new AbortController();
  const timeoutId = setTimeout(() => genController.abort(), API_TIMEOUT_MS);
  let timerId = null;
  try {
    let data;
    if (useStream) {
      body.stream = true;
      body.partial_images = partials;
      showStreamPreview();
      const t0 = performance.now();
      timerId = setInterval(() => {
        document.getElementById('streamElapsed').textContent =
          ((performance.now() - t0) / 1000).toFixed(1) + 's';
      }, 200);
      showLoading('串流生成中...');
      data = await callGenerateAPIStream(body, {
        signal: genController.signal,
        onPartial: (b64, idx) => {
          document.getElementById('streamStage').textContent =
            idx != null ? `部分圖 ${idx + 1}` : '部分圖';
          showStreamPartial(b64, fmt);
        }
      });
    } else {
      showLoading('生成中...');
      data = await callGenerateAPI(body, genController.signal);
    }
    if (!data || !Array.isArray(data.data) || !data.data.length) {
      throw new Error('回應中沒有圖片資料');
    }
    document.getElementById('status').textContent = '完成';
    addToHistory('generate', prompt, data.data, fmt);
  } catch (e) {
    if (e.name === 'AbortError') {
      if (genUserStopped) document.getElementById('status').textContent = '已停止';
      else showError('請求超時（超過5分鐘），請稍後重試');
    } else {
      showError(explainFetchFailure(e));
    }
  } finally {
    clearTimeout(timeoutId);
    if (timerId) clearInterval(timerId);
    genController = null;
    btn.disabled = false;
    stopBtn.style.display = 'none';
    hideStreamPreview();
  }
}

async function editImage() {
  const btn = document.getElementById('editBtn');
  if (btn.disabled) return;
  const prompt = document.getElementById('editPrompt').value.trim();
  if (!prompt) { alert('請輸入編輯提示詞'); return; }
  if (!editFiles.length) { alert('請上傳至少一張圖片'); return; }
  const size = getSize('editSize', 'editCustomSize');
  if (!size) return;
  const quality = document.getElementById('editQuality').value;
  const background = document.getElementById('editBackground').value;
  const fmt = document.getElementById('editFormat').value;
  if (!checkBackgroundFormat(background, fmt)) return;
  if (maskFiles.length) {
    btn.disabled = true;
    const problem = await maskProblem(maskFiles[0], editFiles[0]);
    btn.disabled = false;
    if (problem) { alert('遮罩不符合要求：' + problem); return; }
  }

  const formData = new FormData();
  formData.append('model', IMAGE_MODEL);
  formData.append('prompt', prompt);
  formData.append('n', '1');
  if (size !== 'auto') formData.append('size', size);
  if (quality !== 'auto') formData.append('quality', quality);
  if (background !== 'auto') formData.append('background', background);
  if (fmt !== 'png') {
    formData.append('output_format', fmt);
    formData.append('output_compression', document.getElementById('editCompression').value);
  }
  for (const f of editFiles) formData.append('image[]', f);
  if (maskFiles.length) formData.append('mask', maskFiles[0]);

  const base = requireBaseUrl();
  if (!base) return;

  const stopBtn = document.getElementById('stopEditBtn');
  btn.disabled = true;
  stopBtn.style.display = '';
  editController = new AbortController();
  showLoading('編輯中...');
  const progressBar = document.getElementById('uploadProgress');
  const progressFill = document.getElementById('uploadProgressFill');
  progressBar.classList.add('active');
  progressFill.style.width = '0%';
  try {
    const data = await callEditAPI(formData, (pct) => {
      progressFill.style.width = pct + '%';
      showLoading(pct < 100 ? `上傳中 ${pct}%...` : '生成中...');
    }, editController.signal);
    if (!data || !Array.isArray(data.data) || !data.data.length) {
      throw new Error('回應中沒有圖片資料');
    }
    document.getElementById('status').textContent = '完成';
    addToHistory('edit', prompt, data.data, fmt);
  } catch (e) {
    // Only stopEdit() aborts this signal; XHR timeouts reject with their own message.
    if (e.name === 'AbortError') document.getElementById('status').textContent = '已停止';
    else showError(explainFetchFailure(e));
  } finally {
    editController = null;
    btn.disabled = false;
    stopBtn.style.display = 'none';
    progressBar.classList.remove('active');
  }
}

function initEditor() {
  setupDropZone('editDropZone', 'editImage', 'editPreview', 'editDropText', editFiles, true);
  setupDropZone('maskDropZone', 'editMask', 'maskPreview', 'maskDropText', maskFiles, false);

  // Keyboard shortcuts (ported from image2-sse.html): Ctrl/Cmd+Enter submits the
  // focused prompt; Esc aborts in-flight generations and edits (lightbox Esc wins).
  document.getElementById('prompt').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); generate(); }
  });
  document.getElementById('editPrompt').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); editImage(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('lightbox').classList.contains('open')) return;
    if (genController) stopGenerate();
    if (editController) stopEdit();
    if (chatController) { chatUserStopped = true; chatController.abort(); }
  });
}
