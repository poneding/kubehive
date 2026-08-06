use crate::{
    models::*,
    registry::ClusterRegistry,
    remote_command::{command_succeeded, status_failure},
};
use k8s_openapi::api::core::v1::Pod;
use kube::{
    api::{Api, AttachParams},
    Client,
};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

const MAX_BATCH_PATHS: usize = 1_000;
const MAX_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
const DELETE_PATHS_SCRIPT: &str = r#"
set -u
requested=$#
deleted=0
failed=0
for path do
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    printf 'Path does not exist: %s\n' "$path" >&2
    failed=$((failed + 1))
    continue
  fi

  detail=
  if detail=$(rm -rf "$path" 2>&1); then
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then
      deleted=$((deleted + 1))
    else
      printf 'Path remains after deletion: %s. It may be a mounted path or its parent directory may be read-only.\n' "$path" >&2
      failed=$((failed + 1))
    fi
  else
    if [ -n "$detail" ]; then
      printf 'Unable to delete %s: %s\n' "$path" "$detail" >&2
    else
      printf 'Unable to delete %s: rm exited unsuccessfully.\n' "$path" >&2
    fi
    failed=$((failed + 1))
  fi
done

if [ "$failed" -ne 0 ]; then
  printf 'Deleted %s of %s selected path(s); %s failed.\n' "$deleted" "$requested" "$failed" >&2
  exit 22
fi
"#;

pub async fn directory_context(
    registry: &ClusterRegistry,
    target: ContainerFileTarget,
) -> Result<ContainerDirectoryContext, String> {
    let script = r#"
set -eu
work_dir=$(pwd -P 2>/dev/null || pwd)
home_dir=${HOME:-}
if [ -z "$home_dir" ] || [ ! -d "$home_dir" ]; then
  home_dir=$(cd ~ 2>/dev/null && pwd -P || true)
fi
if [ -z "$home_dir" ] || [ ! -d "$home_dir" ]; then
  home_dir=$work_dir
fi
printf '%s\n%s\n' "$work_dir" "$home_dir"
"#;
    let output = exec_shell(registry, &target, script, &[], None).await?;
    let text = String::from_utf8(output.stdout)
        .map_err(|_| "The container returned invalid directory context".to_string())?;
    let mut lines = text.lines();
    let work_dir = normalize_container_path(lines.next().unwrap_or("/"))?;
    let home_dir = normalize_container_path(lines.next().unwrap_or(&work_dir))?;
    Ok(ContainerDirectoryContext { work_dir, home_dir })
}

