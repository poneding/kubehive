# Kubernetes 资源详情 Sheet 与关联关系矩阵

本文是资源实例详情改造的设计基线。目标不是为每个 Kind 复制一套完全独立的 JSX，而是使用 **Kind 专属详情 schema + Kubernetes 关系解析器**：每种资源展示自己的状态字段、配置字段和关系组；通用 metadata、conditions、labels、annotations 仍复用一致的视觉组件。

## 1. 关系判定优先级

1. **强所有权**：`metadata.ownerReferences`，优先按 UID，其次按 `apiVersion + kind + name` 判定，用于垃圾回收和控制器父子链。
2. **直接引用**：`spec.*Ref`、`roleRef`、`claimRef`、`targetRef`、`serviceAccountName`、`storageClassName` 等。
3. **选择器**：Deployment/StatefulSet/DaemonSet/Service/PDB/NetworkPolicy 的 selector 与 Pod labels 匹配。
4. **同名约定**：Service ↔ Endpoints、Node ↔ `kube-node-lease` Lease。
5. **反向引用**：扫描候选资源的 spec/annotations，寻找指向当前实例的引用。
6. **动态自定义资源**：以目标 UID 扫描 discovery 中可 list 的资源并匹配 ownerReferences。
7. **事件**：同时支持 core/v1 `involvedObject` 与 events.k8s.io/v1 `regarding`；UID 优先，缺少 UID 时匹配 apiVersion/kind/name。

所有列表最多在 Sheet 中展示 50 项，并可点击关联实例，在同一个 Sheet 位置切换到该实例自己的 Kind 专属详情。

## 2. Cluster 与 Workloads

| Kind | 专属详情 | 父资源 | 子资源 / 关联资源 | 判定方式 |
|---|---|---|---|---|
| Node | 容量、allocatable、系统、地址 | — | Pods、Node Lease、Events | `Pod.spec.nodeName`；`kube-node-lease/<node>` |
| Namespace | phase、finalizers、删除状态 | — | Pods、Workloads、Services、ConfigMaps、Secrets、PVCs、Events | `metadata.namespace` |
| Event | type、reason、count、message/note、报告组件 | regarding/involved object、Namespace | — | core/v1 `involvedObject` 或 events.k8s.io/v1 `regarding` |
| Pod | runtime、容器、调度 | direct owner、控制器祖先、Node、Namespace、ServiceAccount、PriorityClass、RuntimeClass、PVC、ConfigMap、Secret | Selecting Services、Events | ownerReferences；Pod spec refs；Service selector |
| Deployment | rollout、strategy、Pod template | Namespace | ReplicaSets、**Managed Pods**、HPA/VPA、PDB、Services、Events | Deployment → ReplicaSet owner；Pod → ReplicaSet owner；selector fallback |
| StatefulSet | rollout、稳定身份、PVC template | Namespace | Managed Pods、PVCs、governing Service、HPA/VPA、PDB、Events | selector/owner；`serviceName`；PVC template 命名与 owner |
| DaemonSet | rollout、节点放置 | Namespace | Managed Pods、PDB、Services、Events | Pod owner/selector |
| ReplicaSet | replicas、Pod template | Deployment、Namespace | Managed Pods、HPA/VPA、PDB、Services、Events | ownerReferences |
| ReplicationController | replicas、Pod template | Namespace | Managed Pods、HPA/VPA、PDB、Services、Events | owner/selector |
| Job | execution、成功/失败/并行度 | CronJob、Namespace | Managed Pods、Events | ownerReferences |
| CronJob | schedule、并发策略、历史 | Namespace | Jobs、Jobs 下的 Pods、Events | Job owner；Pod → Job owner |

### Deployment 的 Managed Pods

真实 Kubernetes 中 Pod 通常不直接属于 Deployment，而是：

```text
Deployment → ReplicaSet → Pod
```

因此 Sheet 同时执行两条判定：

- 找到 ownerReference 指向 Deployment 的 ReplicaSets，再找 ownerReference 指向这些 ReplicaSets 的 Pods；
- 使用 Deployment `spec.selector` 匹配 Pod labels 作为兼容与恢复路径。

## 3. Network

| Kind | 专属详情 | 父资源 | 子资源 / 关联资源 | 判定方式 |
|---|---|---|---|---|
| Service | type、ClusterIP、external IP、ports、selector | Namespace | Selected Pods、Endpoints、Ingresses、Events | selector；同名 Endpoints；Ingress backend refs |
| Endpoints | ready/not-ready addresses、ports | Service、Namespace | Target Pods、Events | 同名 Service；address `targetRef` |
| Ingress | class、address、hosts、TLS、routes | IngressClass、Namespace | Backend Services、TLS Secrets、Events | `ingressClassName`、backend service、`tls.secretName` |
| IngressClass | controller、parameters | — | Ingresses | `Ingress.spec.ingressClassName` |
| NetworkPolicy | podSelector、policyTypes、规则统计 | Namespace | Selected Pods、Events | `spec.podSelector` |
| PortForward | local/remote port、protocol、status | Target Pod | — | port-forward session target |

## 4. Storage

