<p align="center">
  <img src="src/assets/kubehive-logo.svg" width="120" alt="KubeHive">
</p>

<h1 align="center">KubeHive</h1>

<p align="center">
  面向多 Kubernetes 集群运维的桌面工作区，搭载原生 Rust 数据平面。
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong> · <a href="README.zh-TW.md">繁體中文</a>
</p>

KubeHive 是一个多集群 Kubernetes 桌面客户端，使用 **React、TypeScript、Tauri 2、Rust 和 kube-rs** 构建。原生应用读取本地集群配置，为每个 context 创建隔离客户端，并通过类型化 Tauri command 暴露 Kubernetes 操作。浏览器构建保持无凭据状态，并且不会合成集群或 Kubernetes 资源数据。

## 架构

![KubeHive 架构图](docs/images/kubehive-architecture.png)

该图由 Archify 生成。可编辑源文件位于 [`docs/architecture/kubehive.architecture.json`](docs/architecture/kubehive.architecture.json)；可在本地打开 [`docs/architecture/kubehive-architecture.html`](docs/architecture/kubehive-architecture.html)，使用交互式主题和导出控件。

## 功能

- **集群连接管理** — 从默认 kubeconfig 发现 context，导入 kubeconfig 文件或 YAML，或手动填写 API Server 和 Bearer Token。导入配置会由原生客户端验证。
- **动态 Kubernetes 导航** — 发现服务端 API，浏览内置资源与 CRD，选择 namespace，搜索和排序资源表格，并配置可见列。
- **实时资源视图** — 建立一致的分页 list 快照，从其 `resourceVersion` 启动 Kubernetes watch；watch 无权限或中断时回退到轮询。
- **资源检查与受控写操作** — 打开 Kind 专属详情和关联关系，查看 YAML，以 Server-Side Apply 应用清单，单个或批量删除资源，伸缩或重启工作负载，并在允许时驱逐 Pod。
- **排障工作流** — 查看日志，运行容器 exec 会话，使用本地、容器或节点终端（通过短生命周期特权 helper Pod 进入宿主机 shell），浏览容器文件，并为 Pod 或 Service 按端口建立 TCP 转发。
- **集群可见性** — 聚合集群概览中的节点、工作负载健康度、事件、持久卷容量，以及可选 metrics-server CPU/内存数据。
- **Helm 发现** — 从内置可信仓库获取并缓存 Chart 索引，并从集群内 Helm storage Secret 发现 Release。
- **桌面集成** — 持久化窗口状态和 UI 偏好，提供托盘菜单，通过原生运行时打开本地文件/URL，并在配置后支持签名应用更新。

## 运行模式

| 模式 | 数据来源 | 集群访问 |
| --- | --- | --- |
| 浏览器 UI（`npm run dev`） | 无集群数据 | 仅提供前端外壳，不能访问 kubeconfig、Kubernetes API、exec、文件或 port-forward 功能。 |
| Tauri 桌面应用（`npm run tauri dev`） | 原生 Rust 数据平面 | 读取本地 kubeconfig 或导入配置，通过 `kube-rs` 连接；受 Kubernetes API 可用性和 RBAC 约束。 |

## 快速开始

### 前置条件

- **Node.js 22** 和 npm。
- 当前稳定版 **Rust** 工具链。
- 运行或打包桌面应用时所需的 [Tauri 2 平台前置条件](https://v2.tauri.app/start/prerequisites/)。

### 运行浏览器 UI

该方式会启动无凭据的 Vite 前端外壳。集群和资源数据仅在原生桌面应用中可用：

```bash
npm install
npm run dev
```

打开 Vite 输出的 URL（Tauri 配置使用 `http://localhost:1420`）。

### 运行原生桌面应用

```bash
npm install
npm run tauri dev
```

在桌面模式中，可从 kubeconfig 文件、粘贴的 kubeconfig YAML 或手动 API Server/Token 配置添加集群。所有实时行为仍受目标集群 API 能力和 RBAC 权限限制。

## 验证

运行项目和 CI 使用的检查：

```bash
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

浏览器安全的缩放检查需要在端口 `1420`（或 `KUBEHIVE_TEST_URL`）运行开发服务器：

```bash
npm run dev
# 在另一个终端运行：
npm run verify:zoom
```

可选的真实环境 smoke test 使用当前 kubeconfig，且只执行 Server-Side Apply **dry run**：

```bash
KUBEHIVE_LIVE_TEST=1 cargo test \
  --manifest-path src-tauri/Cargo.toml \
  live_ -- --nocapture
```

## 截图

截图使用稳定且语义化的路径。获得新版截图时，在**相同路径**替换对应文件即可；README 链接无需改变。

### 集群首页

![浅色主题下的集群首页](docs/images/cluster-home-light.png)
![深色主题下的集群首页](docs/images/cluster-home-dark.png)

### 资源工作区

![集群概览](docs/images/cluster-overview.png)
![Pod 资源列表](docs/images/resource-list-pods.png)

### 资源详情与会话

![Pod 资源详情](docs/images/resource-details-pod.png)
![容器终端](docs/images/container-terminal.png)
![容器日志](docs/images/container-logs.png)
![容器文件浏览](docs/images/container-file-browser.png)

## 安全与运行边界

- kubeconfig、Bearer Token 和 exec 凭据由原生 Rust 进程处理，而非 WebView `localStorage`。
- Secret 值在资源数据进入 WebView 前会被遮罩；资源列表还会省略部分较大或敏感字段。
- 写操作使用 Kubernetes API 授权和校验。UI 可能依据 discovery verbs 反映可用操作，但 API Server 和 RBAC 策略才是最终依据。
- watch 失败和 API 不可用会显示明确错误或受控的轮询回退；客户端不会伪造实时成功状态。
- 内置 Helm 目录会读取远程索引，不会静默调用本机安装的 `helm` 或 `kubectl` 二进制文件。

## 更多文档

- [发布签名与发布流程](docs/release-signing.md)
