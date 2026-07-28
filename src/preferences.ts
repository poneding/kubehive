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
    columns: "Columns", resetColumns: "Reset defaults", requiredColumn: "Required",
    rowsPerPage: "Rows", pageOf: "of", relatedResources: "Related resources", reverseLinks: "Referenced by",
    settings: "Settings", application: "Application", language: "Application language", theme: "Application theme",
    terminal: "Terminal & logs", terminalTheme: "Terminal theme", terminalFont: "Terminal font",
    network: "Network", proxy: "Proxy", updates: "Updates", autoUpdate: "Automatically install updates",
    checkUpdates: "Check for updates", upToDate: "KubeHive is up to date", addCluster: "Add cluster",
    cancel: "Cancel", add: "Add cluster", currentCluster: "Current cluster", allNamespaces: "All namespaces",
    clusters: "Clusters", cluster: "Cluster", clusterHomeDescription: "Connect to a cluster to open its Overview and resource workspace.",
    configuredClusters: "configured", connectedClusters: "connected", provider: "Provider", location: "Location", version: "Version", status: "Status",
    actions: "Actions", connect: "Connect", openOverview: "Open overview", closeConnection: "Close connection", closingConnection: "Closing…", connected: "Connected", disconnected: "Disconnected", moveUp: "Move up", moveDown: "Move down", remove: "Remove",
    noClusters: "No clusters configured", noClustersHint: "Add a kubeconfig or API server connection to get started.", clusterConnectHint: "Double-click a cluster, use Actions, or click its avatar in the rail to connect.", connectForAlerts: "Connect a cluster to view alerts",
    resourceVisibility: "Configure resource list", resourceVisibilityHint: "Show or hide groups and resources", showAll: "Show all", showGroup: "Show group", showResource: "Show resource",
    searchClusters: "Search clusters", noMatchingClusters: "No matching clusters", noMatchingClustersHint: "Try another name, provider, context, or location.", clusterSettings: "Cluster settings", clusterName: "Cluster name", themeColor: "Theme color", save: "Save",
  },
  "zh-CN": {
    resources: "资源", filterResources: "筛选资源", searchResources: "搜索资源",
    resourceList: "资源列表", namespace: "命名空间", filters: "筛选", refresh: "刷新", create: "创建",
    columns: "显示列", resetColumns: "恢复默认", requiredColumn: "必选",
    rowsPerPage: "每页", pageOf: "共", relatedResources: "关联资源", reverseLinks: "被引用",
    settings: "设置", application: "应用", language: "应用语言", theme: "应用主题",
    terminal: "终端与日志", terminalTheme: "终端主题", terminalFont: "终端字体",
    network: "网络", proxy: "代理", updates: "更新", autoUpdate: "自动安装更新",
    checkUpdates: "检查更新", upToDate: "KubeHive 已是最新版本", addCluster: "添加集群",
    cancel: "取消", add: "添加集群", currentCluster: "当前集群", allNamespaces: "所有命名空间",
    clusters: "集群", cluster: "集群", clusterHomeDescription: "连接集群后进入对应的概览和资源工作区。",
    configuredClusters: "个已配置", connectedClusters: "个已连接", provider: "提供商", location: "位置", version: "版本", status: "状态",
    actions: "操作", connect: "连接", openOverview: "打开概览", closeConnection: "关闭连接", closingConnection: "正在关闭…", connected: "已连接", disconnected: "未连接", moveUp: "上移", moveDown: "下移", remove: "移除",
    noClusters: "尚未配置集群", noClustersHint: "添加 kubeconfig 或 API Server 连接以开始使用。", clusterConnectHint: "双击集群、使用操作菜单，或点击左侧头像即可连接。", connectForAlerts: "连接集群后查看告警",
    resourceVisibility: "配置资源列表", resourceVisibilityHint: "显示或隐藏分组和具体资源", showAll: "全部显示", showGroup: "显示分组", showResource: "显示资源",
    searchClusters: "搜索集群", noMatchingClusters: "没有匹配的集群", noMatchingClustersHint: "请尝试其他名称、提供商、context 或位置。", clusterSettings: "集群设置", clusterName: "集群名称", themeColor: "主题颜色", save: "保存",
  },
  "zh-TW": {
    resources: "資源", filterResources: "篩選資源", searchResources: "搜尋資源",
    resourceList: "資源列表", namespace: "命名空間", filters: "篩選", refresh: "重新整理", create: "建立",
    columns: "顯示欄", resetColumns: "還原預設", requiredColumn: "必選",
    rowsPerPage: "每頁", pageOf: "共", relatedResources: "關聯資源", reverseLinks: "被引用",
    settings: "設定", application: "應用程式", language: "應用程式語言", theme: "應用程式主題",
    terminal: "終端與日誌", terminalTheme: "終端主題", terminalFont: "終端字型",
    network: "網路", proxy: "代理伺服器", updates: "更新", autoUpdate: "自動安裝更新",
    checkUpdates: "檢查更新", upToDate: "KubeHive 已是最新版本", addCluster: "新增叢集",
    cancel: "取消", add: "新增叢集", currentCluster: "目前叢集", allNamespaces: "所有命名空間",
    clusters: "叢集", cluster: "叢集", clusterHomeDescription: "連線叢集後進入對應的概覽與資源工作區。",
    configuredClusters: "個已設定", connectedClusters: "個已連線", provider: "供應商", location: "位置", version: "版本", status: "狀態",
    actions: "操作", connect: "連線", openOverview: "開啟概覽", closeConnection: "關閉連線", closingConnection: "正在關閉…", connected: "已連線", disconnected: "未連線", moveUp: "上移", moveDown: "下移", remove: "移除",
    noClusters: "尚未設定叢集", noClustersHint: "新增 kubeconfig 或 API Server 連線以開始使用。", clusterConnectHint: "按兩下叢集、使用操作選單，或點擊左側頭像即可連線。", connectForAlerts: "連線叢集後檢視警示",
    resourceVisibility: "設定資源列表", resourceVisibilityHint: "顯示或隱藏群組及特定資源", showAll: "全部顯示", showGroup: "顯示群組", showResource: "顯示資源",
    searchClusters: "搜尋叢集", noMatchingClusters: "沒有符合的叢集", noMatchingClustersHint: "請嘗試其他名稱、供應商、context 或位置。", clusterSettings: "叢集設定", clusterName: "叢集名稱", themeColor: "主題顏色", save: "儲存",
  },
} as const;

export type UiKey = keyof typeof ui.en;
export const t = (language: AppLanguage, key: UiKey) => ui[language][key];

const groupZhCn: Record<string, string> = {
  Overview: "概览", Cluster: "集群", Workloads: "工作负载", Network: "网络", Storage: "存储",
  Configuration: "配置", Helm: "Helm", "Access Control": "访问控制", "Custom Resources": "自定义资源", Applications: "应用",
};
const groupZhTw: Record<string, string> = {
  Overview: "概覽", Cluster: "叢集", Workloads: "工作負載", Network: "網路", Storage: "儲存",
  Configuration: "設定", Helm: "Helm", "Access Control": "存取控制", "Custom Resources": "自訂資源", Applications: "應用程式",
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
