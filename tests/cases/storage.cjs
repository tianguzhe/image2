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
    assert.deepEqual(h.records.get('history').get(100).images, images);
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

test('backup import keeps its existing filesystem policy and original image indices', async () => {
  const h = harness();
  h.ctx.setStorage(true, h.directory);
  const history = [{ id: 7, type: 'generate', prompt: 'import', fmt: 'webp', time: 'saved time',
    images: [{ b64_json: base64 }, { url: 'https://example.test/image' }, { b64_json: base64 }] }];
  const input = { value: 'backup.json', files: [{ text: async () => JSON.stringify({ settings: {}, history }) }] };
  await h.ctx.importAll(input);
  assert.equal(input.value, '');
  assert.deepEqual(h.records.get('history').get(7).filenames, ['7_0.webp', '7_2.webp']);
  assert.equal(h.requests.length, 0);
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
