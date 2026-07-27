# KubeHive

KubeHive 是一个面向多集群 Kubernetes 运维的桌面 UI 原型。技术栈为 Rust、Tauri 2、kube-rs、React、Tailwind CSS，并以 shadcn/ui 的组合式组件约定组织基础控件。

## 运行

```bash
npm install
npm run dev
```

浏览器访问 `http://localhost:1420`。运行桌面窗口：

```bash
npm run tauri dev
```

生产构建与验证：

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --no-bundle
```

## 原型交互

- 左侧集群轨道切换四个演示集群，状态与概览同步变化。
- 资源导航、namespace 下拉和资源搜索可过滤工作负载。
- 点击告警工作负载或表格行打开详情抽屉，可切换 Overview、YAML、Events。
- 点击顶部搜索或按 `Cmd/Ctrl+K` 打开命令面板；`Esc` 关闭浮层。
- 窄屏下资源导航变成可收起的侧栏，详情以覆盖层显示。

产品调研、功能矩阵和 kube-rs 架构建议见 [docs/lens-product-research.md](docs/lens-product-research.md)。

## 边界

这是用于验证产品信息架构的 UI 原型。界面数据来自 `src/data.ts`；Rust 端已经配置 kube-rs/Tokio 和 Tauri command 边界，但尚未读取本机 kubeconfig 或连接实际集群。
