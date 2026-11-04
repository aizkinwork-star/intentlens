// pwa/store.js — IndexedDB repositories for the standalone PWA.
//
// The desktop app uses SQLite on the local server. A GitHub Pages PWA has no
// server, so this module is the equivalent local-first store: projects,
// messages, captures (as blobs) and settings all live in IndexedDB on the
// phone. Nothing here talks to the network.

const DB_NAME = 'intentlens-pwa';
const DB_VERSION = 1;

let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('messages')) {
        const messages = db.createObjectStore('messages', { keyPath: 'id' });
        messages.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('images')) {
        const images = db.createObjectStore('images', { keyPath: 'id' });
        images.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const now = () => new Date().toISOString();
const sortByCreated = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));

// ---------------------------------------------------------------- projects

export async function listProjects() {
  const db = await open();
  const rows = await requestToPromise(db.transaction('projects').objectStore('projects').getAll());
  return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function getProject(projectId) {
  const db = await open();
  return requestToPromise(db.transaction('projects').objectStore('projects').get(projectId));
}

export async function createProject(name) {
  const db = await open();
  const project = {
    id: id('prj'),
    name: String(name || 'Untitled project').trim().slice(0, 80) || 'Untitled project',
    summary: '',
    createdAt: now(),
    updatedAt: now(),
  };
  const tx = db.transaction('projects', 'readwrite');
  tx.objectStore('projects').put(project);
  await transactionDone(tx);
  return project;
}

export async function touchProject(projectId) {
  const project = await getProject(projectId);
  if (!project) return null;
  project.updatedAt = now();
  const db = await open();
  const tx = db.transaction('projects', 'readwrite');
  tx.objectStore('projects').put(project);
  await transactionDone(tx);
  return project;
}

export async function deleteProject(projectId) {
  const db = await open();
  const tx = db.transaction(['projects', 'messages', 'images'], 'readwrite');
  tx.objectStore('projects').delete(projectId);
  for (const storeName of ['messages', 'images']) {
    const index = tx.objectStore(storeName).index('projectId');
    const cursorRequest = index.openKeyCursor(IDBKeyRange.only(projectId));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      tx.objectStore(storeName).delete(cursor.primaryKey);
      cursor.continue();
    };
  }
  await transactionDone(tx);
}

// ---------------------------------------------------------------- messages

export async function listMessages(projectId) {
  const db = await open();
  const index = db.transaction('messages').objectStore('messages').index('projectId');
  const rows = await requestToPromise(index.getAll(IDBKeyRange.only(projectId)));
  return rows.sort(sortByCreated);
}

export async function addMessage(message) {
  const db = await open();
  const row = {
    id: id('msg'),
    projectId: message.projectId,
    role: message.role,
    text: String(message.text || '').slice(0, 4000),
    result: message.result || null,
    imageId: message.imageId || null,
    mode: message.mode === 'chat' ? 'chat' : 'vision',
    model: message.model || null,
    createdAt: message.createdAt || now(),
  };
  const tx = db.transaction('messages', 'readwrite');
  tx.objectStore('messages').put(row);
  await transactionDone(tx);
  return row;
}

// ----------------------------------------------------------------- images

export async function putImage(image) {
  const db = await open();
  const row = {
    id: image.id || id('img'),
    projectId: image.projectId,
    blob: image.blob || null,
    dataUrl: image.dataUrl,
    width: image.width,
    height: image.height,
    gridSize: image.gridSize,
    createdAt: image.createdAt || now(),
  };
  const tx = db.transaction('images', 'readwrite');
  tx.objectStore('images').put(row);
  await transactionDone(tx);
  return row;
}

export async function getImage(imageId) {
  const db = await open();
  return requestToPromise(db.transaction('images').objectStore('images').get(imageId));
}

export async function listImages(projectId, limit = 5) {
  const db = await open();
  const index = db.transaction('images').objectStore('images').index('projectId');
  const rows = await requestToPromise(index.getAll(IDBKeyRange.only(projectId)));
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return rows.slice(0, limit);
}

// --------------------------------------------------------------- settings

export async function getSetting(key, fallback = null) {
  const db = await open();
  const row = await requestToPromise(db.transaction('settings').objectStore('settings').get(key));
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  const db = await open();
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put({ key, value });
  await transactionDone(tx);
}

export async function deleteSetting(key) {
  const db = await open();
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').delete(key);
  await transactionDone(tx);
}

export async function allSettings() {
  const db = await open();
  const rows = await requestToPromise(db.transaction('settings').objectStore('settings').getAll());
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}
