const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, base64, deferred } = require('../support/harness.cjs');

for (const fmt of ['png', 'jpeg', 'webp', undefined]) {
  test(`gallery and conversation storage retain bytes and filenames: ${fmt}`, async () => {
    const h = harness();
    const images = [{ b64_json: base64, url: 'https://unused.test/image' }, { url: 'https://example.test/image' }];
    h.ctx.setStorage(true, h.directory);
    await h.ctx.addToHistory('generate', 'prompt', images, fmt);
    const ext = fmt === 'jpeg' ? 'jpg' : fmt || 'png';
    const saved = h.records.get('history').get(100);
    assert.deepEqual(saved.filenames, [`100_0.${ext}`, `100_1.${ext}`]);
    assert.equal(saved.type, 'generate');
    assert.equal(saved.prompt, 'prompt');
    assert.equal(saved.fmt, fmt);
    assert.equal(saved.images, undefined);
    assert.deepEqual(Buffer.from(h.files.get(`100_0.${ext}`)), Buffer.from(base64, 'base64'));
    assert.equal(await h.files.get(`100_1.${ext}`).text(), 'remote-image');
    const names = await h.ctx.persistTurnImages(200, 3, images, fmt);
    assert.deepEqual([...names], [`conv_200_3_0.${ext}`, `conv_200_3_1.${ext}`]);
    assert.deepEqual(h.requests.map(item => item.url), ['https://example.test/image', 'https://example.test/image']);
    h.ctx.setStorage(false, null);
    await h.ctx.addToHistory('edit', 'next prompt', images, fmt);
    assert.deepEqual(h.records.get('history').get(101).images, images);
    assert.equal(h.records.get('history').size, 2);
    assert.equal(await h.ctx.persistTurnImages(200, 4, images, fmt), null);
  });
}

test('history migration preserves metadata and remote/base64 image order', async () => {
  const h = harness();
  const source = { id: 5, prompt: 'migration', type: 'edit', fmt: 'jpeg', time: 'saved time',
    images: [{ b64_json: base64 }, { url: 'https://example.test/image' }] };
  h.ctx.loadHistory = async () => [source];
  h.ctx.showLoading = () => {};
  h.ctx.setStorage(true, h.directory);
  await h.ctx.migrateToFileSystem();
  assert.deepEqual(h.records.get('history').get(5), {
    id: 5, prompt: 'migration', type: 'edit', fmt: 'jpeg', time: 'saved time', filenames: ['5_0.jpg', '5_1.jpg'],
  });
});

test('backup import preserves remote images and their original order in filesystem mode', async () => {
  const h = harness();
  h.ctx.setStorage(true, h.directory);
  const history = [{ id: 7, type: 'generate', prompt: 'import', fmt: 'webp', time: 'saved time',
    images: [{ b64_json: base64 }, { url: 'https://example.test/image' }, { b64_json: base64 }] }];
  const input = { value: 'backup.json', files: [{ text: async () => JSON.stringify({ settings: {}, history }) }] };
  await h.ctx.importAll(input);
  assert.equal(input.value, '');
  const names = h.records.get('history').get(7).filenames;
  assert.equal(names.length, 3);
  names.forEach((name, index) => assert.match(name, new RegExp(`^7_import_.+_${index}\\.webp$`)));
  assert.equal(h.requests.length, 1);
  assert.equal(await h.files.get(names[1]).text(), 'remote-image');
});

test('deleting a gallery image refreshes shifted cache entries and retains other records', async () => {
  const h = harness();
  h.ctx.renderGallery = h.renderGallery;
  h.ctx.updateStorageUsage = async () => {};
  const remaining = Buffer.from('remaining image').toString('base64');
  const record = { id: 1, type: 'generate', prompt: 'batch', fmt: 'png', time: '',
    images: [{ b64_json: base64 }, { b64_json: remaining }] };
  h.records.set('history', new Map([
    [1, record], [11, { ...record, id: 11, images: [{ b64_json: base64 }] }],
  ]));
  await h.ctx.renderGallery();
  const unaffected = h.ctx.galleryFlatList.find(item => item.historyId === 11).src;
  await h.ctx.deleteSingleImage(1, 0);
  const retained = h.ctx.galleryFlatList.find(item => item.historyId === 1);
  assert.equal(retained.imageIndex, 0);
  const blob = h.createdUrls.find(entry => entry.url === retained.src).blob;
  assert.equal(await blob.text(), 'remaining image');
  assert.equal(h.ctx.galleryFlatList.find(item => item.historyId === 11).src, unaffected);
  assert(!h.revokedUrls.includes(unaffected));
  assert.equal(h.revokedUrls.length, 2);
});

