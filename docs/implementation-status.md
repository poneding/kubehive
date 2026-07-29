# KubeHive 真实数据面实现矩阵

本文记录 UI 功能点与 Rust/kube-rs 实现的对应关系。浏览器模式使用演示数据；下表的“真实实现”均指 Tauri 原生模式。

| UI 功能点 | Rust / kube-rs 实现 | 数据与安全行为 |
|---|---|---|
| 集群轨道、context 切换 | `ClusterRegistry` 从默认 kubeconfig 与已导入配置建立 context registry；client 按 cluster ID 缓存 | 凭据不进入 WebView；断开会拒绝后续 client 请求，重连重建 client |
| 添加/移除集群 | `import_clusters`、`remove_cluster` | file/paste/manual 均先由 kube-rs 解析并实际连接验证；导入记录 Unix 权限 0600 |
| 集群 Overview | `overview::cluster_overview` | 并发读取 Nodes、Pods、Events、Deployments、StatefulSets、DaemonSets、PV；metrics API 可选降级 |
| Namespace 选择 | 从真实 Namespace API 构建选项 | cluster-scoped 资源不发送 namespace |
| 资源导航 | `discover_resources` | 使用集群 preferred API resource/version；已移除 API 返回明确不可用状态 |
| 资源列表、搜索、排序、虚拟滚动、列 | `list_resources` + React table contract | Kubernetes list 按 500 条分块；普通列表使用 compact payload，去除大 annotations/finalizers 且 ConfigMap/Secret 不传原始值；UI 无分页且只挂载可视行 |
| Auto-refresh | `start_resource_watch` / `stop_resource_watch` | 从 list resourceVersion 开始 watch；32ms 窗口按资源键合并批量推送；410 时重新 list 对账；页面切换、关闭开关时取消 |
| CRD / 自定义资源 | discovery + CRD DynamicObject + discovered plural/scope/version | 新 CRD 不需要发布新版 UI；支持 list/watch/detail/create/edit/delete |
| Kind 专属资源详情与关系图 | `get_resource` + 前端关系解析器；按 ownerReferences、selector、字段引用、RBAC 引用、storage binding、Ingress backend、autoscaler target 和 CR owner UID 反查 | 每种 Kind 展示自己的配置/状态 section；父/子/引用实例可点击继续下钻；Deployment 同时解析 ReplicaSet → Pod 与 selector fallback |
| Create / Edit / Apply | `apply_manifest` | YAML 解析后使用 Server-Side Apply、strict validation、field manager `kubehive` |
| Delete | `delete_resource` | 明确确认；默认 background propagation，可传 grace period |
| Scale | `scale_resource` | Merge patch `spec.replicas`，拒绝负数 |
| Restart | `restart_resource` | workload patch pod-template annotation；Pod 不提供 Restart 操作 |
| Pod Eviction | `evict_pod` | 使用 `policy/v1` Eviction 子资源；遵守 PodDisruptionBudget 与优雅终止，RBAC 需允许 `create pods/eviction` |
| Logs | `pod_logs` | 工作负载先按 selector 解析运行 Pod；支持 container/tail/since/timestamp/previous 参数 |
| Terminal / exec | `exec_pod` | kube-rs WebSocket exec；命令按 argv 传递，不启动或拼接本地 shell |
| Port Forwarding | `PortForwardRegistry` | 127.0.0.1 TCP listener，每个连接建立 kube-rs portforward WebSocket；可停止与查看错误 |
| Alerts | Overview Event 聚合 | 只显示真实 Warning Event，无告警时显示空状态 |
| Helm Releases | list Secret (`owner=helm`) + watch | release 名称、revision、status 来自 Helm storage Secret metadata；Secret payload 不解码到 WebView |
| Helm Charts | `HelmCatalog` 并发读取官方仓库 `index.yaml`，15 分钟缓存 | 当前浏览 ingress-nginx、Jetstack、Prometheus Community、Argo；不静默执行本机 `helm`，安装/升级仍需独立的 values/diff 流程 |
| Proxy | `set_network_proxy` | HTTP/HTTPS proxy 写入 kube client Config，变更后清空并重建 clients |
| 外观、语言、列、尺寸 | React/localStorage | 仅 UI 偏好，不含集群凭据 |
| 应用更新 | 显式检测构建是否配置签名更新源 | 当前构建无 updater endpoint 时显示“未配置”，不伪造远端检查成功 |

## 增量与取消模型

- 每个资源页面先使用 `limit/continue` 分块执行一致性 list，保存 Kubernetes `resourceVersion`。
- watch command 通过 Tauri `Channel<ResourceWatchMessage>` 批量发送 added/modified/deleted；同一资源在 32ms 窗口内只保留最终状态。
- React 使用资源键 Map 原位合并批次，表格通过虚拟滚动只挂载可视行；搜索和列排序作用于完整逻辑列表。
- watch 遇到 `410 Gone` 时重新 list，并以替换快照清理断档期间已经删除的对象。
- Rust 端为每个 subscription 保存 `CancellationToken`；组件 cleanup 调用 stop command，Channel 失效也会终止任务。
- 日志页面当前每 5 秒重新读取 tail，避免无界缓冲；port-forward 与 exec 均由任务/连接生命周期释放。

## 验证边界

自动测试覆盖：

1. kubeconfig/manual config 解析与云厂商识别；
2. Secret 遮罩与动态 plural；
3. Kubernetes Quantity 与 Overview 百分比；
4. Rust command service 编译、Clippy、单元测试；
5. Playwright UI 交互、主题、表格、抽屉、持久 session；
6. 可选真实 kubeconfig smoke test：API Server version、Pods list、API discovery、Overview，以及 ConfigMap Server-Side Apply dry-run 并确认未持久化；
7. `verify:resource-details` 覆盖 Deployment 专属 rollout/strategy/template、Deployment → ReplicaSet/Pod、Pod 父控制器、Service → Pod/Endpoints/Ingress、Event regarding、ConfigMap/Secret 引用、RBAC、PDB、PortForward target、PVC/PV/StorageClass、HPA target、CRD → 自定义资源及关联资源二次下钻，并 sweep 全部 41 个资源导航页面确认每个 Kind 都有专属 section。

live smoke test 不持久化或删除用户资源；写路径中的真实 API 校验仅使用 Kubernetes dry-run。scale/restart/evict/delete 的最终结果仍由目标集群 RBAC、PodDisruptionBudget 和 admission policy 决定。
