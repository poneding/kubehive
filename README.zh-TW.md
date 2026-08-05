<p align="center">
  <img src="src/assets/kubehive-logo.svg" width="120" alt="KubeHive">
</p>

<h1 align="center">KubeHive</h1>

<p align="center">
  面向多 Kubernetes 叢集維運的桌面工作區，搭載原生 Rust 資料平面。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <strong>繁體中文</strong>
</p>

KubeHive 是一個多叢集 Kubernetes 桌面用戶端，使用 **React、TypeScript、Tauri 2、Rust 與 kube-rs** 建構。原生應用程式讀取本機叢集設定，為每個 context 建立隔離用戶端，並透過型別化 Tauri command 暴露 Kubernetes 操作。瀏覽器建構維持無憑證狀態，且不會合成叢集或 Kubernetes 資源資料。

## 架構

![KubeHive 架構圖](docs/images/kubehive-architecture.png)

此圖由 Archify 產生。可編輯原始檔位於 [`docs/architecture/kubehive.architecture.json`](docs/architecture/kubehive.architecture.json)；可在本機開啟 [`docs/architecture/kubehive-architecture.html`](docs/architecture/kubehive-architecture.html)，使用互動式主題與匯出控制項。

## 功能

- **叢集連線管理** — 從預設 kubeconfig 探索 context，匯入 kubeconfig 檔案或 YAML，或手動填寫 API Server 與 Bearer Token。匯入設定會由原生用戶端驗證。
- **動態 Kubernetes 導覽** — 探索伺服器提供的 API，瀏覽內建資源與 CRD，選取 namespace，搜尋和排序資源表格，並設定可見欄位。
- **即時資源視圖** — 建立一致的分頁 list 快照，從其 `resourceVersion` 啟動 Kubernetes watch；watch 沒有權限或中斷時會回退至輪詢。
- **資源檢查與受控寫入** — 開啟 Kind 專屬詳細資料與關聯關係，檢視 YAML，以 Server-Side Apply 套用資訊清單，單筆或批次刪除資源，縮放或重新啟動工作負載，並在允許時驅逐 Pod。
- **疑難排解工作流程** — 檢視日誌，執行容器 exec 工作階段，使用本機或容器終端機，瀏覽容器檔案，並為 Pod 或 Service 依連接埠建立 TCP 轉送。
- **叢集可見性** — 彙整叢集總覽中的節點、工作負載健康度、事件、持久磁碟區容量，以及可選 metrics-server CPU/記憶體資料。
- **Helm 探索** — 從內建可信任儲存庫取得並快取 Chart 索引，並從叢集內 Helm storage Secret 探索 Release。
- **桌面整合** — 持久化視窗狀態與 UI 偏好，提供系統匣選單，透過原生執行階段開啟本機檔案/URL，並在設定後支援已簽署的應用程式更新。

## 執行模式

| 模式 | 資料來源 | 叢集存取 |
| --- | --- | --- |
| 瀏覽器 UI（`npm run dev`） | 無叢集資料 | 僅提供前端外殼，無法存取 kubeconfig、Kubernetes API、exec、檔案或 port-forward 功能。 |
| Tauri 桌面應用程式（`npm run tauri dev`） | 原生 Rust 資料平面 | 讀取本機 kubeconfig 或匯入設定，透過 `kube-rs` 連線；受 Kubernetes API 可用性與 RBAC 限制。 |

## 快速開始

### 必要條件

- **Node.js 22** 與 npm。
- 目前穩定版 **Rust** 工具鏈。
- 執行或封裝桌面應用程式時所需的 [Tauri 2 平台必要條件](https://v2.tauri.app/start/prerequisites/)。

### 執行瀏覽器 UI

此方式會啟動無憑證的 Vite 前端外殼。叢集與資源資料僅在原生桌面應用程式中可用：

```bash
npm install
npm run dev
```

開啟 Vite 輸出的 URL（Tauri 設定使用 `http://localhost:1420`）。

### 執行原生桌面應用程式

```bash
npm install
npm run tauri dev
```

在桌面模式中，可從 kubeconfig 檔案、貼上的 kubeconfig YAML 或手動 API Server/Token 設定新增叢集。所有即時行為仍受目標叢集 API 能力與 RBAC 權限限制。

## 驗證

執行專案與 CI 使用的檢查：

```bash
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

瀏覽器安全的縮放檢查需要在連接埠 `1420`（或 `KUBEHIVE_TEST_URL`）執行開發伺服器：

```bash
npm run dev
# 在另一個終端機執行：
npm run verify:zoom
```

可選的真實環境 smoke test 使用目前 kubeconfig，且只會執行 Server-Side Apply **dry run**：

```bash
KUBEHIVE_LIVE_TEST=1 cargo test \
  --manifest-path src-tauri/Cargo.toml \
  live_ -- --nocapture
```

## 截圖

截圖使用穩定且語義化的路徑。取得新版截圖時，在**相同路徑**取代對應檔案即可；README 連結不必變更。

### 叢集首頁

![淺色主題下的叢集首頁](docs/images/cluster-home-light.png)
![深色主題下的叢集首頁](docs/images/cluster-home-dark.png)

### 資源工作區

![叢集總覽](docs/images/cluster-overview.png)
![Pod 資源清單](docs/images/resource-list-pods.png)

### 資源詳細資料與工作階段

![Pod 資源詳細資料](docs/images/resource-details-pod.png)
![容器終端機](docs/images/container-terminal.png)
![容器日誌](docs/images/container-logs.png)
![容器檔案瀏覽](docs/images/container-file-browser.png)

## 安全性與執行邊界

- kubeconfig、Bearer Token 與 exec 憑證由原生 Rust 行程處理，而非 WebView `localStorage`。
- Secret 值在資源資料進入 WebView 前會被遮罩；資源清單也會省略部分較大或敏感欄位。
- 寫入操作使用 Kubernetes API 授權與驗證。UI 可能依 discovery verbs 顯示可用操作，但 API Server 與 RBAC 原則才是最終依據。
- watch 失敗與 API 無法使用會顯示明確錯誤或受控的輪詢回退；用戶端不會偽造即時成功狀態。
- 內建 Helm 目錄會讀取遠端索引，不會靜默呼叫本機安裝的 `helm` 或 `kubectl` 二進位檔。

## 更多文件

- [發布簽署與發布流程](docs/release-signing.md)