test('importing an existing history ID replaces its cached image', async () => {
  const h = harness();
  h.ctx.renderGallery = h.renderGallery;
  h.ctx.updateStorageUsage = async () => {};
  const record = { id: 1, type: 'generate', prompt: 'original', fmt: 'png', time: '', images: [{ b64_json: base64 }] };
  h.records.set('history', new Map([[1, record]]));
  await h.ctx.renderGallery();
  const oldUrl = h.ctx.galleryFlatList[0].src;
  const replacement = { ...record, images: [{ b64_json: Buffer.from('replacement').toString('base64') }] };
  await h.ctx.importAll({ value: 'backup', files: [{ text: async () => JSON.stringify({ settings: {}, history: [replacement] }) }] });
  await h.ctx.renderGallery();
  assert(h.revokedUrls.includes(oldUrl));
  const blob = h.createdUrls.find(entry => entry.url === h.ctx.galleryFlatList[0].src).blob;
  assert.equal(await blob.text(), 'replacement');
});

for (const imageCount of [1, 2]) {
  test(`gallery deletion waits for refresh before lightbox navigation: ${imageCount} images`, async () => {
    const h = harness();
    const images = Array.from({ length: imageCount }, () => ({ b64_json: base64 }));
    h.records.set('history', new Map([[1, { id: 1, images }]]));
    const started = deferred();
    const refresh = deferred();
    h.ctx.renderGallery = () => { started.resolve(); return refresh.promise; };
    let completed = false;
    const deletion = h.ctx.deleteSingleImage(1, 0).then(() => { completed = true; });
    await started.promise;
    await new Promise(resolve => setImmediate(resolve));
    const completedTooEarly = completed;
    refresh.resolve();
    await deletion;
    assert.equal(completedTooEarly, false);
  });
}

// A database whose write transactions abort, as browsers do when the storage quota is exceeded.
function quotaExceededDb() {
  const error = new Error('quota');
  error.name = 'QuotaExceededError';
  return {
    transaction() {
      const tx = { error, objectStore: () => ({ add() {}, put() {}, delete() {} }) };
      queueMicrotask(() => tx.onabort?.());
      return tx;
    },
  };
}

test('aborted IndexedDB writes reject instead of hanging and report quota errors', async () => {
  const h = harness();
  h.ctx.openDB = async () => quotaExceededDb();
  const errors = [];
  h.ctx.showError = message => errors.push(message);
  await assert.rejects(h.ctx.saveConversation({ id: 1, turns: [] }), { name: 'QuotaExceededError' });
  await h.ctx.addToHistory('generate', 'prompt', [{ b64_json: base64 }], 'png');
  assert.deepEqual(errors, ['儲存空間已滿，請清理瀏覽器資料或切換到本地資料夾模式']);
});

test('chat recovers from a conversation save that the browser aborts', async () => {
  const h = harness();
  h.ctx.requireBaseUrl = () => 'https://example.test/v1';
  h.ctx.removeChatPartial = () => {};
  h.ctx.openDB = async () => quotaExceededDb();
  h.element('chatInput').value = 'prompt';
  for (const id of ['size', 'quality', 'background']) h.element(id).value = 'auto';
  h.element('partials').value = '0';
  h.ctx.callGenerateAPI = async () => ({ data: [{ b64_json: base64 }] });
  await h.ctx.sendChatTurn();
  assert.equal(h.ctx.chatBusy, false);
  assert.equal(h.element('chatSendBtn').textContent, '送出');
  assert.match(h.element('chatStatus').textContent, /錯誤/);
});

test('reset confirmation states that gallery records and conversations are deleted', async () => {
  const h = harness();
  let message;
  h.ctx.confirm = text => { message = text; return false; };
  await h.ctx.clearHistory();
  assert.match(message, /畫廊記錄/);
  assert.match(message, /對話/);
  assert.match(message, /無法復原/);
});

function captureExport(h) {
  h.ctx.blobToBase64 = async blob => Buffer.from(await blob.arrayBuffer()).toString('base64');
  h.ctx.document.createElement = () => ({ click() {} });
  return async () => JSON.parse(await h.createdUrls.at(-1).blob.text());
}

