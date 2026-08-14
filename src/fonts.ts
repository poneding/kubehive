//! Installed-font discovery for the Settings font pickers.
//!
//! The native build asks the Rust backend (`list_system_fonts`, fontdb) for
//! every family installed on the host. Browser prototypes fall back to a
//! curated platform list plus whatever faces the webview has already loaded.

import { backend, nativeBackendAvailable, type SystemFontFamily } from "./backend";

export type { SystemFontFamily } from "./backend";

type DesktopPlatform = "macos" | "windows" | "linux";

export const detectPlatform = (): DesktopPlatform =>
  /Mac|iPhone|iPad/.test(navigator.userAgent) ? "macos" : /Win/.test(navigator.userAgent) ? "windows" : "linux";

/** Curated fallback for browser prototypes where the Tauri backend is absent. */
const fallbackFonts: Record<DesktopPlatform, Array<[string, boolean]>> = {
  windows: [
    ["Segoe UI Variable", false], ["Segoe UI", false], ["Microsoft YaHei UI", false], ["Microsoft YaHei", false],
    ["Cascadia Mono", true], ["Cascadia Code", true], ["Consolas", true], ["Courier New", true],
    ["JetBrains Mono", true], ["Fira Code", true], ["IBM Plex Mono", true], ["DejaVu Sans Mono", true],
    ["Arial", false], ["Calibri", false], ["Segoe Print", false], ["SimSun", false], ["NSimSun", false],
  ],
  macos: [
    ["-apple-system", false], ["SF Pro Text", false], ["SF Pro Display", false], ["PingFang SC", false], ["PingFang TC", false],
    ["SFMono-Regular", true], ["Menlo", true], ["Monaco", true], ["Courier New", true],
    ["JetBrains Mono", true], ["Fira Code", true], ["IBM Plex Mono", true],
    ["Helvetica Neue", false], ["Arial", false], ["Hiragino Sans GB", false], ["Songti SC", false],
  ],
  linux: [
    ["Inter", false], ["Ubuntu", false], ["Cantarell", false], ["Noto Sans", false], ["Noto Sans CJK SC", false],
    ["DejaVu Sans", false], ["DejaVu Sans Mono", true], ["Liberation Mono", true], ["Noto Sans Mono", true],
    ["JetBrains Mono", true], ["Fira Code", true], ["IBM Plex Mono", true], ["Source Code Pro", true],
    ["FreeMono", true], ["URW Gothic", false],
  ],
};

const dedupe = (fonts: SystemFontFamily[]): SystemFontFamily[] => {
  const seen = new Set<string>();
  return fonts.filter((font) => {
    const key = font.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

async function loadSystemFonts(): Promise<SystemFontFamily[]> {
  if (nativeBackendAvailable) {
    try {
      const fonts = await backend.listSystemFonts();
      if (Array.isArray(fonts) && fonts.length > 0) return dedupe(fonts);
    } catch {
      // Fall through to the browser fallback.
    }
  }
  const platform = detectPlatform();
  const loaded: SystemFontFamily[] = [];
  try {
    for (const face of Array.from(document.fonts ?? [])) {
      const name = face.family.replace(/^["']|["']$/g, "").trim();
      if (name) loaded.push({ name, monospace: face.family.includes("mono") || face.family.includes("Mono") });
    }
  } catch {
    // Some webviews throw on FontFaceSet iteration; ignore.
  }
  return dedupe([...loaded, ...fallbackFonts[platform].map(([name, monospace]) => ({ name, monospace }))]);
}

let cached: Promise<SystemFontFamily[]> | null = null;

/** Installed font families, fetched once and reused by every picker. */
export function listSystemFonts(): Promise<SystemFontFamily[]> {
  if (!cached) cached = loadSystemFonts();
  return cached;
}