pub async fn list(
    registry: &ClusterRegistry,
    request: ContainerPathRequest,
) -> Result<Vec<ContainerFileEntry>, String> {
    let path = normalize_container_path(&request.path)?;
    let script = r#"
set -eu
dir=$1
[ -d "$dir" ] || { echo "Not a directory: $dir" >&2; exit 20; }
for item in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
  [ -e "$item" ] || [ -L "$item" ] || continue
  name=${item##*/}
  if [ -L "$item" ]; then kind=symlink
  elif [ -d "$item" ]; then kind=directory
  else kind=file
  fi
  values=$(stat -c '%s %Y %a' "$item" 2>/dev/null || stat -f '%z %m %Lp' "$item" 2>/dev/null || printf '0 0 0')
  set -- $values
  readable=0; writable=0
  [ -r "$item" ] && readable=1
  [ -w "$item" ] && writable=1
  encoded=$(printf '%s' "$name" | od -An -tx1 | tr -d ' \n')
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$kind" "${1:-0}" "${2:-0}" "${3:-0}" "$readable" "$writable" "$encoded"
done
"#;
    let output = exec_shell(
        registry,
        &request.target,
        script,
        std::slice::from_ref(&path),
        None,
    )
    .await?;
    parse_listing(&path, &output.stdout)
}

pub async fn read_text(
    registry: &ClusterRegistry,
    request: ContainerPathRequest,
) -> Result<ContainerTextFile, String> {
    let path = normalize_container_path(&request.path)?;
    let script = format!(
        "set -eu\n[ -f \"$1\" ] || {{ echo 'Not a regular file' >&2; exit 20; }}\nsize=$(wc -c < \"$1\")\n[ \"$size\" -le {MAX_TEXT_BYTES} ] || {{ echo 'File is larger than the {MAX_TEXT_BYTES} byte text editor limit' >&2; exit 21; }}\ncat \"$1\""
    );
    let output = exec_shell(
        registry,
        &request.target,
        &script,
        std::slice::from_ref(&path),
        None,
    )
    .await?;
    let content = String::from_utf8(output.stdout)
        .map_err(|_| "The selected file is not valid UTF-8 text".to_string())?;
    Ok(ContainerTextFile { path, content })
}

pub async fn write_text(
    registry: &ClusterRegistry,
    request: ContainerWriteTextRequest,
) -> Result<(), String> {
    if request.content.len() > MAX_TEXT_BYTES {
        return Err(format!("Text files are limited to {MAX_TEXT_BYTES} bytes"));
    }
    let path = normalize_container_path(&request.path)?;
    reject_root_mutation(&path)?;
    let script =
        "set -eu\n[ ! -d \"$1\" ] || { echo 'Path is a directory' >&2; exit 20; }\ncat > \"$1\"";
    exec_shell(
        registry,
        &request.target,
        script,
        &[path],
        Some(request.content.into_bytes()),
    )
    .await?;
    Ok(())
}

pub async fn upload(
    registry: &ClusterRegistry,
    request: ContainerUploadRequest,
) -> Result<(), String> {
    if request.data.len() > MAX_UPLOAD_BYTES {
        return Err(format!(
            "Uploads are limited to {MAX_UPLOAD_BYTES} bytes per file"
        ));
    }
    let path = normalize_container_path(&request.path)?;
    reject_root_mutation(&path)?;
    let script = if request.overwrite {
        "set -eu\n[ ! -d \"$1\" ] || { echo 'Path is a directory' >&2; exit 20; }\ncat > \"$1\""
    } else {
        "set -eu\n[ ! -e \"$1\" ] && [ ! -L \"$1\" ] || { echo 'Destination already exists' >&2; exit 20; }\ncat > \"$1\""
    };
    exec_shell(
        registry,
        &request.target,
        script,
        &[path],
        Some(request.data),
    )
    .await?;
    Ok(())
}

pub async fn create_directory(
    registry: &ClusterRegistry,
    request: ContainerPathRequest,
) -> Result<(), String> {
    let path = normalize_container_path(&request.path)?;
    reject_root_mutation(&path)?;
    exec_shell(
        registry,
        &request.target,
        "set -eu\n[ ! -e \"$1\" ] && [ ! -L \"$1\" ] || { echo 'Path already exists' >&2; exit 20; }\nmkdir \"$1\"",
        &[path],
        None,
    )
    .await?;
    Ok(())
}

pub async fn create_file(
    registry: &ClusterRegistry,
    request: ContainerPathRequest,
) -> Result<(), String> {
    let path = normalize_container_path(&request.path)?;
    reject_root_mutation(&path)?;
    exec_shell(
        registry,
        &request.target,
        "set -eu\n[ ! -e \"$1\" ] && [ ! -L \"$1\" ] || { echo 'Path already exists' >&2; exit 20; }\n: > \"$1\"",
        &[path],
        None,
    )
    .await?;
    Ok(())
}

pub async fn rename(
    registry: &ClusterRegistry,
    request: ContainerRenameRequest,
) -> Result<(), String> {
    let source = normalize_container_path(&request.path)?;
    reject_root_mutation(&source)?;
    let name = validate_file_name(&request.new_name)?;
    let parent = parent_path(&source);
    let destination = join_container_path(&parent, &name)?;
    transfer(
        registry,
        &request.target,
        &source,
        &destination,
        TransferOperation::Move,
    )
    .await
}

pub async fn move_path(
    registry: &ClusterRegistry,
    request: ContainerTransferRequest,
) -> Result<(), String> {
    let source = normalize_container_path(&request.source_path)?;
    let destination = normalize_container_path(&request.destination_path)?;
    reject_root_mutation(&source)?;
    reject_root_mutation(&destination)?;
    transfer(
        registry,
        &request.target,
        &source,
        &destination,
        TransferOperation::Move,
    )
    .await
}

pub async fn copy_path(
    registry: &ClusterRegistry,
    request: ContainerTransferRequest,
) -> Result<(), String> {
    let source = normalize_container_path(&request.source_path)?;
    let destination = normalize_container_path(&request.destination_path)?;
    reject_root_mutation(&source)?;
    reject_root_mutation(&destination)?;
    transfer(
        registry,
        &request.target,
        &source,
        &destination,
        TransferOperation::Copy,
    )
    .await
}

pub async fn delete_path(
    registry: &ClusterRegistry,
    request: ContainerPathRequest,
) -> Result<(), String> {
    delete_paths(
        registry,
        ContainerBatchPathRequest {
            target: request.target,
            paths: vec![request.path],
        },
    )
    .await
}

pub async fn delete_paths(
    registry: &ClusterRegistry,
    request: ContainerBatchPathRequest,
) -> Result<(), String> {
    let paths = normalize_delete_paths(&request.paths)?;
    exec_shell(registry, &request.target, DELETE_PATHS_SCRIPT, &paths, None).await?;
    Ok(())
}

pub async fn download(
    registry: &ClusterRegistry,
    downloads: &Path,
    request: ContainerDownloadRequest,
) -> Result<String, String> {
    let path = normalize_container_path(&request.path)?;
    reject_root_mutation(&path)?;
    tokio::fs::create_dir_all(downloads)
        .await
        .map_err(|error| format!("Unable to create the Downloads directory: {error}"))?;
    let source_name = base_name(&path);
    let file_name = download_file_name(&source_name, request.directory);
    let destination = downloads.join(file_name);
    let partial = download_partial_path(downloads);
    let result = if request.directory {
        let parent = parent_path(&path);
        exec_shell_to_file(
            registry,
            &request.target,
            "set -eu\n[ -d \"$1/$2\" ] || { echo 'Not a directory' >&2; exit 20; }\ntar -czf - -C \"$1\" \"$2\"",
            &[parent, source_name],
            &partial,
        )
        .await
    } else {
        exec_shell_to_file(
            registry,
            &request.target,
            "set -eu\n[ -f \"$1\" ] || { echo 'Not a regular file' >&2; exit 20; }\ncat \"$1\"",
            &[path],
            &partial,
        )
        .await
    };
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(error);
    }
    finalize_download(&partial, &destination).await?;
    Ok(destination.to_string_lossy().into_owned())
}

