import path from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { ALLOWED_TYPES, loopbackHost, startServer } from './src/server-app';

dotenv.config();

const HELP = `CloudBoard server

只監聽 localhost。對外的 HTTPS 網址由 cloudflared 提供。

用法
  npm start
  cloudflared tunnel --url http://127.0.0.1:3443

選項
  --port             監聽埠，預設 3443
  --data-dir         資料目錄，預設 ./data
  --clipboard-size   單筆大小上限，預設 5MB
  --clipboard-ttl    即時剪貼簿保留秒數，預設 600。iPad 快捷指令只看這一筆
  --clipboard-type   允許的類型，預設 text,html,rtf,image
  --history-ttl      桌面剪貼簿歷史保留秒數，預設 604800（7 天）
  --history-limit    每個 API Key 的歷史筆數，預設 100
  --max-cache-size   每個 API Key 的歷史總容量，預設 100MB
  -h, --help         顯示說明

環境變數可代替選項：PORT、DATA_DIR、CLIPBOARD_SIZE、CLIPBOARD_TTL、
CLIPBOARD_TYPE、HISTORY_TTL、HISTORY_LIMIT、MAX_CACHE_SIZE。
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      'data-dir': { type: 'string' },
      'clipboard-size': { type: 'string' },
      'clipboard-ttl': { type: 'string' },
      'clipboard-type': { type: 'string' },
      'history-ttl': { type: 'string' },
      'history-limit': { type: 'string' },
      'max-cache-size': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const host = loopbackHost('127.0.0.1');
  const port = numberOption(values.port ?? process.env.PORT, 3443);
  const clipboardTypes = (values['clipboard-type'] ?? process.env.CLIPBOARD_TYPE ?? ALLOWED_TYPES.join(','))
    .split(',')
    .map((type) => type.trim())
    .filter(Boolean);

  const running = await startServer({
    host,
    port,
    dataDir: path.resolve(values['data-dir'] ?? process.env.DATA_DIR ?? 'data'),
    clipboardTypes,
    clipboardSize: sizeToBytes(values['clipboard-size'] ?? process.env.CLIPBOARD_SIZE ?? '5MB'),
    clipboardTtl: numberOption(values['clipboard-ttl'] ?? process.env.CLIPBOARD_TTL, 600),
    historyTtl: numberOption(values['history-ttl'] ?? process.env.HISTORY_TTL, 7 * 24 * 60 * 60),
    historyLimit: numberOption(values['history-limit'] ?? process.env.HISTORY_LIMIT, 100),
    maxCacheItems: numberOption(process.env.MAX_CACHE_ITEMS, 100),
    maxCacheBytes: sizeToBytes(values['max-cache-size'] ?? process.env.MAX_CACHE_SIZE ?? '100MB'),
  });

  console.log('CloudBoard server 已啟動');
  console.log(`監聽: http://${running.host}:${running.port}`);
  console.log('cloudflared 轉出的 https 網址後面加上 /api/v1，就是客戶端介面地址。');

  const shutdown = () => {
    running.close().then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function numberOption(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`數字選項不正確: ${value}`);
  }
  return parsed;
}

export function sizeToBytes(size: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i.exec(size.trim());
  if (!match?.[1]) throw new Error(`無法解析大小: ${size}`);
  const value = Number(match[1]);
  const unit = (match[2] ?? 'B').toUpperCase();
  const multiplier: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
  return Math.floor(value * (multiplier[unit] ?? 1));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
