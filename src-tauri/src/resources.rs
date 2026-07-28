use crate::{
    models::{
        ApiResourceDescriptor, ApplyManifestRequest, DeleteResourceRequest, ExecPodRequest,
        ExecResult, PodLogsRequest, ResourceDetail, ResourceListRequest, ResourceListResponse,
        ResourceRecord, ResourceTarget, ResourceWatchMessage, ScaleResourceRequest,
    },
    registry::ClusterRegistry,
};
use chrono::Utc;
use futures::{StreamExt, TryStreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::{
    api::{
        Api, AttachParams, DeleteParams, DynamicObject, ListParams, LogParams, Patch, PatchParams,
        ResourceExt, WatchEvent, WatchParams,
    },
    core::{ApiResource, GroupVersionKind},
    discovery::{verbs, Discovery, Scope},
    Client,
};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tauri::ipc::Channel;
use tokio::{io::AsyncReadExt, sync::RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Default)]
pub struct WatchRegistry {
    cancellations: RwLock<HashMap<String, CancellationToken>>,
}

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
    let params = list_params(&request);
    let list = api.list(&params).await.map_err(kube_error)?;
    let resource_version = list.metadata.resource_version.unwrap_or_else(|| "0".into());
    let items = list
        .items
        .into_iter()
        .map(|object| record_from_object(object, &request.resource))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ResourceListResponse {
        resource_version,
        items,
    })
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

pub async fn apply_manifest(
    registry: &ClusterRegistry,
    request: ApplyManifestRequest,
) -> Result<ResourceDetail, String> {
    let mut value: Value = serde_yaml::from_str(&request.manifest)
        .map_err(|error| format!("Invalid YAML: {error}"))?;
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
    let client = registry.client(&target.cluster_id).await?;
    let api = dynamic_api(client, &target.resource, target.namespace.as_deref(), true)?;
    if target.resource.kind == "Pod" {
        let object = api.get(&target.name).await.map_err(kube_error)?;
        api.delete(&target.name, &DeleteParams::background())
            .await
            .map_err(kube_error)?;
        return detail_from_object(object, &target.resource);
    }
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
    let status_text = match status {
        Some(status) => status.await.and_then(|value| value.message),
        None => None,
    };
    let success = status_text
        .as_deref()
        .map(|value| value.is_empty() || value.eq_ignore_ascii_case("success"))
        .unwrap_or(stderr.is_empty());
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
    let client = registry.client(&request.cluster_id).await?;
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
                        version = "0".into();
                    }
                    let _ = channel.send(ResourceWatchMessage {
                        subscription_id: subscription_id.clone(),
                        event_type: "error".into(),
                        resource: None,
                        resource_version: Some(version.clone()),
                        error: Some(error.to_string()),
                    });
                    tokio::select! { _ = cancellation.cancelled() => break, _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {} }
                    continue;
                }
            };
            let mut stream = stream.boxed();
            loop {
                let next = tokio::select! {
                    _ = cancellation.cancelled() => None,
                    value = stream.try_next() => match value {
                        Ok(value) => value,
                        Err(error) => {
                            if matches!(&error, kube::Error::Api(response) if response.code == 410) {
                                version = "0".into();
                            }
                            let _ = channel.send(ResourceWatchMessage { subscription_id: subscription_id.clone(), event_type: "error".into(), resource: None, resource_version: Some(version.clone()), error: Some(error.to_string()) });
                            break;
                        }
                    }
                };
                let Some(event) = next else {
                    break;
                };
                let message = match event {
                    WatchEvent::Added(object) => watch_record(
                        &subscription_id,
                        "added",
                        object,
                        &request.resource,
                        &mut version,
                    ),
                    WatchEvent::Modified(object) => watch_record(
                        &subscription_id,
                        "modified",
                        object,
                        &request.resource,
                        &mut version,
                    ),
                    WatchEvent::Deleted(object) => watch_record(
                        &subscription_id,
                        "deleted",
                        object,
                        &request.resource,
                        &mut version,
                    ),
                    WatchEvent::Bookmark(bookmark) => {
                        version = bookmark.metadata.resource_version.clone();
                        ResourceWatchMessage {
                            subscription_id: subscription_id.clone(),
                            event_type: "bookmark".into(),
                            resource: None,
                            resource_version: Some(version.clone()),
                            error: None,
                        }
                    }
                    WatchEvent::Error(error) => {
                        if error.code == 410 {
                            version = "0".into();
                        }
                        ResourceWatchMessage {
                            subscription_id: subscription_id.clone(),
                            event_type: "error".into(),
                            resource: None,
                            resource_version: Some(version.clone()),
                            error: Some(error.to_string()),
                        }
                    }
                };
                if channel.send(message).is_err() {
                    cancellation.cancel();
                    break;
                }
            }
        }
        watches.stop(&subscription_id).await;
    });
    Ok(id)
}

fn watch_record(
    id: &str,
    event_type: &str,
    object: DynamicObject,
    descriptor: &ApiResourceDescriptor,
    version: &mut String,
) -> ResourceWatchMessage {
    if let Some(next) = object.metadata.resource_version.clone() {
        *version = next;
    }
    match record_from_object(object, descriptor) {
        Ok(resource) => ResourceWatchMessage {
            subscription_id: id.into(),
            event_type: event_type.into(),
            resource: Some(resource),
            resource_version: Some(version.clone()),
            error: None,
        },
        Err(error) => ResourceWatchMessage {
            subscription_id: id.into(),
            event_type: "error".into(),
            resource: None,
            resource_version: Some(version.clone()),
            error: Some(error),
        },
    }
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
    let record = record_from_object(object, descriptor)?;
    let manifest = serde_yaml::to_string(&record.object)
        .map_err(|error| format!("Unable to serialize resource YAML: {error}"))?;
    Ok(ResourceDetail { record, manifest })
}

fn record_from_object(
    object: DynamicObject,
    descriptor: &ApiResourceDescriptor,
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
    sanitize_object(&mut value, &descriptor.kind);
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

fn sanitize_object(value: &mut Value, kind: &str) {
    if let Some(metadata) = value
        .pointer_mut("/metadata")
        .and_then(Value::as_object_mut)
    {
        metadata.remove("managedFields");
    }
    if kind == "Secret" {
        if let Some(object) = value.as_object_mut() {
            if let Some(data) = object.get_mut("data").and_then(Value::as_object_mut) {
                for secret in data.values_mut() {
                    *secret = Value::String("••••••••".into());
                }
            }
            object.remove("stringData");
        }
    }
}

fn kube_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_values_are_masked() {
        let mut value = json!({"metadata": {"managedFields": [1]}, "data": {"token": "c2VjcmV0"}, "stringData": {"password": "secret"}});
        sanitize_object(&mut value, "Secret");
        assert_eq!(
            value.pointer("/data/token").and_then(Value::as_str),
            Some("••••••••")
        );
        assert!(value.pointer("/metadata/managedFields").is_none());
        assert!(value.pointer("/stringData").is_none());
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
