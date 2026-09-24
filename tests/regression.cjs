// Run with: node --test tests/regression.cjs
// IMAGE_APP_HTML can point to an earlier version for compatibility checks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(process.env.IMAGE_APP_HTML ||
  path.join(__dirname, '..', 'image_generator_optimized.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const functions = [...script.matchAll(/^(?:async )?function \w+\([^\n]*\) \{[\s\S]*?^\}/gm)]
  .map(match => match[0]).join('\n');
const constants = script.slice(script.indexOf('// ===== Constants'), script.indexOf('// ===== Base URL'));
const base64 = Buffer.from([0, 127, 128, 255]).toString('base64');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.value = '';
    this.textContent = '';
    this.dataset = {};
    const classes = new Set();
    this.classList = {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
    };
  }
  set innerHTML(value) { this.markup = value; this.children = []; }
  get innerHTML() { return this.markup || ''; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute(name, value) { this[name] = value; }
  focus() {}
}

function harness() {
  const elements = new Map();
  const files = new Map();
  const records = new Map();
  const requests = [];
  const createdUrls = [];
  const revokedUrls = [];
  const unload = [];
  const alerts = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const directory = {
    async getFileHandle(name) {
      return {
        async getFile() { return files.get(name); },
        async createWritable() {
          let contents;
          return {
            async write(value) { contents = value; },
            async close() { files.set(name, contents); },
          };
        },
      };
    },
    async removeEntry(name) { files.delete(name); },
  };
  const db = {
    transaction(storeName) {
      if (!records.has(storeName)) records.set(storeName, new Map());
      const store = records.get(storeName);
      const tx = {
        objectStore() {
          const request = result => {
            const req = { result };
            queueMicrotask(() => req.onsuccess?.());
            return req;
          };
          return {
            add: value => store.set(value.id, structuredClone(value)),
            put: value => store.set(value.id, structuredClone(value)),
            delete: id => store.delete(id),
            get: id => request(structuredClone(store.get(id))),
            getAll: () => request(structuredClone([...store.values()])),
          };
        },
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
  const ctx = vm.createContext({
    console: { error() {}, warn() {} },
    Blob, File, FormData, TextDecoder, TextEncoder, ReadableStream,
    AbortController, atob, setTimeout, clearTimeout, setInterval, clearInterval, performance, queueMicrotask,
    URL: class extends URL {
      static createObjectURL(blob) {
        const url = `blob:test/${createdUrls.length}`;
        createdUrls.push({ url, blob });
        return url;
      }
      static revokeObjectURL(url) { revokedUrls.push(url); }
    },
    Date: class extends Date { static now() { return 100; } },
    document: { getElementById: element, createElement: () => new Element() },
    window: { addEventListener: (name, fn) => { if (name === 'beforeunload') unload.push(fn); } },
    alert: message => alerts.push(message), confirm: () => true,
    activeConv: null, chatBusy: false, chatDeleting: false, chatBlobCache: new Map(), chatRenderVersion: 0,
    genController: null, genUserStopped: false, editFiles: [], maskFiles: [],
    gallerySortAsc: false, currentGalleryFilter: 'all', galleryFlatList: [],
    localStorage: { getItem: () => null, setItem() {} },
    async fetch(url, options) {
      requests.push({ url, options });
      return { ok: true, blob: async () => new Blob(['remote-image'], { type: 'image/png' }) };
    },
  });
  vm.runInContext(constants + '\n' + functions + `
    function setStorage(enabled, handle) { useLocalFS = enabled; dirHandle = handle; }
  `, ctx);
  const renderGallery = ctx.renderGallery;
  const renderChat = ctx.renderChat;
  ctx.openDB = async () => db;
  ctx.renderGallery = async () => {};
  ctx.renderChat = async () => {};
  return { ctx, files, records, requests, createdUrls, revokedUrls, unload, alerts, element, directory, renderGallery, renderChat };
}

test('HTML script parses and local image fetch protocols remain allowed', () => {
  new vm.Script(script);
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const connect = csp.split(';').find(value => value.trim().startsWith('connect-src'));
  for (const value of ["'self'", 'https:', 'blob:', 'data:']) assert(connect.includes(value));
});

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

test('generate and edit streaming APIs preserve requests, JSON fallback and HTTP errors', async () => {
  const h = harness();
  h.ctx.getBaseUrl = () => 'https://example.test/v1';
  h.element('apiKey').value = ' test-key ';
  const payload = { data: [{ b64_json: base64 }] };
  const calls = [];
  h.ctx.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => payload };
  };
  const signal = new AbortController().signal;
  const body = { model: 'gpt-image-2.5-sunburst', prompt: 'test', stream: true };
  assert.equal(await h.ctx.callGenerateAPIStream(body, { signal }), payload);
  const form = new FormData();
  form.append('image[]', new Blob(['image']), 'input.png');
  assert.equal(await h.ctx.callEditAPIStream(form, { signal }), payload);
  assert.equal(calls[0].url, 'https://example.test/v1/images/generations');
  assert.equal(calls[0].options.body, JSON.stringify(body));
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].url, 'https://example.test/v1/images/edits');
  assert.equal(calls[1].options.body, form);
  assert.equal(calls[1].options.headers['Content-Type'], undefined);
  for (const { options } of calls) {
    assert.equal(options.signal, signal);
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(options.headers.Accept, 'text/event-stream');
  }
  h.ctx.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  await assert.rejects(h.ctx.callGenerateAPIStream(body), /HTTP 429: rate limited/);
  await assert.rejects(h.ctx.callEditAPIStream(form), /HTTP 429: rate limited/);
});

