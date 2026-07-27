export type AppLanguage = "en" | "zh-CN" | "zh-TW";
export type AppTheme = "system" | "light" | "dark";
export type TerminalTheme = "system" | "dark" | "light";

export type Preferences = {
  language: AppLanguage;
  theme: AppTheme;
  terminalTheme: TerminalTheme;
  terminalFont: string;
  proxyEnabled: boolean;
  proxyUrl: string;
  autoUpdate: boolean;
};

export const defaultPreferences: Preferences = {
  language: "en",
  theme: "system",
  terminalTheme: "dark",
  terminalFont: "monospace",
  proxyEnabled: false,
  proxyUrl: "http://127.0.0.1:7890",
  autoUpdate: true,
};

const ui = {
  en: {
    resources: "Resources", filterResources: "Filter resources", searchResources: "Search resources",
    resourceList: "Resource list", namespace: "Namespace", filters: "Filters", refresh: "Refresh", create: "Create",
    settings: "Settings", application: "Application", language: "Application language", theme: "Application theme",
    terminal: "Terminal & logs", terminalTheme: "Terminal theme", terminalFont: "Terminal font",
    network: "Network", proxy: "Proxy", updates: "Updates", autoUpdate: "Automatically install updates",
    checkUpdates: "Check for updates", upToDate: "KubeHive is up to date", addCluster: "Add cluster",
    cancel: "Cancel", add: "Add cluster", currentCluster: "Current cluster", allNamespaces: "All namespaces",
  },
  "zh-CN": {
    resources: "资源", filterResources: "筛选资源", searchResources: "搜索资源",
    resourceList: "资源列表", namespace: "命名空间", filters: "筛选", refresh: "刷新", create: "创建",
    settings: "设置", application: "应用", language: "应用语言", theme: "应用主题",
    terminal: "终端与日志", terminalTheme: "终端主题", terminalFont: "终端字体",
    network: "网络", proxy: "代理", updates: "更新", autoUpdate: "自动安装更新",
    checkUpdates: "检查更新", upToDate: "KubeHive 已是最新版本", addCluster: "添加集群",
    cancel: "取消", add: "添加集群", currentCluster: "当前集群", allNamespaces: "所有命名空间",
  },
  "zh-TW": {
    resources: "資源", filterResources: "篩選資源", searchResources: "搜尋資源",
    resourceList: "資源列表", namespace: "命名空間", filters: "篩選", refresh: "重新整理", create: "建立",
    settings: "設定", application: "應用程式", language: "應用程式語言", theme: "應用程式主題",
    terminal: "終端與日誌", terminalTheme: "終端主題", terminalFont: "終端字型",
    network: "網路", proxy: "代理伺服器", updates: "更新", autoUpdate: "自動安裝更新",
    checkUpdates: "檢查更新", upToDate: "KubeHive 已是最新版本", addCluster: "新增叢集",
    cancel: "取消", add: "新增叢集", currentCluster: "目前叢集", allNamespaces: "所有命名空間",
  },
} as const;

export type UiKey = keyof typeof ui.en;
export const t = (language: AppLanguage, key: UiKey) => ui[language][key];

const groupZhCn: Record<string, string> = {
  Overview: "概览", Workloads: "工作负载", Network: "网络", Storage: "存储",
  Configuration: "配置", "Access Control": "访问控制", "Custom Resources": "自定义资源", Applications: "应用",
};
const groupZhTw: Record<string, string> = {
  Overview: "概覽", Workloads: "工作負載", Network: "網路", Storage: "儲存",
  Configuration: "設定", "Access Control": "存取控制", "Custom Resources": "自訂資源", Applications: "應用程式",
};

// Kubernetes resource names remain canonical in every language.
export function resourceLabel(_language: AppLanguage, name: string) {
  return name;
}

export function groupLabel(language: AppLanguage, name: string) {
  if (language === "zh-CN") return groupZhCn[name] ?? name;
  if (language === "zh-TW") return groupZhTw[name] ?? name;
  return name;
}