test('backup export includes conversations with inlined images and skips unreadable files', async () => {
  const h = harness();
  const readExport = captureExport(h);
  const timers = [];
  h.ctx.setTimeout = (fn, ms) => timers.push({ fn, ms });
  const errors = [];
  h.ctx.showError = message => errors.push(message);
  h.ctx.setStorage(true, h.directory);
  h.files.set('conv_1_0_0.png', new Blob([Buffer.from(base64, 'base64')]));
  h.files.set('9_1.png', new Blob([Buffer.from(base64, 'base64')]));
  h.records.set('history', new Map([[9, { id: 9, type: 'generate', prompt: 'p', fmt: 'png', time: 't',
    filenames: ['9_0.png', '9_1.png'] }]]));
  h.records.set('conversations', new Map([[1, { id: 1, title: 'c', time: 't', createdAt: 1, updatedAt: 1, turns: [
    { kind: 'seed', prompt: '', filenames: ['conv_1_0_0.png'], images: null, fmt: 'png', time: 't' },
    { kind: 'user', prompt: 'refine', time: 't' },
  ] }]]));
  await h.ctx.exportAll();
  const backup = await readExport();
  assert.deepEqual(backup.history[0].images, [{ b64_json: base64 }]);
  assert.equal(backup.history[0].filenames, undefined);
  assert.deepEqual(backup.conversations[0].turns[0].images, [{ b64_json: base64 }]);
  assert.equal(backup.conversations[0].turns[0].filenames, undefined);
  assert.equal(backup.conversations[0].turns[1].prompt, 'refine');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /1 張/);
  // The download link must outlive the click; browsers fetch it asynchronously.
  assert(!h.revokedUrls.includes(h.createdUrls.at(-1).url));
  timers.forEach(timer => timer.fn());
  assert(h.revokedUrls.includes(h.createdUrls.at(-1).url));
});

for (const useFS of [false, true]) {
  test(`backup import restores conversations: filesystem=${useFS}`, async () => {
    const h = harness();
    if (useFS) h.ctx.setStorage(true, h.directory);
    const conversations = [{ id: 3, title: 'c', time: 't', createdAt: 1, updatedAt: 2, turns: [
      { kind: 'seed', prompt: '', images: [{ b64_json: base64 }], fmt: 'webp', time: 't' },
      { kind: 'user', prompt: 'refine', time: 't' },
      { kind: 'edit', prompt: 'refine', images: [{ b64_json: base64 }], fmt: 'png', time: 't' },
    ] }, { id: 'bad', turns: [] }];
    const input = { value: 'b', files: [{ text: async () => JSON.stringify({ settings: {}, history: [], conversations }) }] };
    await h.ctx.importAll(input);
    const saved = h.records.get('conversations').get(3);
    assert.equal(h.records.get('conversations').size, 1);
    if (useFS) {
      assert.match(saved.turns[0].filenames[0], /^conv_3_0_import_.+_0\.webp$/);
      assert.match(saved.turns[2].filenames[0], /^conv_3_2_import_.+_0\.png$/);
      assert.equal(saved.turns[0].images, null);
      assert.deepEqual(Buffer.from(h.files.get(saved.turns[2].filenames[0])), Buffer.from(base64, 'base64'));
    } else {
      assert.deepEqual(saved.turns[0].images, [{ b64_json: base64 }]);
    }
    assert.equal(saved.turns[1].prompt, 'refine');
    assert.match(h.element('status').textContent, /1 個對話/);
  });
}

test('concurrent gallery renders do not duplicate cards or misalign indices', async () => {
  const h = harness();
  h.ctx.renderGallery = h.renderGallery;
  h.ctx.updateStorageUsage = async () => {};
  // More records than BATCH_SIZE, so decoding yields between batches.
  const history = new Map();
  for (let id = 1; id <= 25; id++) {
    history.set(id, { id, type: 'generate', prompt: `p${id}`, fmt: 'png', time: '', images: [{ b64_json: base64 }] });
  }
  h.records.set('history', history);
  await Promise.all([h.ctx.renderGallery(), h.ctx.renderGallery()]);
  const grid = h.element('galleryGrid');
  assert.equal(grid.children.length, 2);
  const cards = grid.children.flatMap(col => col.children);
  assert.equal(cards.length, 25);
  assert.equal(h.ctx.galleryFlatList.length, 25);
  assert.deepEqual([...h.ctx.galleryFlatList.map(item => item.historyId)], [...Array(25)].map((_, i) => 25 - i));
});

test('deleting a conversation releases its cached image URLs', async () => {
  const h = harness();
  h.ctx.setStorage(true, h.directory);
  h.ctx.chatBlobCache.set('conv_1_0_0.png', 'blob:test/conv');
  h.ctx.chatBlobCache.set('conv_2_0_0.png', 'blob:test/other');
  h.records.set('conversations', new Map([[1, { id: 1, turns: [{ kind: 'seed', filenames: ['conv_1_0_0.png'] }] }]]));
  await h.ctx.deleteConversation(1);
  assert(h.revokedUrls.includes('blob:test/conv'));
  assert.equal(h.ctx.chatBlobCache.has('conv_1_0_0.png'), false);
  assert.equal(h.ctx.chatBlobCache.get('conv_2_0_0.png'), 'blob:test/other');
});