for (const newline of ['\n', '\r\n']) {
test(`streaming handles official image events with ${JSON.stringify(newline)} delimiters`, async () => {
  const h = harness();
  h.ctx.getBaseUrl = () => 'https://example.test/v1';
  const streamText = ('event: image_generation.partial_image\ndata: {"b64_json":"preview","partial_image_index":0}\n\n' +
    'data: {"type":"image_generation.completed","b64_json":"final"}\n\ndata: [DONE]\n\n').replaceAll('\n', newline);
  const streams = [];
  h.ctx.fetch = async () => ({
    ok: true, headers: { get: () => 'text/event-stream' },
    body: new ReadableStream({ start(controller) {
      const bytes = new TextEncoder().encode(streamText);
      // One-byte chunks also split CRLF separators and JSON fields.
      for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
      controller.close();
    } }),
  });
  const fetchStream = h.ctx.fetch;
  h.ctx.fetch = async () => {
    const response = await fetchStream();
    streams.push(response.body);
    return response;
  };
  for (const call of [h.ctx.callGenerateAPIStream, h.ctx.callEditAPIStream]) {
    const partials = [];
    const result = await call({}, { onPartial: (...args) => partials.push(args) });
    assert.deepEqual(partials, [['preview', 0]]);
    assert.equal(result.data[0].b64_json, 'final');
  }
  assert(streams.every(stream => !stream.locked));
});
}

test('stream errors and aborted reads release the reader without returning partial images as final', async () => {
  const h = harness();
  for (const [text, error] of [
    ['data: {"type":"error","error":{"message":"upstream failure"}}\r\n\r\n', /upstream failure/],
    ['data: {"type":"image_edit.partial_image","b64_json":"preview"}\n\n', /沒有收到最終圖片/],
  ]) {
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    } });
    await assert.rejects(h.ctx.readImageEventStream({ body }), error);
    assert.equal(body.locked, false);
  }
  const abort = new Error('Aborted');
  abort.name = 'AbortError';
  const body = new ReadableStream({ start(controller) { controller.error(abort); } });
  await assert.rejects(h.ctx.readImageEventStream({ body }), { name: 'AbortError' });
  assert.equal(body.locked, false);
});

test('partial image count is limited to the documented 0–3 range', () => {
  const h = harness();
  for (const value of ['0', '1', '2', '3']) {
    h.element('partials').value = value;
    assert.equal(h.ctx.getPartialImageCount(), Number(value));
  }
  for (const value of ['-1', '4', '1.5', 'invalid', 'Infinity']) {
    h.element('partials').value = value;
    assert.equal(h.ctx.getPartialImageCount(), 0);
  }
});

