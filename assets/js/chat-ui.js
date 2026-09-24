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
  chatBlobCache.forEach(url => URL.revokeObjectURL(url));
  chatBlobCache.clear();
}

function switchView(name) {
  if (name !== 'gallery' && name !== 'chat') return;
  currentView = name;
  const area = document.querySelector('.gallery-area');
  document.querySelectorAll('#viewSwitch button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === name));
  if (name === 'chat') {
    area.classList.add('chat-mode');
    if (activeConv) renderChat();
    else loadActiveConversation();
  } else {
    area.classList.remove('chat-mode');
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
    const safeSrc = escapeHtml(src);
    const div = document.createElement('div');
    div.className = 'chat-msg image';
    div.innerHTML = `${turn.kind === 'seed' ? '<span class="chat-seed-tag">起點</span>' : ''}
      <div class="chat-img-card">${src
        ? `<img src="${safeSrc}" alt="" loading="lazy">`
        : '<div style="padding:24px;color:var(--text-tertiary);font-size:12px;">圖片已遺失</div>'}</div>
      <div class="chat-img-actions">
        ${src ? `<a href="${safeSrc}" download="chat_${conversation.id}_${i}.${ext}">下載</a>` : ''}
        ${turn.prompt ? `<button data-chat-copy-idx="${i}">複製提示詞</button>` : ''}
      </div>`;
    messages.appendChild(div);
  }
  messages.scrollTop = messages.scrollHeight;
}

function openChatImage(src) {
  if (!src) return;
  const lb = document.getElementById('lightbox');
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightboxPrompt').textContent = '';
  const dl = document.getElementById('lightboxDl'); dl.href = src; dl.download = 'image.png';
  document.getElementById('lightboxCounter').textContent = '';
  document.getElementById('lightboxPrev').disabled = true;
  document.getElementById('lightboxNext').disabled = true;
  lightboxIndex = -1;
  lb.classList.add('open');
  document.body.style.overflow = 'hidden';
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
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatTurn(); }
  });
  document.getElementById('chatMessages').addEventListener('click', (e) => {
    const img = e.target.closest('.chat-img-card img');
    if (img) { openChatImage(img.src); return; }
    const copyBtn = e.target.closest('[data-chat-copy-idx]');
    if (copyBtn && activeConv) {
      const t = activeConv.turns[parseInt(copyBtn.dataset.chatCopyIdx)];
      if (t) navigator.clipboard.writeText(t.prompt).then(() => {
        const orig = copyBtn.textContent; copyBtn.textContent = '已複製';
        setTimeout(() => copyBtn.textContent = orig, 1500);
      });
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
    const conv = await loadConversation(parseInt(item.dataset.convId));
    if (conv) { activeConv = conv; renderChat(); }
    closeChatHistory();
  });
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('chatHistPanel');
    if (!panel.classList.contains('open')) return;
    if (!e.target.closest('.chat-hist-wrap')) closeChatHistory();
  });
  window.addEventListener('beforeunload', revokeChatBlobs);
}
