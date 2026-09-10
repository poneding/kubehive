#!/usr/bin/env node
/**
 * Repair the updater's latest.json so every platform points at the public
 * browser download URL instead of the GitHub API asset URL
 * (api.github.com/.../releases/assets/<id>).
 *
 * tauri-action embeds the API asset URLs into latest.json; without an
 * authenticated octet-stream request those return JSON metadata or a 403, so
 * the Tauri updater fails to download ("update check failed"). The updater
 * signatures cover the artifact bytes only (not the URL), so rewriting the
 * URLs keeps every signature valid.
 *
 * Usage:
 *   node scripts/repair-updater-json.cjs --tag v0.1.1 [--release-id 123456] [--input latest.json] [--output latest.json] [--repo owner/name]
 *
 * The id -> browser_download_url mapping is read from the release via the gh
 * CLI (numeric asset ids, matching what tauri-action embeds):
 *   gh api repos/{owner}/{repo}/releases/{release_id}   (preferred; works for drafts)
 *   gh api repos/{owner}/{repo}/releases/tags/{tag}     (published releases only)
 *
 * --release-id must be used in CI: the "get release by tag" endpoint cannot
 * see draft releases, and this script runs while the release is still a
 * draft (publishing happens only after the repaired latest.json is uploaded).
 * Draft assets also expose download URLs under an "untagged-<hash>" path that
 * stops resolving once the release is published, so those URLs are rewritten
 * to the permanent tag-based path.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

function parseArgs(argv) {
  const args = { tag: "", releaseId: "", input: "latest.json", output: "", repo: "" };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === "--tag") args.tag = value;
    else if (argv[i] === "--release-id") args.releaseId = value;
    else if (argv[i] === "--input") args.input = value;
    else if (argv[i] === "--output") args.output = value;
    else if (argv[i] === "--repo") args.repo = value;
  }
  if (!args.tag) throw new Error("--tag is required (e.g. v0.1.1)");
  args.output ||= args.input;
  return args;
}

function listReleaseAssets({ tag, releaseId, repo }) {
  const target = repo || "poneding/kubehive";
  const jq = '.assets[] | "\\(.id)\\t\\(.browser_download_url)"';
  const releasePath = releaseId
    ? `repos/${target}/releases/${releaseId}`
    : `repos/${target}/releases/tags/${tag}`;
  const raw = execFileSync("gh", ["api", releasePath, "--jq", jq], { encoding: "utf8" });
  const map = new Map();
  for (const line of raw.trim().split("\n")) {
    if (!line) continue;
    const [id, ...rest] = line.split("\t");
    map.set(id, rest.join("\t"));
  }
  if (map.size === 0) throw new Error(`No assets found for release ${tag || `id ${releaseId}`}`);
  // Draft releases expose asset download URLs under an "untagged-<hash>"
  // path that 404s once the release is published; rewrite them to the
  // permanent tag-based path the updater will actually request.
  const draftPath = /\/releases\/download\/untagged-[0-9a-f]+\//i;
  for (const [id, url] of map) {
    if (draftPath.test(url)) map.set(id, url.replace(draftPath, `/releases/download/${tag}/`));
  }
  return map;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const assets = listReleaseAssets(args);
  const document = JSON.parse(fs.readFileSync(args.input, "utf8"));

  let rewritten = 0;
  let unmapped = [];
  for (const [platform, entry] of Object.entries(document.platforms ?? {})) {
    const url = entry.url ?? "";
    const assetId = url.replace(/\/+$/, "").split("/").pop() ?? "";
    const isApiAsset = /^https:\/\/api\.github\.com\/repos\/.+\/releases\/assets\/\d+$/.test(url);
    if (!isApiAsset) continue;
    const browserUrl = assets.get(assetId);
    if (!browserUrl) {
      unmapped.push(`${platform} (${url})`);
      continue;
    }
    entry.url = browserUrl;
    rewritten += 1;
  }

  if (unmapped.length > 0) {
    console.error(`WARNING: could not map ${unmapped.length} platform URL(s):`);
    for (const item of unmapped) console.error(`  - ${item}`);
  }
  if (rewritten === 0) {
    console.log("No API asset URLs found; latest.json already uses standard download URLs.");
  } else {
    console.log(`Rewrote ${rewritten} platform URL(s) to public download URLs.`);
  }
  fs.writeFileSync(args.output, `${JSON.stringify(document, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(`repair-updater-json: ${error.message}`);
  process.exit(1);
}