for (const hasSeed of [false, true]) {
  for (const streaming of [false, true]) {
    test(`Sunburst chat requests use the selected streaming mode: seed=${hasSeed}, stream=${streaming}`, async () => {
      const h = harness();
      h.ctx.requireBaseUrl = () => 'https://example.test/v1';
      h.ctx.removeChatPartial = () => {};
      h.element('chatInput').value = 'refine';
      h.element('partials').value = streaming ? '2' : '0';
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
      h.ctx.callEditAPIStream = response('edit', true);
      await h.ctx.sendChatTurn();
      assert.equal(endpoint, hasSeed ? 'edit' : 'generate');
      assert.equal(actualStreaming, streaming);
      if (hasSeed) {
        assert.equal(request.get('model'), 'gpt-image-2.5-sunburst');
        assert.equal(request.get('stream'), streaming ? 'true' : null);
        assert.equal(request.get('partial_images'), streaming ? '2' : null);
        assert.equal(request.get('image[]').name, 'input.png');
      } else {
        assert.equal(request.model, 'gpt-image-2.5-sunburst');
        assert.equal(request.stream, streaming ? true : undefined);
        assert.equal(request.partial_images, streaming ? 2 : undefined);
      }
      assert.equal(h.ctx.chatBusy, false);
      assert.equal(h.ctx.chatController, null);
      assert.equal(h.element('chatSendBtn').textContent, '送出');
      const saved = h.records.get('conversations').get(hasSeed ? 42 : 100);
      assert.equal(saved.turns.at(-1).kind, hasSeed ? 'edit' : 'generate');
    });
  }
}

test('size validation retains standard, custom and invalid-input behavior', () => {
  const h = harness();
  h.element('size').value = 'auto';
  assert.equal(h.ctx.getSize(), 'auto');
  h.element('size').value = 'custom';
  h.element('customSize').value = ' 1024x1536 ';
  assert.equal(h.ctx.getSize(), '1024x1536');
  h.element('customSize').value = 'invalid';
  assert.equal(h.ctx.getSize(), null);
  assert.equal(h.alerts.length, 1);
});

for (const streaming of [false, true]) {
  test(`generation retains model, format, size and streaming options: ${streaming}`, async () => {
    const h = harness();
    const values = { prompt: ' prompt ', size: 'custom', customSize: '1024x1536', quality: 'high',
      format: 'jpeg', compression: '85', partials: streaming ? '2' : '0' };
    for (const [id, value] of Object.entries(values)) h.element(id).value = value;
    h.ctx.requireBaseUrl = () => 'https://example.test/v1';
    h.ctx.showLoading = h.ctx.showStreamPreview = h.ctx.hideStreamPreview = () => {};
    let request;
    const call = async body => { request = body; return { data: [{ b64_json: base64 }] }; };
    h.ctx.callGenerateAPI = h.ctx.callGenerateAPIStream = call;
    const saved = [];
    h.ctx.addToHistory = async (...args) => saved.push(args);
    await h.ctx.generate();
    assert.deepEqual(JSON.parse(JSON.stringify(request)), {
      model: 'gpt-image-2.5-sunburst', prompt: 'prompt', n: 1, size: '1024x1536', quality: 'high',
      output_format: 'jpeg', output_compression: 85,
      ...(streaming ? { stream: true, partial_images: 2 } : {}),
    });
    assert.equal(saved[0][0], 'generate');
    assert.equal(saved[0][3], 'jpeg');
    assert.equal(h.ctx.genController, null);
    assert.equal(h.element('generateBtn').disabled, false);
  });
}

test('editing retains custom size, mask, image order and format options', async () => {
  const h = harness();
  const values = { editPrompt: ' edit ', editSize: 'custom', editCustomSize: ' 1536x1024 ',
    editQuality: 'high', editFormat: 'webp', editCompression: '90' };
  for (const [id, value] of Object.entries(values)) h.element(id).value = value;
  h.ctx.editFiles = [new File(['one'], 'one.png'), new File(['two'], 'two.png')];
  h.ctx.maskFiles = [new File(['mask'], 'mask.png')];
  h.ctx.requireBaseUrl = () => 'https://example.test/v1';
  h.ctx.showLoading = () => {};
  let form;
  h.ctx.callEditAPI = async data => { form = data; return { data: [{ b64_json: base64 }] }; };
  h.ctx.addToHistory = async () => {};
  await h.ctx.editImage();
  assert.equal(form.get('model'), 'gpt-image-2.5-sunburst');
  assert.equal(form.get('prompt'), 'edit');
  assert.equal(form.get('size'), '1536x1024');
  assert.equal(form.get('quality'), 'high');
  assert.equal(form.get('output_format'), 'webp');
  assert.equal(form.get('output_compression'), '90');
  assert.deepEqual(form.getAll('image[]').map(file => file.name), ['one.png', 'two.png']);
  assert.equal(form.get('mask').name, 'mask.png');
  assert.equal(h.element('editBtn').disabled, false);
});

