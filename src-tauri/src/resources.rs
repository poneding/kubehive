use crate::{
    models::{
        ApiResourceDescriptor, ApplyManifestRequest, BulkActionFailure, BulkActionResult,
        BulkDeleteResourcesRequest, BulkEvictPodsRequest, DeleteResourceRequest, EvictPodRequest,
        ExecPodRequest, ExecResult, ManifestFormat, PodLogsRequest, ResourceDetail,
        ResourceListRequest, ResourceListResponse, ResourceRecord, ResourceTarget,
        ResourceWatchEvent, ResourceWatchMessage, ScaleResourceRequest,
    },
    registry::ClusterRegistry,
    remote_command::{command_succeeded, status_text as remote_status_text},
};
use chrono::Utc;
use futures::{StreamExt, TryStreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::{
    api::{
        Api, AttachParams, DeleteParams, DynamicObject, EvictParams, ListParams, LogParams, Patch,
        PatchParams, ResourceExt, ValidationDirective, WatchEvent, WatchParams,
    },
    core::{ApiResource, GroupVersionKind},
    discovery::{verbs, Discovery, Scope},
    Client,
};
use serde_json::{json, Map, Value};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tauri::ipc::Channel;
use tokio::{io::AsyncReadExt, sync::RwLock, time::MissedTickBehavior};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Default)]
pub struct WatchRegistry {
    cancellations: RwLock<HashMap<String, CancellationToken>>,
}

const LIST_CHUNK_SIZE: u32 = 500;
const WATCH_BATCH_INTERVAL: Duration = Duration::from_millis(32);
const BULK_ACTION_CONCURRENCY: usize = 8;
const MAX_BULK_ACTION_ITEMS: usize = 10_000;

impl WatchRegistry {
    async fn insert(&self, id: String, token: CancellationToken) {
        self.cancellations.write().await.insert(id, token);
    }

    pub async fn stop(&self, id: &str) -> bool {
        if let Some(token) = self.cancellations.write().await.remove(id) {
            token.cancel();
            true
        } else {
            false
        }
    }
}

pub async fn discover_resources(
    registry: &ClusterRegistry,
    cluster_id: &str,
) -> Result<Vec<ApiResourceDescriptor>, String> {
    let client = registry.client(cluster_id).await?;
    let discovery = Discovery::new(client).run().await.map_err(kube_error)?;
    let mut resources = Vec::new();
    for group in discovery.groups_alphabetical() {
        for (resource, capabilities) in group.recommended_resources() {
            if !capabilities.supports_operation(verbs::LIST) {
                continue;
            }
            resources.push(ApiResourceDescriptor {
                api_version: resource.api_version,
                group: resource.group,
                version: resource.version,
                kind: resource.kind,
                plural: resource.plural,
                namespaced: capabilities.scope == Scope::Namespaced,
                verbs: capabilities.operations,
                categories: Vec::new(),
            });
        }
    }
    resources.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then(left.group.cmp(&right.group))
    });
    Ok(resources)
}

pub async fn list_resources(
    registry: &ClusterRegistry,
    request: ResourceListRequest,
) -> Result<ResourceListResponse, String> {
    let client = registry.client(&request.cluster_id).await?;
    let api = dynamic_api(
        client,
        &request.resource,
        request.namespace.as_deref(),
        false,
    )?;
    list_resource_pages(&api, &request).await
}

pub async fn get_resource(
    registry: &ClusterRegistry,
    target: ResourceTarget,
) -> Result<ResourceDetail, String> {
    let client = registry.client(&target.cluster_id).await?;
    let api = dynamic_api(client, &target.resource, target.namespace.as_deref(), true)?;
    let object = api.get(&target.name).await.map_err(kube_error)?;
    detail_from_object(object, &target.resource)
}

fn parse_manifest(manifest: &str, format: ManifestFormat) -> Result<Value, String> {
    let value: Value = match format {
        ManifestFormat::Yaml => {
            serde_yaml::from_str(manifest).map_err(|error| format!("Invalid YAML: {error}"))?
        }
        ManifestFormat::Json => {
            serde_json::from_str(manifest).map_err(|error| format!("Invalid JSON: {error}"))?
        }
    };
    if !value.is_object() {
        return Err("Manifest root must be an object".into());
    }
    Ok(value)
}

/// API-server-owned `metadata` keys that must never be sent in a patch:
/// they are read-only, or used by the API server for optimistic concurrency.
const IMMUTABLE_METADATA_KEYS: &[&str] = &[
    "uid",
    "resourceVersion",
    "creationTimestamp",
    "generation",
    "selfLink",
    "managedFields",
    "deletionTimestamp",
    "deletionGracePeriodSeconds",
];

/// Normalizes a manifest for diffing: drops `status`, `managedFields` and
/// API-server-owned metadata keys so they can never end up in a patch.
fn normalize_manifest_for_diff(value: &mut Value) {
    sanitize_manifest_object(value);
    if let Some(metadata) = value
        .pointer_mut("/metadata")
        .and_then(Value::as_object_mut)
    {
        for key in IMMUTABLE_METADATA_KEYS {
            metadata.remove(*key);
        }
    }
    if let Some(object) = value.as_object_mut() {
        object.remove("status");
    }
}

