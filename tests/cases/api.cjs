const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, base64, deferred } = require('../support/harness.cjs');

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
