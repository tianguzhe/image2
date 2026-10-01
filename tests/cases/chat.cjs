const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, base64, deferred } = require('../support/harness.cjs');

for (const hasSeed of [false, true]) {
  for (const streaming of [false, true]) {
    test(`Sunburst chat generation follows the streaming setting and edits never stream: seed=${hasSeed}, stream=${streaming}`, async () => {
      const h = harness();
      h.ctx.requireBaseUrl = () => 'https://example.test/v1';
      h.ctx.removeChatPartial = () => {};
      h.element('chatInput').value = 'refine';
      h.element('partials').value = streaming ? '2' : '0';
      const values = { size: 'custom', customSize: '1580\u200a×\u200a996', quality: 'high', background: 'auto',
        editSize: 'custom', editCustomSize: '996 X 1580', editQuality: 'medium', editBackground: 'opaque' };
      for (const [id, value] of Object.entries(values)) h.element(id).value = value;
      if (hasSeed) h.ctx.activeConv = {
        id: 42, title: 'seed', turns: [{ kind: 'seed', fmt: 'png', images: [{ b64_json: base64 }] }],
      };
      let request, endpoint, actualStreaming;
      const response = (name, stream) => async body => {
        request = body;
        endpoint = name;
        actualStreaming = stream;
        return { data: [{ b64_json: base64 }] };
      };
      h.ctx.callGenerateAPI = response('generate', false);
      h.ctx.callGenerateAPIStream = response('generate', true);
      h.ctx.callEditAPI = response('edit', false);
      await h.ctx.sendChatTurn();
      assert.equal(endpoint, hasSeed ? 'edit' : 'generate');
      // The proxy returns 502 for streamed edits, so chat edits never stream.
      assert.equal(actualStreaming, hasSeed ? false : streaming);
      if (hasSeed) {
        assert.equal(request.get('model'), 'gpt-image-2.5-sunburst');
        assert.equal(request.get('stream'), null);
        assert.equal(request.get('partial_images'), null);
        assert.equal(request.get('image[]').name, 'input.png');
        // Chat edits reuse the edit tab settings and send the user's prompt verbatim.
        assert.equal(request.get('size'), '996x1580');
        assert.equal(request.get('quality'), 'medium');
        assert.equal(request.get('background'), 'opaque');
        assert.equal(request.get('prompt'), 'refine');
      } else {
        assert.equal(request.model, 'gpt-image-2.5-sunburst');
        assert.equal(request.prompt, 'refine');
        assert.equal(request.size, '1580x996');
        assert.equal(request.quality, 'high');
        assert.equal(request.background, undefined);
        assert.equal(request.stream, streaming ? true : undefined);
        assert.equal(request.partial_images, streaming ? 2 : undefined);
      }
      assert.equal(h.ctx.chatBusy, false);
      assert.equal(h.ctx.chatController, null);
      assert.equal(h.element('chatSendBtn').textContent, '送出');
      const saved = h.records.get('conversations').get(hasSeed ? 42 : 100);
      assert.equal(saved.turns.at(-1).kind, hasSeed ? 'edit' : 'generate');
      assert.equal(saved.turns.at(-1).prompt, 'refine');
    });
  }
}

test('chat rejects invalid edit settings before sending or recording a turn', async () => {
  const h = harness();
  h.ctx.requireBaseUrl = () => 'https://example.test/v1';
  h.element('chatInput').value = 'refine';
  const values = { editSize: 'custom', editCustomSize: '0x1000', editQuality: 'auto', editBackground: 'auto' };
  for (const [id, value] of Object.entries(values)) h.element(id).value = value;
  const conv = { id: 42, title: 'seed', turns: [{ kind: 'seed', fmt: 'png', images: [{ b64_json: base64 }] }] };
  h.ctx.activeConv = conv;
  let calls = 0;
  h.ctx.callEditAPI = async () => { calls++; };
  await h.ctx.sendChatTurn();
  assert.equal(calls, 0);
  assert.equal(h.alerts.length, 1);
  assert.equal(conv.turns.length, 1);
  assert.equal(h.element('chatInput').value, 'refine');
  assert.equal(h.ctx.chatBusy, false);
});