/// Computes a JSON merge patch (RFC 7386) that transforms `base` into `desired`:
///
/// - unchanged values are omitted;
/// - changed or new values are included;
/// - values present in `base` but absent from `desired` are emitted as `null`,
///   which deletes them — this is what makes removing fields such as
///   `spec.taints` actually take effect, regardless of which field manager
///   owns them (server-side apply would silently skip such removals).
///
/// Returns `None` when the two objects are equivalent.
fn merge_patch_between(base: &Value, desired: &Value) -> Option<Value> {
    match (base, desired) {
        (Value::Object(base_map), Value::Object(desired_map)) => {
            let mut patch = Map::new();
            for (key, desired_value) in desired_map {
                match base_map.get(key) {
                    Some(base_value) => {
                        if let Some(sub_patch) = merge_patch_between(base_value, desired_value) {
                            patch.insert(key.clone(), sub_patch);
                        }
                    }
                    None => {
                        patch.insert(key.clone(), desired_value.clone());
                    }
                }
            }
            for key in base_map.keys() {
                if !desired_map.contains_key(key) {
                    patch.insert(key.clone(), Value::Null);
                }
            }
            if patch.is_empty() {
                None
            } else {
                Some(Value::Object(patch))
            }
        }
        (base_value, desired_value) if base_value == desired_value => None,
        (_, desired_value) => Some(desired_value.clone()),
    }
}

pub async fn apply_manifest(
    registry: &ClusterRegistry,
    request: ApplyManifestRequest,
) -> Result<ResourceDetail, String> {
    let mut value = parse_manifest(&request.manifest, request.format)?;
    let api_version = value
        .pointer("/apiVersion")
        .and_then(Value::as_str)
        .ok_or_else(|| "Manifest is missing apiVersion".to_string())?
        .to_string();
    let kind = value
        .pointer("/kind")
        .and_then(Value::as_str)
        .ok_or_else(|| "Manifest is missing kind".to_string())?
        .to_string();
    let name = value
        .pointer("/metadata/name")
        .and_then(Value::as_str)
        .ok_or_else(|| "Manifest is missing metadata.name".to_string())?
        .to_string();
    if let Some(metadata) = value
        .pointer_mut("/metadata")
        .and_then(Value::as_object_mut)
    {
        metadata.remove("managedFields");
    }
    value.as_object_mut().map(|object| object.remove("status"));

    let client = registry.client(&request.cluster_id).await?;
    let descriptor = match request.resource {
        Some(resource) if resource.api_version == api_version && resource.kind == kind => resource,
        _ => resolve_descriptor(client.clone(), &api_version, &kind).await?,
    };
    let namespace = value.pointer("/metadata/namespace").and_then(Value::as_str);
    let api = dynamic_api(client, &descriptor, namespace, true)?;

    // Editing an existing resource: fetch its live state and send an exact
    // JSON merge patch instead of a server-side apply. Server-side apply
    // silently ignores removals of fields owned by other field managers
    // (e.g. taints added with `kubectl` or the Taints dialog), which made
    // "Applied successfully" report success while the edit had no effect.
    let current = match api.get(&name).await {
        Ok(object) => object,
        Err(error) => {
            let not_found = matches!(&error, kube::Error::Api(api_error) if api_error.code == 404);
            if !not_found {
                return Err(kube_error(error));
            }
            // The resource does not exist yet (create flow): fall back to
            // server-side apply, which can create it.
            let mut params = PatchParams::apply("kubehive").validation_strict();
            if request.dry_run {
                params = params.dry_run();
            }
            if request.force {
                params = params.force();
            }
            let object = api
                .patch(&name, &params, &Patch::Apply(&value))
                .await
                .map_err(kube_error)?;
            return detail_from_object(object, &descriptor);
        }
    };

    let mut base = serde_json::to_value(&current)
        .map_err(|error| format!("Unable to read current {} state: {error}", descriptor.kind))?;
    normalize_manifest_for_diff(&mut base);
    normalize_manifest_for_diff(&mut value);

    let Some(patch) = merge_patch_between(&base, &value) else {
        // Nothing changed: return the live object unchanged.
        return detail_from_object(current, &descriptor);
    };

    let params = PatchParams {
        field_manager: Some("kubehive".into()),
        field_validation: Some(ValidationDirective::Strict),
        dry_run: request.dry_run,
        ..PatchParams::default()
    };
    let object = api
        .patch(&name, &params, &Patch::Merge(&patch))
        .await
        .map_err(kube_error)?;
    detail_from_object(object, &descriptor)
}

pub async fn delete_resource(
    registry: &ClusterRegistry,
    request: DeleteResourceRequest,
) -> Result<(), String> {
    let client = registry.client(&request.target.cluster_id).await?;
    let api = dynamic_api(
        client,
        &request.target.resource,
        request.target.namespace.as_deref(),
        true,
    )?;
    let mut params = if request.foreground {
        DeleteParams::foreground()
    } else {
        DeleteParams::background()
    };
    if let Some(seconds) = request.grace_period_seconds {
        params = params.grace_period(seconds);
    }
    api.delete(&request.target.name, &params)
        .await
        .map_err(kube_error)?;
    Ok(())
}

type BulkActionOutcome = (String, String, Option<String>, Result<(), String>);

