import { mkdtemp } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { removeStore } from '../src/store';
import { loopbackHost, startServer, type RunningServer } from '../src/server-app';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  assertRejected(() => loopbackHost('0.0.0.0'), 'localhost');
  assertRejected(() => loopbackHost('140.112.250.142'), 'localhost');
  assert(loopbackHost('localhost') === '127.0.0.1', 'localhost 應綁到 127.0.0.1');

  const dataDir = await mkdtemp(path.join(tmpdir(), 'cloudboard-'));
  let running: RunningServer | undefined;
  const sockets: Socket[] = [];
  try {
    running = await startServer({
      host: 'localhost',
      port: 0,
      dataDir,
      clipboardTypes: ['text', 'html', 'rtf', 'image'],
      clipboardSize: 2048,
      clipboardTtl: 600,
      historyTtl: 86400,
      historyLimit: 10,
      maxCacheItems: 10,
      maxCacheBytes: 1024 * 1024,
    });

    assert(running.host === '127.0.0.1', `應只綁定 127.0.0.1，實際 ${running.host}`);
    const base = `http://127.0.0.1:${running.port}/api/v1`;
    const config = await getJson(`${base}/config`);
    assert(Array.isArray(config.clipboard_type) && config.clipboard_type.includes('image'), 'config 應包含 image');

    const keyBody = await getJson(`${base}/key-gen`);
    const key = String(keyBody.key);
    assert(/^[1-9A-HJ-NP-Za-km-z]{46}$/.test(key), `API Key 格式不正確: ${key}`);

    const sender = await connect(`http://127.0.0.1:${running.port}`);
    const receiver = await connect(`http://127.0.0.1:${running.port}`);
    sockets.push(sender, receiver);
    sender.emit('auth', key);
    receiver.emit('auth', key);
    await delay(100);

    let senderSawOwnUpdate = false;
    sender.on('clipboard:sync', () => {
      senderSawOwnUpdate = true;
    });
    const incoming = waitFor<SyncPacket>(receiver, 'clipboard:sync');

    const text = await postJson(`${base}/sync`, {
      key,
      type: 'text',
      content: 'hello-desktop',
      clientId: sender.id,
    });
    assert(text.code === 200, `文字同步失敗 ${JSON.stringify(text)}`);
    const packet = await incoming;
    assert(packet.type === 'text' && packet.content === 'hello-desktop', '接收端沒有拿到文字');
    assert(packet.sourceId === sender.id, 'sourceId 應為送出端 socket id');
    await delay(200);
    assert(!senderSawOwnUpdate, '送出端不應收到自己的同步');

    const image = await postJson(`${base}/sync`, {
      key,
      type: 'image',
      content: `data:image/png;base64,${PNG}`,
      clientId: sender.id,
    });
    assert(image.code === 200, `圖片同步失敗 ${JSON.stringify(image)}`);

    const latest = await getJson(`${base}/sync?key=${encodeURIComponent(key)}`);
    assert(latest.data?.type === 'image' && latest.data.content === PNG, 'GET /sync 應回傳去掉 data URL 的圖片');

    const form = await fetch(`${base}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key, type: 'text', content: 'from-shortcut' }),
    });
    assert(form.ok, '表單同步失敗');

    const multipart = new FormData();
    multipart.set('key', key);
    multipart.set('file', new Blob([Buffer.from(PNG, 'base64')]), 'dot.png');
    const fileResponse = await fetch(`${base}/sync`, { method: 'POST', body: multipart });
    const fileBody = await fileResponse.json() as { code?: number; msg?: string };
    assert(fileBody.code === 200, `圖片檔上傳失敗 ${JSON.stringify(fileBody)}`);

    const historyResponse = await fetch(`${base}/history?key=${encodeURIComponent(key)}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    const history = await historyResponse.json() as { code?: number; data?: Array<{ type: string; content: string }> };
    assert(history.code === 200 && Array.isArray(history.data), '桌面應可讀取歷史');
    const contents = history.data.map((item) => item.content);
    assert(contents.includes('from-shortcut'), '歷史應包含快捷指令文字');
    assert(contents.includes(PNG), '歷史應包含圖片');
    assert(history.data[0]?.type === 'image', '歷史應以最新項目排在前面');

    const ipad = await fetch(`${base}/history?key=${encodeURIComponent(key)}`, {
      headers: {
        'user-agent': 'Shortcuts/1500 CFNetwork/1400 Darwin/22.0.0',
        'x-cloudboard-client': 'ios',
      },
    });
    const ipadBody = await ipad.text();
    assert(ipad.status === 403, `iPad 歷史應被拒絕，實際 ${ipad.status}`);
    assert(!ipadBody.includes('from-shortcut') && !ipadBody.includes(PNG.slice(0, 24)), 'iPad 回應不應包含歷史內容');

    const ipadLatest = await getJson(`${base}/sync?key=${encodeURIComponent(key)}`, {
      'user-agent': 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
    });
    assert(ipadLatest.data?.type === 'image', 'iPad 仍應能取得最新一筆剪貼簿');

    const rejected = await postJson(`${base}/sync`, { key, type: 'files', content: 'nope' });
    assert(rejected.code === -2, '不支援的類型應回 -2');

    const oversized = await postJson(`${base}/sync`, { key, type: 'text', content: 'x'.repeat(3000) });
    assert(oversized.code === -3, '超過大小應回 -3');

    const health = await getJson(`http://127.0.0.1:${running.port}/healthz`);
    assert(health.status === 'ok', 'localhost 健康檢查失敗');
    const lan = lanAddress();
    if (lan) {
      const reachable = await fetch(`http://${lan}:${running.port}/healthz`, { signal: AbortSignal.timeout(1500) })
        .then((response) => response.ok, () => false);
      assert(!reachable, '區網位址不應連到服務');
    }

    console.log(`驗證通過 ${base}`);
  } finally {
    for (const socket of sockets) socket.close();
    await running?.close();
    await removeStore(dataDir);
  }
}

function assertRejected(run: () => void, needle: string): void {
  try {
    run();
  } catch (error) {
    assert(error instanceof Error && error.message.includes(needle), `預期錯誤包含 ${needle}`);
    return;
  }
  throw new Error(`預期拒絕包含 ${needle}`);
}

async function getJson(url: string, headers?: Record<string, string>): Promise<Record<string, any>> {
  const response = await fetch(url, { headers });
  return response.json() as Promise<Record<string, any>>;
}

async function postJson(url: string, body: unknown): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<Record<string, any>>;
}

function connect(url: string): Promise<Socket> {
  const socket = io(url, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 連線逾時')), 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitFor<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${event} 逾時`)), 4000);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function lanAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SyncPacket {
  type: string;
  content: string;
  sourceId: string;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
