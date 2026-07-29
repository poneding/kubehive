# KubeHive

KubeHive 是一个使用 **Rust、Tauri 2、kube-rs、React** 构建的多集群 Kubernetes 桌面客户端。原型 UI 已接入真实 Kubernetes 数据面：桌面应用会读取本机 kubeconfig，按 context 建立独立 kube-rs client，并通过类型化 Tauri commands、list/watch 与受控写操作驱动界面。

浏览器模式仍保留演示数据，便于不启动 Tauri 时进行 UI 开发；只有原生 Tauri 模式会接触 kubeconfig 和集群凭据。

## 已实现的真实集成

- 读取默认 `KUBECONFIG` / `~/.kube/config`，发现所有 context，并探测 API Server 版本与节点状态。
- 导入 kubeconfig 文件、粘贴 kubeconfig、手动 API Server + Bearer Token；导入文件以用户私有权限保存在应用配置目录。
- kube-rs API discovery：根据集群实际 served API 选择资源版本，并动态浏览 CRD 与自定义资源，不需要为新 CRD 发布前端版本。
- 所有 Kubernetes 资源页面使用统一 DynamicObject list/get contract；普通列表使用 compact payload，namespace、搜索、可排序虚拟列表、自定义列和资源关联继续由 UI 复用。
- list 按 500 条使用 Kubernetes `limit/continue` 构建一致快照，再从对应 `resourceVersion` 启动 watch；watch 事件按资源键合并并批量推送，切换页面或关闭 auto-refresh 会取消任务。
- 真实集群 Overview：节点、Pods、工作负载健康、Events、PV 容量，以及可用时的 `metrics.k8s.io` CPU/内存数据。
- Kind 专属资源详情 Sheet：Pod、Deployment、Service、Ingress、存储、RBAC、Autoscaler、Webhook、CRD/自定义资源等分别展示自己的状态与配置字段，并解析可点击的父资源、子资源和引用关系；Deployment 可直接下钻 ReplicaSet 与其管理的 Pod。
- 详情与操作：获取实时 YAML、Server-Side Apply、单个/批量删除、scale、workload rollout restart，以及遵守 PodDisruptionBudget 的单个/批量 Pod eviction；批量请求限制并发并逐项报告失败。
- 排障：Pod/工作负载日志、容器 exec 命令、基于 kube-rs WebSocket 的本地 TCP port-forward。
- Helm chart 目录从内置可信仓库的真实 `index.yaml` 获取并缓存；release 通过集群内 `owner=helm` Secrets 动态发现；Secret 数据在传给 WebView 前默认遮罩。
- 原生断开/重连、移除已导入集群，以及 Kubernetes 客户端代理设置。
- 无集群、API 不支持、RBAC 禁止、metrics API 缺失等状态均显示为显式错误或降级状态，不再伪造成功数据。

## 运行

安装依赖并运行浏览器 UI（演示数据）：

```bash
npm install
npm run dev
```

运行连接真实 kubeconfig 的桌面应用：

```bash
npm run tauri dev
```

## 验证

```bash
npm run build
npm run verify:ui                 # 需要 npm run dev 运行在 1420 端口
npm run verify:resource-details   # 验证 Kind 专属面板与 Deployment → Pod 等关系导航
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --no-bundle
```

若要使用当前 kubeconfig 对真实 API Server 执行只读端到端测试：

```bash
KUBEHIVE_LIVE_TEST=1 cargo test \
  --manifest-path src-tauri/Cargo.toml \
  live_ -- --nocapture
```

这些测试会通过 kube-rs 连接 `current-context`，验证 API Server version、Pods 归一化列表、API discovery、Overview 聚合，执行一次 ConfigMap Server-Side Apply **dry-run** 后确认对象未持久化，并拉取官方 Helm repository indexes；不会改变集群资源。

## 安全与运行边界

- kubeconfig、Bearer Token 和 exec credential 只在 Rust 原生进程中处理，不写入 WebView localStorage。
- Tauri command 不拼接或启动 shell 字符串；容器 exec 接收明确的 argv 数组。
- Secret 的 `data` 在 Rust 序列化边界默认替换为遮罩值，`managedFields` 不发送到资源表格。
- 写操作使用 Kubernetes API Server 权限与校验；UI 同时根据 discovery verbs 禁用明显不可用的动作，最终授权仍以 RBAC/API 错误为准。
- 浏览器开发模式无法连接集群、exec 或 port-forward，会明确保持演示行为。
- Helm chart 浏览使用 ingress-nginx、Jetstack、Prometheus Community、Argo 的官方仓库；Chart 安装/升级与应用自动更新仍需要签名发布源，不会静默调用本机 `helm`/`kubectl` 二进制。

实现矩阵与数据流见 [docs/implementation-status.md](docs/implementation-status.md)；完整资源关系设计见 [docs/resource-relationship-matrix.md](docs/resource-relationship-matrix.md)；产品调研与完整范围建议见 [docs/lens-product-research.md](docs/lens-product-research.md)。