fn validate_bulk_action_size(count: usize) -> Result<(), String> {
    if count > MAX_BULK_ACTION_ITEMS {
        return Err(format!(
            "Bulk actions are limited to {MAX_BULK_ACTION_ITEMS} resources per request"
        ));
    }
    Ok(())
}

fn summarize_bulk_action(requested: usize, outcomes: Vec<BulkActionOutcome>) -> BulkActionResult {
    let mut succeeded = 0;
    let mut failures = Vec::new();
    for (kind, name, namespace, result) in outcomes {
        match result {
            Ok(()) => succeeded += 1,
            Err(error) => failures.push(BulkActionFailure {
                kind,
                name,
                namespace,
                error,
            }),
        }
    }
    BulkActionResult {
        requested,
        succeeded,
        failures,
    }
}

pub async fn delete_resources(
    registry: &ClusterRegistry,
    request: BulkDeleteResourcesRequest,
) -> Result<BulkActionResult, String> {
    let requested = request.targets.len();
    validate_bulk_action_size(requested)?;
    let outcomes = futures::stream::iter(request.targets.into_iter().map(|request| {
        let kind = request.target.resource.kind.clone();
        let name = request.target.name.clone();
        let namespace = request.target.namespace.clone();
        async move {
            let result = delete_resource(registry, request).await;
            (kind, name, namespace, result)
        }
    }))
    .buffer_unordered(BULK_ACTION_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;
    Ok(summarize_bulk_action(requested, outcomes))
}

fn eviction_params(grace_period_seconds: Option<u32>) -> EvictParams {
    let mut params = EvictParams::default();
    if let Some(seconds) = grace_period_seconds {
        params.delete_options = Some(DeleteParams::default().grace_period(seconds));
    }
    params
}

pub async fn evict_pod(registry: &ClusterRegistry, request: EvictPodRequest) -> Result<(), String> {
    if request.namespace.trim().is_empty() || request.pod.trim().is_empty() {
        return Err("Pod namespace and name are required".into());
    }
    let client = registry.client(&request.cluster_id).await?;
    let pods: Api<Pod> = Api::namespaced(client, &request.namespace);
    pods.evict(&request.pod, &eviction_params(request.grace_period_seconds))
        .await
        .map_err(eviction_error)?;
    Ok(())
}

pub async fn evict_pods(
    registry: &ClusterRegistry,
    request: BulkEvictPodsRequest,
) -> Result<BulkActionResult, String> {
    let requested = request.pods.len();
    validate_bulk_action_size(requested)?;
    let outcomes = futures::stream::iter(request.pods.into_iter().map(|request| {
        let name = request.pod.clone();
        let namespace = Some(request.namespace.clone());
        async move {
            let result = evict_pod(registry, request).await;
            ("Pod".into(), name, namespace, result)
        }
    }))
    .buffer_unordered(BULK_ACTION_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;
    Ok(summarize_bulk_action(requested, outcomes))
}

pub async fn scale_resource(
    registry: &ClusterRegistry,
    request: ScaleResourceRequest,
) -> Result<ResourceDetail, String> {
    if request.replicas < 0 {
        return Err("Replicas cannot be negative".into());
    }
    let client = registry.client(&request.target.cluster_id).await?;
    let api = dynamic_api(
        client,
        &request.target.resource,
        request.target.namespace.as_deref(),
        true,
    )?;
    let patch = json!({"spec": {"replicas": request.replicas}});
    let object = api
        .patch(
            &request.target.name,
            &PatchParams::default(),
            &Patch::Merge(&patch),
        )
        .await
        .map_err(kube_error)?;
    detail_from_object(object, &request.target.resource)
}

pub async fn restart_resource(
    registry: &ClusterRegistry,
    target: ResourceTarget,
) -> Result<ResourceDetail, String> {
    if target.resource.kind == "Pod" {
        return Err("Pods do not support restart; use eviction instead".into());
    }
    let client = registry.client(&target.cluster_id).await?;
    let api = dynamic_api(client, &target.resource, target.namespace.as_deref(), true)?;
    let timestamp = Utc::now().to_rfc3339();
    let patch = json!({"spec": {"template": {"metadata": {"annotations": {"kubehive.dev/restartedAt": timestamp}}}}});
    let object = api
        .patch(&target.name, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .map_err(kube_error)?;
    detail_from_object(object, &target.resource)
}

pub async fn pod_logs(
    registry: &ClusterRegistry,
    request: PodLogsRequest,
) -> Result<String, String> {
    let client = registry.client(&request.cluster_id).await?;
    let pods: Api<Pod> = Api::namespaced(client, &request.namespace);
    let params = LogParams {
        container: request.container,
        tail_lines: Some(request.tail_lines.unwrap_or(500).clamp(1, 10_000)),
        since_seconds: request.since_seconds,
        timestamps: request.timestamps,
        previous: request.previous,
        ..Default::default()
    };
    pods.logs(&request.pod, &params).await.map_err(kube_error)
}

pub async fn exec_pod(
    registry: &ClusterRegistry,
    request: ExecPodRequest,
) -> Result<ExecResult, String> {
    if request.command.is_empty() {
        return Err("A command is required".into());
    }
    let client = registry.client(&request.cluster_id).await?;
    let pods: Api<Pod> = Api::namespaced(client, &request.namespace);
    let params = AttachParams {
        container: request.container,
        stdin: false,
        stdout: true,
        stderr: true,
        tty: false,
        ..Default::default()
    };
    let mut process = pods
        .exec(&request.pod, request.command, &params)
        .await
        .map_err(kube_error)?;
    let status = process.take_status();
    let mut stdout_reader = process
        .stdout()
        .ok_or_else(|| "The exec stream did not provide stdout".to_string())?;
    let mut stderr_reader = process
        .stderr()
        .ok_or_else(|| "The exec stream did not provide stderr".to_string())?;
    let mut stdout = String::new();
    let mut stderr = String::new();
    let (stdout_result, stderr_result) = tokio::join!(
        stdout_reader.read_to_string(&mut stdout),
        stderr_reader.read_to_string(&mut stderr)
    );
    stdout_result.map_err(|error| format!("Unable to read command output: {error}"))?;
    stderr_result.map_err(|error| format!("Unable to read command error output: {error}"))?;
    process
        .join()
        .await
        .map_err(|error| format!("Remote command failed: {error}"))?;
    let status = match status {
        Some(status) => status.await,
        None => None,
    };
    let success = command_succeeded(status.as_ref(), &stderr);
    let status_text = remote_status_text(status.as_ref());
    Ok(ExecResult {
        stdout,
        stderr,
        success,
        status: status_text,
    })
}

pub async fn start_watch(
    registry: Arc<ClusterRegistry>,
    watches: Arc<WatchRegistry>,
    request: ResourceListRequest,
    channel: Channel<ResourceWatchMessage>,
) -> Result<String, String> {
    let client = registry.streaming_client(&request.cluster_id).await?;
    let api = dynamic_api(
        client,
        &request.resource,
        request.namespace.as_deref(),
        false,
    )?;
    let id = Uuid::new_v4().to_string();
    let cancellation = CancellationToken::new();
    watches.insert(id.clone(), cancellation.clone()).await;
    let subscription_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let mut version = request
            .resource_version
            .clone()
            .unwrap_or_else(|| "0".into());
        loop {
            if cancellation.is_cancelled() {
                break;
            }
            let params = watch_params(&request);
            let stream = match api.watch(&params, &version).await {
                Ok(stream) => stream,
                Err(error) => {
                    if matches!(&error, kube::Error::Api(response) if response.code == 410) {
                        match send_watch_snapshot(&api, &request, &channel, &subscription_id).await
                        {
                            Ok(next_version) => {
                                version = next_version;
                                continue;
                            }
                            Err(snapshot_error) => {
                                if send_watch_error(
                                    &channel,
                                    &subscription_id,
                                    &version,
                                    snapshot_error,
                                )
                                .is_err()
                                {
                                    cancellation.cancel();
                                    break;
                                }
                            }
                        }
                    } else if send_watch_error(
                        &channel,
                        &subscription_id,
                        &version,
                        error.to_string(),
                    )
                    .is_err()
                    {
                        cancellation.cancel();
                        break;
                    }
                    tokio::select! {
                        _ = cancellation.cancelled() => break,
                        _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                    }
                    continue;
                }
            };
            let mut stream = stream.boxed();
            let mut pending = HashMap::<String, ResourceWatchEvent>::new();
            let mut flush = tokio::time::interval(WATCH_BATCH_INTERVAL);
            flush.set_missed_tick_behavior(MissedTickBehavior::Skip);
            flush.tick().await;
            let mut needs_relist = false;
            let mut retry_delay = false;
            loop {
                tokio::select! {
                    _ = cancellation.cancelled() => break,
                    _ = flush.tick() => {
                        if flush_watch_events(&channel, &subscription_id, &version, &mut pending).is_err() {
                            cancellation.cancel();
                            break;
                        }
                    }
                    value = stream.try_next() => match value {
                        Ok(Some(event)) => match event {
                            WatchEvent::Added(object) => queue_watch_record(&mut pending, "added", object, &request.resource, request.compact, &mut version),
                            WatchEvent::Modified(object) => queue_watch_record(&mut pending, "modified", object, &request.resource, request.compact, &mut version),
                            WatchEvent::Deleted(object) => queue_watch_record(&mut pending, "deleted", object, &request.resource, request.compact, &mut version),
                            WatchEvent::Bookmark(bookmark) => version = bookmark.metadata.resource_version,
                            WatchEvent::Error(error) => {
                                if error.code == 410 {
                                    needs_relist = true;
                                } else {
                                    retry_delay = true;
                                    if send_watch_error(&channel, &subscription_id, &version, error.to_string()).is_err() {
                                        cancellation.cancel();
                                    }
                                }
                                break;
                            }
                        },
                        Ok(None) => break,
                        Err(error) => {
                            if matches!(&error, kube::Error::Api(response) if response.code == 410) {
                                needs_relist = true;
                            } else {
                                retry_delay = true;
                                if send_watch_error(&channel, &subscription_id, &version, error.to_string()).is_err() {
                                    cancellation.cancel();
                                }
                            }
                            break;
                        }
                    }
                }
            }
            if cancellation.is_cancelled() {
                break;
            }
            if flush_watch_events(&channel, &subscription_id, &version, &mut pending).is_err() {
                cancellation.cancel();
                break;
            }
            if needs_relist {
                match send_watch_snapshot(&api, &request, &channel, &subscription_id).await {
                    Ok(next_version) => version = next_version,
                    Err(error) => {
                        if send_watch_error(&channel, &subscription_id, &version, error).is_err() {
                            cancellation.cancel();
                            break;
                        }
                        retry_delay = true;
                    }
                }
            }
            if retry_delay {
                tokio::select! {
                    _ = cancellation.cancelled() => break,
                    _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                }
            }
        }
        watches.stop(&subscription_id).await;
    });
    Ok(id)
}

fn queue_watch_record(
    pending: &mut HashMap<String, ResourceWatchEvent>,
    event_type: &str,
    object: DynamicObject,
    descriptor: &ApiResourceDescriptor,
    compact: bool,
    version: &mut String,
) {
    if let Some(next) = object.metadata.resource_version.clone() {
        *version = next;
    }
    if let Ok(resource) = record_from_object(object, descriptor, compact) {
        pending.insert(
            resource.key.clone(),
            ResourceWatchEvent {
                event_type: event_type.into(),
                resource,
            },
        );
    }
}

fn flush_watch_events(
    channel: &Channel<ResourceWatchMessage>,
    subscription_id: &str,
    version: &str,
    pending: &mut HashMap<String, ResourceWatchEvent>,
) -> Result<(), String> {
    if pending.is_empty() {
        return Ok(());
    }
    channel
        .send(ResourceWatchMessage {
            subscription_id: subscription_id.into(),
            event_type: "batch".into(),
            events: pending.drain().map(|(_, event)| event).collect(),
            resources: Vec::new(),
            resource_version: Some(version.into()),
            error: None,
        })
        .map_err(|error| error.to_string())
}

fn send_watch_error(
    channel: &Channel<ResourceWatchMessage>,
    subscription_id: &str,
    version: &str,
    error: String,
) -> Result<(), String> {
    channel
        .send(ResourceWatchMessage {
            subscription_id: subscription_id.into(),
            event_type: "error".into(),
            events: Vec::new(),
            resources: Vec::new(),
            resource_version: Some(version.into()),
            error: Some(error),
        })
        .map_err(|send_error| send_error.to_string())
}

async fn send_watch_snapshot(
    api: &Api<DynamicObject>,
    request: &ResourceListRequest,
    channel: &Channel<ResourceWatchMessage>,
    subscription_id: &str,
) -> Result<String, String> {
    let response = list_resource_pages(api, request).await?;
    let version = response.resource_version.clone();
    channel
        .send(ResourceWatchMessage {
            subscription_id: subscription_id.into(),
            event_type: "snapshot".into(),
            events: Vec::new(),
            resources: response.items,
            resource_version: Some(version.clone()),
            error: None,
        })
        .map_err(|error| error.to_string())?;
    Ok(version)
}

async fn list_resource_pages(
    api: &Api<DynamicObject>,
    request: &ResourceListRequest,
) -> Result<ResourceListResponse, String> {
    let mut continue_token: Option<String> = None;
    let mut resource_version = "0".to_string();
    let mut items = Vec::new();
    loop {
        let mut params = list_params(request).limit(LIST_CHUNK_SIZE);
        if let Some(token) = continue_token.as_deref() {
            params = params.continue_token(token);
        }
        let list = api.list(&params).await.map_err(kube_error)?;
        if let Some(version) = list.metadata.resource_version {
            resource_version = version;
        }
        continue_token = list.metadata.continue_.filter(|token| !token.is_empty());
        items.extend(
            list.items
                .into_iter()
                .map(|object| record_from_object(object, &request.resource, request.compact))
                .collect::<Result<Vec<_>, _>>()?,
        );
        if continue_token.is_none() {
            break;
        }
    }
    Ok(ResourceListResponse {
        resource_version,
        items,
    })
}

fn dynamic_api(
    client: Client,
    descriptor: &ApiResourceDescriptor,
    namespace: Option<&str>,
    require_namespace: bool,
) -> Result<Api<DynamicObject>, String> {
    let resource = ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk(&descriptor.group, &descriptor.version, &descriptor.kind),
        &descriptor.plural,
    );
    if descriptor.namespaced {
        let namespace = namespace.filter(|value| !value.is_empty() && *value != "All namespaces");
        if let Some(namespace) = namespace {
            Ok(Api::namespaced_with(client, namespace, &resource))
        } else if require_namespace {
            Err(format!("A namespace is required for {}", descriptor.kind))
        } else {
            Ok(Api::all_with(client, &resource))
        }
    } else {
        Ok(Api::all_with(client, &resource))
    }
}

