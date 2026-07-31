use crate::{models::*, registry::ClusterRegistry};
use chrono::Utc;
use k8s_openapi::api::core::v1::Pod;
use kube::{
    api::{Api, AttachParams},
    Client,
};
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MAX_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

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
    let output = exec_shell(registry, &request.target, script, &[path.clone()], None).await?;
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
    let output = exec_shell(registry, &request.target, &script, &[path.clone()], None).await?;
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
    let path = normalize_container_path(&request.path)?;
    reject_root_mutation(&path)?;
    exec_shell(
        registry,
        &request.target,
        "set -eu\n[ -e \"$1\" ] || [ -L \"$1\" ] || { echo 'Path does not exist' >&2; exit 20; }\nrm -rf \"$1\"",
        &[path],
        None,
    )
    .await?;
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
    let partial = destination.with_extension(format!(
        "{}.part",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("download")
    ));
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
    tokio::fs::rename(&partial, &destination)
        .await
        .map_err(|error| format!("Unable to finish the download: {error}"))?;
    Ok(destination.to_string_lossy().into_owned())
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
    if source == destination {
        return Err("Source and destination are the same".into());
    }
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
    let command = shell_command(script, args);
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
        Some(status) => status.await.and_then(|value| value.message),
        None => None,
    };
    let stderr = String::from_utf8_lossy(&stderr_bytes).trim().to_string();
    if let Err(error) = join_result {
        return Err(remote_error(error.to_string(), &stderr, status.as_deref()));
    }
    if status
        .as_deref()
        .is_some_and(|value| !value.is_empty() && !value.eq_ignore_ascii_case("success"))
    {
        return Err(remote_error(
            "Container command failed".into(),
            &stderr,
            status.as_deref(),
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
        .exec(target.pod.trim(), shell_command(script, args), &params)
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
        Some(status) => status.await.and_then(|value| value.message),
        None => None,
    };
    let stderr = String::from_utf8_lossy(&stderr_bytes).trim().to_string();
    if let Err(error) = join_result {
        return Err(remote_error(error.to_string(), &stderr, status.as_deref()));
    }
    if status
        .as_deref()
        .is_some_and(|value| !value.is_empty() && !value.eq_ignore_ascii_case("success"))
    {
        return Err(remote_error(
            "Container download failed".into(),
            &stderr,
            status.as_deref(),
        ));
    }
    Ok(())
}

fn shell_command(script: &str, args: &[String]) -> Vec<String> {
    let mut command = vec![
        "sh".to_string(),
        "-c".to_string(),
        script.to_string(),
        "kubehive".to_string(),
    ];
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
            let name_bytes = decode_hex(fields[6])?;
            let name = String::from_utf8(name_bytes)
                .map_err(|_| "A container file name is not valid UTF-8".to_string())?;
            let path = join_container_path(directory, &name)?;
            Ok(ContainerFileEntry {
                name,
                path,
                kind: fields[0].to_string(),
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
    if value.len() % 2 != 0 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
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
    let value = value.trim();
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
    let value = value.trim();
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
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S-%3f");
    if directory {
        format!("{source}-{timestamp}.tar.gz")
    } else if let Some((stem, extension)) = source
        .rsplit_once('.')
        .filter(|(stem, extension)| !stem.is_empty() && !extension.is_empty())
    {
        format!("{stem}-{timestamp}.{extension}")
    } else {
        format!("{source}-{timestamp}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let listing = b"directory\t0\t1710000000\t755\t1\t1\t666f6c6465720a6e616d65\nfile\t42\t1710000001\t644\t1\t0\t61202724286229\n";
        let entries = parse_listing("/tmp", listing).unwrap();
        assert_eq!(entries[0].name, "folder\nname");
        assert_eq!(entries[0].path, "/tmp/folder\nname");
        assert_eq!(entries[1].name, "a '$(b)");
        assert_eq!(entries[1].size, 42);
        assert!(!entries[1].writable);
    }

    #[test]
    fn download_names_preserve_extensions_and_archive_directories() {
        let file = download_file_name("app.log", false);
        assert!(file.starts_with("app-"));
        assert!(file.ends_with(".log"));
        assert!(download_file_name("config", true).ends_with(".tar.gz"));
    }
}
