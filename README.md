# CloudBoard server

相容 [CloudBoard](https://github.com/journey-ad/cloudboard) 桌面客戶端與 iPad 快捷指令的剪貼簿同步服務。程式只有命令列，沒有網頁後台。

服務只聽 `http://127.0.0.1:3443`。HTTPS 與對外連線用你現有的 cloudflared，不要在這台機器上另開憑證或對外埠。客戶端介面地址是 cloudflared 的 https 網址加上 `/api/v1`。

## 放到 Debian

在伺服器上 clone 到 `/opt/cloudboard-server`。systemd 服務就是從這個路徑啟動。

需要 Node.js 20 以上。先看 `node -v`。Debian 內建的 `nodejs` 若低於 20，先裝 Node.js 22：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
```

然後：

```bash
sudo useradd --system --create-home --home-dir /var/lib/cloudboard-server --shell /usr/sbin/nologin cloudboard
sudo mkdir -p /var/lib/cloudboard-server
sudo git clone https://github.com/SpencerFang0617/cloudboard-server.git /opt/cloudboard-server
sudo chown -R cloudboard:cloudboard /opt/cloudboard-server /var/lib/cloudboard-server
cd /opt/cloudboard-server
sudo -u cloudboard npm ci
sudo cp deploy/cloudboard-server.service /etc/systemd/system/cloudboard-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now cloudboard-server
```

`npm ci` 結束時可能印出漏洞筆數，以及 npm 10 可升級到 12 的通知。不要在這台機器上執行 `npm install -g npm@12`，也不要在伺服器上跑 `npm audit fix`。鎖定檔已修掉先前稽核的 7 項（2 低、1 中、4 高），都是阻斷服務，沒有遠端執行：`ws` 8.21.3、`engine.io` 6.6.11、`socket.io-parser` 4.2.7、`socket.io-adapter` 2.5.8、`qs` 6.16.0、`body-parser` 2.3.0、`esbuild` 0.28.2。之後若 `npm audit` 再出現漏洞，在開發機更新 `package-lock.json` 並推上；伺服器只做下面的 `git pull` 與 `npm ci`。

不用在伺服器上建立 `.env`。連接埠與資料目錄已寫在服務檔裡：聽 `127.0.0.1:3443`，資料放在 `/var/lib/cloudboard-server`。

在現有的 cloudflared 設定裡，把主機名指到這個位址：

```yaml
ingress:
  - hostname: 你的網域
    service: http://127.0.0.1:3443
  - service: http_status:404
```

改完後重載 cloudflared。CloudBoard 介面地址填 `https://你的網域/api/v1`。

之後更新：

```bash
cd /opt/cloudboard-server
sudo git pull
sudo -u cloudboard npm ci
sudo systemctl restart cloudboard-server
```

## 本機 Windows

只用於開發與 `npm run verify`。正式連線仍走 Debian 上的 cloudflared。

```powershell
cd cloudboard-server
npm install
copy .env.example .env
npm start
npm run verify
```

## 客戶端行為

- `GET /api/v1/config`、`GET /api/v1/key-gen`、`POST /api/v1/sync`、`GET /api/v1/sync?key=` 與 Socket.IO 的 `auth`、`clipboard:sync` 跟原版相同。
- 圖片以 `type: image` 傳送，內容是 base64。也接受 `multipart/form-data` 的圖片檔，以及 `data:image/...;base64,` 開頭的內容。
- 桌面客戶端可讀 `GET /api/v1/history?key=`。iPhone、iPad、Shortcuts、Scriptable 的請求會得到 403，快捷指令繼續只用最新一筆。
- 即時剪貼簿預設 10 分鐘後不再出現在 `GET /sync`。歷史預設再保留 7 天，只給桌面使用。