fn list_params(request: &ResourceListRequest) -> ListParams {
    let mut params = ListParams::default();
    if let Some(labels) = request
        .label_selector
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        params = params.labels(labels);
    }
    if let Some(fields) = request
        .field_selector
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        params = params.fields(fields);
    }
    params
}

fn watch_params(request: &ResourceListRequest) -> WatchParams {
    let mut params = WatchParams::default().timeout(60);
    if let Some(labels) = request
        .label_selector
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        params = params.labels(labels);
    }
    if let Some(fields) = request
        .field_selector
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        params = params.fields(fields);
    }
    params
}

async fn resolve_descriptor(
    client: Client,
    api_version: &str,
    kind: &str,
) -> Result<ApiResourceDescriptor, String> {
    let (group, version) = api_version.split_once('/').unwrap_or(("", api_version));
    let discovery = Discovery::new(client).run().await.map_err(kube_error)?;
    let gvk = GroupVersionKind::gvk(group, version, kind);
    let (resource, capabilities) = discovery
        .resolve_gvk(&gvk)
        .ok_or_else(|| format!("The cluster does not serve {api_version}/{kind}"))?;
    Ok(ApiResourceDescriptor {
        api_version: resource.api_version,
        group: resource.group,
        version: resource.version,
        kind: resource.kind,
        plural: resource.plural,
        namespaced: capabilities.scope == Scope::Namespaced,
        verbs: capabilities.operations,
        categories: Vec::new(),
    })
}

