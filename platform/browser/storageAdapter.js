import { StorageAdapter } from '../storageAdapter.js';

export class BrowserStorageAdapter extends StorageAdapter {
  constructor({ namespace = 'intentlens' } = {}) {
    super({ namespace });
    this.db = null;
    this.dbName = `intentlens_${namespace}`;
    this.dbVersion = 1;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const stores = ['projects', 'objects', 'tasks', 'sources', 'images', this.namespace];
        for (const name of stores) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'id' });
          }
        }
      };
      request.onsuccess = () => { this.db = request.result; resolve(); };
      request.onerror = (event) => reject(new Error(`IndexedDB error: ${event.target.error}`));
    });
  }

  async close() {
    if (this.db) { this.db.close(); this.db = null; }
  }

  _tx(mode) {
    const tx = this.db.transaction([this.namespace], mode);
    return tx.objectStore(this.namespace);
  }

  async get(key) {
    if (!this.db) throw new Error('Store not initialized');
    return new Promise((resolve, reject) => {
      const store = this._tx('readonly');
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async set(key, value) {
    if (!this.db) throw new Error('Store not initialized');
    return new Promise((resolve, reject) => {
      const store = this._tx('readwrite');
      const req = store.put({ id: key, ...value });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async delete(key) {
    if (!this.db) throw new Error('Store not initialized');
    return new Promise((resolve, reject) => {
      const store = this._tx('readwrite');
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async keys() {
    if (!this.db) throw new Error('Store not initialized');
    return new Promise((resolve, reject) => {
      const store = this._tx('readonly');
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async clear() {
    if (!this.db) throw new Error('Store not initialized');
    return new Promise((resolve, reject) => {
      const store = this._tx('readwrite');
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}