test('single conversation deletion keeps unrelated records, confirms, handles failures and empties history', async () => {
  const h = harness();
  h.element('chatHistPanel').classList.add('open');
  const first = { id: 1, title: 'first', updatedAt: 2, turns: [] };
  const second = { id: 2, title: '<second>', updatedAt: 1, turns: [] };
  await h.ctx.saveConversation(first);
  await h.ctx.saveConversation(second);
  h.ctx.activeConv = first;
  h.ctx.confirm = () => false;
  await h.ctx.deleteChatHistoryItem(1);
  assert.equal(h.records.get('conversations').size, 2);
  h.ctx.confirm = () => true;
  h.ctx.chatBusy = true;
  await h.ctx.deleteChatHistoryItem(1);
  assert.equal(h.records.get('conversations').size, 2);
  h.ctx.chatBusy = false;
  const originalDelete = h.ctx.deleteConversation;
  h.ctx.deleteConversation = async () => { throw new Error('disk failure'); };
  await h.ctx.deleteChatHistoryItem(1);
  assert.equal(h.ctx.activeConv.id, 1);
  assert.equal(h.ctx.chatDeleting, false);
  h.ctx.deleteConversation = originalDelete;
  await h.ctx.deleteChatHistoryItem(2);
  assert.equal(h.ctx.activeConv.id, 1);
  assert.equal(h.records.get('conversations').size, 1);
  await h.ctx.deleteChatHistoryItem(1);
  assert.equal(h.ctx.activeConv, null);
  assert(h.element('chatHistPanel').innerHTML.includes('尚無對話'));
});

test('pending generation saves to its originating conversation after the user opens another', async () => {
  const h = harness();
  h.ctx.requireBaseUrl = () => 'https://example.test/v1';
  h.ctx.removeChatPartial = () => {};
  h.element('chatInput').value = 'original request';
  h.element('partials').value = '2';
  for (const id of ['size', 'quality', 'background']) h.element(id).value = 'auto';
  const original = { id: 1, title: 'original', turns: [] };
  const next = { id: 2, title: 'next', turns: [] };
  h.ctx.activeConv = original;
  const response = deferred();
  let partial;
  let previewCount = 0;
  h.ctx.callGenerateAPIStream = (body, options) => { partial = options.onPartial; return response.promise; };
  h.ctx.showChatPartial = () => { previewCount++; };
  const pending = h.ctx.sendChatTurn();
  h.ctx.activeConv = next;
  partial(base64);
  response.resolve({ data: [{ b64_json: base64 }] });
  await pending;
  assert.equal(previewCount, 0);
  assert.equal(next.turns.length, 0);
  assert.equal(h.ctx.activeConv, next);
  assert.equal(h.records.get('conversations').get(1).turns.at(-1).kind, 'generate');
  assert.equal(h.records.get('conversations').has(2), false);
});

for (const sameConversation of [false, true]) {
  test(`an older chat render cannot append stale images: same conversation=${sameConversation}`, async () => {
    const h = harness();
    h.ctx.renderChat = h.renderChat;
    const image = deferred();
    h.ctx.activeConv = { id: 1, title: 'old', turns: [{ kind: 'seed', fmt: 'png' }] };
    h.ctx.turnImageSrc = () => image.promise;
    const oldRender = h.ctx.renderChat();
    if (!sameConversation) {
      h.ctx.activeConv = { id: 2, title: 'new', turns: [{ kind: 'user', prompt: 'new text' }] };
    }
    h.ctx.turnImageSrc = async () => 'data:image/png;base64,new';
    await h.ctx.renderChat();
    image.resolve('data:image/png;base64,old');
    await oldRender;
    const messages = h.element('chatMessages').children;
    assert.equal(messages.length, 1);
    assert(!messages[0].innerHTML.includes('base64,old'));
  });
}

test('Enter that confirms an IME composition does not send the chat turn', () => {
  const h = harness();
  h.ctx.initChat();
  let sent = 0;
  h.ctx.sendChatTurn = () => { sent++; };
  const press = extra => h.element('chatInput').dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false,
    isComposing: false, keyCode: 13, preventDefault() {}, ...extra });
  press({ isComposing: true });
  // Safari reports the confirming Enter with isComposing=false but keyCode 229.
  press({ keyCode: 229 });
  press({ shiftKey: true });
  assert.equal(sent, 0);
  press();
  assert.equal(sent, 1);
});