fn detail_from_object(
    object: DynamicObject,
    descriptor: &ApiResourceDescriptor,
) -> Result<ResourceDetail, String> {
    let manifest = manifest_from_object(&object)?;
    let record = record_from_object(object, descriptor, false)?;
    Ok(ResourceDetail { record, manifest })
}

fn manifest_from_object(object: &DynamicObject) -> Result<String, String> {
    let mut value = serde_json::to_value(object)
        .map_err(|error| format!("Unable to normalize resource manifest: {error}"))?;
    sanitize_manifest_object(&mut value);
    serde_yaml::to_string(&value)
        .map_err(|error| format!("Unable to serialize resource YAML: {error}"))
}

fn sanitize_manifest_object(value: &mut Value) {
    if let Some(metadata) = value
        .pointer_mut("/metadata")
        .and_then(Value::as_object_mut)
    {
        metadata.remove("managedFields");
    }
}

fn record_from_object(
    object: DynamicObject,
    descriptor: &ApiResourceDescriptor,
    compact: bool,
) -> Result<ResourceRecord, String> {
    let name = object.name_any();
    let namespace = object.namespace().unwrap_or_else(|| "—".into());
    let uid = object.metadata.uid.clone();
    let resource_version = object.metadata.resource_version.clone();
    let created_at = object
        .metadata
        .creation_timestamp
        .as_ref()
        .map(|time| time.0.to_rfc3339());
    let age_seconds = object
        .metadata
        .creation_timestamp
        .as_ref()
        .map(|time| (Utc::now() - time.0).num_seconds().max(0));
    let mut value = serde_json::to_value(&object)
        .map_err(|error| format!("Unable to normalize {}: {error}", descriptor.kind))?;
    sanitize_object(&mut value, &descriptor.kind, compact);
    Ok(ResourceRecord {
        key: if descriptor.namespaced {
            format!("{namespace}/{name}")
        } else {
            name.clone()
        },
        name,
        namespace,
        uid,
        resource_version,
        api_version: descriptor.api_version.clone(),
        kind: descriptor.kind.clone(),
        created_at,
        age_seconds,
        object: value,
    })
}