| Kind | 专属详情 | 父资源 | 子资源 / 关联资源 | 判定方式 |
|---|---|---|---|---|
| PersistentVolumeClaim | phase、request/capacity、access modes | PV、StorageClass、Namespace、可选 StatefulSet owner | Mounted Pods、Events | `volumeName`、`storageClassName`、Pod volumes |
| PersistentVolume | phase、capacity、source、reclaim policy | StorageClass | Bound Claim、Mounted Pods、Events | `claimRef`；Pods 经 PVC 反查 |
| StorageClass | provisioner、binding、expansion、parameters | — | PVs、PVCs | `spec.storageClassName` |

## 5. Configuration 与 Policy

| Kind | 专属详情 | 父资源 | 子资源 / 关联资源 | 判定方式 |
|---|---|---|---|---|
| ConfigMap | data/binaryData key 数、immutable | Namespace | Referencing Pods、Events | Pod volumes/env/envFrom/projected refs |
| Secret | type、key 数、遮罩状态 | Namespace | Referencing Pods、TLS Ingresses、ServiceAccounts、Events | Pod refs、Ingress TLS、SA refs |
| ResourceQuota | hard/used/scopes | Namespace | Events | namespace 与 involvedObject |
| LimitRange | 每条 limit 默认值、request、min/max | Namespace | Events | namespace 与 involvedObject |
| HorizontalPodAutoscaler | target、min/max/current/desired、metrics | Scale target、Namespace | Events | `spec.scaleTargetRef` |
| VerticalPodAutoscaler | target、update mode、recommendations | Target、Namespace | Events | `spec.targetRef` |
| PodDisruptionBudget | min/max、healthy、allowed disruptions | Namespace | Selected Pods、Pod controllers、Events | selector + Pod ownerReferences |
| PriorityClass | value、globalDefault、preemption | — | Pods | `Pod.spec.priorityClassName` |
| RuntimeClass | handler、overhead、scheduling | — | Pods | `Pod.spec.runtimeClassName` |
| Lease | holder、duration、renew、transitions | Namespace、可选 Node | — | kube-node-lease 同名约定 |
| MutatingWebhookConfiguration | webhook names、failure policy、side effects | — | Webhook Services | `clientConfig.service` |
| ValidatingWebhookConfiguration | webhook names、failure policy、side effects | — | Webhook Services | `clientConfig.service` |

Secret 的 value 不进入 WebView，详情只显示 keys 与 Rust 边界遮罩说明，避免编辑遮罩字符串破坏真实 Secret。

## 6. Access Control

| Kind | 专属详情 | 父资源 | 子资源 / 关联资源 | 判定方式 |
|---|---|---|---|---|
| ServiceAccount | secrets、imagePullSecrets、automount | Namespace | Pods、RoleBindings、ClusterRoleBindings、Secrets | Pod SA name；binding subjects；SA refs |
| Role | rules、API groups、resources、verbs | Namespace | RoleBindings | `roleRef.kind/name` |
| ClusterRole | rules、aggregation | — | RoleBindings、ClusterRoleBindings | `roleRef.kind/name` |
| RoleBinding | roleRef、subjects | Role/ClusterRole、Namespace | ServiceAccount subjects | `roleRef`、`subjects` |
| ClusterRoleBinding | roleRef、subjects | ClusterRole | ServiceAccount subjects | `roleRef`、`subjects` |
| PodSecurityPolicy | privileged、host、runAs、volumes | — | Roles allowing `use` | RBAC rule resources/resourceNames |

User 和 Group 不是 Kubernetes API 资源实例，因此保留在 Binding 的专属字段中，不伪造成可点击资源。

## 7. CRD、Custom Resource 与 Helm

| Kind | 专属详情 | 父资源 | 子资源 / 关联资源 | 判定方式 |
|---|---|---|---|---|
| CustomResourceDefinition | group、kind、plural、scope、versions、conversion | — | 自定义资源实例 | 以 CRD `metadata.name` 唯一选择定义，再使用精确 group/storage-version/plural/scope descriptor |
| 任意 Custom Resource | 通用 spec/status scalar summary + printer columns | ownerReferences、Namespace | Owned Resources、Events | UID owner scan；动态 discovery |
| HelmChart | repository、chart version、app version、description | — | — | 外部仓库 catalog |
| HelmRelease | chart、revision、status、appVersion | Namespace | Managed resources | `meta.helm.sh/release-name/namespace` annotations |

## 8. UI 验收要求

- 打开任意列表行，Sheet 必须显示该 Kind 的专属 section，而不是统一的 Deployment 模板字段。
- Deployment Sheet 必须包含 `ReplicaSets` 与 `Managed Pods`，Pod 项可点击。
- Pod Sheet 必须能看到 direct owner 与更高层 controller ancestry。
- Service、Ingress、PVC/PV、HPA/VPA、RBAC、CRD 等必须显示各自引用关系。
- 关系加载、RBAC/API 失败、空列表分别有明确 loading/error/empty 状态。
- 关联项点击后切换到目标资源自己的 Sheet，并重新解析目标资源的关系。
- 浏览器 demo 与 Tauri live 模式都必须具备可验证的 Deployment → ReplicaSet → Pods 路径。
- 自动化 sweep 必须逐一打开资源导航中的所有 demo Kind，并确认每个实例至少渲染一个 Kind 专属 section。
