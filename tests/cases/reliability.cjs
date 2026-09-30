const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, base64, deferred } = require('../support/harness.cjs');

const galleryRecord = (id = 1) => ({ id, type: 'generate', prompt: 'original', fmt: 'png', time: 't', filenames: [`${id}_0.png`] });
const conversation = () => ({ id: 2, title: 'original', updatedAt: 2, turns: [{ kind: 'seed', fmt: 'png', filenames: ['conv_2_0_0.png'] }] });
const backupInput = data => ({ value: 'backup.json', files: [{ text: async () => JSON.stringify({ settings: {}, history: [], ...data }) }] });

for (const kind of ['history', 'single', 'conversation']) {
  test(`a rejected ${kind} deletion preserves original files and cached URLs`, async () => {
    const h = harness();
    h.ctx.setStorage(true, h.directory);
    const record = galleryRecord();
    if (kind === 'single') record.filenames.push('1_1.png');
    h.records.set('history', new Map([[1, record]]));
    h.records.set('conversations', new Map([[2, conversation()]]));
    for (const name of ['1_0.png', '1_1.png', 'conv_2_0_0.png']) h.files.set(name, new Blob(['original']));
    h.ctx.chatBlobCache.set('conv_2_0_0.png', 'blob:original');
    h.db.failNextWrite = new Error('transaction aborted');
    if (kind === 'conversation') await assert.rejects(h.ctx.deleteConversation(2), /transaction aborted/);
    else if (kind === 'history') await h.ctx.deleteHistoryItem(1);
    else await h.ctx.deleteSingleImage(1, 0);
    assert.deepEqual(h.records.get('history').get(1), record);
    assert.equal(h.records.get('conversations').size, 1);
    assert.equal(h.files.size, 3);
    assert.equal(h.revokedUrls.length, 0);
    assert.equal(h.ctx.storageActivity, 0);
  });
}

for (const failure of ['download', 'commit', 'none']) {
  test(`filesystem replacement import is atomic per record: ${failure}`, async () => {
    const h = harness();
    h.ctx.setStorage(true, h.directory);
    const original = galleryRecord();
    h.records.set('history', new Map([[1, original]]));
    h.files.set('1_0.png', new Blob(['original']));
    const replacement = { ...original, images: [{ b64_json: base64 }, { url: 'https://example.test/image' }] };
    delete replacement.filenames;
    if (failure === 'download') h.ctx.fetch = async () => ({ ok: false, status: 503 });
    if (failure === 'commit') h.db.failNextWrite = new Error('commit failed');
    await h.ctx.importAll(backupInput({ history: [replacement] }));
    if (failure === 'none') {
      const saved = h.records.get('history').get(1);
      assert(saved.filenames.every(name => name.startsWith('1_import_')));
      assert.equal(h.files.has('1_0.png'), false);
      assert.equal(h.files.size, 2);
    } else {
      assert.deepEqual(h.records.get('history').get(1), original);
      assert.equal(await h.files.get('1_0.png').text(), 'original');
      assert.deepEqual([...h.files.keys()], ['1_0.png']);
      assert.match(h.element('status').children[0].textContent, /匯入失敗/);
    }
    assert.equal(h.ctx.storageMaintenance, false);
  });
}

test('importing a conversation refreshes the selected conversation and its image cache', async () => {
  const h = harness();
  const previous = conversation();
  h.ctx.activeConv = previous;
  h.records.set('conversations', new Map([[2, previous]]));
  h.ctx.chatBlobCache.set('conv_2_0_0.png', 'blob:previous');
  const replacement = { ...previous, title: 'replacement', turns: [{ kind: 'seed', images: [{ b64_json: base64 }] }] };
  await h.ctx.importAll(backupInput({ conversations: [replacement] }));
  assert.equal(h.ctx.activeConv.title, 'replacement');
  assert.equal(h.ctx.activeConv.turns[0].images[0].b64_json, base64);
  assert(h.revokedUrls.includes('blob:previous'));
});