test('image sources and edit input retain MIME types, extensions and bytes', async () => {
  const h = harness();
  h.ctx.fetch = fetch;
  for (const [fmt, mime, ext] of [
    ['png', 'image/png', 'png'], ['jpeg', 'image/jpeg', 'jpg'], ['webp', 'image/webp', 'webp'],
    [undefined, 'image/png', 'png'],
  ]) {
    const src = await h.ctx.turnImageSrc({ fmt, images: [{ b64_json: base64 }] });
    assert.equal(src, `data:${mime};base64,${base64}`);
    const file = await h.ctx.srcToFile(src, fmt);
    assert.equal(file.name, `input.${ext}`);
    assert.equal(file.type, mime);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(base64, 'base64'));
    h.ctx.b64ToObjectUrl(base64, mime);
    assert.equal(h.createdUrls.at(-1).blob.type, mime);
    assert.deepEqual(Buffer.from(await h.createdUrls.at(-1).blob.arrayBuffer()), Buffer.from(base64, 'base64'));
  }
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

test('upload previews retain file order and release removed object URLs', () => {
  const h = harness();
  const files = [];
  h.ctx.setupDropZone('zone', 'input', 'preview', 'text', files, true);
  const input = h.element('input');
  const first = new File(['first'], 'first.png', { type: 'image/png' });
  const second = new File(['second'], 'second.png', { type: 'image/png' });
  input.files = [first];
  input.listeners.change();
  const firstUrl = h.element('preview').children[0].children[0].src;
  input.files = [second];
  input.listeners.change();
  assert.deepEqual(files, [first, second]);
  assert.equal(h.element('preview').children.length, 2);
  assert.equal(h.element('preview').children[0].children[0].src, firstUrl);
  assert.equal(h.createdUrls.length, 2);
  h.element('preview').children[0].children[1].onclick({ stopPropagation() {} });
  assert.deepEqual(files, [second]);
  assert.deepEqual(h.revokedUrls, [firstUrl]);
  h.unload.forEach(fn => fn());
  assert.equal(new Set(h.revokedUrls).size, 2);
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

test('repeated edit submissions send only one request while busy', async () => {
  const h = harness();
  for (const [id, value] of Object.entries({ editPrompt: 'edit', editSize: 'auto', editQuality: 'auto', editFormat: 'png' })) {
    h.element(id).value = value;
  }
  h.ctx.editFiles = [new File(['image'], 'image.png')];
  h.ctx.requireBaseUrl = () => 'https://example.test/v1';
  h.ctx.showLoading = () => {};
  h.ctx.addToHistory = async () => {};
  const response = deferred();
  let requests = 0;
  h.ctx.callEditAPI = () => { requests++; return response.promise; };
  const first = h.ctx.editImage();
  const second = h.ctx.editImage();
  response.resolve({ data: [{ b64_json: base64 }] });
  await Promise.all([first, second]);
  assert.equal(requests, 1);
  assert.equal(h.element('editBtn').disabled, false);
});

test('a request that was stopped before upload never starts XHR', async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  h.ctx.getBaseUrl = () => 'https://example.test/v1';
  let created = false;
  h.ctx.XMLHttpRequest = class {
    constructor() { created = true; this.upload = {}; }
    open() {}
    setRequestHeader() {}
    send() {
      this.status = 200;
      this.responseText = '{"data":[]}';
      this.onload();
    }
  };
  await assert.rejects(h.ctx.callEditAPI(new FormData(), null, controller.signal), { name: 'AbortError' });
  assert.equal(created, false);
});

test('generation timeout remains active until the JSON response body is consumed', async () => {
  const h = harness();
  const parsing = deferred();
  const responseBody = deferred();
  let timeoutCleared = false;
  h.ctx.getBaseUrl = () => 'https://example.test/v1';
  h.ctx.setTimeout = () => 1;
  h.ctx.clearTimeout = () => { timeoutCleared = true; };
  h.ctx.fetch = async () => ({ ok: true, json: () => { parsing.resolve(); return responseBody.promise; } });
  const request = h.ctx.callGenerateAPI({ prompt: 'test' });
  await parsing.promise;
  const clearedDuringDownload = timeoutCleared;
  responseBody.resolve({ data: [{ b64_json: base64 }] });
  await request;
  assert.equal(clearedDuringDownload, false);
  assert.equal(timeoutCleared, true);
});

test('pending generation saves to its originating conversation after the user opens another', async () => {
  const h = harness();
  h.ctx.requireBaseUrl = () => 'https://example.test/v1';
  h.ctx.removeChatPartial = () => {};
  h.element('chatInput').value = 'original request';
  h.element('partials').value = '2';
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
