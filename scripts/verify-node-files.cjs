const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const checks = [];
const check = (name, condition, detail = "") => {
  checks.push({ name, ok: Boolean(condition), detail });
};

const modelsRs = read("src-tauri/src/models.rs");
const nodeFilesRs = read("src-tauri/src/node_files.rs");
const nodesRs = read("src-tauri/src/nodes.rs");
const containerFilesRs = read("src-tauri/src/container_files.rs");
const libRs = read("src-tauri/src/lib.rs");
const appModuleFiles = fs.readdirSync(path.join(root, "src/app"))
  .map((file) => `src/app/${file}`);
const appTsx = ["src/App.tsx", ...appModuleFiles].map(read).join("\n");
// NodeTaintsDialog now lives in its own module; the footer check is scoped to
// that file instead of relying on concatenation order.
const resourceActionDialogsTsx = read("src/app/resource-action-dialogs.tsx");
const backendTs = read("src/backend.ts");
const containerFileExplorerTsx = read("src/container-file-explorer.tsx");
const i18nTs = read("src/i18n.ts");

check(
  "node file session request models",
  /pub struct NodeFileTarget/.test(modelsRs)
    && /pub struct SetNodeUnschedulableRequest/.test(modelsRs)
    && /pub struct DrainNodeRequest/.test(modelsRs)
    && /pub struct DrainNodeResult/.test(modelsRs)
    && /pub struct AddNodeTaintRequest/.test(modelsRs)
    && /pub struct RemoveNodeTaintRequest/.test(modelsRs)
    && /pub struct NodeTaintInfo/.test(modelsRs),
);
check(
  "node file helper pod reuses the node shell pod machinery",
  /pub struct NodeFileSessionRegistry/.test(nodeFilesRs)
    && /fn build_node_files_pod/.test(nodeFilesRs)
    && /chroot \/host/.test(nodeFilesRs)
    && /node-shell/.test(nodeFilesRs) === false
    && /node-files/.test(nodeFilesRs)
    && /active_deadline_seconds: Some\(node_shell_active_deadline_seconds\(\)\)/.test(nodeFilesRs)
    && /privileged: Some\(true\)/.test(nodeFilesRs)
    && /while true; do sleep 3600; done/.test(nodeFilesRs),
),
check(
  "node file session registry reference counts and reuses pods",
  /users: u32/.test(nodeFilesRs)
    && /find_existing_helper_pod/.test(nodeFilesRs)
    && /users\.saturating_sub\(1\)/.test(nodeFilesRs)
    && /stop_cluster/.test(nodeFilesRs),
);
check(
  "host root file targets run through chroot",
  /host_root: bool/.test(modelsRs)
    && /host_root/.test(containerFilesRs)
    && /"chroot", "\/host", "sh", "-c"/.test(containerFilesRs),
);
check(
  "drain implements kubectl semantics",
  /pub async fn drain_node/.test(nodesRs)
    && /spec\.nodeName/.test(nodesRs)
    && /DaemonSet-managed Pods/.test(nodesRs)
    && /ignore_daemonsets/.test(nodesRs)
    && /delete_emptydir_data/.test(nodesRs)
    && /no controller/.test(nodesRs)
    && /force/.test(nodesRs)
    && /429/.test(nodesRs)
    && /evict/.test(nodesRs),
);
check(
  "cordon and taint operations",
  /pub async fn set_node_unschedulable/.test(nodesRs)
    && /pub async fn add_node_taint/.test(nodesRs)
    && /pub async fn remove_node_taint/.test(nodesRs)
    && /pub async fn list_node_taints/.test(nodesRs)
    && /"NoSchedule" \| "PreferNoSchedule" \| "NoExecute"/.test(nodesRs),
);
check(
  "node file sessions stop with cluster teardown",
  /start_node_file_session/.test(libRs)
    && /stop_node_file_session/.test(libRs)
    && /drain_node/.test(libRs)
    && /add_node_taint/.test(libRs)
    && /remove_node_taint/.test(libRs)
    && /NodeFileSessionRegistry::default\(\)/.test(libRs)
    && /node_files\.stop_cluster/.test(libRs),
);
check(
  "frontend exposes node file service and node actions",
  /startNodeFileSession/.test(backendTs)
    && /stopNodeFileSession/.test(backendTs)
    && /setNodeUnschedulable/.test(backendTs)
    && /drainNode/.test(backendTs)
    && /listNodeTaints/.test(backendTs)
    && /addNodeTaint/.test(backendTs)
    && /removeNodeTaint/.test(backendTs)
    && /hostRoot\?: boolean/.test(backendTs),
);
check(
  "node rows offer files, cordon, drain and taints",
  /id: "files", label: tr\(language, "nodeFiles"\)/.test(appTsx)
    && /tr\(language, "uncordon"\)/.test(appTsx)
    && /tr\(language, "cordon"\)/.test(appTsx)
    && /onRowAction\("Drain", item\)/.test(appTsx)
    && /onRowAction\("Taints", item\)/.test(appTsx)
    && /actionKind === "Node"/.test(appTsx),
);
check(
  "node terminal menu sits before node files and taints use paint bucket",
  /id: "terminal", label: tr\(language, "terminal"\), icon: SquareTerminal, onSelect: \(\) => onRowAction\("Terminal", item\) \},\s*\{ type: "item" as const, id: "files", label: tr\(language, "nodeFiles"\)/.test(appTsx)
    && /id: "taints", label: tr\(language, "taints"\), icon: PaintBucket/.test(appTsx)
    && /icon: PaintBucket/.test(appTsx),
);
check(
  "cordon is confirmed through the delete-style dialog",
  /function NodeCordonDialog/.test(appTsx)
    && /resource-delete-dialog/.test(appTsx)
    && /cordonPrompt/.test(appTsx)
    && /setCordonTarget\(row\)/.test(appTsx)
    && /confirmResourceCordon/.test(appTsx),
);
check(
  "taints dialog renders a table with effect column, combobox effect and no footer",
  /node-taints-table/.test(appTsx)
    && /taintEffect"\)\}\s*<\/th>/.test(appTsx)
    && /Combobox className="node-taints-effect"/.test(appTsx)
    && /taintEffectNoScheduleHint/.test(appTsx)
    && /taintEffectPreferNoScheduleHint/.test(appTsx)
    && /taintEffectNoExecuteHint/.test(appTsx)
    && !/<footer>/.test(resourceActionDialogsTsx.slice(resourceActionDialogsTsx.indexOf("function NodeTaintsDialog"))),
);
check(
  "taint removal filter is covered by a unit test",
  /fn retain_taints_for_removal/.test(nodesRs)
    && /fn taint_removal_filters_by_key_and_optional_effect/.test(nodesRs),
);
check(
  "node file explorer sessions resolve and release helper pods without target controls",
  /startNodeFileSession\(\{ clusterId, node: nodeName \}\)/.test(appTsx)
    && /nodeFileTarget/.test(appTsx)
    && /nodeFileName/.test(appTsx)
    && /stopNodeFileSession\(\{ clusterId, node: cache\.nodeFileName \}\)/.test(appTsx)
    && /const fileSessionTargets = fileExplorer && !nodeFiles/.test(appTsx)
    && !/nodeFilesSessionHint/.test(appTsx),
);
check(
  "node file explorer remains loading until its helper Pod resolves",
  /const nodeFileTargetLoading = Boolean\(nodeFileSessionKey && nodeName && !nodeFileTarget && !nodeFileSessionFailure\)/.test(appTsx)
    && /targetLoading=\{nodeFiles && nodeFileTargetLoading\}/.test(appTsx)
    && /targetUnavailableTitle=\{nodeFiles \? tr\(language, "nodeFilesUnavailable"\) : undefined\}/.test(appTsx)
    && /if \(!target\) return targetLoading/.test(containerFileExplorerTsx)
    && /connectingToFilesystem/.test(containerFileExplorerTsx),
);
check(
  "file tabs restore their last confirmed directory without reloading",
  /fileExplorerSnapshot\?: ContainerFileExplorerSnapshot/.test(appTsx)
    && /key=\{fileExplorerInstanceKey\}/.test(appTsx)
    && /initialSnapshot=\{sessionCache\?\.fileExplorerSnapshot\}/.test(appTsx)
    && /onSnapshotChange=\{\(fileExplorerSnapshot\) => patchSessionCache\(\{ fileExplorerSnapshot \}\)\}/.test(appTsx)
    && /export type ContainerFileExplorerSnapshot/.test(containerFileExplorerTsx)
    && /restoredSnapshot && contextReloadToken === 0/.test(containerFileExplorerTsx)
    && /restoredSnapshot\?\.path === path && contextReloadToken === 0 && reloadToken === 0/.test(containerFileExplorerTsx)
    && /snapshotChangeRef\.current\?\.\(\{ targetKey, path, workDir, homeDir, entries: \[\.\.\.entries\] \}\)/.test(containerFileExplorerTsx),
);
check(
  "i18n covers node file service and node actions in all languages",
  /cordon: "Cordon"/.test(i18nTs)
    && /drain: "Drain"/.test(i18nTs)
    && /taints: "Taints"/.test(i18nTs)
    && !/drain: "Drain\.\.\."/.test(i18nTs)
    && !/taints: "Taints\.\.\."/.test(i18nTs)
    && /nodeFiles: "Node files"/.test(i18nTs)
    && /cordon: "封锁"/.test(i18nTs)
    && /nodeFiles: "节点文件"/.test(i18nTs)
    && /cordon: "封鎖"/.test(i18nTs)
    && /nodeFiles: "節點檔案"/.test(i18nTs),
);
check(
  "backend unit coverage for node file pod and drain filters",
  /fn file_helper_pod_is_privileged_and_pinned_to_the_target_node/.test(nodeFilesRs)
    && /fn drain_filters_match_kubectl_semantics/.test(nodesRs)
    && /fn taint_key_and_value_validation/.test(nodesRs),
);

const failed = checks.filter((entry) => !entry.ok);
console.log(JSON.stringify({ checks, passed: failed.length === 0 }, null, 2));
if (failed.length) process.exitCode = 1;