function wireViewElements(h) {
  h.ctx.document.querySelector = () => h.element('galleryArea');
  h.ctx.document.querySelectorAll = () => [];
  h.ctx.renderChat = h.renderChat;
}

test('new conversation from gallery does not restore an older conversation', async () => {
  const h = harness();
  wireViewElements(h);
  let loads = 0;
  h.ctx.loadConversations = async () => { loads++; return [{ id: 1, title: 'old', turns: [] }]; };
  h.ctx.newConversation();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 0);
  assert.equal(h.ctx.activeConv, null);
  assert.equal(h.ctx.currentView, 'chat');
  assert.equal(h.element('chatTitle').textContent, '新對話');
});

test('pending history restoration cannot replace an explicitly created new conversation', async () => {
  const h = harness();
  wireViewElements(h);
  h.ctx.currentView = 'chat';
  const history = deferred();
  h.ctx.loadConversations = () => history.promise;
  const loading = h.ctx.loadActiveConversation();
  h.ctx.newConversation();
  history.resolve([{ id: 1, title: 'old', turns: [] }]);
  await loading;
  assert.equal(h.ctx.activeConv, null);
  assert.equal(h.element('chatTitle').textContent, '新對話');
});

test('pending history restoration cannot switch away from a newly submitted conversation', async () => {
  const h = harness();
  wireViewElements(h);
  h.ctx.currentView = 'chat';
  h.ctx.requireBaseUrl = () => 'https://example.test/v1';
  h.ctx.removeChatPartial = () => {};
  h.element('chatInput').value = 'new image';
  for (const id of ['size', 'quality', 'background']) h.element(id).value = 'auto';
  h.element('partials').value = '0';
  const history = deferred();
  h.ctx.loadConversations = () => history.promise;
  const loading = h.ctx.loadActiveConversation();
  h.ctx.callGenerateAPI = async () => ({ data: [{ b64_json: base64 }] });
  await h.ctx.sendChatTurn();
  const submitted = h.ctx.activeConv;
  history.resolve([{ id: 1, title: 'old', turns: [] }]);
  await loading;
  assert.equal(h.ctx.activeConv, submitted);
  assert.equal(h.ctx.activeConv.turns.at(-1).kind, 'generate');
});

test('rapid history selections keep the most recently selected conversation', async () => {
  const h = harness();
  wireViewElements(h);
  h.ctx.initChat();
  const first = deferred(), second = deferred();
  h.ctx.loadConversation = id => id === 1 ? first.promise : second.promise;
  const select = id => h.element('chatHistPanel').listeners.click({
    target: { closest: selector => selector === '[data-conv-id]' ? { dataset: { convId: String(id) } } : null },
  });
  const loadingFirst = select(1);
  const loadingSecond = select(2);
  second.resolve({ id: 2, title: 'second', turns: [] });
  await loadingSecond;
  first.resolve({ id: 1, title: 'first', turns: [] });
  await loadingFirst;
  assert.equal(h.ctx.activeConv.id, 2);
  assert.equal(h.element('chatTitle').textContent, 'second');
});

for (const saveFails of [false, true]) {
  test(`starting a conversation from an image preserves the current selection during an interrupted save: fails=${saveFails}`, async () => {
    const h = harness();
    wireViewElements(h);
    h.ctx.currentView = 'chat';
    const original = { id: 1, title: 'original', turns: [] };
    h.ctx.activeConv = original;
    h.ctx.blobToBase64 = async () => base64;
    const started = deferred(), saving = deferred();
    const errors = [];
    h.ctx.showError = message => errors.push(message);
    h.ctx.saveConversation = async () => { started.resolve(); await saving.promise; };
    const pending = h.ctx.startChatFromImage({ src: 'https://example.test/image', filename: 'image.png', prompt: 'seed' });
    await started.promise;
    assert.equal(h.ctx.activeConv, original);
    if (saveFails) saving.reject(new Error('quota'));
    else { h.ctx.newConversation(); saving.resolve(); }
    await pending;
    assert.equal(h.ctx.activeConv, saveFails ? original : null);
    assert.equal(errors.length, saveFails ? 1 : 0);
  });
}