pub async fn download_batch(
    registry: &ClusterRegistry,
    downloads: &Path,
    request: ContainerBatchDownloadRequest,
) -> Result<String, String> {
    let paths = normalize_batch_paths(&request.paths)?;
    tokio::fs::create_dir_all(downloads)
        .await
        .map_err(|error| format!("Unable to create the Downloads directory: {error}"))?;
    let destination = downloads.join("container-files.tar.gz");
    let partial = download_partial_path(downloads);
    let script = r#"
set -eu
stage=${TMPDIR:-/tmp}/kubehive-files-$$
mkdir "$stage"
trap 'rm -rf "$stage"' EXIT HUP INT TERM
shift
for source do
  [ -e "$source" ] || [ -L "$source" ] || { echo "Path does not exist: $source" >&2; exit 20; }
  name=${source##*/}
  target=$stage/$name
  suffix=2
  while [ -e "$target" ] || [ -L "$target" ]; do
    target=$stage/$name-$suffix
    suffix=$((suffix + 1))
  done
  cp -a "$source" "$target"
done
tar -czf - -C "$stage" .
"#;
    let mut args = vec!["--".to_string()];
    args.extend(paths);
    let result = exec_shell_to_file(registry, &request.target, script, &args, &partial).await;
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(error);
    }
    finalize_download(&partial, &destination).await?;
    Ok(destination.to_string_lossy().into_owned())
}

fn normalize_delete_paths(values: &[String]) -> Result<Vec<String>, String> {
    let mut paths = normalize_batch_paths(values)?;
    paths.sort_by_key(String::len);
    let mut roots = Vec::with_capacity(paths.len());
    for path in paths {
        if !roots
            .iter()
            .any(|root: &String| path.starts_with(&format!("{root}/")))
        {
            roots.push(path);
        }
    }
    Ok(roots)
}

