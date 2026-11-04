// Tiny .env loader. Avoids a dependency for one file of KEY=VALUE lines.
// Real environment variables always win over the file.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where `.env` is read from, in order:
 *   1. INTENTLENS_ENV_FILE (explicit)
 *   2. the current working directory (development)
 *   3. the per-user IntentLens config directory (the packaged desktop app has
 *      no writable project folder, so this is where desktop users put STT_URL)
 * Earlier files win; real environment variables win over all of them.
 */
export function envFileCandidates() {
  const files = [];
  if (process.env.INTENTLENS_ENV_FILE) files.push(resolve(process.env.INTENTLENS_ENV_FILE));
  files.push(resolve(process.cwd(), '.env'));

  const configDir = process.env.INTENTLENS_CONFIG_DIR || (
    process.env.APPDATA ? join(process.env.APPDATA, 'IntentLens')
      : process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'IntentLens')
        : join(homedir(), '.config', 'IntentLens')
  );
  files.push(join(configDir, '.env'));
  return [...new Set(files)];
}

function readEnvFile(file) {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

export function loadEnv(file) {
  const files = file ? [file] : envFileCandidates();
  let loaded = false;
  for (const candidate of files) {
    if (readEnvFile(candidate)) loaded = true;
  }

  // Also load saved UI configuration from intentlens-config.json if present
  const configFile = resolve(process.cwd(), 'intentlens-config.json');
  if (existsSync(configFile)) {
    try {
      const json = JSON.parse(readFileSync(configFile, 'utf8'));
      if (json && typeof json === 'object') {
        for (const [k, v] of Object.entries(json)) {
          if (process.env[k] === undefined && typeof v === 'string' && v.trim()) {
            process.env[k] = v.trim();
          }
        }
        loaded = true;
      }
    } catch {
      // ignore json parse error
    }
  }

  return loaded;
}
