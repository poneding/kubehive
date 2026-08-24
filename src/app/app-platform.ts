import { createDefaultPreferences } from "../preferences";
import type { DesktopPlatform } from "./types";

const platform: DesktopPlatform = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "macos" : /Win/.test(navigator.userAgent) ? "windows" : "linux";
document.documentElement.classList.add(`platform-${platform}`);
const defaultPreferences = createDefaultPreferences(platform);
const appVersion = __KUBEHIVE_VERSION__;

export { appVersion, defaultPreferences, platform };
