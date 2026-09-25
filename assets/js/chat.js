// Conversation lifecycle and sequential image editing. Uses api.js, storage.js and chat-ui.js.

function chatSendOrStop() {
  if (chatBusy) {
    if (chatController) { chatUserStopped = true; chatController.abort(); }
    return;
  }
  sendChatTurn();
}

async function turnImageSrc(turn) {
  if (turn.filenames && turn.filenames.length) {
    const fname = turn.filenames[0];
    if (chatBlobCache.has(fname)) return chatBlobCache.get(fname);
    if (useLocalFS && dirHandle) {
      try {
        const fh = await dirHandle.getFileHandle(fname);
        const file = await fh.getFile();
        const url = URL.createObjectURL(file);
        chatBlobCache.set(fname, url);
        return url;
      } catch { return ''; }
    }
    return '';
  }
  if (turn.images && turn.images.length) {
    const img = turn.images[0];
    const mime = imageMimeType(turn.fmt);
    return sanitizeUrl(img.url || `data:${mime};base64,${img.b64_json}`);
  }
  return '';
}

async function persistTurnImages(convId, turnIdx, images, fmt) {
  if (!(useLocalFS && dirHandle)) return null;
  return persistImages(images, fmt, `conv_${convId}_${turnIdx}`);
}

function latestImageTurn(conv) {
  if (!conv) return null;
  for (let i = conv.turns.length - 1; i >= 0; i--) {
    const t = conv.turns[i];
    if ((t.filenames && t.filenames.length) || (t.images && t.images.length)) return t;
  }
  return null;
}

function newConversation() {
  if (currentView !== 'chat') switchView('chat');
  activeConv = null;
  closeChatHistory();
  renderChat();
  document.getElementById('chatInput').focus();
}

async function loadActiveConversation() {
  const list = await loadConversations();
  activeConv = list.length ? list[0] : null;
  renderChat();
}

async function startChatFromImage(item) {
  if (!item || !item.src) return;
  const extOf = (item.filename || '').split('.').pop().toLowerCase();
  const fmt = extOf === 'jpg' ? 'jpeg' : (extOf === 'webp' ? 'webp' : 'png');
  const now = Date.now();
  const time = new Date().toLocaleString('zh-TW');
  // The seed turn owns its own copy of the picked image so it survives independently
  // of the gallery item (which the user may later delete).
  let images = null, filenames = null;
  try {
    if (useLocalFS && dirHandle) {
      const file = await srcToFile(item.src, fmt);
      const ext = imageExtension(fmt);
      const fname = `conv_${now}_0_0.${ext}`;
      await writeLocalFile(fname, file);
      filenames = [fname];
    } else {
      const resp = await fetch(item.src);
      const blob = await resp.blob();
      images = [{ b64_json: await blobToBase64(blob) }];
    }
  } catch (e) {
    console.error('startChatFromImage seed failed:', e);
    switchView('chat');
    showChatStatus('無法載入起點圖片', true);
    return;
  }
  activeConv = {
    id: now, title: (item.prompt || '對話微調').slice(0, 24), time,
    createdAt: now, updatedAt: now,
    turns: [{ kind: 'seed', prompt: item.prompt || '', images, filenames, fmt, time }]
  };
  await saveConversation(activeConv);
  closeLightbox();
  switchView('chat');
  showChatStatus('');
  document.getElementById('chatInput').focus();
}

function startChatFromLightbox() {
  const item = galleryFlatList[lightboxIndex];
  if (item) startChatFromImage(item);
}

async function deleteActiveConversation() {
  if (!activeConv) return;
  await deleteChatHistoryItem(activeConv.id);
}

async function deleteChatHistoryItem(id) {
  if (chatDeleting) return;
  if (chatBusy) {
    showChatStatus('請先停止生成，再刪除對話', true);
    return;
  }
  if (!confirm('確定刪除此對話？本地資料夾的圖片也會一併移除。')) return;
  chatDeleting = true;
  try {
    await deleteConversation(id);
    if (activeConv && activeConv.id === id) {
      activeConv = null;
      await loadActiveConversation();
    }
    if (document.getElementById('chatHistPanel').classList.contains('open')) {
      await renderChatHistory();
    }
    showChatStatus('');
  } catch (e) {
    console.error('deleteConversation failed:', e);
    showChatStatus('刪除對話失敗，請重試', true);
  } finally {
    chatDeleting = false;
  }
}

