import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { Server } from 'socket.io';
import Busboy from 'busboy';
import { isAppleMobileClient } from './clients';
import { ClipboardStore } from './store';
import type { HistoryRecord } from './store';

const ALLOWED_TYPES = ['text', 'html', 'rtf', 'image'] as const;

export interface ServerOptions {
  host: string;
  port: number;
  dataDir: string;
  clipboardTypes: string[];
  clipboardSize: number;
  clipboardTtl: number;
  historyTtl: number;
  historyLimit: number;
  maxCacheItems: number;
  maxCacheBytes: number;
}

export interface RunningServer {
  host: string;
  port: number;
  close: () => Promise<void>;
}

interface SyncBody {
  key: string;
  content: string;
  type: string;
  clientId?: string;
}

export function loopbackHost(host: string): '127.0.0.1' | '::1' {
  const normalized = host.trim().toLowerCase();
  if (normalized === '127.0.0.1' || normalized === 'localhost') return '127.0.0.1';
  if (normalized === '::1') return '::1';
  throw new Error('只監聽 localhost，對外連線請交給 cloudflared');
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = loopbackHost(options.host);
  const store = new ClipboardStore({
    dataDir: options.dataDir,
    historyLimit: options.historyLimit,
    historyTtlSeconds: options.historyTtl,
    maxCacheBytes: options.maxCacheBytes,
  });
  await store.init();

  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use((req, res, next) => {
    res.on('finish', () => {
      console.log(`${req.method} ${req.path} ${res.statusCode}`);
    });
    next();
  });

  const bodyLimit = options.clipboardSize + 1024 * 1024;
  app.use(express.json({ limit: bodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: bodyLimit }));
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (isPayloadTooLarge(error)) {
      res.status(400).json({
        code: -3,
        msg: `內容超出大小限制，目前上限：${options.clipboardSize}`,
      });
      return;
    }
    next(error);
  });

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  io.on('connection', (socket) => {
    console.log(`客戶端已連線 ${socket.id}`);
    socket.on('auth', (key: unknown) => {
      if (typeof key !== 'string' || key.length === 0) return;
      for (const room of socket.rooms) {
        if (room !== socket.id) socket.leave(room);
      }
      socket.join(key);
      const members = io.sockets.adapter.rooms.get(key)?.size ?? 0;
      console.log(`客戶端 ${socket.id} 已加入同步房間，成員 ${members}`);
    });
    socket.on('disconnect', (reason) => {
      console.log(`客戶端已離線 ${socket.id} ${reason}`);
    });
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.all('/api/v1/config', (_req, res) => {
    res.json({
      version: 1001,
      max_cache_items: options.maxCacheItems,
      max_cache_size: options.maxCacheBytes,
      clipboard_type: options.clipboardTypes,
      clipboard_size: options.clipboardSize,
      clipboard_ttl: options.clipboardTtl,
    });
  });

  app.all('/api/v1/key-gen', (_req, res) => {
    res.json({ key: generateApiKey() });
  });

  app.get('/api/v1/sync', async (req, res) => {
    const key = queryString(req.query.key);
    if (!key) {
      res.status(400).json({ error: '缺少必要參數 `key`' });
      return;
    }
    try {
      const item = await store.latest(key, options.clipboardTtl);
      const ttl = item ? Math.max(0, Math.floor(item.timestamp + options.clipboardTtl - Date.now() / 1000)) : 0;
      res.json({
        code: 200,
        msg: 'success',
        data: item ? { content: item.content, type: item.type, timestamp: item.timestamp } : null,
        ttl,
      });
    } catch (error) {
      console.error('讀取剪貼簿失敗', error);
      res.status(500).json({ code: 500, msg: '伺服器錯誤' });
    }
  });

  app.post('/api/v1/sync', async (req, res) => {
    try {
      const body = await readSyncBody(req, options.clipboardSize);
      if (!body.content || !body.key) {
        res.status(400).json({ code: -1, msg: '缺少必要參數 `content` 或 `key`' });
        return;
      }
      if (!options.clipboardTypes.includes(body.type)) {
        res.status(400).json({
          code: -2,
          msg: `不支援的內容類型，目前啟用類型：${options.clipboardTypes.join(',')}`,
        });
        return;
      }
      const content = normalizeContent(body.type, body.content);
      if (!content) {
        res.status(400).json({ code: -1, msg: '缺少必要參數 `content` 或 `key`' });
        return;
      }
      if (Buffer.byteLength(content, 'utf8') > options.clipboardSize) {
        res.status(400).json({
          code: -3,
          msg: `內容超出大小限制，目前上限：${options.clipboardSize}`,
        });
        return;
      }

      const record = await store.add(body.key, body.type, content);
      broadcast(io, body.key, record, body.clientId);
      console.log(`已同步 ${record.type} ${record.bytes} bytes`);
      res.json({ code: 200, msg: 'success', ttl: options.clipboardTtl });
    } catch (error) {
      if (isTooBig(error)) {
        res.status(400).json({
          code: -3,
          msg: `內容超出大小限制，目前上限：${options.clipboardSize}`,
        });
        return;
      }
      console.error('更新剪貼簿失敗', error);
      res.status(500).json({ code: 500, msg: '伺服器錯誤' });
    }
  });

  app.get('/api/v1/history', async (req, res) => {
    if (isAppleMobileClient(req.get('user-agent'), req.get('x-cloudboard-client'))) {
      res.status(403).json({ code: 403, msg: '此用戶端不提供剪貼簿歷史' });
      return;
    }
    const key = queryString(req.query.key);
    if (!key) {
      res.status(400).json({ error: '缺少必要參數 `key`' });
      return;
    }
    try {
      const requested = Number(queryString(req.query.limit));
      const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, options.historyLimit) : Math.min(30, options.historyLimit);
      const items = (await store.history(key)).slice(0, limit);
      res.json({
        code: 200,
        msg: 'success',
        data: items.map((item) => ({
          id: item.id,
          type: item.type,
          content: item.content,
          timestamp: item.timestamp,
          bytes: item.bytes,
        })),
      });
    } catch (error) {
      console.error('讀取剪貼簿歷史失敗', error);
      res.status(500).json({ code: 500, msg: '伺服器錯誤' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, host, () => resolve());
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const boundHost = typeof address === 'object' && address ? address.address : host;

  return {
    host: boundHost,
    port,
    close: () => new Promise<void>((resolve, reject) => {
      io.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}

function broadcast(io: Server, key: string, record: HistoryRecord, sourceId?: string): void {
  const payload = {
    type: record.type,
    content: record.content,
    timestamp: record.timestamp,
    sourceId: sourceId ?? '',
    id: record.id,
  };
  const sender = sourceId ? io.sockets.sockets.get(sourceId) : undefined;
  if (sender) {
    sender.broadcast.to(key).emit('clipboard:sync', payload);
    return;
  }
  io.to(key).emit('clipboard:sync', payload);
}

async function readSyncBody(req: Request, maxBytes: number): Promise<SyncBody> {
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.includes('multipart/form-data')) {
    const fields = await parseMultipart(req, maxBytes);
    return {
      key: fields.key ?? '',
      content: fields.content ?? '',
      type: fields.type || 'text',
      clientId: fields.clientId || fields.sourceId || undefined,
    };
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const clientId = firstString(body.clientId, body.sourceId);
  return {
    key: typeof body.key === 'string' ? body.key : '',
    content: typeof body.content === 'string' ? body.content : '',
    type: typeof body.type === 'string' && body.type ? body.type : 'text',
    ...(clientId ? { clientId } : {}),
  };
}

function parseMultipart(req: IncomingMessage, maxBytes: number): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const parser = Busboy({
      headers: req.headers,
      limits: { fileSize: maxBytes, fieldSize: maxBytes + 1024, files: 1, fields: 12 },
    });
    const fields: Record<string, string> = {};
    let pending = 0;
    let settled = false;
    let tooBig = false;

    const finish = () => {
      if (settled || pending > 0) return;
      settled = true;
      if (tooBig) reject(Object.assign(new Error('too big'), { code: 'TOO_BIG' }));
      else resolve(fields);
    };

    parser.on('field', (name: string, value: string, info: { valueTruncated?: boolean }) => {
      if (info.valueTruncated) tooBig = true;
      fields[name] = value;
    });
    parser.on('file', (_name: string, stream: NodeJS.ReadableStream, info: { filename: string }) => {
      pending += 1;
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => {
        tooBig = true;
      });
      stream.on('error', (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      stream.on('end', () => {
        if (!tooBig && chunks.length > 0) {
          fields.content = Buffer.concat(chunks).toString('base64');
          fields.type = 'image';
          if (info.filename) fields.filename = info.filename;
        }
        pending -= 1;
        finish();
      });
    });
    parser.on('error', (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    parser.on('close', () => finish());
    req.pipe(parser);
  });
}

function normalizeContent(type: string, content: string): string {
  if (type !== 'image') return content;
  const dataUrl = /^data:image\/[a-zA-Z0-9.+-]+;base64,([\s\S]+)$/.exec(content);
  const payload = dataUrl?.[1] ?? content;
  return payload.replace(/\s+/g, '');
}

function queryString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function isPayloadTooLarge(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { type?: string }).type === 'entity.too.large';
}

function isTooBig(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: string }).code === 'TOO_BIG';
}

function generateApiKey(): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const pattern = /^[1-9A-HJ-NP-Za-km-z]{46}$/;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const encoded = encodeBase58(randomBytes(34), alphabet);
    if (pattern.test(encoded)) return encoded;
  }
  return encodeBase58(randomBytes(34), alphabet);
}

function encodeBase58(bytes: Buffer, alphabet: string): string {
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += (digits[i] ?? 0) << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  return `${'1'.repeat(zeros)}${digits.reverse().map((digit) => alphabet[digit] ?? '').join('')}`;
}

export { ALLOWED_TYPES };
