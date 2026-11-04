// platform/storageAdapter.js — Storage adapter contract.
//
// Platform implementations:
//   - platform/storageAdapterBrowser.js — IndexedDB (PWA, Electron renderer)
//   - platform/storageAdapterElectron.js — SQLite (Electron main, mobile native)
//   - platform/storageAdapterMemory.js — In-memory (testing only)
//
// Every adapter implements: get(), set(), delete(), keys(), clear().
// The UI never touches IndexedDB or SQLite directly — it goes through this adapter.

export class StorageAdapter {
  constructor({ namespace = 'intentlens' } = {}) {
    this.namespace = namespace;
  }

  get(key) {
    throw new Error('get() not implemented by platform adapter');
  }

  set(key, value) {
    throw new Error('set() not implemented by platform adapter');
  }

  delete(key) {
    throw new Error('delete() not implemented by platform adapter');
  }

  keys() {
    throw new Error('keys() not implemented by platform adapter');
  }

  clear() {
    throw new Error('clear() not implemented by platform adapter');
  }

  // Helper: get namespaced key
  key(key) {
    return `${this.namespace}:${key}`;
  }
}