async function sendChatTurn() {
  if (chatBusy || chatDeleting) return;
  const input = document.getElementById('chatInput');
  const prompt = input.value.trim();
  if (!prompt) { input.focus(); return; }
  const base = requireBaseUrl();
  if (!base) return;

  const seedTurn = latestImageTurn(activeConv);
  const hasImage = !!seedTurn;
  const fmt = 'png';
  // Keep output settings fixed across turns: edits follow the edit tab, generation the generate tab.
  const ids = hasImage
    ? { size: 'editSize', custom: 'editCustomSize', quality: 'editQuality', background: 'editBackground' }
    : { size: 'size', custom: 'customSize', quality: 'quality', background: 'background' };
  const size = getSize(ids.size, ids.custom);
  if (!size) return;
  const quality = document.getElementById(ids.quality).value;
  const background = document.getElementById(ids.background).value;
  // Same streaming preference as the generate tab
  const partials = getPartialImageCount();
  chatBusy = true;
  chatUserStopped = false;
  chatController = new AbortController();
  const timeoutId = setTimeout(() => chatController.abort(), API_TIMEOUT_MS);
  const sendBtn = document.getElementById('chatSendBtn');
  sendBtn.textContent = '停止';

  const now = Date.now();
  if (!activeConv) {
    const time = new Date().toLocaleString('zh-TW');
    activeConv = { id: now, title: prompt.slice(0, 24), time, createdAt: now, updatedAt: now, turns: [] };
  }
  // The request belongs to this conversation even if the user opens a new one.
  const conversation = activeConv;
  conversation.turns.push({ kind: 'user', prompt, time: new Date().toLocaleString('zh-TW') });
  renderChat();
  input.value = '';

  try {
    let data;
    const onPartial = (b64) => {
      if (activeConv !== conversation) return;
      showChatStatus('串流中…');
      showChatPartial(b64, fmt);
    };
    if (hasImage) {
      showChatStatus('微調中...');
      const src = await turnImageSrc(seedTurn);
      if (!src) throw new Error('找不到可用的輸入圖片');
      const file = await srcToFile(src, seedTurn.fmt || 'png');
      const formData = new FormData();
      formData.append('model', IMAGE_MODEL);
      formData.append('prompt', `${prompt}\n\n${CHAT_EDIT_CONSTRAINT}`);
      formData.append('n', '1');
      if (size !== 'auto') formData.append('size', size);
      if (quality !== 'auto') formData.append('quality', quality);
      if (background !== 'auto') formData.append('background', background);
      formData.append('image[]', file);
      // Streamed edits get a 502 without CORS headers from the proxy; match the edit tab and never stream.
      data = await callEditAPI(formData,
        (pct) => {
          if (activeConv === conversation) showChatStatus(pct < 100 ? `上傳中 ${pct}%...` : '生成中...');
        },
        chatController.signal);
    } else {
      showChatStatus(partials > 0 ? '串流生成中...' : '生成中...');
      const body = { model: IMAGE_MODEL, prompt, n: 1 };
      if (size !== 'auto') body.size = size;
      if (quality !== 'auto') body.quality = quality;
      if (background !== 'auto') body.background = background;
      if (partials > 0) {
        body.stream = true;
        body.partial_images = partials;
        data = await callGenerateAPIStream(body, { signal: chatController.signal, onPartial });
      } else {
        data = await callGenerateAPI(body, chatController.signal);
      }
    }
    if (!data || !Array.isArray(data.data) || !data.data.length) {
      throw new Error('回應中沒有圖片資料');
    }
    const images = data.data;
    const turnIdx = conversation.turns.length;
    const filenames = await persistTurnImages(conversation.id, turnIdx, images, fmt);
    conversation.turns.push({
      kind: hasImage ? 'edit' : 'generate', prompt,
      images: filenames ? null : images, filenames, fmt,
      time: new Date().toLocaleString('zh-TW')
    });
    conversation.updatedAt = Date.now();
    await saveConversation(conversation);
    if (activeConv === conversation) {
      showChatStatus('');
      renderChat();
    }
  } catch (e) {
    if (activeConv !== conversation) {
      console.error('sendChatTurn failed for conversation', conversation.id, e);
      return;
    }
    if (e.name === 'AbortError') {
      if (chatUserStopped) showChatStatus('已停止');
      else showChatStatus('請求超時（超過5分鐘），請稍後重試', true);
    } else {
      console.error('sendChatTurn failed:', e);
      showChatStatus('錯誤：' + explainFetchFailure(e), true);
    }
  } finally {
    clearTimeout(timeoutId);
    chatController = null;
    chatBusy = false;
    removeChatPartial();
    sendBtn.textContent = '送出';
    sendBtn.disabled = false;
  }
}
