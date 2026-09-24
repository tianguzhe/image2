// HTTP requests, SSE parsing, authentication, timeout and cancellation. Uses settings.js.

function getHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const key = document.getElementById('apiKey').value.trim();
  if (key) h['Authorization'] = `Bearer ${key}`;
  return h;
}

async function callGenerateAPI(body, signal) {
  const base = getBaseUrl();
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
      headers: getHeaders(),
      body: JSON.stringify(body),
      signal: fetchSignal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    // Keep the timeout active until the response body has finished downloading.
    return await res.json();
  } catch (e) {
    // Internal timeout only; external aborts propagate as AbortError for the caller
    if (e.name === 'AbortError' && !signal) throw new Error('請求超時（超過5分鐘），請稍後重試');
    throw e;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function readImageEventStream(res, onPartial) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const finalImages = [];
  let streamError = null;

  const processBlock = (raw) => {
    const lines = raw.split(/\r?\n/);
    let eventName = '';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      // SSE spec: strip only the first space after "data:"
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    if (data === '[DONE]') return;
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    const type = payload.type || eventName || '';
    if (type === 'error' || payload.error) {
      const err = payload.error || payload;
      streamError = new Error(err.message || 'SSE 回傳 error 事件');
      return;
    }
    // Event shapes vary across OpenAI versions and proxies; match loosely.
    let b64 = null, isFinal = false, idx = null;
    if (/partial/i.test(type) || payload.partial_image_b64 != null) {
      b64 = payload.partial_image_b64 || payload.b64_json;
      idx = payload.partial_image_index;
    } else if (/complete|done/i.test(type)) {
      b64 = payload.b64_json || payload.data?.[0]?.b64_json || payload.result;
      isFinal = true;
    } else if (payload.data?.[0]?.b64_json) {
      b64 = payload.data[0].b64_json;
      isFinal = true;
    } else if (payload.b64_json || payload.result) {
      b64 = payload.b64_json || payload.result;
      isFinal = true;
    }
    if (!b64) return;
    if (isFinal) finalImages.push({ b64_json: b64 });
    else if (onPartial) onPartial(b64, idx);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE proxies may use LF or CRLF, including delimiters split across chunks.
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer)) !== null) {
        processBlock(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer);
    if (streamError) throw streamError;
    if (!finalImages.length) throw new Error('串流結束但沒有收到最終圖片');
    return { data: finalImages };
  } finally {
    reader.releaseLock();
  }
}

async function callGenerateAPIStream(body, { signal, onPartial } = {}) {
  const base = getBaseUrl();
  const headers = getHeaders();
  headers['Accept'] = 'text/event-stream';
  const res = await fetch(`${base}/images/generations`, {
    method: 'POST', headers, body: JSON.stringify(body), signal
  });
  return readImageAPIResponse(res, onPartial);
}

async function callEditAPIStream(formData, { signal, onPartial } = {}) {
  const base = getBaseUrl();
  const headers = { 'Accept': 'text/event-stream' };
  const key = document.getElementById('apiKey').value.trim();
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(`${base}/images/edits`, {
    method: 'POST', headers, body: formData, signal
  });
  return readImageAPIResponse(res, onPartial);
}

async function readImageAPIResponse(res, onPartial) {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
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
        reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText}`));
      }
    };
    xhr.onerror = () => { cleanup(); reject(new Error('網路錯誤')); };
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
