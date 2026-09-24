const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { htmlPath, html, script, scripts, splitApp, harness } = require('../support/harness.cjs');

test('HTML script parses and local image fetch protocols remain allowed', () => {
  new vm.Script(script);
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const connect = csp.split(';').find(value => value.trim().startsWith('connect-src'));
  for (const value of ["'self'", 'https:', 'blob:', 'data:']) assert(connect.includes(value));
});

test('local assets exist and classic scripts preserve dependency order and HTML event handlers', { skip: !splitApp }, () => {
  const h = harness();
  const tags = [...html.matchAll(/<script\b([^>]*)>/g)];
  assert.equal(scripts[0].src, 'assets/js/config.js');
  assert.equal(scripts[1].src, 'assets/js/state.js');
  assert.equal(scripts.at(-1).src, 'assets/js/app.js');
  for (const [, attributes] of tags) {
    assert(/\bdefer\b/.test(attributes));
    assert(!/\basync\b|type="module"/.test(attributes));
  }
  for (const [, relativePath] of html.matchAll(/href="(assets\/css\/[^\"]+)"/g)) {
    assert(fs.readFileSync(path.resolve(path.dirname(htmlPath), relativePath), 'utf8').trim());
  }
  for (const [, handler] of html.matchAll(/on(?:click|change|input|keydown)="([^\"]+)"/g)) {
    new vm.Script(`(function(event) { ${handler} });`);
    for (const [, name] of handler.matchAll(/(?<![.\w])([A-Za-z_$][\w$]*)\(/g)) {
      if (name === 'if') continue;
      assert.equal(typeof h.ctx[name], 'function', `Missing inline event handler: ${name}`);
    }
  }
});

test('the real startup entry restores settings after binding controls and initializes the gallery', { skip: !splitApp }, async () => {
  const h = harness();
  h.settings.set('gpt_image_baseurl', 'https://example.test/v1');
  h.settings.set('gpt_image_apikey', 'test-only-key');
  h.settings.set('gpt_image_form', JSON.stringify({
    size: 'custom', customSize: '1280x720', format: 'jpeg', compression: '80',
    editSize: 'custom', editCustomSize: '1024x1024', editFormat: 'webp', editCompression: '70', partials: '2',
  }));
  for (const id of ['size', 'quality', 'format', 'partials', 'editSize', 'editQuality', 'editFormat']) {
    h.element(id).tagName = 'SELECT';
  }
  h.ctx.renderGallery = h.renderGallery;
  const entry = scripts.at(-1);
  await vm.runInContext(entry.source, h.ctx, { filename: entry.src });
  assert.equal(h.element('modelName').textContent, 'gpt-image-2.5-sunburst · 視覺煉金實驗室');
  assert.equal(h.element('baseUrl').value, 'https://example.test/v1');
  assert.equal(h.element('apiKey').value, 'test-only-key');
  assert.equal(h.element('customSizeGroup').style.display, '');
  assert.equal(h.element('editCustomSizeGroup').style.display, '');
  assert.equal(h.element('compressionGroup').style.display, '');
  assert.equal(h.element('editCompressionGroup').style.display, '');
  assert.equal(h.element('compressionVal').textContent, '80%');
  assert.equal(h.element('editCompressionVal').textContent, '70%');
  assert.equal(h.ctx.getPartialImageCount(), 2);
  assert.equal(h.element('galleryEmpty').style.display, '');
  assert.equal(h.element('galleryGrid').children.length, 2);
  for (const [id, event] of [['galleryGrid', 'click'], ['editImage', 'change'], ['editMask', 'change'],
    ['prompt', 'keydown'], ['editPrompt', 'keydown'], ['chatInput', 'keydown'], ['chatHistPanel', 'click']]) {
    assert.equal(h.element(id).eventHandlers[event].length, 1, `Event binding for ${id}`);
  }
  h.element('size').value = 'auto';
  h.element('size').dispatchEvent(new Event('change'));
  assert.equal(h.element('customSizeGroup').style.display, 'none');
  h.unload.forEach(handler => handler());
});
