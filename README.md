# CloudBoard server

相容 [CloudBoard](https://github.com/journey-ad/cloudboard) 桌面客戶端與 iPad 快捷指令的剪貼簿同步服務。程式只有命令列，沒有網頁後台。

服務只聽 `http://127.0.0.1:3443`。憑證和對外連線交給 cloudflared，客戶端填它提供的 https 網址加上 `/api/v1`。

## 本機 Windows

需要 Node.js 20 以上。

```powershell
cd cloudboard-server
npm install
copy .env.example .env
npm start
```

另一個終端機：

```powershell
cloudflared tunnel --url http://127.0.0.1:3443
```

cloudflared 印出的 `https://xxxx.trycloudflare.com/api/v1` 就是 CloudBoard 的介面地址。

協定檢查：

```powershell
npm run verify
```

## Debian

```bash
sudo apt update
sudo apt install -y nodejs npm
sudo mkdir -p /opt/cloudboard-server /var/lib/cloudboard-server
sudo useradd --system --home /var/lib/cloudboard-server --shell /usr/sbin/nologin cloudboard
sudo cp -a . /opt/cloudboard-server
sudo chown -R cloudboard:cloudboard /opt/cloudboard-server /var/lib/cloudboard-server
cd /opt/cloudboard-server
sudo -u cloudboard npm ci
sudo cp deploy/cloudboard-server.service /etc/systemd/system/cloudboard-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now cloudboard-server
```

cloudflared 的來源位址設為 `http://127.0.0.1:3443`。

## 客戶端行為

- `GET /api/v1/config`、`GET /api/v1/key-gen`、`POST /api/v1/sync`、`GET /api/v1/sync?key=` 與 Socket.IO 的 `auth`、`clipboard:sync` 跟原版相同。
- 圖片以 `type: image` 傳送，內容是 base64。也接受 `multipart/form-data` 的圖片檔，以及 `data:image/...;base64,` 開頭的內容。
- 桌面客戶端可讀 `GET /api/v1/history?key=`。iPhone、iPad、Shortcuts、Scriptable 的請求會得到 403，快捷指令繼續只用最新一筆，不會拿到歷史清單。
- 即時剪貼簿預設 10 分鐘後不再出現在 `GET /sync`。歷史預設再保留 7 天，只給桌面使用。