fn normalize_batch_paths(values: &[String]) -> Result<Vec<String>, String> {
    if values.is_empty() {
        return Err("Select at least one container path".into());
    }
    if values.len() > MAX_BATCH_PATHS {
        return Err(format!(
            "Batch operations are limited to {MAX_BATCH_PATHS} paths"
        ));
    }
    let mut paths = Vec::with_capacity(values.len());
    for value in values {
        let path = normalize_container_path(value)?;
        reject_root_mutation(&path)?;
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    Ok(paths)
}

enum TransferOperation {
    Move,
    Copy,
}

async fn transfer(
    registry: &ClusterRegistry,
    target: &ContainerFileTarget,
    source: &str,
    destination: &str,
    operation: TransferOperation,
) -> Result<(), String> {
    validate_transfer_paths(source, destination)?;
    let command = match operation {
        TransferOperation::Move => "mv",
        TransferOperation::Copy => "cp -a",
    };
    let script = format!(
        "set -eu\n[ -e \"$1\" ] || [ -L \"$1\" ] || {{ echo 'Source does not exist' >&2; exit 20; }}\n[ ! -e \"$2\" ] && [ ! -L \"$2\" ] || {{ echo 'Destination already exists' >&2; exit 21; }}\n{command} \"$1\" \"$2\""
    );
    exec_shell(
        registry,
        target,
        &script,
        &[source.to_string(), destination.to_string()],
        None,
    )
    .await?;
    Ok(())
}

fn validate_transfer_paths(source: &str, destination: &str) -> Result<(), String> {
    if source == destination {
        return Err("Source and destination are the same".into());
    }
    if destination.starts_with(&format!("{source}/")) {
        return Err("A path cannot be moved or copied inside itself".into());
    }
    Ok(())
}

struct CommandOutput {
    stdout: Vec<u8>,
}

async fn exec_shell(
    registry: &ClusterRegistry,
    target: &ContainerFileTarget,
    script: &str,
    args: &[String],
    input: Option<Vec<u8>>,
) -> Result<CommandOutput, String> {
    validate_target(target)?;
    let client = registry.streaming_client(&target.cluster_id).await?;
    let command = shell_command(script, args, target.host_root);
    let mut params = AttachParams {
        container: target
            .container
            .clone()
            .filter(|value| !value.trim().is_empty()),
        stdin: input.is_some(),
        stdout: true,
        stderr: true,
        tty: false,
        ..Default::default()
    };
    params.max_stdin_buf_size = Some(64 * 1024);
    params.max_stdout_buf_size = Some(64 * 1024);
    let pods: Api<Pod> = Api::namespaced(client, target.namespace.trim());
    let mut process = pods
        .exec(target.pod.trim(), command, &params)
        .await
        .map_err(|error| format!("Unable to access container files: {error}"))?;
    let status = process.take_status();
    let mut stdout_reader = process
        .stdout()
        .ok_or_else(|| "The container file stream did not provide stdout".to_string())?;
    let mut stderr_reader = process
        .stderr()
        .ok_or_else(|| "The container file stream did not provide stderr".to_string())?;
    let mut stdin_writer = if input.is_some() {
        Some(
            process
                .stdin()
                .ok_or_else(|| "The container file stream did not provide stdin".to_string())?,
        )
    } else {
        None
    };
    let mut stdout = Vec::new();
    let mut stderr_bytes = Vec::new();
    let write = async move {
        if let (Some(mut writer), Some(data)) = (stdin_writer.take(), input) {
            writer
                .write_all(&data)
                .await
                .map_err(|error| format!("Unable to upload file data: {error}"))?;
            writer
                .shutdown()
                .await
                .map_err(|error| format!("Unable to finish the upload stream: {error}"))?;
        }
        Ok::<(), String>(())
    };
    let (write_result, stdout_result, stderr_result) = tokio::join!(
        write,
        stdout_reader.read_to_end(&mut stdout),
        stderr_reader.read_to_end(&mut stderr_bytes),
    );
    write_result?;
    stdout_result.map_err(|error| format!("Unable to read container file output: {error}"))?;
    stderr_result.map_err(|error| format!("Unable to read container file errors: {error}"))?;
    let join_result = process.join().await;
    let status = match status {
        Some(status) => status.await,
        None => None,
    };
    let stderr = String::from_utf8_lossy(&stderr_bytes).trim().to_string();
    let status_error = status_failure(status.as_ref());
    if let Err(error) = join_result {
        return Err(remote_error(
            error.to_string(),
            &stderr,
            status_error.as_deref(),
        ));
    }
    if !command_succeeded(status.as_ref(), &stderr) {
        return Err(remote_error(
            "Container command failed".into(),
            &stderr,
            status_error.as_deref(),
        ));
    }
    Ok(CommandOutput { stdout })
}

async fn exec_shell_to_file(
    registry: &ClusterRegistry,
    target: &ContainerFileTarget,
    script: &str,
    args: &[String],
    destination: &Path,
) -> Result<(), String> {
    validate_target(target)?;
    let client: Client = registry.streaming_client(&target.cluster_id).await?;
    let pods: Api<Pod> = Api::namespaced(client, target.namespace.trim());
    let params = AttachParams {
        container: target
            .container
            .clone()
            .filter(|value| !value.trim().is_empty()),
        stdin: false,
        stdout: true,
        stderr: true,
        tty: false,
        ..Default::default()
    };
    let mut process = pods
        .exec(
            target.pod.trim(),
            shell_command(script, args, target.host_root),
            &params,
        )
        .await
        .map_err(|error| format!("Unable to start the container download: {error}"))?;
    let status = process.take_status();
    let mut stdout = process
        .stdout()
        .ok_or_else(|| "The container download did not provide stdout".to_string())?;
    let mut stderr = process
        .stderr()
        .ok_or_else(|| "The container download did not provide stderr".to_string())?;
    let mut file = tokio::fs::File::create(destination)
        .await
        .map_err(|error| format!("Unable to create the download file: {error}"))?;
    let copy = async {
        tokio::io::copy(&mut stdout, &mut file)
            .await
            .map_err(|error| format!("Unable to save the container download: {error}"))?;
        file.flush()
            .await
            .map_err(|error| format!("Unable to flush the download file: {error}"))
    };
    let mut stderr_bytes = Vec::new();
    let (copy_result, stderr_result) = tokio::join!(copy, stderr.read_to_end(&mut stderr_bytes));
    copy_result?;
    stderr_result.map_err(|error| format!("Unable to read download errors: {error}"))?;
    let join_result = process.join().await;
    let status = match status {
        Some(status) => status.await,
        None => None,
    };
    let stderr = String::from_utf8_lossy(&stderr_bytes).trim().to_string();
    let status_error = status_failure(status.as_ref());
    if let Err(error) = join_result {
        return Err(remote_error(
            error.to_string(),
            &stderr,
            status_error.as_deref(),
        ));
    }
    if !command_succeeded(status.as_ref(), &stderr) {
        return Err(remote_error(
            "Container download failed".into(),
            &stderr,
            status_error.as_deref(),
        ));
    }
    Ok(())
}

/// Builds `sh -c <script> kubehive <args>`. Node host sessions (`host_root`)
/// enter the host filesystem first via `chroot /host`, so every path argument
/// and tool resolution applies to the Node host instead of the helper Pod.
fn shell_command(script: &str, args: &[String], host_root: bool) -> Vec<String> {
    let mut command = Vec::with_capacity(args.len() + 4);
    if host_root {
        command.extend(
            ["chroot", "/host", "sh", "-c"]
                .into_iter()
                .map(String::from),
        );
    } else {
        command.push("sh".into());
        command.push("-c".into());
    }
    command.push(script.to_string());
    command.push("kubehive".to_string());
    command.extend(args.iter().cloned());
    command
}

fn validate_target(target: &ContainerFileTarget) -> Result<(), String> {
    if target.cluster_id.trim().is_empty() {
        return Err("A cluster is required".into());
    }
    if target.namespace.trim().is_empty() {
        return Err("A namespace is required".into());
    }
    if target.pod.trim().is_empty() {
        return Err("A Pod is required".into());
    }
    Ok(())
}

fn remote_error(fallback: String, stderr: &str, status: Option<&str>) -> String {
    if !stderr.is_empty() {
        stderr.to_string()
    } else if let Some(status) = status.filter(|value| !value.is_empty()) {
        status.to_string()
    } else {
        fallback
    }
}

fn parse_listing(directory: &str, bytes: &[u8]) -> Result<Vec<ContainerFileEntry>, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "The container returned an invalid directory listing".to_string())?;
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let fields = line.split('\t').collect::<Vec<_>>();
            if fields.len() != 7 {
                return Err("The container returned a malformed directory listing".to_string());
            }
            let kind = match fields[0] {
                "file" | "directory" | "symlink" => fields[0].to_string(),
                _ => return Err("The container returned an unknown file type".to_string()),
            };
            let name_bytes = decode_hex(fields[6])?;
            let name = String::from_utf8(name_bytes)
                .map_err(|_| "A container file name is not valid UTF-8".to_string())?;
            let path = join_container_path(directory, &name)?;
            Ok(ContainerFileEntry {
                name,
                path,
                kind,
                size: fields[1].parse().unwrap_or(0),
                modified_at: fields[2].parse().unwrap_or(0),
                permissions: fields[3].to_string(),
                readable: fields[4] == "1",
                writable: fields[5] == "1",
            })
        })
        .collect()
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(2) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The container returned an invalid file name".into());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16).map_err(|error| error.to_string())
        })
        .collect()
}

