// Chat rendering, partial previews, history dropdown and events. Uses chat.js.

function showChatPartial(b64, fmt) {
  try {
    const messages = document.getElementById('chatMessages');
    let card = document.getElementById('chatPartialCard');
    if (!card) {
      card = document.createElement('div');
      card.id = 'chatPartialCard';
      card.className = 'chat-msg image';
      card.innerHTML = '<span class="chat-seed-tag">串流中…</span><div class="chat-img-card"><img alt=""></div>';
      messages.appendChild(card);
    }
    const mime = imageMimeType(fmt);
    if (chatPartialUrl) URL.revokeObjectURL(chatPartialUrl);
    chatPartialUrl = b64ToObjectUrl(b64, mime);
    card.querySelector('img').src = chatPartialUrl;
    messages.scrollTop = messages.scrollHeight;
  } catch (e) {
    console.warn('skip malformed partial image:', e);
  }
}

function removeChatPartial() {
  const card = document.getElementById('chatPartialCard');
  if (card) card.remove();
  if (chatPartialUrl) { URL.revokeObjectURL(chatPartialUrl); chatPartialUrl = null; }
}

function revokeChatBlobs() {
  chatCacheVersion++;
  chatBlobCache.forEach(url => URL.revokeObjectURL(url));
  chatBlobCache.clear();
}

function switchView(name, restoreConversation = true) {
  if (name !== 'gallery' && name !== 'chat') return;
  chatNavigationVersion++;
  currentView = name;
  const area = document.querySelector('.gallery-area');
  document.querySelectorAll('#viewSwitch button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === name));
  if (name === 'chat') {
    area.classList.add('chat-mode');
    if (activeConv || !restoreConversation) renderChat();
    else loadActiveConversation();
  } else {
    area.classList.remove('chat-mode');
    if (galleryColumns !== getGalleryColumnCount()) renderGallery();
  }
}

function showChatStatus(msg, isError) {
  const el = document.getElementById('chatStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = isError ? 'var(--danger)' : 'var(--text-secondary)';
}

async function renderChat() {
  const version = ++chatRenderVersion;
  const conversation = activeConv;
  const titleEl = document.getElementById('chatTitle');
  const messages = document.getElementById('chatMessages');
  const delBtn = document.getElementById('chatDelBtn');
  if (!messages) return;
  titleEl.textContent = conversation ? (conversation.title || '對話') : '新對話';
  delBtn.style.display = conversation ? '' : 'none';

  if (!conversation || !conversation.turns.length) {
    messages.innerHTML = `<div class="chat-empty">從畫廊任一張圖點「對話微調」，<br>或在下方直接輸入提示詞開始。<br><br>之後每一輪都會以上一張圖為基礎，連續修改。</div>`;
    return;
  }
  messages.innerHTML = '';
  const turns = [...conversation.turns];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.kind === 'user') {
      const div = document.createElement('div');
      div.className = 'chat-msg user';
      div.innerHTML = `<div class="chat-bubble">${escapeHtml(turn.prompt)}</div><span class="chat-msg-time">${escapeHtml(turn.time || '')}</span>`;
      messages.appendChild(div);
      continue;
    }
    const src = await turnImageSrc(turn);
    if (version !== chatRenderVersion || activeConv !== conversation) return;
    const ext = imageExtension(turn.fmt);
    const filename = `chat_${conversation.id}_${i}.${ext}`;
    const safeSrc = escapeHtml(src);
    const div = document.createElement('div');
    div.className = 'chat-msg image';
    div.innerHTML = `${turn.kind === 'seed' ? '<span class="chat-seed-tag">起點</span>' : ''}
      <div class="chat-img-card">${src
        ? `<button type="button" class="chat-image-open" aria-label="查看圖片大圖"
            data-filename="${escapeHtml(filename)}" data-chat-image-idx="${i}">
            <img src="${safeSrc}" alt="" loading="lazy" decoding="async">
            <span class="chat-img-hint" aria-hidden="true">查看大圖</span>
          </button>`
        : '<div style="padding:24px;color:var(--text-tertiary);font-size:12px;">圖片已遺失</div>'}</div>
      <div class="chat-img-actions">
        ${src ? `<a href="${safeSrc}" download="${escapeHtml(filename)}">下載</a>` : ''}
        ${turn.prompt ? `<button data-chat-copy-idx="${i}">複製提示詞</button>` : ''}
      </div>`;
    messages.appendChild(div);
  }
  messages.scrollTop = messages.scrollHeight;
}

