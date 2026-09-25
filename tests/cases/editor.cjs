const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, base64, deferred } = require('../support/harness.cjs');

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

test('custom sizes follow the GPT Image 2.5 resolution constraints', () => {
  const h = harness();
  h.element('size').value = 'custom';
  for (const valid of ['1280x720', '3840x2160', '2160x3840', '2400x800', '1024x640']) {
    h.element('customSize').value = valid;
    assert.equal(h.ctx.getSize(), valid, valid);
  }
  assert.equal(h.alerts.length, 0);
  // Non-multiple of 16, edge > 3840, ratio > 3:1, too few pixels, too many pixels.
  for (const invalid of ['1000x1000', '4096x1024', '2448x800', '800x800', '3840x2400']) {
    h.element('customSize').value = invalid;
    assert.equal(h.ctx.getSize(), null, invalid);
  }
  assert.equal(h.alerts.length, 5);
});

for (const streaming of [false, true]) {
  test(`generation retains model, format, size and streaming options: ${streaming}`, async () => {
    const h = harness();
    const values = { prompt: ' prompt ', size: 'custom', customSize: '1024x1536', quality: 'high',
      background: 'auto', format: 'jpeg', compression: '85', partials: streaming ? '2' : '0' };
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
    editQuality: 'high', editBackground: 'auto', editFormat: 'webp', editCompression: '90' };
  for (const [id, value] of Object.entries(values)) h.element(id).value = value;
  h.ctx.editFiles = [new File(['one'], 'one.png'), new File(['two'], 'two.png')];
  h.ctx.maskFiles = [new File([png(1024, 1024, 6)], 'mask.png', { type: 'image/png' })];
  h.ctx.createImageBitmap = async () => ({ width: 1024, height: 1024, close() {} });
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
  assert.equal(form.get('background'), null);
  assert.equal(h.element('editBtn').disabled, false);
});

test('generation sends GPT Image 2.5 quality tiers and transparent backgrounds', async () => {
  const h = harness();
  const values = { prompt: 'logo', size: 'auto', quality: 'xhigh', background: 'transparent',
    format: 'webp', compression: '80', partials: '0' };
  for (const [id, value] of Object.entries(values)) h.element(id).value = value;
  h.ctx.requireBaseUrl = () => 'https://example.test/v1';
  h.ctx.showLoading = h.ctx.hideStreamPreview = () => {};
  let request;
  h.ctx.callGenerateAPI = async body => { request = body; return { data: [{ b64_json: base64 }] }; };
  h.ctx.addToHistory = async () => {};
  await h.ctx.generate();
  assert.equal(request.quality, 'xhigh');
  assert.equal(request.background, 'transparent');
  assert.equal(request.output_format, 'webp');
});

test('editing sends max quality and opaque backgrounds', async () => {
  const h = harness();
  const values = { editPrompt: 'edit', editSize: 'auto', editQuality: 'max', editBackground: 'opaque',
    editFormat: 'png' };
  for (const [id, value] of Object.entries(values)) h.element(id).value = value;
  h.ctx.editFiles = [new File(['one'], 'one.png')];
  h.ctx.requireBaseUrl = () => 'https://example.test/v1';
  h.ctx.showLoading = () => {};
  let form;
  h.ctx.callEditAPI = async data => { form = data; return { data: [{ b64_json: base64 }] }; };
  h.ctx.addToHistory = async () => {};
  await h.ctx.editImage();
  assert.equal(form.get('quality'), 'max');
  assert.equal(form.get('background'), 'opaque');
});

test('transparent backgrounds with JPEG output are rejected before any request', async () => {
  const h = harness();
  const values = { prompt: 'logo', size: 'auto', quality: 'auto', background: 'transparent',
    format: 'jpeg', partials: '0', editPrompt: 'edit', editSize: 'auto', editQuality: 'auto',
    editBackground: 'transparent', editFormat: 'jpeg' };
  for (const [id, value] of Object.entries(values)) h.element(id).value = value;
  h.ctx.editFiles = [new File(['one'], 'one.png')];
  h.ctx.requireBaseUrl = () => 'https://example.test/v1';
  let calls = 0;
  h.ctx.callGenerateAPI = h.ctx.callGenerateAPIStream = h.ctx.callEditAPI = async () => { calls++; };
  await h.ctx.generate();
  await h.ctx.editImage();
  assert.equal(calls, 0);
  assert.equal(h.alerts.length, 2);
  assert.equal(h.ctx.genController, null);
  assert.equal(h.element('editBtn').disabled, undefined);
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

// Minimal PNG: signature, IHDR, optional tRNS, IEND. CRCs are not checked by the parser.
function png(width, height, colorType, extraChunks = []) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    ...extraChunks.map(type => chunk(type, Buffer.alloc(1))), chunk('IEND', Buffer.alloc(0))]);
}