pub(crate) fn normalize_container_path(value: &str) -> Result<String, String> {
    if value.is_empty() || !value.starts_with('/') {
        return Err("Container paths must be absolute".into());
    }
    if value.contains('\0') {
        return Err("Container paths cannot contain NUL bytes".into());
    }
    let mut parts = Vec::new();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err("Container path escapes the filesystem root".into());
                }
            }
            value => parts.push(value),
        }
    }
    Ok(if parts.is_empty() {
        "/".into()
    } else {
        format!("/{}", parts.join("/"))
    })
}

fn validate_file_name(value: &str) -> Result<String, String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\0')
    {
        return Err("Enter a valid file name without path separators".into());
    }
    Ok(value.to_string())
}

fn join_container_path(parent: &str, name: &str) -> Result<String, String> {
    let name = validate_file_name(name)?;
    normalize_container_path(&format!("{}/{}", parent.trim_end_matches('/'), name))
}

fn parent_path(path: &str) -> String {
    Path::new(path)
        .parent()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("/")
        .to_string()
}

fn base_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("container-files")
        .to_string()
}

fn reject_root_mutation(path: &str) -> Result<(), String> {
    if path == "/" {
        Err("The container filesystem root cannot be changed".into())
    } else {
        Ok(())
    }
}

fn safe_local_component(value: &str) -> String {
    let value: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let value = value.trim_matches(['-', '.']);
    if value.is_empty() {
        "container-files".into()
    } else {
        value.chars().take(100).collect()
    }
}

