const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const tauriConfig = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const cargoToml = fs.readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8");
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = [packageJson.version, tauriConfig.version, cargoVersion];

if (!versions.every(Boolean) || new Set(versions).size !== 1) {
  throw new Error(`Version mismatch: package.json=${packageJson.version}, tauri.conf.json=${tauriConfig.version}, Cargo.toml=${cargoVersion ?? "missing"}`);
}

const tag = process.env.RELEASE_TAG;
if (tag && tag !== `v${packageJson.version}`) {
  throw new Error(`Release tag ${tag} must match v${packageJson.version}`);
}

console.log(`Release version verified: ${packageJson.version}`);
