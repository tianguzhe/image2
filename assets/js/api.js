// HTTP requests, SSE parsing, authentication, timeout and cancellation. Uses settings.js.

// Proxies also return { message, code } or a string error; keep the useful message visible.
function httpErrorMessage(status, text) {
  try {
    const payload = JSON.parse(text);
    const err = payload?.error ?? payload;
    if (typeof err === 'string' && err) return `HTTP ${status}: ${err.slice(0, 500)}`;
    if (typeof err?.message === 'string' && err.message) {
      return `HTTP ${status}: ${err.message.slice(0, 500)}${err.code ? ` (${String(err.code).slice(0, 100)})` : ''}`;
    }
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return `HTTP ${status}: ${text.slice(0, 500)}`;
}

function getHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const key = document.getElementById('apiKey').value.trim();
  if (key) h['Authorization'] = `Bearer ${key}`;
  return h;
}

async function requestGeneration(body, { signal, onPartial, stream = false } = {}) {
  const base = getBaseUrl();
  const headers = getHeaders();
  if (stream) headers.Accept = 'text/event-stream';
  let timeoutId = null;
  let fetchSignal = signal;
  if (!fetchSignal) {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    fetchSignal = controller.signal;
  }
  try {
    const res = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: fetchSignal
    });
    // Keep the timeout active until the response body has finished downloading.
    if (stream) return await readImageAPIResponse(res, onPartial);
    if (!res.ok) throw new Error(httpErrorMessage(res.status, await res.text()));
    return await res.json();
  } catch (e) {
    // Internal timeout only; external aborts propagate as AbortError for the caller
    if (e.name === 'AbortError' && !signal) throw new Error('請求超時（超過5分鐘），請稍後重試');
    throw e;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function callGenerateAPI(body, signal) {
  return requestGeneration(body, { signal });
}

async function readImageEventStream(res, onPartial) {
  if (!res.body) throw new Error('串流回應沒有內容');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const finalImages = [];
  let eventName = '';
  let dataLines = [];
  let lineParts = [];
  let skipLF = false;
  let streamDone = false;
  let readerDone = false;

  const processEvent = () => {
    const name = eventName;
    eventName = '';
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (data === '[DONE]') { streamDone = true; return; }
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    if (!payload || typeof payload !== 'object') return;
    const type = payload.type || name || '';
    if (type === 'error' || payload.error) {
      const err = payload.error || payload;
      throw new Error(err.message || 'SSE 回傳 error 事件');
    }
    // Event shapes vary across OpenAI versions and proxies; match loosely.
    let b64 = null, isFinal = false, idx = null;
    if (/partial/i.test(type) || payload.partial_image_b64 != null) {
      b64 = payload.partial_image_b64 || payload.b64_json;
      idx = payload.partial_image_index;
    } else if (Array.isArray(payload.data)) {
      for (const img of payload.data) {
        if (typeof img?.b64_json === 'string' && img.b64_json) finalImages.push({ b64_json: img.b64_json });
      }
      return;
    } else if (/complete|done/i.test(type)) {
      b64 = payload.b64_json || payload.result;
      isFinal = true;
    } else if (payload.b64_json || payload.result) {
      b64 = payload.b64_json || payload.result;
      isFinal = true;
    }
    if (typeof b64 !== 'string' || !b64) return;
    if (isFinal) finalImages.push({ b64_json: b64 });
    else if (onPartial) onPartial(b64, idx);
  };

  const processLine = (line) => {
    if (!line) { processEvent(); return; }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    // SSE strips only the first space after the colon.
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') eventName = value;
    if (field === 'data') dataLines.push(value);
  };

  const processChunk = (chunk) => {
    // Retain fragments until a complete line arrives. Re-scanning and concatenating
    // the entire Base64 event on every network chunk becomes quadratic for large images.
    let start = 0;
    for (let i = 0; i < chunk.length && !streamDone; i++) {
      const char = chunk[i];
      if (skipLF) {
        skipLF = false;
        if (char === '\n') { start = i + 1; continue; }
      }
      if (char !== '\r' && char !== '\n') continue;
      lineParts.push(chunk.slice(start, i));
      processLine(lineParts.join(''));
      lineParts = [];
      start = i + 1;
      skipLF = char === '\r';
    }
    if (!streamDone && start < chunk.length) lineParts.push(chunk.slice(start));
  };

  try {
    while (!streamDone) {
      const { value, done } = await reader.read();
      if (done) { readerDone = true; break; }
      processChunk(decoder.decode(value, { stream: true }));
    }
    if (!streamDone) {
      processChunk(decoder.decode());
      if (lineParts.length) processLine(lineParts.join(''));
      processEvent();
    }
    if (!finalImages.length) throw new Error('串流結束但沒有收到最終圖片');
    return { data: finalImages };
  } finally {
    // Error / [DONE] events can arrive before the proxy closes its connection.
    if (!readerDone) {
      try { await reader.cancel(); } catch {}
    }
    reader.releaseLock();
  }
}

async function callGenerateAPIStream(body, { signal, onPartial } = {}) {
  return requestGeneration(body, { signal, onPartial, stream: true });
}

async function readImageAPIResponse(res, onPartial) {
  if (!res.ok) throw new Error(httpErrorMessage(res.status, await res.text()));
  const contentType = res.headers.get('content-type') || '';
  // Proxies may ignore stream:true and return plain JSON.
  if (!contentType.includes('text/event-stream')) return res.json();
  return readImageEventStream(res, onPartial);
}

function explainFetchFailure(e) {
  if (e instanceof TypeError && /fetch|load failed|networkerror/i.test(e.message)) {
    return '請求未到達伺服器：通常是 CORS 預檢失敗、憑證/網路錯誤，或 Base URL 寫錯。'
      + '目前頁面 Origin 為 ' + location.origin + '，代理需允許此來源及 Authorization 標頭。';
  }
  return e.message;
}

function callEditAPI(formData, onProgress, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
      return;
    }
    const base = getBaseUrl();
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base}/images/edits`);
    xhr.timeout = API_TIMEOUT_MS;
    const key = document.getElementById('apiKey').value.trim();
    if (key) xhr.setRequestHeader('Authorization', `Bearer ${key}`);
    const onAbort = () => xhr.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round(e.loaded / e.total * 100));
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('回應格式錯誤')); }
      } else {
        reject(new Error(httpErrorMessage(xhr.status, xhr.responseText)));
      }
    };
    // XHR gives no detail on network/CORS failures; mirror fetch's TypeError so
    // explainFetchFailure() gives the same guidance as the generate tab.
    xhr.onerror = () => { cleanup(); reject(new TypeError('NetworkError: upload did not reach the server')); };
    xhr.ontimeout = () => { cleanup(); reject(new Error('請求超時（超過5分鐘），請稍後重試')); };
    xhr.onabort = () => {
      cleanup();
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    };
    xhr.send(formData);
  });
}