fn download_file_name(source: &str, directory: bool) -> String {
    let source = safe_local_component(source);
    if directory {
        format!("{source}.tar.gz")
    } else {
        source
    }
}

fn download_partial_path(downloads: &Path) -> PathBuf {
    downloads.join(format!(".kubehive-download-{}.part", Uuid::new_v4()))
}

async fn finalize_download(partial: &Path, destination: &Path) -> Result<(), String> {
    if tokio::fs::try_exists(destination)
        .await
        .map_err(|error| format!("Unable to finish the download: {error}"))?
    {
        tokio::fs::remove_file(destination)
            .await
            .map_err(|error| format!("Unable to replace the existing download: {error}"))?;
    }
    tokio::fs::rename(partial, destination)
        .await
        .map_err(|error| format!("Unable to finish the download: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn normalizes_absolute_container_paths() {
        assert_eq!(
            normalize_container_path("/var//log/./app"),
            Ok("/var/log/app".into())
        );
        assert_eq!(
            normalize_container_path("/var/log/../tmp"),
            Ok("/var/tmp".into())
        );
        assert!(normalize_container_path("relative/file").is_err());
        assert!(normalize_container_path("/../../etc").is_err());
    }

    #[test]
    fn listing_parser_decodes_unusual_names_without_shell_injection() {
        let listing = b"directory\t0\t1710000000\t755\t1\t1\t666f6c6465720a6e616d65\nfile\t42\t1710000001\t644\t1\t0\t61202724286229\nfile\t3\t1710000002\t644\t1\t1\t20666f6f20\n";
        let entries = parse_listing("/tmp", listing).unwrap();
        assert_eq!(entries[0].name, "folder\nname");
        assert_eq!(entries[0].path, "/tmp/folder\nname");
        assert_eq!(entries[1].name, "a '$(b)");
        assert_eq!(entries[1].size, 42);
        assert!(!entries[1].writable);
        assert_eq!(entries[2].name, " foo ");
        assert_eq!(entries[2].path, "/tmp/ foo ");
    }

    #[test]
    fn validates_and_deduplicates_batch_paths() {
        assert!(normalize_batch_paths(&[]).is_err());
        assert!(normalize_batch_paths(&["/".into()]).is_err());
        assert_eq!(
            normalize_batch_paths(&["/app/a".into(), "/app/./a".into(), "/tmp/b".into()]).unwrap(),
            vec!["/app/a", "/tmp/b"]
        );
    }

    #[test]
    fn deletion_paths_deduplicate_nested_selections() {
        assert!(normalize_delete_paths(&[]).is_err());
        assert_eq!(
            normalize_delete_paths(&[
                "/app/logs/old.log".into(),
                "/app".into(),
                "/tmp/cache".into()
            ])
            .unwrap(),
            vec!["/app", "/tmp/cache"]
        );
    }

    #[test]
    fn delete_script_removes_paths_with_shell_metacharacters() {
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path().join("quoted '$value file.txt");
        std::fs::write(&target, "delete me").unwrap();

        let output = Command::new("sh")
            .arg("-c")
            .arg(DELETE_PATHS_SCRIPT)
            .arg("kubehive")
            .arg(&target)
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "delete script failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!target.exists());
    }

    #[test]
    fn delete_script_continues_after_a_stale_batch_path() {
        let temporary = tempfile::tempdir().unwrap();
        let existing = temporary.path().join("existing.txt");
        let missing = temporary.path().join("already-gone.txt");
        std::fs::write(&existing, "delete me").unwrap();

        let output = Command::new("sh")
            .arg("-c")
            .arg(DELETE_PATHS_SCRIPT)
            .arg("kubehive")
            .arg(&missing)
            .arg(&existing)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);

        assert!(!output.status.success());
        assert!(
            !existing.exists(),
            "valid batch paths should still be deleted"
        );
        assert!(stderr.contains("Path does not exist"));
        assert!(stderr.contains("Deleted 1 of 2 selected path(s); 1 failed."));
    }

    #[test]
    fn rejects_recursive_or_identical_transfers() {
        assert!(validate_transfer_paths("/app", "/app").is_err());
        assert!(validate_transfer_paths("/app", "/app/archive").is_err());
        assert!(validate_transfer_paths("/app", "/application").is_ok());
        assert!(validate_transfer_paths("/app", "/tmp/app").is_ok());
    }

    #[test]
    fn rejects_mutating_the_filesystem_root() {
        assert!(reject_root_mutation("/").is_err());
        assert!(reject_root_mutation("/tmp").is_ok());
    }

    #[test]
    fn download_names_preserve_source_names_without_timestamps() {
        assert_eq!(download_file_name("app.log", false), "app.log");
        assert_eq!(download_file_name("config", false), "config");
        assert_eq!(download_file_name("config", true), "config.tar.gz");
    }

    #[tokio::test]
    async fn finalized_download_replaces_an_existing_file_without_renaming() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("app.log");
        let partial = temporary.path().join("download.part");
        tokio::fs::write(&destination, "old content").await.unwrap();
        tokio::fs::write(&partial, "new content").await.unwrap();

        finalize_download(&partial, &destination).await.unwrap();

        assert_eq!(destination.file_name().unwrap(), "app.log");
        assert_eq!(
            tokio::fs::read_to_string(&destination).await.unwrap(),
            "new content"
        );
        assert!(!partial.exists());
    }
}