fn sanitize_object(value: &mut Value, kind: &str, compact: bool) {
    if let Some(metadata) = value
        .pointer_mut("/metadata")
        .and_then(Value::as_object_mut)
    {
        metadata.remove("managedFields");
        if compact {
            metadata.retain(|key, _| {
                matches!(
                    key.as_str(),
                    "name"
                        | "namespace"
                        | "uid"
                        | "resourceVersion"
                        | "creationTimestamp"
                        | "labels"
                        | "ownerReferences"
                        | "deletionTimestamp"
                )
            });
        }
    }
    if let Some(object) = value.as_object_mut() {
        if kind == "Secret" {
            if let Some(data) = object.get_mut("data").and_then(Value::as_object_mut) {
                for secret in data.values_mut() {
                    *secret = Value::String("••••••••".into());
                }
            }
            object.remove("stringData");
        }
        if compact && kind == "ConfigMap" {
            if let Some(data) = object.get_mut("data").and_then(Value::as_object_mut) {
                for entry in data.values_mut() {
                    *entry = Value::Null;
                }
            }
            if let Some(data) = object.get_mut("binaryData").and_then(Value::as_object_mut) {
                for entry in data.values_mut() {
                    *entry = Value::Null;
                }
            }
        }
    }
}

fn eviction_error(error: kube::Error) -> String {
    match error {
        kube::Error::Api(response) if response.code == 429 => format!(
            "Eviction blocked by a PodDisruptionBudget or disruption policy: {}",
            response.message
        ),
        other => kube_error(other),
    }
}

