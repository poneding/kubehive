# Lens 产品功能调研与 KubeHive 范围建议

> 调研日期：2026-07-26。来源优先采用 Lens 官方文档、官方产品页、官方 GitHub 仓库。本文用于产品范围设计，不复制 Lens 的实现或品牌资产。

## 1. 结论摘要

Lens Desktop 的价值不只是“图形化 kubectl”，而是把多集群上下文、Kubernetes 资源浏览、观测、排障和写操作放进同一桌面工作流。KubeHive 的首要竞争点应是：**连接快、资源表格快、跨集群切换快、长时间 watch 稳定**，而不是第一版复刻 Lens 的账户、团队空间和商业云能力。

关于“Lens 已闭源”需要更精确：官方 `lensapp/lens` 仓库明确说明，仓库曾包含 Lens Desktop 开源版本源码，该开源版本已经退役且不再维护；Mirantis 的 Lens Desktop 产品仍在积极开发。仓库仍公开并保留 MIT 许可证及历史，但它不再是当前桌面产品的完整、持续更新源码。因此可称“当前产品不再以原开源模式开发”，而不是“所有代码和历史都不可见”。[Lens GitHub README](https://github.com/lensapp/lens) · [MIT License](https://github.com/lensapp/lens/blob/lens-desktop/LICENSE)

## 2. 已验证的 Lens 功能清单

### 2.1 桌面、多集群与连接

- Linux、macOS、Windows 独立桌面应用；导航器用于组织和打开多个 Kubernetes 集群。[Using Lens](https://docs.k8slens.dev/k8slens/using-lens/) · [Navigator](https://docs.k8slens.dev/k8slens/using-lens/navigator/)
- 从 kubeconfig 加入集群；可指定 kubeconfig 文件、kubectl、Helm 仓库，设置集群名称、图标、工作区和代理等行为。[Cluster settings](https://docs.k8slens.dev/k8slens/cluster/cluster-settings/) · [Kubernetes preferences](https://docs.k8slens.dev/k8slens/using-lens/preferences/kubernetes/)
- Hotbar 收藏常用集群和资源；命令面板、快捷键用于快速导航和执行动作。[Hotbar](https://docs.k8slens.dev/k8slens/using-lens/hotbar/) · [Command palette](https://docs.k8slens.dev/k8slens/using-lens/command-palette/) · [Keyboard shortcuts](https://docs.k8slens.dev/k8slens/using-lens/keyboard-shortcuts/)
- Lens Teamwork/Spaces 提供集中式集群访问、邀请成员、团队组织和角色权限。这是依赖 Lens ID/服务端的协作能力，不是纯本地 Kubernetes 客户端能力。[Teamwork](https://docs.k8slens.dev/k8slens/teamwork/) · [Lens Spaces](https://docs.k8slens.dev/k8slens/spaces/)

### 2.2 Kubernetes 资源覆盖

| 领域 | 已验证视图/能力 | 官方来源 |
|---|---|---|
| 集群 | Overview、Nodes、Namespaces、Events | [Using Lens](https://docs.k8slens.dev/k8slens/using-lens/)、[Nodes](https://docs.k8slens.dev/k8slens/using-lens/nodes/)、[Events](https://docs.k8slens.dev/k8slens/using-lens/events/) |
| Workloads | Pods、Deployments、StatefulSets、DaemonSets、ReplicaSets、Jobs、CronJobs | [Workloads](https://docs.k8slens.dev/k8slens/using-lens/workloads/)、[Pods](https://docs.k8slens.dev/k8slens/using-lens/workloads/pods/)、[Deployments](https://docs.k8slens.dev/k8slens/using-lens/workloads/deployments/) |
| Network | Services、Endpoints、Ingresses、NetworkPolicies、Port Forward | [Network](https://docs.k8slens.dev/k8slens/using-lens/network/)、[Services](https://docs.k8slens.dev/k8slens/using-lens/network/services/)、[Network Policies](https://docs.k8slens.dev/k8slens/using-lens/network/network-policies/) |
| Config | ConfigMaps、Secrets、ResourceQuotas、LimitRanges、HPA、PodDisruptionBudgets | [Config](https://docs.k8slens.dev/k8slens/using-lens/config/) |
| Storage | PersistentVolumes、PersistentVolumeClaims、StorageClasses | [Storage](https://docs.k8slens.dev/k8slens/using-lens/storage/) |
| Access Control | ServiceAccounts、Roles、RoleBindings、ClusterRoles、ClusterRoleBindings | [Access Control](https://docs.k8slens.dev/k8slens/using-lens/access-control/) |
| CRD | CustomResourceDefinitions 与自定义资源浏览 | [Custom Resources](https://docs.k8slens.dev/k8slens/using-lens/custom-resources/) |
| Helm | Chart 仓库、搜索/安装 Chart、Release 查看、升级和删除 | [Helm Charts](https://docs.k8slens.dev/k8slens/using-lens/helm/charts/) · [Helm Releases](https://docs.k8slens.dev/k8slens/using-lens/helm/releases/) |

各列表通常支持按 namespace 筛选、搜索、排序，打开资源详情并查看元数据、状态和关联对象。对具备权限的资源可创建、编辑 YAML、应用更新、删除；工作负载还包含 scale、restart 等上下文动作。具体动作受 Kubernetes RBAC 约束。[Pods](https://docs.k8slens.dev/k8slens/using-lens/workloads/pods/) · [Deployments](https://docs.k8slens.dev/k8slens/using-lens/workloads/deployments/)

### 2.3 观测与排障

- 集群、节点和工作负载 CPU/内存指标；可配置或自动使用 Prometheus。[Cluster metrics](https://docs.k8slens.dev/k8slens/cluster/cluster-metrics/) · [Prometheus](https://docs.k8slens.dev/k8slens/cluster/cluster-settings/#prometheus)
- 容器日志查看、搜索、下载、时间戳与多容器切换；Pod shell/exec 和本地集群终端。[Pod logs](https://docs.k8slens.dev/k8slens/using-lens/workloads/pods/#pod-logs) · [Terminal](https://docs.k8slens.dev/k8slens/using-lens/terminal/)
- Kubernetes Events、资源状态、关联资源和告警支持从概览下钻到故障对象。[Events](https://docs.k8slens.dev/k8slens/using-lens/events/)
- Service/Pod 端口转发，便于本地访问集群应用。[Port Forwarding](https://docs.k8slens.dev/k8slens/using-lens/network/port-forwarding/)

### 2.4 可扩展性和设置

- 扩展 API 可注册页面、菜单项、状态栏项、命令、集群功能和偏好项；历史扩展 API 文档仍可用于理解产品边界，但不应直接绑定其兼容性。[Lens Extension API](https://api-docs.k8slens.dev/) · [Renderer extension guide](https://api-docs.k8slens.dev/v5.5.4/extensions/guides/renderer-extension)
- Preferences 覆盖外观、更新、代理、终端 shell、Kubernetes/kubectl、Helm 仓库、扩展等。[Preferences](https://docs.k8slens.dev/k8slens/using-lens/preferences/) · [Proxy](https://docs.k8slens.dev/k8slens/using-lens/preferences/proxy/)
- 官方商业方案还包含团队协作、集中式访问和企业管理。产品页可能随订阅策略变动，应以购买时官方定价页为准。[Lens pricing](https://k8slens.dev/pricing)

## 3. KubeHive 产品范围

| 优先级 | 功能 | 验收重点 |
|---|---|---|
| MVP | kubeconfig 导入、context/cluster 切换、namespace 筛选 | 启动后快速可用；凭据只留本机 |
| MVP | 通用资源列表、搜索、排序、watch、详情与 YAML | 10k+ 资源下表格不阻塞；增量更新 |
| MVP | Pods/Deployments/StatefulSets/DaemonSets/Jobs/CronJobs | 状态、容器、镜像、owner、conditions 可下钻 |
| MVP | Nodes、Events、Services、Ingress、ConfigMap、Secret、PV/PVC | Secret 默认遮罩；RBAC 禁止动作必须禁用 |
| MVP | Logs、exec shell、port-forward | 流可取消；退出页面释放连接和子任务 |
| MVP | 创建/编辑/apply/delete、scale、rollout restart | diff/确认、dry-run、冲突和审计信息 |
| P1 | Prometheus/metrics-server 指标、健康诊断 | 观测源可替换；失败不影响资源浏览 |
| P1 | Helm repository/chart/release 管理 | 升级前 values diff 与 rollback |
| P1 | CRD discovery 和通用动态资源页面 | 不发布新版也能展示新 CRD |
| P1 | 收藏、命令面板、快捷键、多个窗口/标签 | 纯键盘完成高频排障路径 |
| P1 | OIDC/exec credential、HTTP/SOCKS proxy | 不自行实现云厂商认证协议 |
| P2 | 插件 SDK | 先稳定内部命令/资源模型再公开 API |
| P2 | 团队空间、共享目录、策略与审计后端 | 独立控制面；不能伪装成纯客户端功能 |
| P2 | AI 助手与成本分析 | 必须显式数据边界、脱敏和可关闭 |

## 4. kube-rs + Tauri 2 架构建议

```text
React/shadcn UI
  ├─ virtualized tables, inspectors, Monaco/YAML, xterm
  └─ typed Tauri commands + event channels
                  │
Rust application core (Tokio)
  ├─ ClusterRegistry: kubeconfig/context/credential lifecycle
  ├─ DiscoveryCache: API groups, CRDs, capabilities, RBAC hints
  ├─ ResourceStore: list + watch/reflection + normalized deltas
  ├─ ActionService: patch/apply/delete/scale/log/exec/port-forward
  ├─ MetricsProvider: metrics.k8s.io / Prometheus adapters
  └─ SecretStore: OS keychain references; never webview/localStorage
                  │
            kube-rs / Kubernetes API
```

关键决策：

1. **每集群独立取消域**：`ClusterSession` 持有 `kube::Client`、discovery cache、watch tasks 和 cancellation token，切换 UI 不应反复重建 TLS/认证。
2. **增量传输**：Rust 使用 `watcher`/reflector 维护索引，只把 added/modified/deleted delta 推给 React；禁止定时全量 JSON 重传。
3. **背压与可见性**：日志、events、watch 分通道并设有界队列；不可见页面降采样或暂停订阅。
4. **动态 API**：核心资源使用 `k8s-openapi` 强类型，CRD 使用 `DynamicObject` 和 discovery，二者归一为统一 UI row/inspector contract。
5. **写操作安全**：Server-Side Apply、field manager、resourceVersion 冲突提示；删除、Secret 展示、特权 exec 均二次确认；UI 动作由 `SelfSubjectAccessReview` 或实际 API 错误约束。
6. **跨平台**：Tauri command 不执行拼接 shell 字符串；exec credential 通过明确参数启动；证书、代理和 OS keychain 在 Rust 层处理。

## 5. 原型覆盖与非目标

当前 UI 原型已覆盖多集群轨道、资源导航、namespace 筛选、集群健康概览、指标、节点利用率、事件流、工作负载表格/搜索、详情抽屉、YAML、事件、日志/终端入口、命令面板和响应式移动布局。Rust/Tauri 工程已引入 `kube`、`k8s-openapi`、Tokio 并暴露最小命令边界。

它使用演示数据，目的是验证信息架构和交互密度；尚未连接真实 kubeconfig，不承诺上述 MVP 已实现。下一实施阶段应先做 `ClusterRegistry + list/watch + Pods` 的纵向链路，再扩资源矩阵。
