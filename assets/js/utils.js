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
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
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

async function srcToFile(src, fmt) {
  const resp = await fetch(src);
  const blob = await resp.blob();
  const ext = imageExtension(fmt);
  return new File([blob], `input.${ext}`, { type: blob.type || 'image/png' });
}