fn kube_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bulk_action_summary_keeps_partial_failures() {
        let summary = summarize_bulk_action(
            3,
            vec![
                ("Pod".into(), "one".into(), Some("default".into()), Ok(())),
                (
                    "Pod".into(),
                    "two".into(),
                    Some("default".into()),
                    Err("blocked".into()),
                ),
                ("Pod".into(), "three".into(), Some("default".into()), Ok(())),
            ],
        );
        assert_eq!(summary.requested, 3);
        assert_eq!(summary.succeeded, 2);
        assert_eq!(summary.failures.len(), 1);
        assert_eq!(summary.failures[0].name, "two");
        assert!(validate_bulk_action_size(MAX_BULK_ACTION_ITEMS).is_ok());
        assert!(validate_bulk_action_size(MAX_BULK_ACTION_ITEMS + 1).is_err());
    }

    #[test]
    fn merge_patch_between_removes_absent_fields() {
        // Deleting a field (e.g. spec.taints) must produce a `null` entry so
        // the merge patch actually removes it regardless of which field
        // manager owns it; unchanged values must be omitted entirely.
        let base = json!({
            "apiVersion": "v1",
            "kind": "Node",
            "metadata": {
                "name": "node-1",
                "resourceVersion": "12345",
                "labels": {"a": "1", "b": "2"},
            },
            "spec": {
                "taints": [{"key": "k", "value": "v", "effect": "NoSchedule"}],
                "unschedulable": false,
            },
            "status": {"conditions": []},
        });
        let desired = json!({
            "apiVersion": "v1",
            "kind": "Node",
            "metadata": {
                "name": "node-1",
                "resourceVersion": "12345",
                "labels": {"a": "1", "b": "2", "c": "3"},
            },
            "spec": {"unschedulable": false},
            "status": {"conditions": []},
        });
        let patch = merge_patch_between(&base, &desired).expect("diff is not empty");
        assert_eq!(
            patch,
            json!({
                "metadata": {"labels": {"c": "3"}},
                "spec": {"taints": null},
            })
        );

        // Identical objects produce no patch (no API call needed).
        assert!(merge_patch_between(&base, &base).is_none());

        // Normalization strips status, managedFields and immutable metadata
        // keys so they can never leak into a patch.
        let mut normalized_base = base.clone();
        let mut normalized_desired = desired.clone();
        normalize_manifest_for_diff(&mut normalized_base);
        normalize_manifest_for_diff(&mut normalized_desired);
        let patch = merge_patch_between(&normalized_base, &normalized_desired).unwrap();
        assert_eq!(
            patch,
            json!({
                "metadata": {"labels": {"c": "3"}},
                "spec": {"taints": null},
            })
        );
        let mut normalized_dup = base.clone();
        normalize_manifest_for_diff(&mut normalized_dup);
        assert!(merge_patch_between(&normalized_dup, &normalized_base).is_none());
    }

    #[test]
    fn eviction_params_preserve_grace_period() {
        assert!(eviction_params(None).delete_options.is_none());
        assert_eq!(
            eviction_params(Some(30))
                .delete_options
                .and_then(|options| options.grace_period_seconds),
            Some(30)
        );
    }

    #[test]
    fn eviction_reports_disruption_budget_blocks() {
        let message = eviction_error(kube::Error::Api(kube::core::ErrorResponse {
            status: "Failure".into(),
            message: "Cannot evict pod as it would violate the pod's disruption budget".into(),
            reason: "TooManyRequests".into(),
            code: 429,
        }));
        assert!(message.contains("PodDisruptionBudget"));
        assert!(message.contains("Cannot evict pod"));
    }

    #[test]
    fn manifest_parser_respects_selected_format() {
        let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n";
        let json = r#"{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"demo"}}"#;
        assert_eq!(
            parse_manifest(yaml, ManifestFormat::Yaml)
                .unwrap()
                .pointer("/metadata/name")
                .and_then(Value::as_str),
            Some("demo")
        );
        assert_eq!(
            parse_manifest(json, ManifestFormat::Json)
                .unwrap()
                .pointer("/kind")
                .and_then(Value::as_str),
            Some("ConfigMap")
        );
        assert!(parse_manifest(yaml, ManifestFormat::Json)
            .unwrap_err()
            .starts_with("Invalid JSON:"));
        assert!(parse_manifest("[]", ManifestFormat::Json)
            .unwrap_err()
            .contains("root must be an object"));
    }

    #[test]
    fn secret_values_are_masked() {
        let mut value = json!({"metadata": {"managedFields": [1]}, "data": {"token": "c2VjcmV0"}, "stringData": {"password": "secret"}});
        sanitize_object(&mut value, "Secret", false);
        assert_eq!(
            value.pointer("/data/token").and_then(Value::as_str),
            Some("••••••••")
        );
        assert!(value.pointer("/metadata/managedFields").is_none());
        assert!(value.pointer("/stringData").is_none());
    }

    #[test]
    fn manifest_view_keeps_secret_values_while_the_record_stays_masked() {
        let object = serde_json::from_value::<DynamicObject>(json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {"name": "api-token", "managedFields": []},
            "data": {"token": "c2VjcmV0"}
        }))
        .unwrap();
        let descriptor = ApiResourceDescriptor {
            api_version: "v1".into(),
            group: "".into(),
            version: "v1".into(),
            kind: "Secret".into(),
            plural: "secrets".into(),
            namespaced: true,
            verbs: vec!["get".into()],
            categories: vec![],
        };
        let detail = detail_from_object(object, &descriptor).unwrap();
        assert!(detail.manifest.contains("c2VjcmV0"));
        assert!(!detail.manifest.contains("managedFields"));
        assert_eq!(
            detail
                .record
                .object
                .pointer("/data/token")
                .and_then(Value::as_str),
            Some("••••••••")
        );
    }

    #[test]
    fn compact_list_objects_remove_heavy_values() {
        let mut value = json!({
            "metadata": {
                "name": "settings",
                "namespace": "default",
                "uid": "123",
                "resourceVersion": "42",
                "creationTimestamp": "2026-01-01T00:00:00Z",
                "labels": {"app": "demo"},
                "annotations": {"kubectl.kubernetes.io/last-applied-configuration": "large"},
                "managedFields": [1],
                "finalizers": ["example.dev/finalizer"]
            },
            "data": {"large.yaml": "very large content"},
            "binaryData": {"archive": "AAAA"}
        });
        sanitize_object(&mut value, "ConfigMap", true);
        assert!(value.pointer("/metadata/annotations").is_none());
        assert!(value.pointer("/metadata/managedFields").is_none());
        assert!(value.pointer("/metadata/finalizers").is_none());
        assert_eq!(
            value
                .pointer("/metadata/labels/app")
                .and_then(Value::as_str),
            Some("demo")
        );
        assert!(value
            .pointer("/data/large.yaml")
            .is_some_and(Value::is_null));
        assert!(value
            .pointer("/binaryData/archive")
            .is_some_and(Value::is_null));
    }

    #[tokio::test]
    async fn live_kubeconfig_data_plane_when_requested() {
        if std::env::var("KUBEHIVE_LIVE_TEST").as_deref() != Ok("1") {
            return;
        }
        let kubeconfig = kube::config::Kubeconfig::read().expect("live test requires kubeconfig");
        let context = kubeconfig
            .current_context
            .clone()
            .expect("live test requires current-context");
        let config_dir =
            std::env::temp_dir().join(format!("kubehive-live-test-{}", uuid::Uuid::new_v4()));
        let registry = ClusterRegistry::new(config_dir);
        let cluster_id = format!("default:{context}");
        let client = registry
            .client(&cluster_id)
            .await
            .expect("connect current context");
        let version = client
            .apiserver_version()
            .await
            .expect("read API server version");
        assert!(!version.git_version.is_empty());
        let descriptor = ApiResourceDescriptor {
            api_version: "v1".into(),
            group: "".into(),
            version: "v1".into(),
            kind: "Pod".into(),
            plural: "pods".into(),
            namespaced: true,
            verbs: vec!["list".into(), "watch".into()],
            categories: vec![],
        };
        let response = list_resources(
            &registry,
            ResourceListRequest {
                cluster_id: cluster_id.clone(),
                resource: descriptor,
                namespace: None,
                label_selector: None,
                field_selector: None,
                resource_version: None,
                compact: true,
            },
        )
        .await
        .expect("list pods through normalized command service");
        assert!(!response.resource_version.is_empty());
        for item in response.items.iter().take(3) {
            assert_eq!(item.kind, "Pod");
            assert!(!item.name.is_empty());
        }
        let discovered = discover_resources(&registry, &cluster_id)
            .await
            .expect("discover served APIs");
        assert!(discovered
            .iter()
            .any(|resource| resource.kind == "Pod"
                && resource.verbs.iter().any(|verb| verb == "list")));
        let overview = crate::overview::cluster_overview(&registry, &cluster_id)
            .await
            .expect("load live overview aggregation");
        assert_eq!(overview.cluster_id, cluster_id);
        assert!(overview.ready_nodes <= overview.nodes);
        assert!(overview.running_pods <= overview.pods);

        let namespace = registry
            .entry(&cluster_id)
            .await
            .expect("read registry entry")
            .default_namespace;
        let name = format!("kubehive-dry-run-{}", uuid::Uuid::new_v4().simple());
        let config_map = ApiResourceDescriptor {
            api_version: "v1".into(),
            group: "".into(),
            version: "v1".into(),
            kind: "ConfigMap".into(),
            plural: "configmaps".into(),
            namespaced: true,
            verbs: vec!["get".into(), "list".into(), "create".into(), "patch".into()],
            categories: vec![],
        };
        let manifest = format!("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {name}\n  namespace: {namespace}\ndata:\n  smoke: ok\n");
        let applied = apply_manifest(
            &registry,
            ApplyManifestRequest {
                cluster_id: cluster_id.clone(),
                manifest,
                format: ManifestFormat::Yaml,
                resource: Some(config_map.clone()),
                dry_run: true,
                force: false,
            },
        )
        .await
        .expect("server-side apply dry-run");
        assert_eq!(applied.record.name, name);
        let persisted = list_resources(
            &registry,
            ResourceListRequest {
                cluster_id,
                resource: config_map,
                namespace: Some(namespace),
                label_selector: None,
                field_selector: Some(format!("metadata.name={name}")),
                resource_version: None,
                compact: false,
            },
        )
        .await
        .expect("verify dry-run did not persist");
        assert!(persisted.items.is_empty());
    }

    #[test]
    fn descriptor_round_trip_uses_explicit_plural() {
        let descriptor = ApiResourceDescriptor {
            api_version: "example.dev/v1".into(),
            group: "example.dev".into(),
            version: "v1".into(),
            kind: "Person".into(),
            plural: "people".into(),
            namespaced: true,
            verbs: vec!["list".into()],
            categories: vec![],
        };
        let resource = ApiResource::from_gvk_with_plural(
            &GroupVersionKind::gvk(&descriptor.group, &descriptor.version, &descriptor.kind),
            &descriptor.plural,
        );
        assert_eq!(resource.plural, "people");
    }
}