function openChatImage(src, filename = 'image.png', prompt = '') {
  if (!src) return;
  document.getElementById('lightboxImg').src = src;
  const promptEl = document.getElementById('lightboxPrompt');
  promptEl.textContent = prompt;
  promptEl.classList.remove('expanded');
  const dl = document.getElementById('lightboxDl'); dl.href = src; dl.download = filename;
  document.getElementById('lightboxCounter').textContent = '';
  document.getElementById('lightboxPrev').disabled = true;
  document.getElementById('lightboxNext').disabled = true;
  lightboxIndex = -1;
  lightboxItem = null;
  for (const id of ['lightboxChat', 'lightboxDel']) document.getElementById(id).hidden = true;
  document.getElementById('lightboxCopy').hidden = !prompt;
  activateLightbox();
}

async function toggleChatHistory() {
  const panel = document.getElementById('chatHistPanel');
  if (panel.classList.contains('open')) { closeChatHistory(); return; }
  await renderChatHistory();
  panel.classList.add('open');
}

async function renderChatHistory() {
  const panel = document.getElementById('chatHistPanel');
  const list = await loadConversations();
  panel.innerHTML = list.length
    ? list.map(c => `<div class="chat-hist-item ${activeConv && c.id === activeConv.id ? 'active' : ''}" data-conv-id="${c.id}">
        <span class="chat-hist-info"><span class="chat-hist-title">${escapeHtml(c.title || '對話')}</span><span class="chat-hist-time">${escapeHtml(c.time || '')}</span></span>
        <button type="button" class="chat-hist-delete" data-delete-conv-id="${c.id}" aria-label="刪除對話：${escapeHtml(c.title || '對話')}">刪除</button>
      </div>`).join('')
    : '<div class="chat-hist-empty">尚無對話</div>';
}

function closeChatHistory() {
  const panel = document.getElementById('chatHistPanel');
  if (panel) panel.classList.remove('open');
}

function initChat() {
  // ---- chat event wiring ----
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    // Enter also confirms an IME candidate (Chinese/Japanese input); that must not send.
    // Safari reports that Enter with isComposing=false, so keyCode 229 is checked too.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatTurn(); }
  });
  document.getElementById('chatMessages').addEventListener('click', (e) => {
    const imageBtn = e.target.closest('.chat-image-open');
    if (imageBtn) {
      const turn = activeConv?.turns[Number(imageBtn.dataset.chatImageIdx)];
      const img = imageBtn.querySelector('img');
      if (img) openChatImage(img.src, imageBtn.dataset.filename, turn?.prompt || '');
      return;
    }
    const copyBtn = e.target.closest('[data-chat-copy-idx]');
    if (copyBtn && activeConv) {
      const t = activeConv.turns[parseInt(copyBtn.dataset.chatCopyIdx)];
      if (t) copyText(copyBtn, t.prompt);
    }
  });
  document.getElementById('chatHistPanel').addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('[data-delete-conv-id]');
    if (deleteBtn) {
      e.stopPropagation();
      deleteBtn.disabled = true;
      try {
        await deleteChatHistoryItem(Number(deleteBtn.dataset.deleteConvId));
      } finally {
        deleteBtn.disabled = false;
      }
      return;
    }
    if (chatBusy || chatDeleting) return;
    const item = e.target.closest('[data-conv-id]');
    if (!item) return;
    const version = ++chatNavigationVersion;
    try {
      const conv = await loadConversation(Number(item.dataset.convId));
      if (version !== chatNavigationVersion) return;
      if (conv) { activeConv = conv; renderChat(); }
      closeChatHistory();
    } catch (e) {
      console.error('loadConversation failed:', e);
      if (version === chatNavigationVersion) showChatStatus('無法載入對話，請重試', true);
    }
  });
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('chatHistPanel');
    if (!panel.classList.contains('open')) return;
    if (!e.target.closest('.chat-hist-wrap')) closeChatHistory();
  });
  window.addEventListener('beforeunload', revokeChatBlobs);
}
