import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface HistoryRecord {
  id: string;
  type: string;
  content: string;
  timestamp: number;
  bytes: number;
}

interface IndexEntry {
  id: string;
  type: string;
  timestamp: number;
  bytes: number;
}

export interface StoreOptions {
  dataDir: string;
  historyLimit: number;
  historyTtlSeconds: number;
  maxCacheBytes: number;
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ClipboardStore {
  private secret: Buffer | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: StoreOptions) {}

  async init(): Promise<void> {
    await mkdir(this.options.dataDir, { recursive: true });
    const secretPath = path.join(this.options.dataDir, 'secret.key');
    try {
      const existing = await readFile(secretPath);
      if (existing.length !== 32) throw new Error('secret.key 長度不正確');
      this.secret = existing;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== 'ENOENT' && !(error instanceof Error && error.message.includes('長度'))) {
        throw error;
      }
      this.secret = randomBytes(32);
      await writeFile(secretPath, this.secret, { mode: 0o600 });
    }
  }

  async add(apiKey: string, type: string, content: string): Promise<HistoryRecord> {
    return this.lock(async () => {
      const now = Math.floor(Date.now() / 1000);
      const record: HistoryRecord = {
        id: randomUUID(),
        type,
        content,
        timestamp: now,
        bytes: Buffer.byteLength(content, 'utf8'),
      };
      const dir = this.roomDir(apiKey);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${record.id}.enc`), this.encrypt(content));
      const entries = await this.readIndex(dir);
      entries.unshift({
        id: record.id,
        type: record.type,
        timestamp: record.timestamp,
        bytes: record.bytes,
      });
      await this.writeIndex(dir, await this.evict(dir, entries, now));
      return record;
    });
  }

  async latest(apiKey: string, liveTtlSeconds: number): Promise<HistoryRecord | null> {
    return this.lock(async () => {
      const items = await this.loadRoom(apiKey, Math.floor(Date.now() / 1000));
      const newest = items[0];
      if (!newest) return null;
      if (newest.timestamp + liveTtlSeconds <= Math.floor(Date.now() / 1000)) return null;
      return newest;
    });
  }

  async history(apiKey: string): Promise<HistoryRecord[]> {
    return this.lock(async () => this.loadRoom(apiKey, Math.floor(Date.now() / 1000)));
  }

  private async loadRoom(apiKey: string, nowSeconds: number): Promise<HistoryRecord[]> {
    const dir = this.roomDir(apiKey);
    const entries = await this.readIndex(dir);
    const kept = await this.evict(dir, entries, nowSeconds);
    if (entries.length > 0 || kept.length > 0) {
      await this.writeIndex(dir, kept);
    }
    const records: HistoryRecord[] = [];
    for (const entry of kept) {
      const content = await this.readContent(dir, entry.id);
      if (content === null) continue;
      records.push({ ...entry, content });
    }
    return records;
  }

  private roomDir(apiKey: string): string {
    const hash = createHash('sha256').update(apiKey).digest('hex');
    return path.join(this.options.dataDir, 'rooms', hash);
  }

  private async readIndex(dir: string): Promise<IndexEntry[]> {
    try {
      const raw = await readFile(path.join(dir, 'index.json'), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is IndexEntry => {
        if (!entry || typeof entry !== 'object') return false;
        const item = entry as Partial<IndexEntry>;
        return typeof item.id === 'string'
          && ID_RE.test(item.id)
          && typeof item.type === 'string'
          && typeof item.timestamp === 'number'
          && typeof item.bytes === 'number';
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    }
  }

  private async writeIndex(dir: string, entries: IndexEntry[]): Promise<void> {
    await mkdir(dir, { recursive: true });
    const destination = path.join(dir, 'index.json');
    const temporary = path.join(dir, 'index.json.tmp');
    await writeFile(temporary, JSON.stringify(entries));
    await rm(destination, { force: true });
    await rename(temporary, destination);
  }

  private async evict(dir: string, entries: IndexEntry[], nowSeconds: number): Promise<IndexEntry[]> {
    const fresh = entries.filter((entry) => entry.timestamp + this.options.historyTtlSeconds > nowSeconds);
    const removed = entries.filter((entry) => !fresh.includes(entry));
    const kept: IndexEntry[] = [];
    let total = 0;
    for (const entry of fresh) {
      if (kept.length >= this.options.historyLimit) {
        removed.push(entry);
        continue;
      }
      if (total + entry.bytes > this.options.maxCacheBytes && kept.length > 0) {
        removed.push(entry);
        continue;
      }
      kept.push(entry);
      total += entry.bytes;
    }
    await Promise.all(removed.map((entry) => rm(path.join(dir, `${entry.id}.enc`), { force: true })));
    return kept;
  }

  private async readContent(dir: string, id: string): Promise<string | null> {
    if (!ID_RE.test(id)) return null;
    try {
      return this.decrypt(await readFile(path.join(dir, `${id}.enc`)));
    } catch {
      return null;
    }
  }

  private encrypt(plain: string): Buffer {
    const secret = this.requireSecret();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secret, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }

  private decrypt(payload: Buffer): string {
    const secret = this.requireSecret();
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const data = payload.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', secret, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  private requireSecret(): Buffer {
    if (!this.secret) throw new Error('剪貼簿儲存尚未初始化');
    return this.secret;
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

export async function removeStore(dataDir: string): Promise<void> {
  await rm(dataDir, { recursive: true, force: true });
}