for (const failure of ['copy', 'commit', 'none']) {
  test(`changing directory preserves both gallery and conversation images: ${failure}`, async () => {
    const h = harness();
    const target = harness();
    h.ctx.setStorage(true, h.directory);
    const record = galleryRecord(), conv = conversation();
    h.records.set('history', new Map([[1, record]]));
    h.records.set('conversations', new Map([[2, conv]]));
    h.files.set('1_0.png', new Blob(['gallery']));
    h.files.set('conv_2_0_0.png', new Blob(['chat']));
    h.ctx.activeConv = structuredClone(conv);
    h.ctx.blobUrlCache.set('1_0.png', 'blob:old-gallery');
    h.ctx.chatBlobCache.set('conv_2_0_0.png', 'blob:old-chat');
    target.files.set('unrelated.png', new Blob(['unrelated']));
    if (failure === 'copy') {
      const read = h.directory.getFileHandle;
      h.directory.getFileHandle = name => {
        if (name.startsWith('conv_')) throw new Error('missing chat image');
        return read(name);
      };
    }
    if (failure === 'commit') h.db.failNextWrite = new Error('commit failed');
    const change = h.ctx.changeStorageDirectory(target.directory);
    if (failure !== 'none') {
      await assert.rejects(change);
      assert.equal(h.ctx.dirHandle, h.directory);
      assert.deepEqual(h.records.get('history').get(1), record);
      assert.deepEqual(h.records.get('conversations').get(2), conv);
      assert.deepEqual([...target.files.keys()], ['unrelated.png']);
      assert.equal(h.revokedUrls.length, 0);
    } else {
      await change;
      assert.equal(h.ctx.dirHandle, target.directory);
      const saved = h.records.get('history').get(1);
      assert.equal(await target.files.get(saved.filenames[0]).text(), 'gallery');
      assert.equal(await target.files.get(h.ctx.activeConv.turns[0].filenames[0]).text(), 'chat');
      assert.equal(h.records.get('settings').get('dirHandle').handle, target.directory);
      assert(h.revokedUrls.includes('blob:old-gallery'));
      assert(h.revokedUrls.includes('blob:old-chat'));
    }
    assert.equal(h.files.size, 2, 'source files remain a recovery copy');
    assert.equal(await target.files.get('unrelated.png').text(), 'unrelated');
  });
}

test('pending import blocks resets, folder changes and new requests until it settles', async () => {
  const h = harness();
  const reading = deferred();
  const input = { value: 'backup', files: [{ text: () => reading.promise }] };
  const pending = h.ctx.importAll(input);
  let resets = 0, picks = 0;
  h.ctx.indexedDB = { deleteDatabase() { resets++; } };
  h.ctx.window.showDirectoryPicker = () => { picks++; };
  h.element('prompt').value = 'p';
  h.element('chatInput').value = 'p';
  await h.ctx.clearHistory();
  await h.ctx.pickDirectory();
  await h.ctx.generate();
  await h.ctx.sendChatTurn();
  assert.equal(resets, 0);
  assert.equal(picks, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.ctx.activeConv, null);
  reading.resolve(JSON.stringify({ settings: {}, history: [] }));
  await pending;
  assert.equal(h.ctx.storageMaintenance, false);
});

test('changing imported API endpoint clears the existing credential before the next request', async () => {
  const h = harness();
  h.element('baseUrl').value = 'https://trusted.test/v1';
  h.element('apiKey').value = 'private-key';
  h.settings.set('gpt_image_apikey', 'private-key');
  await h.ctx.importAll(backupInput({ settings: { baseUrl: 'https://new.test' } }));
  assert.equal(h.ctx.getBaseUrl(), 'https://new.test/v1');
  assert.equal(h.ctx.getHeaders().Authorization, undefined);
  assert.equal(h.settings.has('gpt_image_apikey'), false);
  assert.match(h.element('status').textContent, /重新填寫 API Key/);
});

test('URL validation rejects unsafe, ambiguous and non-TLS remote API endpoints', () => {
  const h = harness();
  for (const url of ['javascript:alert(1)', '/relative', 'http://remote.test', 'https://user:pass@example.test',
    'https://example.test/v1?token=secret', 'https://example.test/#fragment']) {
    h.element('baseUrl').value = url;
    assert.equal(h.ctx.requireBaseUrl(), '');
  }
  for (const [url, normalized] of [['https://example.test/', 'https://example.test/v1'],
    ['https://example.test/custom///', 'https://example.test/custom'], ['http://localhost:3000', 'http://localhost:3000/v1']]) {
    assert.equal(h.ctx.normalizeBaseUrl(url), normalized);
  }
});

test('late chat file reads cannot recreate invalidated cache entries', async () => {
  const h = harness();
  const file = deferred(), started = deferred();
  h.ctx.setStorage(true, { async getFileHandle() { return { getFile() { started.resolve(); return file.promise; } }; } });
  const pending = h.ctx.turnImageSrc({ filenames: ['conv_2_0_0.png'] });
  await started.promise;
  h.ctx.revokeChatBlobs();
  file.resolve(new Blob(['stale']));
  assert.equal(await pending, '');
  assert.equal(h.ctx.chatBlobCache.size, 0);
  assert.equal(h.createdUrls.length, 0);
});

test('overlapping chat reads share one cached object URL', async () => {
  const h = harness();
  h.ctx.setStorage(true, h.directory);
  h.files.set('conv_2_0_0.png', new Blob(['chat']));
  const urls = await Promise.all([1, 2].map(() => h.ctx.turnImageSrc({ filenames: ['conv_2_0_0.png'] })));
  assert.equal(urls[0], urls[1]);
  assert.equal(h.createdUrls.length, 1);
});

