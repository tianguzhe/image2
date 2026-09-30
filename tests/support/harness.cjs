// Run with: node --test tests/regression.cjs
// IMAGE_APP_HTML can point to an earlier version for compatibility checks.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;

const htmlPath = process.env.IMAGE_APP_HTML || path.join(__dirname, '..', '..', 'image_generator_optimized.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(match => {
  const src = match[1].match(/\bsrc="([^"]+)"/)?.[1];
  return { src, source: src ? fs.readFileSync(path.resolve(path.dirname(htmlPath), src), 'utf8') : match[2] };
});
const script = scripts.map(item => item.source).join('\n');
const splitApp = scripts.some(item => item.src);
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
    this.eventHandlers = {};
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
  addEventListener(name, handler) {
    this.listeners[name] = handler;
    (this.eventHandlers[name] ||= []).push(handler);
  }
  dispatchEvent(event) {
    for (const handler of this.eventHandlers[event.type] || []) handler.call(this, event);
  }
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
  const settings = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const directory = {
    async isSameEntry(other) { return other === directory; },
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
    transaction(storeName, mode) {
      const storeNames = Array.isArray(storeName) ? storeName : [storeName];
      for (const name of storeNames) if (!records.has(name)) records.set(name, new Map());
      const writes = [];
      const error = mode === 'readwrite' ? db.failNextWrite : null;
      if (error) db.failNextWrite = null;
      let aborted = false;
      const tx = {
        error,
        abort() { aborted = true; },
        objectStore(name = storeNames[0]) {
          const store = records.get(name);
          const clone = value => name === 'settings' && value?.handle ? { ...value } : structuredClone(value);
          const request = result => {
            const req = { result };
            queueMicrotask(() => req.onsuccess?.());
            return req;
          };
          return {
            add: value => { const saved = clone(value); writes.push(() => store.set(value.id ?? value.key, saved)); },
            put: value => { const saved = clone(value); writes.push(() => store.set(value.id ?? value.key, saved)); },
            delete: id => writes.push(() => store.delete(id)),
            get: id => request(clone(store.get(id))),
            getAll: () => request(structuredClone([...store.values()])),
            count: () => request(store.size),
          };
        },
      };
      queueMicrotask(() => {
        if (error || aborted) { tx.onabort?.(); return; }
        writes.forEach(write => write());
        tx.oncomplete?.();
      });
      return tx;
    },
  };
  const ctx = vm.createContext({
    console: { error() {}, warn() {} },
    Blob, File, FormData, TextDecoder, TextEncoder, ReadableStream, Event, crypto,
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
    document: Object.assign(new Element(), {
      getElementById: element, createElement: () => new Element(), createTextNode: text => ({ textContent: text }),
      querySelector: element, querySelectorAll: () => [], body: new Element(),
    }),
    navigator: {},
    window: { addEventListener: (name, fn) => { if (name === 'beforeunload') unload.push(fn); } },
    alert: message => alerts.push(message), confirm: () => true,
    activeConv: null, chatBusy: false, chatDeleting: false, chatBlobCache: new Map(), chatRenderVersion: 0,
    genController: null, genUserStopped: false, editFiles: [], maskFiles: [],
    gallerySortAsc: false, currentGalleryFilter: 'all', galleryFlatList: [],
    localStorage: {
      getItem: key => settings.get(key) ?? null,
      setItem: (key, value) => settings.set(key, String(value)),
      removeItem: key => settings.delete(key),
    },
    async fetch(url, options) {
      requests.push({ url, options });
      return { ok: true, blob: async () => new Blob(['remote-image'], { type: 'image/png' }) };
    },
  });
  if (splitApp) {
    // Execute each real dependency independently, in the HTML's loading order.
    for (const { src, source } of scripts) {
      if (src.endsWith('/app.js')) continue;
      vm.runInContext(source, ctx, { filename: src });
    }
    // Expose lexical state to scenario setup without replacing its declaration.
    const state = scripts.find(item => item.src.endsWith('/state.js')).source;
    for (const [, kind, name] of state.matchAll(/^(let|const) (\w+) = /gm)) {
      vm.runInContext(`Object.defineProperty(globalThis, '${name}', {
        configurable: true, get: () => ${name},
        ${kind === 'let' ? `set: value => { ${name} = value; },` : ''}
      });`, ctx);
    }
  } else {
    vm.runInContext(constants + '\n' + functions, ctx);
  }
  vm.runInContext(`
    function setStorage(enabled, handle) { useLocalFS = enabled; dirHandle = handle; }
  `, ctx);
  const renderGallery = ctx.renderGallery;
  const renderChat = ctx.renderChat;
  const openDB = ctx.openDB;
  ctx.openDB = async () => db;
  ctx.renderGallery = async () => {};
  ctx.renderChat = async () => {};
  return { ctx, files, records, requests, createdUrls, revokedUrls, unload, alerts, element, directory, renderGallery, renderChat, openDB, settings, db };
}


module.exports = { htmlPath, html, scripts, script, splitApp, harness, base64, deferred };
