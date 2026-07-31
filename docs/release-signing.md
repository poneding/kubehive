# Release Signing

KubeHive releases use Tauri's signed updater. The public key is committed in `src-tauri/tauri.conf.json`; the matching private key remains ignored at `src-tauri/.tauri/kubehive-updater.key`.

Before pushing the first release tag, add the private key to the repository's Actions secrets:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < src-tauri/.tauri/kubehive-updater.key
```

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional because this generated key has no password. Store both secrets in the repository, never in source control. Losing the private key means installed clients cannot trust future releases, so retain an encrypted backup before deleting the local key.

The release workflow validates that `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` have the same version. To publish a version, update all three, merge to `main`, then push a matching tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/release.yml` creates a draft release, generates the release body with `git-cliff`, builds signed macOS (Apple Silicon and Intel), Windows, and Linux bundles, merges the updater metadata into `latest.json`, and only then publishes the GitHub Release. Use conventional commit prefixes such as `feat:`, `fix:`, `docs:`, and `ci:` so generated release notes remain categorized.
