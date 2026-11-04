// server/store.js — SQLite persistence for IntentLens object/project memory (§9).
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, statSync, unlinkSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const IMAGE_CAP = 5;
const TASK_CAP = 15;

const now = () => new Date().toISOString();

export class Store {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.imagesDir = join(dataDir, 'images');
    this.cropsDir = join(dataDir, 'crops');
    this.capturesDir = join(dataDir, 'captures');
    this.db = null;
  }

  open() {
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.imagesDir, { recursive: true });
    mkdirSync(this.cropsDir, { recursive: true });
    mkdirSync(this.capturesDir, { recursive: true });
    this.db = new DatabaseSync(join(this.dataDir, 'intentlens.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this._ensureSchema();
    try {
      this.db.exec('DELETE FROM sources_fts;');
      this.db.exec('INSERT INTO sources_fts(title, publisher, part_number, excerpt, source_id) SELECT title, publisher, part_number, excerpt, id FROM sources;');
    } catch { /* ignore */ }
  }

  close() {
    if (this.db) { this.db.close(); this.db = null; }
  }

  _ensureSchema() {
    const db = this.db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_docs (
        project_id TEXT PRIMARY KEY,
        doc_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        original_path TEXT NOT NULL,
        overlay_path TEXT,
        overlay_svg TEXT,
        mime_type TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        grid_size INTEGER NOT NULL,
        captured_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS captures_project_created
        ON captures(project_id, created_at);
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS objects (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_label TEXT,
        ai_label TEXT,
        kind TEXT,
        original_image_path TEXT,
        crop_image_path TEXT,
        source_frame_id TEXT,
        anchor_x REAL, anchor_y REAL,
        box_x REAL, box_y REAL, box_w REAL, box_h REAL,
        colour_summary TEXT,
        shape_summary TEXT,
        texture_summary TEXT,
        part_number TEXT,
        confidence REAL,
        identity_status TEXT,
        current_tracking_state TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS object_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        claim TEXT NOT NULL,
        kind TEXT NOT NULL,
        retrieved_at TEXT,
        FOREIGN KEY (object_id) REFERENCES objects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_command TEXT NOT NULL,
        answer_short TEXT NOT NULL,
        active_object_ids TEXT,
        source_frame_ids TEXT,
        provider_used TEXT,
        fallback_occurred INTEGER NOT NULL DEFAULT 0,
        citations TEXT,
        unresolved_items TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS task_citations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        claim TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        publisher TEXT NOT NULL DEFAULT '',
        canonical_url TEXT NOT NULL,
        revision TEXT NOT NULL DEFAULT '',
        part_number TEXT NOT NULL DEFAULT '',
        page_section TEXT NOT NULL DEFAULT '',
        excerpt TEXT NOT NULL DEFAULT '',
        source_kind TEXT NOT NULL DEFAULT 'user_document',
        source_verified INTEGER NOT NULL DEFAULT 0,
        imported_at TEXT NOT NULL,
        checksum TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      DROP TRIGGER IF EXISTS sources_ai;
      DROP TRIGGER IF EXISTS sources_ad;
      DROP TRIGGER IF EXISTS sources_au;
      DROP TABLE IF EXISTS sources_fts;
      CREATE VIRTUAL TABLE sources_fts USING fts5(
        title, publisher, part_number, excerpt, source_id UNINDEXED
      );
      CREATE TRIGGER sources_ai AFTER INSERT ON sources BEGIN
        INSERT INTO sources_fts(title, publisher, part_number, excerpt, source_id)
        VALUES (new.title, new.publisher, new.part_number, new.excerpt, new.id);
      END;
      CREATE TRIGGER sources_ad AFTER DELETE ON sources BEGIN
        DELETE FROM sources_fts WHERE source_id = old.id;
      END;
      CREATE TRIGGER sources_au AFTER UPDATE ON sources BEGIN
        DELETE FROM sources_fts WHERE source_id = old.id;
        INSERT INTO sources_fts(title, publisher, part_number, excerpt, source_id)
        VALUES (new.title, new.publisher, new.part_number, new.excerpt, new.id);
      END;
    `);
  }

  getOrCreateProject(id, name) {
    const existing = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    const ts = now();
    if (existing) return existing;
    this.db.prepare('INSERT INTO projects (id, name, summary, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, name || 'Project', '', ts);
    return { id, name: name || 'Project', summary: '', updated_at: ts };
  }

  updateProjectSummary(id, summary) {
    this.db.prepare(
      'UPDATE projects SET summary = ?, updated_at = ? WHERE id = ?'
    ).run(summary, now(), id);
  }

  addImage(projectId, path, pinned = false) {
    const id = randomUUID();
    const ts = now();
    this.db.prepare(
      'INSERT INTO images (id, project_id, path, pinned, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, projectId, path, pinned ? 1 : 0, ts);
    this._enforceImageCap(projectId);
    return id;
  }

  listImages(projectId) {
    return this.db.prepare(
      'SELECT * FROM images WHERE project_id = ? ORDER BY pinned DESC, created_at DESC'
    ).all(projectId);
  }

  deleteImage(imageId) {
    const row = this.db.prepare('SELECT path FROM images WHERE id = ?').get(imageId);
    if (row) {
      this._deleteFile(row.path);
      this.db.prepare('DELETE FROM images WHERE id = ?').run(imageId);
    }
  }

  _enforceImageCap(projectId) {
    while (true) {
      const all = this.db.prepare(
        'SELECT * FROM images WHERE project_id = ? ORDER BY created_at ASC'
      ).all(projectId);
      if (all.length <= IMAGE_CAP) break;
      const victim = all.find((i) => !i.pinned);
      if (!victim) break;
      this._deleteFile(victim.path);
      this.db.prepare('DELETE FROM images WHERE id = ?').run(victim.id);
    }
  }

  createObject(record) {
    const id = record.id || `O${this._nextObjectNumber(record.projectId)}`;
    const ts = now();
    this.db.prepare(`
      INSERT INTO objects (id, project_id, user_label, ai_label, kind, original_image_path,
        crop_image_path, source_frame_id, anchor_x, anchor_y, box_x, box_y, box_w, box_h,
        colour_summary, shape_summary, texture_summary, part_number, confidence,
        identity_status, current_tracking_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, record.projectId, record.userLabel || null, record.aiLabel || null, record.kind || 'object',
      record.originalImagePath || null, record.cropImagePath || null, record.sourceFrameId || null,
      record.anchor ? record.anchor.x : null, record.anchor ? record.anchor.y : null,
      record.box ? record.box.x : null, record.box ? record.box.y : null,
      record.box ? record.box.width : null, record.box ? record.box.height : null,
      record.appearance ? record.appearance.colourSummary || null : null,
      record.appearance ? record.appearance.shapeSummary || null : null,
      record.appearance ? record.appearance.textureSummary || null : null,
      record.partNumber || null,
      record.confidence == null ? null : record.confidence,
      record.identityStatus || 'unknown',
      record.currentTrackingState || 'not_active',
      ts, ts
    );
    if (Array.isArray(record.evidence)) {
      for (const e of record.evidence) {
        this.db.prepare(
          'INSERT INTO object_evidence (object_id, title, url, claim, kind, retrieved_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(id, e.title, e.url, e.claim, e.kind, e.retrievedAt || null);
      }
    }
    return this.getObject(id);
  }

  _nextObjectNumber(projectId) {
    const row = this.db.prepare(
      'SELECT id FROM objects WHERE project_id = ? ORDER BY id DESC LIMIT 1'
    ).get(projectId);
    if (!row) return 1;
    const m = /^O(\d+)$/.exec(row.id);
    return m ? parseInt(m[1], 10) + 1 : 1;
  }

  getObject(id) {
    const obj = this.db.prepare('SELECT * FROM objects WHERE id = ?').get(id);
    if (!obj) return null;
    obj.evidence = this.db.prepare(
      'SELECT title, url, claim, kind, retrieved_at FROM object_evidence WHERE object_id = ?'
    ).all(id);
    return this._serializeObject(obj);
  }

  listObjects(projectId) {
    const rows = this.db.prepare(
      'SELECT * FROM objects WHERE project_id = ? ORDER BY updated_at DESC'
    ).all(projectId);
    return rows.map((r) => this._serializeObject(r));
  }

  updateObject(id, fields) {
    const sets = [];
    const vals = [];
    const allowed = {
      user_label: 'userLabel', ai_label: 'aiLabel', kind: 'kind',
      crop_image_path: 'cropImagePath', source_frame_id: 'sourceFrameId',
      colour_summary: 'colourSummary', shape_summary: 'shapeSummary',
      texture_summary: 'textureSummary', part_number: 'partNumber',
      confidence: 'confidence', identity_status: 'identityStatus',
      current_tracking_state: 'currentTrackingState',
    };
    for (const [col, key] of Object.entries(allowed)) {
      if (key in fields) { sets.push(`${col} = ?`); vals.push(fields[key]); }
    }
    if (fields.anchor) { sets.push('anchor_x = ?, anchor_y = ?'); vals.push(fields.anchor.x, fields.anchor.y); }
    if (fields.box) {
      sets.push('box_x = ?, box_y = ?, box_w = ?, box_h = ?');
      vals.push(fields.box.x, fields.box.y, fields.box.width, fields.box.height);
    }
    if (!sets.length) return this.getObject(id);
    sets.push('updated_at = ?');
    vals.push(now(), id);
    this.db.prepare(`UPDATE objects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.getObject(id);
  }

  deleteObject(id) {
    const obj = this.db.prepare('SELECT crop_image_path FROM objects WHERE id = ?').get(id);
    if (obj && obj.crop_image_path) this._deleteFile(obj.crop_image_path);
    this.db.prepare('DELETE FROM objects WHERE id = ?').run(id);
  }

  _serializeObject(row) {
    return {
      id: row.id,
      projectId: row.project_id,
      userLabel: row.user_label,
      aiLabel: row.ai_label,
      kind: row.kind,
      originalImagePath: row.original_image_path,
      cropImagePath: row.crop_image_path,
      sourceFrameId: row.source_frame_id,
      anchor: row.anchor_x != null ? { x: row.anchor_x, y: row.anchor_y } : null,
      box: row.box_x != null ? {
        x: row.box_x, y: row.box_y, width: row.box_w, height: row.box_h,
      } : null,
      appearance: {
        colourSummary: row.colour_summary,
        shapeSummary: row.shape_summary,
        textureSummary: row.texture_summary,
      },
      partNumber: row.part_number,
      evidence: (row.evidence || []).map((e) => ({ title: e.title, url: e.url, claim: e.claim, kind: e.kind, retrievedAt: e.retrieved_at })),
      userNotes: [],
      confidence: row.confidence,
      identityStatus: row.identity_status,
      currentTrackingState: row.current_tracking_state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createTask(record) {
    const id = record.id || randomUUID();
    const ts = now();
    this.db.prepare(`
      INSERT INTO tasks (id, project_id, user_command, answer_short,
        active_object_ids, source_frame_ids, provider_used, fallback_occurred,
        citations, unresolved_items, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, record.projectId, record.userCommand, record.answerShort,
      record.activeObjectIds ? JSON.stringify(record.activeObjectIds) : '[]',
      record.sourceFrameIds ? JSON.stringify(record.sourceFrameIds) : '[]',
      record.providerUsed || null, record.fallbackOccurred ? 1 : 0,
      record.citations ? JSON.stringify(record.citations) : '[]',
      record.unresolvedItems ? JSON.stringify(record.unresolvedItems) : '[]',
      ts
    );
    if (record.citations && record.citations.length) {
      for (const c of record.citations) {
        this.db.prepare(
          'INSERT INTO task_citations (task_id, title, url, claim) VALUES (?, ?, ?, ?)'
        ).run(id, c.title, c.url, c.claim);
      }
    }
    this._enforceTaskCap(record.projectId);
    return this.getTask(id);
  }

  _enforceTaskCap(projectId) {
    const tasks = this.db.prepare(
      'SELECT * FROM tasks WHERE project_id = ? ORDER BY rowid ASC'
    ).all(projectId);
    while (tasks.length > TASK_CAP) {
      const oldest = tasks.shift();
      this._archiveTaskIntoSummary(projectId, oldest);
      this.db.prepare('DELETE FROM task_citations WHERE task_id = ?').run(oldest.id);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(oldest.id);
    }
  }

  compressContext(projectId, keepRecent = 3) {
    const tasks = this.db.prepare(
      'SELECT * FROM tasks WHERE project_id = ? ORDER BY rowid ASC'
    ).all(projectId);
    if (tasks.length <= keepRecent) return { archived: 0, kept: tasks.length };

    const toArchive = tasks.slice(0, tasks.length - keepRecent);
    for (const task of toArchive) {
      this._archiveTaskIntoSummary(projectId, task);
      this.db.prepare('DELETE FROM task_citations WHERE task_id = ?').run(task.id);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    }
    return { archived: toArchive.length, kept: keepRecent };
  }

  _archiveTaskIntoSummary(projectId, task) {
    const proj = this.db.prepare('SELECT summary FROM projects WHERE id = ?').get(projectId);
    const fact = `- ${task.user_command} → ${task.answer_short} (${task.provider_used || 'unknown provider'})`;
    const summary = proj.summary ? `${proj.summary}\n${fact}` : fact;
    this.updateProjectSummary(projectId, summary);
  }

  getTask(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) return null;
    return this._serializeTask(row);
  }

  listTasks(projectId) {
    const rows = this.db.prepare(
      'SELECT * FROM tasks WHERE project_id = ? ORDER BY rowid DESC LIMIT ?'
    ).all(projectId, TASK_CAP);
    return rows.map((r) => this._serializeTask(r));
  }

  _serializeTask(row) {
    return {
      id: row.id,
      projectId: row.project_id,
      userCommand: row.user_command,
      answerShort: row.answer_short,
      activeObjectIds: row.active_object_ids ? JSON.parse(row.active_object_ids) : [],
      sourceFrameIds: row.source_frame_ids ? JSON.parse(row.source_frame_ids) : [],
      providerUsed: row.provider_used,
      fallbackOccurred: Boolean(row.fallback_occurred),
      citations: (row.citations ? JSON.parse(row.citations) : []),
      unresolvedItems: row.unresolved_items ? JSON.parse(row.unresolved_items) : [],
      createdAt: row.created_at,
    };
  }

  getProjectContext(projectId) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) return null;
    return {
      project: {
        id: project.id,
        name: project.name,
        summary: project.summary,
        updatedAt: project.updated_at,
      },
      tasks: this.listTasks(projectId),
      objects: this.listObjects(projectId),
      images: this.listImages(projectId),
    };
  }

  // Source vault
  addSource(projectId, source) {
    const id = source.id || randomUUID();
    const ts = now();
    const checksum = source.checksum || '';
    const text = (v, max) => String(v ?? '').trim().slice(0, max);
    this.db.prepare(`
      INSERT INTO sources (id, project_id, title, publisher, canonical_url, revision,
        part_number, page_section, excerpt, source_kind, source_verified,
        imported_at, checksum)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, projectId,
      text(source.title, 200),
      text(source.publisher, 100),
      text(source.canonical_url, 500),
      text(source.revision, 50),
      text(source.part_number, 100),
      text(source.page_section, 100),
      text(source.excerpt, 5000),
      text(source.source_kind, 50),
      source.source_verified ? 1 : 0,
      ts,
      checksum
    );
    return { id, ...source };
  }

  listSources(projectId) {
    return this.db.prepare(
      'SELECT * FROM sources WHERE project_id = ? ORDER BY imported_at DESC'
    ).all(projectId).map((r) => ({
      id: r.id,
      title: r.title,
      publisher: r.publisher,
      canonical_url: r.canonical_url,
      revision: r.revision,
      part_number: r.part_number,
      page_section: r.page_section,
      excerpt: r.excerpt,
      source_kind: r.source_kind,
      source_verified: Boolean(r.source_verified),
      imported_at: r.imported_at,
      checksum: r.checksum,
    }));
  }

  searchSources(projectId, query, limit = 10) {
    const q = String(query || '').trim();
    if (!q) return [];
    // Sanitize FTS query by quoting tokens.
    const tokens = q.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`);
    const ftsQuery = tokens.join(' OR ');
    let rows = [];
    try {
      if (projectId) {
        rows = this.db.prepare(`
          SELECT s.*, bm25(sources_fts) AS rank
          FROM sources_fts fts
          JOIN sources s ON s.id = fts.source_id
          WHERE s.project_id = ? AND sources_fts MATCH ?
          ORDER BY bm25(sources_fts)
          LIMIT ?
        `).all(projectId, ftsQuery, limit);
      } else {
        rows = this.db.prepare(`
          SELECT s.*, bm25(sources_fts) AS rank
          FROM sources_fts fts
          JOIN sources s ON s.id = fts.source_id
          WHERE sources_fts MATCH ?
          ORDER BY bm25(sources_fts)
          LIMIT ?
        `).all(ftsQuery, limit);
      }
    } catch {
      rows = [];
    }

    let exactMatches = [];
    try {
      if (projectId) {
        exactMatches = this.db.prepare(
          'SELECT * FROM sources WHERE project_id = ? AND part_number = ? AND part_number != "" ORDER BY imported_at DESC LIMIT ?'
        ).all(projectId, q, limit);
      } else {
        exactMatches = this.db.prepare(
          'SELECT * FROM sources WHERE part_number = ? AND part_number != "" ORDER BY imported_at DESC LIMIT ?'
        ).all(q, limit);
      }
    } catch {
      exactMatches = [];
    }

    const seen = new Set();
    const combined = [];
    for (const r of exactMatches) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        combined.push({ ...r, _rank: 0 });
      }
    }
    for (const r of rows) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        combined.push(r);
      }
    }

    return combined.map((r) => ({
      id: r.id,
      title: r.title,
      publisher: r.publisher,
      canonical_url: r.canonical_url,
      revision: r.revision,
      part_number: r.part_number,
      page_section: r.page_section,
      excerpt: r.excerpt,
      source_kind: r.source_kind,
      source_verified: Boolean(r.source_verified),
      imported_at: r.imported_at,
      checksum: r.checksum,
      rank: r.rank,
    }));
  }

  getSource(id) {
    const row = this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      publisher: row.publisher,
      canonical_url: row.canonical_url,
      revision: row.revision,
      part_number: row.part_number,
      page_section: row.page_section,
      excerpt: row.excerpt,
      source_kind: row.source_kind,
      source_verified: Boolean(row.source_verified),
      imported_at: row.imported_at,
      checksum: row.checksum,
    };
  }

  deleteSource(id) {
    this.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
  }

  deleteSourcesForProject(projectId) {
    this.db.prepare('DELETE FROM sources WHERE project_id = ?').run(projectId);
  }

  // ------------------------------------------------------------------
  // Structured project documents + immutable captures (screenshot workflow)
  // ------------------------------------------------------------------

  saveProjectDoc(project) {
    if (!project || typeof project !== 'object' || typeof project.projectId !== 'string' || !project.projectId) {
      throw new Error('saveProjectDoc requires a project with a projectId');
    }
    this.getOrCreateProject(project.projectId, project.title || 'Project');
    const ts = now();
    const doc = JSON.stringify(project);
    const existing = this.db.prepare('SELECT project_id FROM project_docs WHERE project_id = ?')
      .get(project.projectId);
    if (existing) {
      this.db.prepare('UPDATE project_docs SET doc_json = ?, updated_at = ? WHERE project_id = ?')
        .run(doc, ts, project.projectId);
    } else {
      this.db.prepare('INSERT INTO project_docs (project_id, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(project.projectId, doc, ts, ts);
    }
    return this.getProjectDoc(project.projectId);
  }

  getProjectDoc(projectId) {
    const row = this.db.prepare('SELECT doc_json FROM project_docs WHERE project_id = ?').get(projectId);
    if (!row) return null;
    try { return JSON.parse(row.doc_json); } catch { return null; }
  }

  listProjectDocs(limit = 20) {
    const n = Math.min(100, Math.max(1, Number(limit) || 20));
    return this.db.prepare('SELECT doc_json FROM project_docs ORDER BY updated_at DESC LIMIT ?').all(n)
      .map((row) => {
        try { return JSON.parse(row.doc_json); } catch { return null; }
      })
      .filter(Boolean);
  }

  _safeSegment(value) {
    const text = String(value ?? '');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(text)) throw new Error('Unsafe project or capture id');
    return text;
  }

  createCapture({
    id,
    projectId,
    originalBuffer,
    overlayBuffer = null,
    overlaySvg = null,
    mimeType = 'image/jpeg',
    width,
    height,
    gridSize,
    capturedAt,
  }) {
    if (!id || !projectId || !Buffer.isBuffer(originalBuffer)) {
      throw new Error('createCapture requires id, projectId and an image buffer');
    }
    const safeProject = this._safeSegment(projectId);
    const safeCapture = this._safeSegment(id);
    this.getOrCreateProject(projectId, 'Project');

    mkdirSync(join(this.capturesDir, safeProject), { recursive: true });
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const originalPath = join(this.capturesDir, safeProject, `${safeCapture}-original.${ext}`);
    const overlayPath = overlayBuffer ? join(this.capturesDir, safeProject, `${safeCapture}-overlay.png`) : null;
    const ts = now();

    try {
      this.db.prepare(`
        INSERT INTO captures (id, project_id, original_path, overlay_path, overlay_svg,
          mime_type, width, height, grid_size, captured_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, projectId, originalPath, overlayPath, overlaySvg || null,
        mimeType, Math.round(width), Math.round(height), Math.round(gridSize),
        capturedAt || ts, ts,
      );
    } catch (err) {
      if (/UNIQUE|constraint/i.test(String(err?.message))) {
        const conflict = new Error(`Capture ${id} already exists; original captures are immutable.`);
        conflict.code = 'CAPTURE_EXISTS';
        throw conflict;
      }
      throw err;
    }

    try {
      // 'wx' refuses to overwrite an existing file. The original is immutable.
      writeFileSync(originalPath, originalBuffer, { flag: 'wx' });
      if (overlayPath) writeFileSync(overlayPath, overlayBuffer, { flag: 'wx' });
    } catch (err) {
      this._deleteFile(originalPath);
      if (overlayPath) this._deleteFile(overlayPath);
      this.db.prepare('DELETE FROM captures WHERE id = ?').run(id);
      const failed = new Error(`Could not store capture ${id}: ${err.message}`);
      failed.code = 'CAPTURE_WRITE_FAILED';
      throw failed;
    }

    return this.getCapture(id);
  }

  _mapCapture(row) {
    if (!row) return null;
    return {
      captureId: row.id,
      projectId: row.project_id,
      width: row.width,
      height: row.height,
      gridSize: row.grid_size,
      mimeType: row.mime_type,
      capturedAt: row.captured_at,
      createdAt: row.created_at,
      hasOverlay: Boolean(row.overlay_path || row.overlay_svg),
      originalUrl: `/api/captures/${row.id}/original`,
      overlayUrl: row.overlay_path || row.overlay_svg ? `/api/captures/${row.id}/overlay` : null,
    };
  }

  getCapture(id) {
    const row = this.db.prepare('SELECT * FROM captures WHERE id = ?').get(id);
    return this._mapCapture(row);
  }

  listCaptures(projectId, limit = 20) {
    const n = Math.min(100, Math.max(1, Number(limit) || 20));
    return this.db.prepare(
      'SELECT * FROM captures WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(projectId, n).map((row) => this._mapCapture(row));
  }

  /** Absolute file location + content type for serving a capture. */
  getCaptureFile(id, kind = 'original') {
    const row = this.db.prepare('SELECT * FROM captures WHERE id = ?').get(id);
    if (!row) return null;
    if (kind === 'overlay') {
      if (row.overlay_path && existsSync(row.overlay_path)) {
        return { path: row.overlay_path, mimeType: 'image/png' };
      }
      if (row.overlay_svg) {
        return { inlineText: row.overlay_svg, mimeType: 'image/svg+xml' };
      }
      if (row.original_path && existsSync(row.original_path)) {
        return { path: row.original_path, mimeType: row.mime_type };
      }
      return null;
    }
    if (!row.original_path || !existsSync(row.original_path)) return null;
    return { path: row.original_path, mimeType: row.mime_type };
  }

  deleteProject(id) {
    const images = this.listImages(id);
    for (const img of images) this._deleteFile(img.path);
    const objects = this.db.prepare('SELECT crop_image_path FROM objects WHERE project_id = ?').all(id);
    for (const obj of objects) if (obj.crop_image_path) this._deleteFile(obj.crop_image_path);
    const captures = this.db.prepare('SELECT original_path, overlay_path FROM captures WHERE project_id = ?').all(id);
    for (const cap of captures) {
      if (cap.original_path) this._deleteFile(cap.original_path);
      if (cap.overlay_path) this._deleteFile(cap.overlay_path);
    }
    try {
      if (/^[A-Za-z0-9_-]{1,80}$/.test(String(id))) {
        rmSync(join(this.capturesDir, id), { recursive: true, force: true });
      }
    } catch { /* directory already gone */ }
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  _deleteFile(path) {
    try { unlinkSync(path); } catch { /* file already gone */ }
  }
}

