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
      const values = { size: '1536x1024', quality: 'high', background: 'auto',
        editSize: '1024x1536', editQuality: 'medium', editBackground: 'opaque' };
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
        // Chat edits reuse the edit tab settings and restate what must stay unchanged.
        assert.equal(request.get('size'), '1024x1536');
        assert.equal(request.get('quality'), 'medium');
        assert.equal(request.get('background'), 'opaque');
        assert.equal(request.get('prompt'),
          'refine\n\n只修改上述指令提到的部分；其餘構圖、主體、光線、風格保持不變；不要加入文字或浮水印。');
      } else {
        assert.equal(request.model, 'gpt-image-2.5-sunburst');
        assert.equal(request.prompt, 'refine');
        assert.equal(request.size, '1536x1024');
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
  const values = { editSize: 'custom', editCustomSize: '1000x1000', editQuality: 'auto', editBackground: 'auto' };
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
