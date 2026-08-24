const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const checks = [];
const check = (name, condition, detail = "") => {
  checks.push({ name, ok: Boolean(condition), detail });
};

const terminalRs = read("src-tauri/src/terminal.rs");
const modelsRs = read("src-tauri/src/models.rs");
const appTsx = ["src/App.tsx", ...fs.readdirSync(path.join(root, "src/app")).map((file) => `src/app/${file}`)].map(read).join("\n");
const backendTs = read("src/backend.ts");
const i18nTs = read("src/i18n.ts");

check(
  "node field on StartTerminalRequest",
  /pub node: Option<String>/.test(modelsRs),
);
check(
  "privileged node shell pod builder",
  /fn build_node_shell_pod/.test(terminalRs)
    && /host_network: Some\(true\)/.test(terminalRs)
    && /host_pid: Some\(true\)/.test(terminalRs)
    && /host_ipc: Some\(true\)/.test(terminalRs)
    && /privileged: Some\(true\)/.test(terminalRs)
    && /while true; do sleep 3600; done/.test(terminalRs)
    && /active_deadline_seconds: Some\(node_shell_active_deadline_seconds\(\)\)/.test(terminalRs),
);
check(
  "node terminal uses nsenter host entry",
  /fn default_node_terminal_command/.test(terminalRs)
    && /nsenter --target 1 --mount --uts --ipc --net/.test(terminalRs)
    && /chroot \/host/.test(terminalRs),
);
check(
  "ephemeral node shell cleanup",
  /fn delete_node_shell_pod/.test(terminalRs)
    && /wait_for_pod_running/.test(terminalRs)
    && /start_node/.test(terminalRs),
);
check(
  "frontend exposes node terminal target",
  /terminalTarget\?: "local" \| "container" \| "node"/.test(appTsx)
    && /startNodeTerminal/.test(backendTs)
    && /nodeTerminal: "Node terminal"/.test(i18nTs)
    && /nodeTerminal: "节点终端"/.test(i18nTs)
    && /nodeTerminal: "節點終端機"/.test(i18nTs),
);
check(
  "Node actions open node terminal sessions",
  /item\.kind === "Node"/.test(appTsx)
    && /actionKind === "Node"/.test(appTsx)
    && /backend\.startNodeTerminal\(\{ clusterId, node: nodeName/.test(appTsx)
    && /terminalTarget === "node"/.test(appTsx),
);
check(
  "backend unit coverage for node shell pod",
  /fn node_shell_pod_is_privileged_and_pinned_to_the_target_node/.test(terminalRs)
    && /fn node_terminal_command_enters_host_namespaces/.test(terminalRs),
);

const failed = checks.filter((entry) => !entry.ok);
console.log(JSON.stringify({ checks, passed: failed.length === 0 }, null, 2));
if (failed.length) process.exitCode = 1;
