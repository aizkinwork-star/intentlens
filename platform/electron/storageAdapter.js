// platform/electron/storageAdapter.js — SQLite storage adapter for Electron desktop.
//
// Used by: Electron desktop app (Windows, macOS, Linux).
// Stores data in SQLite files in the user's app data directory.
// This is the same store format as the legacy server/store.js for compatibility.

import { DatabaseSync } from 'node:sqlite';
import { StorageAdapter } from '../storageAdapter.js';

export class ElectronStorageAdapter extends StorageAdapter {
  constructor({ namespace = 'intentlens' } = {}) {
    super({ namespace });
    this.db = null;
    this.dbPath = null;
  }

  async init() {
    const { app } = require('electron');
    const { join } = require('node:path');
    const { mkdirSync } = require('node:fs');

    const userDataDir = app.getPath('userData');
    this.dbPath = join(userDataDir, 'IntentLens', 'intentlens.sqlite');
    mkdirSync(join(userDataDir, 'IntentLens'), { recursive: true });

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this._ensureSchema();
  }

  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async get(key) {
    if (!this.db) throw new Error('Store not initialized');
    const row = this.db.prepare('SELECT value FROM intentlens_data WHERE id = ?').get(key);
    if (!row) return null;
    return JSON.parse(row.value);
  }

  async set(key, value) {
    if (!this.db) throw new Error('Store not initialized');
    this.db.prepare(
      'INSERT OR REPLACE INTO intentlens_data (id, value, updated_at) VALUES (?, ?, ?)'
    ).run(key, JSON.stringify(value), new Date().toISOString());
  }

  async delete(key) {
    if (!this.db) throw new Error('Store not initialized');
    this.db.prepare('DELETE FROM intentlens_data WHERE id = ?').run(key);
  }

  async keys() {
    if (!this.db) throw new Error('Store not initialized');
    const rows = this.db.prepare('SELECT id FROM intentlens_data').all();
    return rows.map((r) => r.id);
  }

  async clear() {
    if (!this.db) throw new Error('Store not initialized');
    this.db.prepare('DELETE FROM intentlens_data').run();
  }

  async _ensureSchema() {
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS intentlens_data (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `).run();
  }
}