test('edit uploads accept only documented image types, sizes and counts', () => {
  const h = harness();
  const files = [];
  h.ctx.setupDropZone('zone', 'input', 'preview', 'text', files, true);
  const add = list => { h.element('input').files = list; h.element('input').dispatchEvent({ type: 'change' }); };
  add([
    new File(['a'], 'a.png', { type: 'image/png' }),
    new File(['b'], 'b.gif', { type: 'image/gif' }),
    { name: 'huge.jpg', type: 'image/jpeg', size: 50 * 1024 * 1024 },
    new File(['c'], 'c.webp', { type: 'image/webp' }),
  ]);
  assert.deepEqual(files.map(f => f.name), ['a.png', 'c.webp']);
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0], /b\.gif/);
  assert.match(h.alerts[0], /huge\.jpg/);
  add(Array.from({ length: 20 }, (_, i) => new File(['x'], `${i}.jpg`, { type: 'image/jpeg' })));
  assert.equal(files.length, 16);
  assert.equal(h.alerts.length, 2);
});

for (const [name, mask, problem] of [
  ['JPEG mask', new File(['jpeg'], 'm.jpg', { type: 'image/jpeg' }), /PNG/],
  ['opaque RGB mask', new File([png(1024, 1024, 2)], 'm.png', { type: 'image/png' }), /透明/],
  ['mask of another size', new File([png(512, 512, 6)], 'm.png', { type: 'image/png' }), /尺寸/],
  ['valid RGBA mask', new File([png(1024, 1024, 6)], 'm.png', { type: 'image/png' }), null],
  ['valid RGB+tRNS mask', new File([png(1024, 1024, 2, ['tRNS'])], 'm.png', { type: 'image/png' }), null],
]) {
  test(`edit mask validation: ${name}`, async () => {
    const h = harness();
    const values = { editPrompt: 'edit', editSize: 'auto', editQuality: 'auto', editBackground: 'auto', editFormat: 'png' };
    for (const [id, value] of Object.entries(values)) h.element(id).value = value;
    h.ctx.editFiles = [new File(['one'], 'one.png', { type: 'image/png' })];
    h.ctx.maskFiles = [mask];
    h.ctx.createImageBitmap = async () => ({ width: 1024, height: 1024, close() {} });
    h.ctx.requireBaseUrl = () => 'https://example.test/v1';
    h.ctx.showLoading = () => {};
    h.ctx.addToHistory = async () => {};
    let calls = 0;
    h.ctx.callEditAPI = async () => { calls++; return { data: [{ b64_json: base64 }] }; };
    await h.ctx.editImage();
    assert.equal(calls, problem ? 0 : 1);
    if (problem) assert.match(h.alerts[0], problem);
    assert.equal(h.element('editBtn').disabled, false);
  });
}

test('an in-flight edit can be stopped by the user', async () => {
  const h = harness();
  const values = { editPrompt: 'edit', editSize: 'auto', editQuality: 'auto', editBackground: 'auto', editFormat: 'png' };
  for (const [id, value] of Object.entries(values)) h.element(id).value = value;
  h.ctx.editFiles = [new File(['one'], 'one.png', { type: 'image/png' })];
  h.ctx.requireBaseUrl = () => 'https://example.test/v1';
  h.ctx.showLoading = () => {};
  const started = deferred();
  h.ctx.callEditAPI = (form, onProgress, signal) => new Promise((resolve, reject) => {
    started.resolve();
    signal.addEventListener('abort', () => {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  const pending = h.ctx.editImage();
  await started.promise;
  assert.equal(h.element('stopEditBtn').style.display, '');
  h.ctx.stopEdit();
  await pending;
  assert.equal(h.element('status').textContent, '已停止');
  assert.equal(h.element('stopEditBtn').style.display, 'none');
  assert.equal(h.element('editBtn').disabled, false);
  assert.equal(h.ctx.editController, null);
});
