// HTML escaping, image conversions and display formatting. No startup side effects.

function escapeHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeUrl(url) {
  if (typeof url !== 'string') return '';
  // Allow data URLs, blob URLs, and HTTPS/HTTP
  if (url.startsWith('data:image/')) return url;
  if (url.startsWith('blob:')) return url;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') return url;
  } catch {}
  return '';
}

function imageExtension(fmt) {
  return fmt === 'jpeg' ? 'jpg' : fmt || 'png';
}

function imageMimeType(fmt) {
  return fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
}

function base64ToBytes(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64ToObjectUrl(b64, mime) {
  return URL.createObjectURL(new Blob([base64ToBytes(b64)], { type: mime }));
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const s = reader.result; resolve(s.slice(s.indexOf(',') + 1)); };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function fetchImageBlob(src, signal) {
  const url = sanitizeUrl(src);
  if (!url) throw new Error('圖片網址無效');
  const controller = signal ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), API_TIMEOUT_MS) : null;
  try {
    const response = await fetch(url, { signal: signal || controller.signal });
    if (!response.ok) throw new Error(`圖片下載失敗（HTTP ${response.status}）`);
    const blob = await response.blob();
    if (!blob.size) throw new Error('圖片內容為空');
    if (blob.type && !blob.type.startsWith('image/') && blob.type !== 'application/octet-stream') {
      throw new Error('下載內容不是圖片');
    }
    return blob;
  } catch (error) {
    if (controller?.signal.aborted) throw new Error('圖片下載超時（超過5分鐘），請稍後重試');
    throw error;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

async function srcToFile(src, fmt, signal) {
  const blob = await fetchImageBlob(src, signal);
  const ext = imageExtension(fmt);
  return new File([blob], `input.${ext}`, { type: blob.type || imageMimeType(fmt) });
}