test('gallery refresh keeps lightbox actions bound to the displayed record', async () => {
  const h = harness();
  h.ctx.updateStorageUsage = () => {};
  const record = id => ({ id, type: 'generate', prompt: `p${id}`, images: [{ b64_json: base64 }] });
  h.records.set('history', new Map([[1, record(1)], [2, record(2)]]));
  await h.renderGallery();
  h.ctx.openLightbox(1);
  h.records.get('history').set(3, record(3));
  await h.renderGallery();
  assert.equal(h.ctx.lightboxItem.historyId, 1);
  assert.equal(h.ctx.lightboxIndex, 2);
  let deleted;
  h.ctx.deleteSingleImage = async id => { deleted = id; };
  await h.ctx.deleteLightboxImage();
  assert.equal(deleted, 1);
  h.ctx.openChatImage('blob:chat');
  h.ctx.lightboxNav(1);
  assert.equal(h.element('lightboxImg').src, 'blob:chat');
  assert.equal(h.element('lightboxDel').hidden, true);
});

test('gallery resize reloads image data only when its column count changes', async () => {
  const h = harness();
  const timers = [];
  let onResize, renders = 0;
  h.ctx.window.innerWidth = 1000;
  h.ctx.galleryColumns = 2;
  h.ctx.window.addEventListener = (event, fn) => { if (event === 'resize') onResize = fn; };
  h.ctx.setTimeout = fn => { timers.push(fn); return 1; };
  h.ctx.renderGallery = async () => { renders++; };
  h.ctx.initGallery();
  onResize(); timers.pop()();
  assert.equal(renders, 0);
  h.ctx.window.innerWidth = 390;
  onResize(); timers.pop()();
  assert.equal(renders, 1);
  assert.equal(h.ctx.getGalleryColumnCount(), 1);
});

test('invalid Base64 backup records are skipped before persistence', async () => {
  const h = harness();
  const item = { ...galleryRecord(), images: [{ b64_json: '<invalid>' }] };
  delete item.filenames;
  await h.ctx.importAll(backupInput({ history: [item] }));
  assert.equal(h.records.get('history')?.size || 0, 0);
  assert.match(h.element('status').textContent, /跳過 1/);
});

test('image download timeout covers the body and rejects non-image error pages', async () => {
  const h = harness();
  let timeout, cleared = false;
  const reading = deferred();
  h.ctx.setTimeout = fn => { timeout = fn; return 1; };
  h.ctx.clearTimeout = () => { cleared = true; };
  h.ctx.fetch = async (url, { signal }) => ({ ok: true, blob: () => {
    reading.resolve();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  } });
  const pending = h.ctx.fetchImageBlob('https://example.test/slow');
  await reading.promise;
  assert.equal(cleared, false);
  timeout();
  await assert.rejects(pending, /圖片下載超時/);
  assert.equal(cleared, true);
  h.ctx.fetch = async () => ({ ok: true, blob: async () => new Blob(['<html>Error</html>'], { type: 'text/html' }) });
  await assert.rejects(h.ctx.fetchImageBlob('https://example.test/image'), /不是圖片/);
});

test('settings failures do not prevent event binding or make debounced writes throw', () => {
  const h = harness();
  h.ctx.localStorage.getItem = () => { throw new Error('storage denied'); };
  h.ctx.localStorage.setItem = () => { throw new Error('storage full'); };
  assert.doesNotThrow(() => h.ctx.initSettings());
  assert(h.element('size').listeners.change);
  h.element('prompt').value = 'unsaved prompt';
  assert.doesNotThrow(() => h.ctx.persistFormState());
  assert.equal(h.element('prompt').value, 'unsaved prompt');
  assert.match(h.element('status').children[0].textContent, /無法保存設定/);
});

test('strict backup reads propagate database read failures instead of exporting empty history', async () => {
  const h = harness();
  h.ctx.openDB = async () => ({ transaction() { return { objectStore() { return { getAll() {
    const req = { error: new Error('read failed') };
    queueMicrotask(() => req.onerror());
    return req;
  } }; } }; } });
  await assert.rejects(h.ctx.loadHistory({ strict: true }), /read failed/);
  assert.equal((await h.ctx.loadHistory()).length, 0);
  await h.ctx.exportAll();
  assert.equal(h.createdUrls.length, 0);
  assert.equal(h.ctx.storageMaintenance, false);
});

test('synchronous write errors abort earlier requests in a multi-store transaction', async () => {
  const h = harness();
  await assert.rejects(h.ctx.writeTransaction(h.db, ['history', 'settings'], tx => {
    tx.objectStore('history').put(galleryRecord());
    throw new Error('directory handle cannot be cloned');
  }), /cannot be cloned/);
  assert.equal(h.records.get('history').size, 0);
});

test('a new backup record cannot overwrite an unrelated file in the destination folder', async () => {
  const h = harness();
  h.ctx.setStorage(true, h.directory);
  h.files.set('1_0.png', new Blob(['unrelated original']));
  await h.ctx.importAll(backupInput({ history: [{ ...galleryRecord(), images: [{ b64_json: base64 }] }] }));
  assert.equal(await h.files.get('1_0.png').text(), 'unrelated original');
  assert.notEqual(h.records.get('history').get(1).filenames[0], '1_0.png');
});
