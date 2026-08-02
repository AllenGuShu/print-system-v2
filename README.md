# 🖨️ 印刷下單系統 v2.0 — 完整部署說明（含檔案上傳）

這個系統可以：老師線上填單、上傳封面/內頁檔到 Google Drive、自動算價、自動記錄到 Google Sheet、寄 email 通知你和印刷負責人。

---

## 需要申請的帳號（共4個，都免費）

1. **Google 帳號**（你應該已經有）
2. **GitHub 帳號** — 放程式碼
3. **Vercel 帳號** — 讓網頁上線（用 GitHub 登入即可，不用另外申請）
4. **Resend 帳號** — 用來寄 email 通知（免費額度每天100封，夠用）

---

## 步驟一：建立 Google Sheet

1. [sheets.google.com](https://sheets.google.com) → 新增空白試算表
2. 命名「印刷下單系統 v2」
3. 第一個工作表改名為 **`訂單記錄`**
4. A1 開始貼上這行標題：
```
訂單編號	時間戳記	客戶名	教室	授課教師	取件時間	檔案名稱	印刷類型	數量	頁數	實際張數	紙單價	單本金額	總金額	封面檔連結	內頁檔連結	備註
```
5. **記下網址中的 Sheet ID**：
   `https://docs.google.com/spreadsheets/d/`**`這一段`**`/edit`

---

## 步驟二：建立 Google Drive 資料夾

1. [drive.google.com](https://drive.google.com) → 新增資料夾，命名「印刷訂單檔案」
2. 打開這個資料夾，**記下網址中的資料夾 ID**：
   `https://drive.google.com/drive/folders/`**`這一段`**

---

## 步驟三：建立 Google Service Account（關鍵步驟）

這是讓網頁能夠**自動**寫入 Sheet 和上傳檔案到 Drive 的關鍵，不需要每次登入。

1. [console.cloud.google.com](https://console.cloud.google.com) → 新建專案，命名「PrintSystem」
2. 左側「**API 和服務**」→「**已啟用的 API 和服務**」→「**啟用 API**」
3. 分別搜尋並啟用：
   - **Google Sheets API**
   - **Google Drive API**
4. 左側「**憑證**」→「**建立憑證**」→「**服務帳戶**」
5. 名稱填 `print-system-bot` → 建立並繼續 → 完成
6. 點剛建立的服務帳戶 → 「**金鑰**」分頁 → 「**新增金鑰**」→「**建立新金鑰**」→ 選 **JSON** → 下載
7. **這個下載的 JSON 檔案內容，之後要整個貼到 Vercel 環境變數**

8. **重要：把服務帳戶加入權限**
   - 複製服務帳戶的 email（在服務帳戶頁面，格式像 `xxx@xxx.iam.gserviceaccount.com`）
   - 回到 **Google Sheet** → 右上角「共用」→ 貼上這個 email → 給「編輯者」權限
   - 回到 **Google Drive 資料夾** → 右鍵「共用」→ 貼上同一個 email → 給「編輯者」權限

---

## 步驟四：申請 Resend（寄 email 用）

1. [resend.com](https://resend.com) → 註冊帳號（用 email 或 GitHub 登入）
2. 登入後左側「**API Keys**」→「**Create API Key**」
3. 命名任意 → 建立 → **複製這組 API Key**（只會顯示一次，先存起來）

> 免費版寄信會顯示寄件者是 `onboarding@resend.dev`，收件人看得到是系統自動寄送，這不影響使用。

---

## 步驟五：上傳程式碼到 GitHub

1. [github.com](https://github.com) → 新建 Repository，命名 `print-system-v2` → Public → Create
2. 把我給你的整個資料夾內容上傳：
   - **Add file** → **Upload files**
   - 把資料夾內所有檔案（含子資料夾 api/、lib/、public/）拖曳上傳
   - Commit changes

**確認檔案結構長這樣：**
```
print-system-v2/
├── api/
│   ├── auth.js
│   ├── order.js
│   └── orders.js
├── lib/
│   └── pricing.js
├── public/
│   ├── index.html
│   └── admin.html
├── package.json
└── vercel.json
```

---

## 步驟六：部署到 Vercel

1. [vercel.com](https://vercel.com) → 用 GitHub 登入
2. **Add New Project** → 選 `print-system-v2` → **Deploy**（第一次會失敗沒關係）
3. 部署完成後 → **Settings** → **Environment Variables**

新增以下環境變數：

| 變數名稱 | 值 |
|---------|-----|
| `GOOGLE_SHEET_ID` | 步驟一記下的 Sheet ID |
| `GOOGLE_DRIVE_FOLDER_ID` | 步驟二記下的資料夾 ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 步驟三下載的整個 JSON 檔內容（全部貼上） |
| `RESEND_API_KEY` | 步驟四的 API Key |
| `NOTIFY_EMAILS` | 你和印刷負責人的 email，用逗號分隔，例如 `a@gmail.com,b@gmail.com` |
| `ADMIN_PASSWORD` | 你自訂的後台密碼 |
| `ADMIN_TOKEN` | 隨便一串英數字，例如 `tk_9x8k2m` |

4. 設定完 → **Deployments** → 最新的部署 → 右上角 **⋯** → **Redeploy**

---

## 步驟七：測試

部署完成拿到網址，例如 `https://print-system-v2-xxx.vercel.app`

1. 打開該網址，填一筆測試訂單（含上傳一個測試檔案）→ 送出
2. 檢查：
   - Google Sheet 是否有新增一行資料？
   - Google Drive 資料夾是否有新檔案？
   - email 有沒有收到通知？
3. 打開 `/admin`，輸入密碼，確認能看到剛才的訂單

---

## 日常使用

- **老師下單**：`https://你的網址.vercel.app/`
- **你的後台**：`https://你的網址.vercel.app/admin`

---

## 常見問題排除

**送出後顯示「送出失敗」？**
→ 到 Vercel → Deployments → 點最新部署 → **Functions** → 找 `api/order` 的 log，把錯誤訊息貼給我

**檔案上傳但 Drive 沒看到？**
→ 檢查步驟三第8點，服務帳戶 email 是否已加入 Drive 資料夾的共用權限

**沒收到 email？**
→ 檢查 Resend API Key 是否正確，`NOTIFY_EMAILS` 格式是否為逗號分隔

**後台登入不了？**
→ 確認 Vercel 環境變數 `ADMIN_PASSWORD` 設定正確，且已 Redeploy

---

有任何步驟卡住，把錯誤截圖或訊息傳給我，我幫你排除！