for (const removeRecord of [false, true]) {
  test(`a stale filesystem read cannot overwrite or revive the gallery cache: deleted=${removeRecord}`, async () => {
    const h = harness();
    const firstRead = deferred();
    const started = deferred();
    let reads = 0;
    h.ctx.setStorage(true, {
      async getFileHandle() {
        return { getFile() {
          if (++reads === 1) { started.resolve(); return firstRead.promise; }
          return new Blob(['replacement']);
        } };
      },
    });
    h.ctx.updateStorageUsage = async () => {};
    let history = [{ id: 1, type: 'generate', prompt: 'p', filenames: ['1_0.png'] }];
    h.ctx.loadHistory = async () => history;
    const previous = h.renderGallery();
    await started.promise;
    h.ctx.invalidateGalleryCache(1);
    if (removeRecord) history = [];
    await h.renderGallery();
    firstRead.resolve(new Blob(['stale']));
    await previous;
    assert.equal(h.createdUrls.length, removeRecord ? 0 : 1);
    assert.equal(h.ctx.blobUrlCache.size, removeRecord ? 0 : 1);
    if (!removeRecord) {
      const entry = h.createdUrls.find(item => item.url === h.ctx.blobUrlCache.get('1_0.png'));
      assert.equal(await entry.blob.text(), 'replacement');
      assert.equal(h.ctx.galleryFlatList[0].src, entry.url);
    }
  });
}

test('failed remote downloads preserve the original history during migration', async () => {
  const h = harness();
  const original = { id: 9, type: 'generate', prompt: 'p', fmt: 'png', time: '',
    images: [{ url: 'https://example.test/expired' }] };
  h.records.set('history', new Map([[9, original]]));
  h.ctx.setStorage(true, h.directory);
  h.ctx.fetch = async () => ({ ok: false, status: 403, blob: async () => new Blob(['error page']) });
  await h.ctx.migrateToFileSystem();
  assert.deepEqual(h.records.get('history').get(9), original);
  assert.equal(h.files.size, 0);
  await assert.rejects(h.ctx.persistImages([{}], 'png', 'empty'), /圖片缺少/);
});

test('failed local writes abort the stream and retain the original error', async () => {
  const h = harness();
  const failure = new Error('disk full');
  let aborted = false, closed = false;
  h.ctx.setStorage(true, {
    async getFileHandle() { return { async createWritable() { return {
      async write() { throw failure; },
      async close() { closed = true; },
      async abort() { aborted = true; throw new Error('secondary failure'); },
    }; } }; },
  });
  await assert.rejects(h.ctx.writeLocalFile('image.png', new Uint8Array()), error => error === failure);
  assert.equal(aborted, true);
  assert.equal(closed, false);
});

test('a batch of image writes keeps the directory selected when the batch started', async () => {
  const h = harness();
  const download = deferred();
  const started = deferred();
  h.ctx.setStorage(true, h.directory);
  h.ctx.fetch = async () => { started.resolve(); return download.promise; };
  const pending = h.ctx.persistImages([{ url: 'https://example.test/image' }, { b64_json: base64 }], 'png', 'batch');
  await started.promise;
  h.ctx.setStorage(true, { getFileHandle() { throw new Error('wrong directory'); } });
  download.resolve({ ok: true, blob: async () => new Blob(['remote']) });
  await pending;
  assert.deepEqual([...h.files.keys()], ['batch_0.png', 'batch_1.png']);
});

test('database connections close for upgrades and reopen on the next operation', async () => {
  const h = harness();
  let opened = 0, closed = 0;
  h.ctx.indexedDB = { open() {
    opened++;
    const req = { result: { close() { closed++; } } };
    queueMicrotask(() => req.onsuccess());
    return req;
  } };
  const first = await h.openDB();
  assert.equal(await h.openDB(), first);
  first.onversionchange();
  assert.equal(closed, 1);
  assert.notEqual(await h.openDB(), first);
  assert.equal(opened, 2);
});

test('blocked database resets retain settings and wait for deletion before reloading', async () => {
  const h = harness();
  const blocked = deferred();
  const errors = [];
  let req, reloads = 0;
  h.settings.set('gpt_image_baseurl', 'https://example.test/v1');
  h.settings.set('gpt_image_history', '[{"id":1}]');
  h.ctx.formSaveTimer = setTimeout(() => h.settings.set('gpt_image_form', '{}'), 1000);
  h.ctx.showError = message => errors.push(message);
  h.ctx.location = { reload() { reloads++; } };
  h.ctx.indexedDB = { deleteDatabase() {
    req = {};
    queueMicrotask(() => { req.onblocked(); blocked.resolve(); });
    return req;
  } };
  const reset = h.ctx.clearHistory();
  await blocked.promise;
  assert.equal(reloads, 0);
  assert.equal(h.settings.size, 2);
  assert.match(errors[0], /其他.*分頁/);
  req.onsuccess();
  await reset;
  assert.equal(reloads, 1);
  assert.equal(h.settings.size, 0);
  assert.equal(h.ctx.formSaveTimer, null);
});
