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
