import { Button, ScrollArea } from "@/components/ui";
import { CheckCircle2, Download, Globe2, LoaderCircle, Monitor, Moon, RefreshCw, Sun, Type, Wifi, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { UpdateState } from "../app-update";
import { Combobox, type ComboboxOption } from "../combobox";
import { listSystemFonts, type SystemFontFamily } from "../fonts";
import { localizedUpdateError, tr } from "../i18n";
import { contentFontSizes, t, SYSTEM_FONT, type AppLanguage, type ContentTheme, type Preferences } from "../preferences";
import { ToggleSwitch } from "./app-controls";
import { appVersion } from "./app-state";

function SettingsSheet({ preferences, onChange, updateState, onCheckUpdates, onClose }: { preferences: Preferences; onChange: (next: Preferences) => void; updateState: UpdateState; onCheckUpdates: () => void; onClose: () => void }) {
  const language = preferences.language;
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) => onChange({ ...preferences, [key]: value });
  // Installed system fonts drive both pickers, so every offered face actually
  // exists on this machine and can render its own name in its own style.
  const [systemFonts, setSystemFonts] = useState<SystemFontFamily[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listSystemFonts().then((fonts) => { if (!cancelled) setSystemFonts(fonts); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const fontPreview = (name: string) => ({ fontFamily: `"${name.replace(/"/g, "")}", sans-serif` });
  const fontOption = (font: SystemFontFamily): ComboboxOption => ({ value: font.name, label: font.name, style: fontPreview(font.name) });
  const withCurrent = (options: ComboboxOption[], current: string) => options.some((option) => option.value === current)
    ? options
    : [{ value: current, label: current, style: fontPreview(current) }, ...options];
  const appFontOptions = [
    { value: SYSTEM_FONT, label: tr(language, "systemDefault") },
    ...systemFonts.map(fontOption),
  ];
  const monoFonts = systemFonts.filter((font) => font.monospace);
  const monoFontOptions = [
    { value: SYSTEM_FONT, label: tr(language, "systemDefault") },
    ...monoFonts.map((font) => ({ ...fontOption(font), group: tr(language, "monospaceFonts") })),
    ...systemFonts.filter((font) => !font.monospace).map((font) => ({ ...fontOption(font), group: tr(language, "allFonts") })),
  ];
  const themeLabels = language === "en" ? ["Follow system", "Light", "Dark"] : language === "zh-TW" ? ["跟隨系統", "淺色", "深色"] : ["跟随系统", "浅色", "深色"];
  const contentThemeLabels = language === "en" ? ["Follow application", "Dark", "Light"] : language === "zh-TW" ? ["跟隨應用程式主題", "深色", "淺色"] : ["跟随应用主题", "深色", "浅色"];
  const updateDetail = updateState.status === "checking" ? "Checking the signed release" : updateState.status === "available" && updateState.update ? `Version ${updateState.update.version} is ready in About` : updateState.status === "current" ? t(language, "upToDate") : updateState.status === "error" ? localizedUpdateError(language, updateState.message) : `Version ${appVersion} · stable channel`;
  const checking = updateState.status === "checking" || updateState.status === "downloading";
  return <div className="modal-backdrop panel-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-modal"><div className="settings-header"><h2>{t(language, "settings")}</h2><div /><Button variant="ghost" size="icon" aria-label={tr(language, "close")} onClick={onClose}><X size={15} /></Button></div><ScrollArea className="settings-scroll-area" viewportClassName="settings-scroll">
    <section className="settings-section"><div className="settings-section-title"><Globe2 size={15} /><div><h3>{t(language, "application")}</h3><p>{tr(language, "languageAppearance")}</p></div></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "language")}</strong><small>{tr(language, "appliesImmediately")}</small></span><Combobox value={preferences.language} onChange={(value) => update("language", value as AppLanguage)} options={[{ value: "en", label: "English" }, { value: "zh-CN", label: "简体中文" }, { value: "zh-TW", label: "繁體中文" }]} searchable={false} /></div><div className="settings-row"><span><strong>{t(language, "theme")}</strong><small>{tr(language, "systemAppearance")}</small></span><Combobox value={preferences.theme} onChange={(value) => update("theme", value as Preferences["theme"])} options={[{ value: "system", label: themeLabels[0], icon: Monitor }, { value: "light", label: themeLabels[1], icon: Sun }, { value: "dark", label: themeLabels[2], icon: Moon }]} searchable={false} /></div><div className="settings-row"><span><strong>{t(language, "appFont")}</strong><small>{tr(language, "appFontHint")}</small></span><Combobox value={preferences.appFont || SYSTEM_FONT} onChange={(value) => update("appFont", value === SYSTEM_FONT ? "" : value)} options={withCurrent(appFontOptions, preferences.appFont || SYSTEM_FONT)} /></div><div className="settings-row"><span><strong>{t(language, "monoFont")}</strong><small>{tr(language, "monoFontHint")}</small></span><Combobox value={preferences.monoFont || SYSTEM_FONT} onChange={(value) => update("monoFont", value === SYSTEM_FONT ? "" : value)} options={withCurrent(monoFontOptions, preferences.monoFont || SYSTEM_FONT)} /></div></div></section>
    <section className="settings-section"><div className="settings-section-title"><Type size={15} /><div><h3>{tr(language, "terminalLogsEditor")}</h3><p>{tr(language, "contentAppearanceDescription")}</p></div></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "contentTheme")}</strong><small>{tr(language, "contentColors")}</small></span><Combobox value={preferences.contentTheme} onChange={(value) => update("contentTheme", value as ContentTheme)} options={[{ value: "system", label: contentThemeLabels[0], icon: Monitor }, { value: "dark", label: contentThemeLabels[1], icon: Moon }, { value: "light", label: contentThemeLabels[2], icon: Sun }]} searchable={false} /></div><div className="settings-row"><span><strong>{t(language, "contentFontSize")}</strong><small>{tr(language, "contentText")}</small></span><Combobox value={String(preferences.contentFontSize)} onChange={(value) => update("contentFontSize", Number(value) as Preferences["contentFontSize"])} options={contentFontSizes.map((value) => ({ value: String(value), label: `${value} px` }))} searchable={false} /></div></div></section>
    <section className="settings-section"><div className="settings-section-title"><Wifi size={15} /><div><h3>{t(language, "proxy")}</h3><p>{tr(language, "proxyTraffic")}</p></div></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "proxy")}</strong><small>{tr(language, "proxyClients")}</small></span><ToggleSwitch label={tr(language, "enableProxy")} checked={preferences.proxyEnabled} onChange={(value) => update("proxyEnabled", value)} /></div>{preferences.proxyEnabled && <div className="settings-input-row"><span>{tr(language, "proxyUrl")}</span><input value={preferences.proxyUrl} onChange={(event) => update("proxyUrl", event.target.value)} placeholder="http://127.0.0.1:7890" /></div>}</div></section>
    <section className="settings-section"><div className="settings-section-title"><Download size={15} /><div><h3>{t(language, "updates")}</h3><p>{updateDetail}</p></div><Button variant="outline" size="sm" disabled={checking} onClick={onCheckUpdates}>{checking ? <LoaderCircle className="spin" size={13} /> : updateState.status === "current" ? <CheckCircle2 size={13} /> : <RefreshCw size={13} />} {t(language, "checkUpdates")}</Button></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "autoUpdate")}</strong><small>{tr(language, "checkStableChannel")}</small></span><ToggleSwitch label={tr(language, "automaticUpdates")} checked={preferences.autoUpdate} onChange={(value) => update("autoUpdate", value)} /></div></div></section>
  </ScrollArea></section></div>;
}

export { SettingsSheet };
