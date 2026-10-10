use crate::{
    models::{PortForwardSession, PortForwardTargetKind, StartPortForwardRequest},
    registry::ClusterRegistry,
};
use k8s_openapi::{
    api::{
        core::v1::{EndpointAddress, Endpoints, ObjectReference, Pod, Service, ServicePort},
        discovery::v1::{Endpoint, EndpointPort as SliceEndpointPort, EndpointSlice},
    },
    apimachinery::pkg::util::intstr::IntOrString,
};
use kube::{api::ListParams, Api, Client};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{
    io::copy_bidirectional,
    net::TcpListener,
    sync::{Mutex, RwLock},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct RunningForward {
    session: PortForwardSession,
    cancellation: CancellationToken,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedPortForward {
    id: String,
    cluster_id: String,
    namespace: String,
    target_kind: PortForwardTargetKind,
    target_name: String,
    /// The requested local port; zero requests automatic assignment.
    local_port: u16,
    /// The kernel-assigned local port for an automatic forward, reused across restarts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    assigned_local_port: Option<u16>,
    host: String,
    protocol: String,
    /// Pod port for Pod targets; Service port for Service targets.
    remote_port: u16,
    /// Resolved endpoint Pod name (Service targets only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pod: Option<String>,
    /// Resolved endpoint Pod port (Service targets only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pod_port: Option<u16>,
    #[serde(default)]
    paused: bool,
}

impl PersistedPortForward {
    fn matches_target(&self, request: &StartPortForwardRequest) -> bool {
        self.cluster_id == request.cluster_id
            && self.namespace == request.namespace
            && self.target_kind == request.target_kind
            && self.target_name == request.target_name
            && self.remote_port == request.remote_port
    }

    fn effective_local_port(&self) -> u16 {
        if self.local_port != 0 {
            self.local_port
        } else {
            self.assigned_local_port.unwrap_or(0)
        }
    }

    fn paused_session(&self) -> PortForwardSession {
        PortForwardSession {
            id: self.id.clone(),
            cluster_id: self.cluster_id.clone(),
            namespace: self.namespace.clone(),
            target_kind: self.target_kind,
            target_name: self.target_name.clone(),
            pod: self.pod.clone().unwrap_or_else(|| {
                if self.target_kind == PortForwardTargetKind::Pod {
                    self.target_name.clone()
                } else {
                    String::new()
                }
            }),
            host: self.host.clone(),
            protocol: self.protocol.clone(),
            local_port: self.effective_local_port(),
            remote_port: self.pod_port.unwrap_or(self.remote_port),
            service_port: (self.target_kind == PortForwardTargetKind::Service)
                .then_some(self.remote_port),
            status: "Paused".into(),
            error: None,
        }
    }

    fn request(&self) -> StartPortForwardRequest {
        StartPortForwardRequest {
            cluster_id: self.cluster_id.clone(),
            namespace: self.namespace.clone(),
            target_kind: self.target_kind,
            target_name: self.target_name.clone(),
            local_port: self.effective_local_port(),
            host: self.host.clone(),
            protocol: self.protocol.clone(),
            remote_port: self.remote_port,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedForwardTarget {
    pod: String,
    remote_port: u16,
    service_port: Option<u16>,
}

pub struct PortForwardRegistry {
    sessions: RwLock<HashMap<String, RunningForward>>,
    paused: RwLock<HashMap<String, PortForwardSession>>,
    persisted: RwLock<HashMap<String, PersistedPortForward>>,
    persistence: Mutex<()>,
    persisted_path: PathBuf,
}

impl PortForwardRegistry {
    pub fn new(config_dir: PathBuf) -> Self {
        let persisted_path = config_dir.join("port-forwards.json");
        let persisted = fs::read_to_string(&persisted_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<Vec<PersistedPortForward>>(&contents).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|forward| (forward.id.clone(), forward))
            .collect::<HashMap<_, _>>();
        let paused = persisted
            .values()
            .filter(|forward| forward.paused)
            .map(|forward| (forward.id.clone(), forward.paused_session()))
            .collect();
        Self {
            sessions: RwLock::new(HashMap::new()),
            paused: RwLock::new(paused),
            persisted: RwLock::new(persisted),
            persistence: Mutex::new(()),
            persisted_path,
        }
    }

    pub async fn list(&self, cluster_id: Option<&str>) -> Vec<PortForwardSession> {
        let mut sessions = self
            .sessions
            .read()
            .await
            .values()
            .filter(|item| {
                cluster_id
                    .map(|id| item.session.cluster_id == id)
                    .unwrap_or(true)
            })
            .map(|item| item.session.clone())
            .collect::<Vec<_>>();
        sessions.extend(
            self.paused
                .read()
                .await
                .values()
                .filter(|session| {
                    cluster_id
                        .map(|id| session.cluster_id == id)
                        .unwrap_or(true)
                })
                .cloned(),
        );
        sessions.sort_by_key(|session| session.local_port);
        sessions
    }

    /// Stops a forward permanently. Its restart definition is removed as well.
    pub async fn stop(&self, id: &str) -> Result<bool, String> {
        let _persistence = self.persistence.lock().await;
        let mut proposed = self.persisted.read().await.clone();
        let removed_persistence = proposed.remove(id).is_some();
        if removed_persistence {
            self.commit_persisted(proposed).await?;
        }
        let stopped = self.cancel_runtime(id).await;
        let paused = self.paused.write().await.remove(id).is_some();
        Ok(stopped || paused || removed_persistence)
    }

    /// Temporarily closes a listener while retaining its port-forward definition.
    pub async fn pause(&self, id: &str) -> Result<PortForwardSession, String> {
        let _persistence = self.persistence.lock().await;
        let running = self
            .sessions
            .read()
            .await
            .get(id)
            .map(|running| running.session.clone())
            .ok_or_else(|| "The port-forward session is not active".to_string())?;
        let mut proposed = self.persisted.read().await.clone();
        let forward = proposed
            .get_mut(id)
            .ok_or_else(|| "The port-forward definition no longer exists".to_string())?;
        forward.paused = true;
        self.commit_persisted(proposed).await?;

        self.cancel_runtime(id).await;
        let mut paused = running;
        paused.status = "Paused".into();
        paused.error = None;
        self.paused
            .write()
            .await
            .insert(id.to_string(), paused.clone());
        Ok(paused)
    }

    /// Reopens a paused listener using its saved target and the last assigned port when possible.
    pub async fn resume(
        self: Arc<Self>,
        registry: Arc<ClusterRegistry>,
        id: &str,
    ) -> Result<PortForwardSession, String> {
        let _persistence = self.persistence.lock().await;
        let persisted = self
            .persisted
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| "The port-forward definition no longer exists".to_string())?;
        if !persisted.paused {
            return Err("The port-forward session is not paused".into());
        }
        let paused = self
            .paused
            .read()
            .await
            .get(id)
            .cloned()
            .unwrap_or_else(|| persisted.paused_session());
        let mut request = persisted.request();
        if request.local_port == 0 && paused.local_port != 0 {
            request.local_port = paused.local_port;
        }
        let session = self
            .clone()
            .start_runtime(registry, request, id.to_string())
            .await?;
        let mut proposed = self.persisted.read().await.clone();
        if let Some(forward) = proposed.get_mut(id) {
            forward.paused = false;
            if forward.local_port == 0 {
                forward.assigned_local_port = Some(session.local_port);
            }
        }
        if let Err(error) = self.commit_persisted(proposed).await {
            self.cancel_runtime(id).await;
            return Err(error);
        }
        self.paused.write().await.remove(id);
        Ok(session)
    }

    /// Temporarily stops a cluster's runtime forwards while retaining their restart definitions.
    pub async fn suspend_cluster(&self, cluster_id: &str) {
        let ids = self
            .sessions
            .read()
            .await
            .values()
            .filter(|running| running.session.cluster_id == cluster_id)
            .map(|running| running.session.id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            self.cancel_runtime(&id).await;
        }
    }

    /// Removes all stored definitions when a cluster is removed from the desktop client.
    pub async fn remove_cluster(&self, cluster_id: &str) -> Result<(), String> {
        let _persistence = self.persistence.lock().await;
        let mut proposed = self.persisted.read().await.clone();
        let count = proposed.len();
        proposed.retain(|_, forward| forward.cluster_id != cluster_id);
        let removed = proposed.len() != count;
        if removed {
            self.commit_persisted(proposed).await?;
        }
        self.suspend_cluster(cluster_id).await;
        self.paused
            .write()
            .await
            .retain(|_, session| session.cluster_id != cluster_id);
        Ok(())
    }

    /// Restarts the saved forwards after a cluster has connected successfully.
    /// Individual failures remain saved and will be retried on the next reconnect.
    pub async fn resume_cluster(self: Arc<Self>, registry: Arc<ClusterRegistry>, cluster_id: &str) {
        let running = self
            .sessions
            .read()
            .await
            .keys()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        let forwards = self
            .persisted
            .read()
            .await
            .values()
            .filter(|forward| {
                forward.cluster_id == cluster_id
                    && !forward.paused
                    && !running.contains(&forward.id)
            })
            .cloned()
            .collect::<Vec<_>>();
        for forward in forwards {
            let id = forward.id.clone();
            let automatic = forward.local_port == 0;
            if let Ok(session) = self
                .clone()
                .start_runtime(registry.clone(), forward.request(), id.clone())
                .await
            {
                if automatic {
                    self.record_assigned_port(&id, session.local_port).await;
                }
            }
        }
    }

    pub async fn start(
        self: Arc<Self>,
        registry: Arc<ClusterRegistry>,
        request: StartPortForwardRequest,
    ) -> Result<PortForwardSession, String> {
        let _persistence = self.persistence.lock().await;
        let already_forwarded = self
            .persisted
            .read()
            .await
            .values()
            .any(|forward| forward.matches_target(&request));
        if already_forwarded {
            return Err(format!(
                "A port-forward already exists for {:?}/{} port {} in namespace {}",
                request.target_kind, request.target_name, request.remote_port, request.namespace
            ));
        }

        let mut persisted = PersistedPortForward {
            id: Uuid::new_v4().to_string(),
            cluster_id: request.cluster_id.clone(),
            namespace: request.namespace.clone(),
            target_kind: request.target_kind,
            target_name: request.target_name.clone(),
            local_port: request.local_port,
            assigned_local_port: None,
            host: request.host.clone(),
            protocol: request.protocol.clone(),
            remote_port: request.remote_port,
            pod: None,
            pod_port: None,
            paused: false,
        };
        let session = self
            .clone()
            .start_runtime(registry, request, persisted.id.clone())
            .await?;
        // Keep the port the kernel picked for an automatic forward so a restart
        // can rebind it instead of allocating a different one.
        if persisted.local_port == 0 {
            persisted.assigned_local_port = Some(session.local_port);
        }
        // Retain the resolved endpoint so paused/restored sessions still show
        // the real Target Pod and its port rather than the Service port.
        if persisted.target_kind == PortForwardTargetKind::Service {
            persisted.pod = Some(session.pod.clone());
            persisted.pod_port = Some(session.remote_port);
        }
        let mut proposed = self.persisted.read().await.clone();
        proposed.insert(persisted.id.clone(), persisted);
        if let Err(error) = self.commit_persisted(proposed).await {
            self.cancel_runtime(&session.id).await;
            return Err(error);
        }
        Ok(session)
    }

    async fn start_runtime(
        self: Arc<Self>,
        registry: Arc<ClusterRegistry>,
        request: StartPortForwardRequest,
        id: String,
    ) -> Result<PortForwardSession, String> {
        validate_port(request.remote_port, "Remote")?;
        let bind_address = local_bind_address(&request.host)?;
        validate_protocol(&request.protocol)?;
        if request.target_name.trim().is_empty() {
            return Err("A Pod or Service name is required for port forwarding".into());
        }

        let client = registry.client(&request.cluster_id).await?;
        let resolved = resolve_target(&client, &request).await?;
        let pods: Api<Pod> = Api::namespaced(client, &request.namespace);
        let listener = TcpListener::bind((bind_address.as_str(), request.local_port))
            .await
            .map_err(|error| {
                format!("Unable to bind local port {}: {error}", request.local_port)
            })?;
        let local_port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let cancellation = CancellationToken::new();
        let session = PortForwardSession {
            id: id.clone(),
            cluster_id: request.cluster_id,
            namespace: request.namespace,
            target_kind: request.target_kind,
            target_name: request.target_name,
            pod: resolved.pod,
            host: request.host,
            protocol: request.protocol,
            local_port,
            remote_port: resolved.remote_port,
            service_port: resolved.service_port,
            status: "Active".into(),
            error: None,
        };
        self.sessions.write().await.insert(
            id.clone(),
            RunningForward {
                session: session.clone(),
                cancellation: cancellation.clone(),
            },
        );

        let state = self.clone();
        let session_for_task = session.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = cancellation.cancelled() => break,
                    result = listener.accept() => result,
                };
                let (mut local_stream, _) = match accepted {
                    Ok(value) => value,
                    Err(error) => {
                        state.set_error(&id, error.to_string()).await;
                        break;
                    }
                };
                state.set_active(&id).await;
                let pods = pods.clone();
                let pod = session_for_task.pod.clone();
                let remote_port = session_for_task.remote_port;
                let state_for_connection = state.clone();
                let id_for_connection = id.clone();
                let connection_cancellation = cancellation.clone();
                tauri::async_runtime::spawn(async move {
                    let result = async {
                        let ports = [remote_port];
                        let portforward = pods.portforward(&pod, &ports);
                        tokio::pin!(portforward);
                        let mut forwarder = tokio::select! {
                            _ = connection_cancellation.cancelled() => return Ok(()),
                            result = &mut portforward => result.map_err(|error| error.to_string())?,
                        };
                        let mut remote_stream =
                            forwarder.take_stream(remote_port).ok_or_else(|| {
                                "Kubernetes did not provide a port-forward stream".to_string()
                            })?;
                        let server_error = forwarder.take_error(remote_port).ok_or_else(|| {
                            "Kubernetes did not provide a port-forward error channel".to_string()
                        })?;
                        let outcome = tokio::select! {
                            _ = connection_cancellation.cancelled() => Ok(()),
                            // A browser can close an HTTP connection after receiving its response.
                            // That is local connection cleanup, not a listener-level failure.
                            result = copy_bidirectional(&mut local_stream, &mut remote_stream) => {
                                let _ = result;
                                Ok(())
                            },
                            error = server_error => match error {
                                Some(error) => Err(error),
                                None => Ok(()),
                            },
                        };
                        drop(remote_stream);
                        // Do not call Portforwarder::join() here: it waits for this per-connection
                        // WebSocket task after its stream has been dropped and can report normal
                        // connection teardown as a send/receive error. Dropping it lets the
                        // per-connection task finish without changing the long-lived listener state.
                        outcome
                    }
                    .await;
                    if let Err(error) = result {
                        state_for_connection
                            .set_error(&id_for_connection, error)
                            .await;
                    }
                });
            }
        });
        Ok(session)
    }

    /// Persists a port the kernel assigned to an automatic forward. Older
    /// definitions that predate the field are upgraded on their next restart.
    async fn record_assigned_port(&self, id: &str, local_port: u16) {
        let _persistence = self.persistence.lock().await;
        let mut proposed = self.persisted.read().await.clone();
        match proposed.get_mut(id) {
            Some(forward)
                if forward.local_port == 0
                    && forward.assigned_local_port != Some(local_port) =>
            {
                forward.assigned_local_port = Some(local_port);
            }
            _ => return,
        }
        let _ = self.commit_persisted(proposed).await;
    }

    async fn cancel_runtime(&self, id: &str) -> bool {
        if let Some(session) = self.sessions.write().await.remove(id) {
            session.cancellation.cancel();
            true
        } else {
            false
        }
    }

    async fn commit_persisted(
        &self,
        proposed: HashMap<String, PersistedPortForward>,
    ) -> Result<(), String> {
        write_persisted_forwards(&self.persisted_path, &proposed)?;
        *self.persisted.write().await = proposed;
        Ok(())
    }

    async fn set_active(&self, id: &str) {
        if let Some(running) = self.sessions.write().await.get_mut(id) {
            running.session.status = "Active".into();
            running.session.error = None;
        }
    }

    async fn set_error(&self, id: &str, error: String) {
        if let Some(running) = self.sessions.write().await.get_mut(id) {
            running.session.status = "Error".into();
            running.session.error = Some(error);
        }
    }
}

fn write_persisted_forwards(
    path: &Path,
    persisted: &HashMap<String, PersistedPortForward>,
) -> Result<(), String> {
    let mut forwards = persisted.values().cloned().collect::<Vec<_>>();
    forwards.sort_by(|left, right| {
        (
            &left.cluster_id,
            &left.namespace,
            &left.target_name,
            left.remote_port,
        )
            .cmp(&(
                &right.cluster_id,
                &right.namespace,
                &right.target_name,
                right.remote_port,
            ))
    });
    let contents = serde_json::to_string_pretty(&forwards).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create port-forward config directory: {error}"))?;
    }

    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    if let Err(error) = fs::write(&temporary, contents) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Unable to save port-forward sessions: {error}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) = fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600)) {
            let _ = fs::remove_file(&temporary);
            return Err(format!("Unable to secure port-forward sessions: {error}"));
        }
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Unable to replace port-forward sessions: {error}"));
    }
    Ok(())
}

async fn resolve_target(
    client: &Client,
    request: &StartPortForwardRequest,
) -> Result<ResolvedForwardTarget, String> {
    match request.target_kind {
        PortForwardTargetKind::Pod => {
            let pods: Api<Pod> = Api::namespaced(client.clone(), &request.namespace);
            pods.get(&request.target_name).await.map_err(|error| {
                format!(
                    "Unable to find Pod {} in namespace {}: {error}",
                    request.target_name, request.namespace
                )
            })?;
            Ok(ResolvedForwardTarget {
                pod: request.target_name.clone(),
                remote_port: request.remote_port,
                service_port: None,
            })
        }
        PortForwardTargetKind::Service => resolve_service_target(client, request).await,
    }
}

async fn resolve_service_target(
    client: &Client,
    request: &StartPortForwardRequest,
) -> Result<ResolvedForwardTarget, String> {
    let services: Api<Service> = Api::namespaced(client.clone(), &request.namespace);
    let service = services.get(&request.target_name).await.map_err(|error| {
        format!(
            "Unable to find Service {} in namespace {}: {error}",
            request.target_name, request.namespace
        )
    })?;
    let spec = service.spec.as_ref().ok_or_else(|| {
        format!(
            "Service {}/{} has no spec to port-forward",
            request.namespace, request.target_name
        )
    })?;
    if spec.type_.as_deref() == Some("ExternalName") {
        return Err(format!(
            "Service {}/{} is ExternalName and has no Pod endpoint to port-forward",
            request.namespace, request.target_name
        ));
    }
    let service_ports = spec.ports.as_deref().unwrap_or_default();
    let service_port = service_ports
        .iter()
        .find(|port| port.port == i32::from(request.remote_port))
        .ok_or_else(|| {
            format!(
                "Service {}/{} does not expose TCP port {}",
                request.namespace, request.target_name, request.remote_port
            )
        })?;
    if service_port.protocol.as_deref().unwrap_or("TCP") != "TCP" {
        return Err(format!(
            "Service {}/{} port {} uses {}; Kubernetes port-forward supports TCP only",
            request.namespace,
            request.target_name,
            request.remote_port,
            service_port.protocol.as_deref().unwrap_or("TCP")
        ));
    }

    let (pod_name, endpoint_port) = resolve_service_endpoint(
        client,
        &request.namespace,
        &request.target_name,
        service_port,
        service_ports.len(),
        spec.publish_not_ready_addresses.unwrap_or(false),
        spec.selector
            .as_ref()
            .is_none_or(|selector| selector.is_empty()),
    )
    .await?;
    let pods: Api<Pod> = Api::namespaced(client.clone(), &request.namespace);
    let pod = pods.get(&pod_name).await.map_err(|error| {
        format!(
            "Service {}/{} selected Pod {}, but it cannot be read: {error}",
            request.namespace, request.target_name, pod_name
        )
    })?;
    let remote_port = endpoint_port
        .or_else(|| service_target_port(service_port, &pod))
        .ok_or_else(|| {
            let target = match &service_port.target_port {
                Some(IntOrString::String(name)) => format!("named targetPort {name:?}"),
                Some(IntOrString::Int(port)) => format!("targetPort {port}"),
                None => format!("service port {}", service_port.port),
            };
            format!(
                "Unable to resolve {target} on endpoint Pod {}/{}",
                request.namespace, pod_name
            )
        })?;

    Ok(ResolvedForwardTarget {
        pod: pod_name,
        remote_port,
        service_port: Some(request.remote_port),
    })
}

async fn resolve_service_endpoint(
    client: &Client,
    namespace: &str,
    service_name: &str,
    service_port: &ServicePort,
    service_port_count: usize,
    publish_not_ready_addresses: bool,
    selectorless: bool,
) -> Result<(String, Option<u16>), String> {
    let slices: Api<EndpointSlice> = Api::namespaced(client.clone(), namespace);
    let selector =
        ListParams::default().labels(&format!("kubernetes.io/service-name={service_name}"));
    let mut diagnostics = Vec::new();
    if selectorless {
        diagnostics.push("Service has no selector, so its endpoints are managed manually".into());
    }

    match slices.list(&selector).await {
        Ok(list) => {
            if let Some(endpoint) = select_ready_slice_endpoint(
                &list.items,
                service_port,
                service_port_count,
                publish_not_ready_addresses,
            ) {
                return Ok(endpoint);
            }
            diagnostics.extend(slice_endpoint_diagnostics(
                &list.items,
                service_port,
                service_port_count,
            ));
        }
        Err(error) => diagnostics.push(format!("Unable to list EndpointSlices: {error}")),
    }

    // EndpointSlice is the primary Service endpoint API. Fall back to the legacy
    // Endpoints resource for older clusters and RBAC roles that have not granted
    // discovery.k8s.io permissions yet.
    let endpoints: Api<Endpoints> = Api::namespaced(client.clone(), namespace);
    match endpoints.get_opt(service_name).await {
        Ok(Some(endpoints)) => {
            if let Some(endpoint) = select_ready_legacy_endpoint(
                &endpoints,
                service_port,
                service_port_count,
                publish_not_ready_addresses,
            ) {
                return Ok(endpoint);
            }
            diagnostics.extend(legacy_endpoint_diagnostics(
                &endpoints,
                service_port,
                service_port_count,
            ));
        }
        Ok(None) => diagnostics.push("Endpoints resource does not exist".into()),
        Err(error) => diagnostics.push(format!("Unable to read Endpoints fallback: {error}")),
    }

    Err(format!(
        "Unable to resolve a Pod-backed endpoint for Service {namespace}/{service_name} port {}: the Kubernetes API server only proxies port-forward traffic to Pods. {}",
        service_port.port,
        diagnostics.join("; ")
    ))
}

fn select_ready_slice_endpoint(
    slices: &[EndpointSlice],
    service_port: &ServicePort,
    service_port_count: usize,
    publish_not_ready_addresses: bool,
) -> Option<(String, Option<u16>)> {
    for slice in slices {
        let Some(endpoint_port) =
            matching_slice_port(slice.ports.as_deref(), service_port, service_port_count)
        else {
            continue;
        };
        for endpoint in &slice.endpoints {
            if !publish_not_ready_addresses && !endpoint_is_ready(endpoint) {
                continue;
            }
            if let Some(pod) = pod_name_from_reference(endpoint.target_ref.as_ref()) {
                return Some((pod, endpoint_port));
            }
        }
    }
    None
}

fn select_ready_legacy_endpoint(
    endpoints: &Endpoints,
    service_port: &ServicePort,
    service_port_count: usize,
    publish_not_ready_addresses: bool,
) -> Option<(String, Option<u16>)> {
    for subset in endpoints.subsets.as_deref().unwrap_or_default() {
        let Some(endpoint_port) =
            matching_legacy_port(subset.ports.as_deref(), service_port, service_port_count)
        else {
            continue;
        };
        if let Some(addresses) = &subset.addresses {
            for address in addresses {
                if let Some(pod) = pod_name_from_reference(address.target_ref.as_ref()) {
                    return Some((pod, endpoint_port));
                }
            }
        }
        if publish_not_ready_addresses {
            if let Some(addresses) = &subset.not_ready_addresses {
                for address in addresses {
                    if let Some(pod) = pod_name_from_reference(address.target_ref.as_ref()) {
                        return Some((pod, endpoint_port));
                    }
                }
            }
        }
    }
    None
}

fn matching_slice_port(
    ports: Option<&[SliceEndpointPort]>,
    service_port: &ServicePort,
    service_port_count: usize,
) -> Option<Option<u16>> {
    let Some(ports) = ports else {
        return Some(None);
    };
    if ports.is_empty() {
        return Some(None);
    }
    ports
        .iter()
        .find(|port| {
            port.protocol.as_deref().unwrap_or("TCP") == "TCP"
                && service_port_name_matches(port.name.as_deref(), service_port, service_port_count)
        })
        .map(|port| port.port.and_then(port_from_i32))
}

fn matching_legacy_port(
    ports: Option<&[k8s_openapi::api::core::v1::EndpointPort]>,
    service_port: &ServicePort,
    service_port_count: usize,
) -> Option<Option<u16>> {
    let Some(ports) = ports else {
        return Some(None);
    };
    if ports.is_empty() {
        return Some(None);
    }
    ports
        .iter()
        .find(|port| {
            port.protocol.as_deref().unwrap_or("TCP") == "TCP"
                && service_port_name_matches(port.name.as_deref(), service_port, service_port_count)
        })
        .map(|port| port_from_i32(port.port))
}

fn service_port_name_matches(
    endpoint_port_name: Option<&str>,
    service_port: &ServicePort,
    service_port_count: usize,
) -> bool {
    match service_port.name.as_deref() {
        Some(name) => endpoint_port_name == Some(name),
        None => service_port_count == 1,
    }
}

fn pod_name_from_reference(reference: Option<&ObjectReference>) -> Option<String> {
    let reference = reference?;
    if reference.kind.as_deref() != Some("Pod") {
        return None;
    }
    reference.name.clone()
}

fn endpoint_is_ready(endpoint: &Endpoint) -> bool {
    endpoint
        .conditions
        .as_ref()
        .and_then(|conditions| conditions.ready)
        != Some(false)
}

/// Renders an endpoint port as `name/protocol port` for operator-facing messages.
fn describe_port(name: Option<&str>, protocol: Option<&str>, port: Option<i32>) -> String {
    let name = name.unwrap_or("-");
    let protocol = protocol.unwrap_or("TCP");
    match port {
        Some(port) => format!("{name}/{protocol} {port}"),
        None => format!("{name}/{protocol}"),
    }
}

fn describe_service_port(service_port: &ServicePort) -> String {
    describe_port(
        service_port.name.as_deref(),
        service_port.protocol.as_deref(),
        Some(service_port.port),
    )
}

/// Names the object an endpoint address stands for, so a target that is not a Pod
/// is reported instead of silently disappearing from the diagnostics.
fn describe_endpoint_target(reference: Option<&ObjectReference>, addresses: &[String]) -> String {
    let target = match reference {
        Some(reference) => match (reference.kind.as_deref(), reference.name.as_deref()) {
            (Some(kind), Some(name)) => format!("{kind}/{name}"),
            _ => "an unnamed target".to_string(),
        },
        None => "no target reference".to_string(),
    };
    if addresses.is_empty() {
        target
    } else {
        format!("{target} ({})", addresses.join(", "))
    }
}

fn summarize_targets(targets: &[String]) -> String {
    let mut unique = targets.to_vec();
    unique.sort();
    unique.dedup();
    const LIMIT: usize = 3;
    if unique.len() > LIMIT {
        format!(
            "{} and {} more",
            unique[..LIMIT].join(", "),
            unique.len() - LIMIT
        )
    } else {
        unique.join(", ")
    }
}

/// Explains why no EndpointSlice endpoint can back this Service port.  Port-forward
/// traffic reaches Pods only, so a CRD-backed target has to be named here.
fn slice_endpoint_diagnostics(
    slices: &[EndpointSlice],
    service_port: &ServicePort,
    service_port_count: usize,
) -> Vec<String> {
    let mut exposed = Vec::new();
    let mut matched: Vec<&Endpoint> = Vec::new();
    for slice in slices {
        if let Some(ports) = slice.ports.as_deref() {
            exposed.extend(ports.iter().map(|port| {
                describe_port(port.name.as_deref(), port.protocol.as_deref(), port.port)
            }));
        }
        if matching_slice_port(slice.ports.as_deref(), service_port, service_port_count).is_some() {
            matched.extend(slice.endpoints.iter());
        }
    }

    let mut diagnostics = Vec::new();
    if matched.is_empty() {
        diagnostics.push(if exposed.is_empty() {
            "EndpointSlices for this Service contain no endpoints".to_string()
        } else {
            format!(
                "EndpointSlices expose {} but not Service port {}",
                exposed.join(", "),
                describe_service_port(service_port)
            )
        });
        return diagnostics;
    }

    let not_ready = matched
        .iter()
        .filter(|endpoint| !endpoint_is_ready(endpoint))
        .count();
    if not_ready > 0 {
        diagnostics.push(format!(
            "{not_ready} of {} EndpointSlice endpoints on that port are not ready",
            matched.len()
        ));
    }
    let targets: Vec<String> = matched
        .iter()
        .filter(|endpoint| pod_name_from_reference(endpoint.target_ref.as_ref()).is_none())
        .map(|endpoint| describe_endpoint_target(endpoint.target_ref.as_ref(), &endpoint.addresses))
        .collect();
    if !targets.is_empty() {
        diagnostics.push(format!(
            "EndpointSlice endpoints target {} instead of a Pod",
            summarize_targets(&targets)
        ));
    }
    if diagnostics.is_empty() {
        diagnostics
            .push("EndpointSlices contain no ready Pod endpoint for that Service port".into());
    }
    diagnostics
}

/// Explains why no legacy Endpoints address can back this Service port.
fn legacy_endpoint_diagnostics(
    endpoints: &Endpoints,
    service_port: &ServicePort,
    service_port_count: usize,
) -> Vec<String> {
    let mut exposed = Vec::new();
    let mut ready: Vec<&EndpointAddress> = Vec::new();
    let mut not_ready: Vec<&EndpointAddress> = Vec::new();
    for subset in endpoints.subsets.as_deref().unwrap_or_default() {
        if let Some(ports) = subset.ports.as_deref() {
            exposed.extend(ports.iter().map(|port| {
                describe_port(
                    port.name.as_deref(),
                    port.protocol.as_deref(),
                    Some(port.port),
                )
            }));
        }
        if matching_legacy_port(subset.ports.as_deref(), service_port, service_port_count).is_some()
        {
            ready.extend(subset.addresses.as_deref().unwrap_or_default());
            not_ready.extend(subset.not_ready_addresses.as_deref().unwrap_or_default());
        }
    }

    let mut diagnostics = Vec::new();
    if ready.is_empty() && not_ready.is_empty() {
        diagnostics.push(if exposed.is_empty() {
            "Endpoints for this Service contain no addresses".to_string()
        } else {
            format!(
                "Endpoints expose {} but not Service port {}",
                exposed.join(", "),
                describe_service_port(service_port)
            )
        });
        return diagnostics;
    }

    if ready.is_empty() {
        diagnostics.push(format!(
            "{} Endpoints addresses on that port are not ready",
            not_ready.len()
        ));
    }
    let targets: Vec<String> = ready
        .iter()
        .chain(not_ready.iter())
        .filter(|address| pod_name_from_reference(address.target_ref.as_ref()).is_none())
        .map(|address| {
            describe_endpoint_target(
                address.target_ref.as_ref(),
                std::slice::from_ref(&address.ip),
            )
        })
        .collect();
    if !targets.is_empty() {
        diagnostics.push(format!(
            "Endpoints addresses target {} instead of a Pod",
            summarize_targets(&targets)
        ));
    }
    if diagnostics.is_empty() {
        diagnostics.push("Endpoints contains no ready Pod endpoint for that Service port".into());
    }
    diagnostics
}

fn service_target_port(service_port: &ServicePort, pod: &Pod) -> Option<u16> {
    match &service_port.target_port {
        Some(IntOrString::Int(port)) => port_from_i32(*port),
        Some(IntOrString::String(name)) => pod_named_port(pod, name),
        None => port_from_i32(service_port.port),
    }
}

fn pod_named_port(pod: &Pod, name: &str) -> Option<u16> {
    pod.spec
        .as_ref()?
        .containers
        .iter()
        .flat_map(|container| container.ports.as_deref().unwrap_or_default())
        .find(|port| {
            port.name.as_deref() == Some(name) && port.protocol.as_deref().unwrap_or("TCP") == "TCP"
        })
        .and_then(|port| port_from_i32(port.container_port))
}

fn port_from_i32(port: i32) -> Option<u16> {
    u16::try_from(port).ok().filter(|port| *port > 0)
}

fn validate_port(port: u16, label: &str) -> Result<(), String> {
    if port == 0 {
        Err(format!("{label} port must be between 1 and 65535"))
    } else {
        Ok(())
    }
}

fn local_bind_address(host: &str) -> Result<String, String> {
    match host {
        "localhost" => Ok("127.0.0.1".into()),
        "0.0.0.0" => Ok("0.0.0.0".into()),
        _ => Err("Host must be localhost or 0.0.0.0".into()),
    }
}

fn validate_protocol(protocol: &str) -> Result<(), String> {
    match protocol {
        "http" | "https" => Ok(()),
        _ => Err("Protocol must be http or https".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::{
        api::{
            core::v1::{
                Container, ContainerPort, EndpointAddress, EndpointPort, EndpointSubset,
                ObjectReference, PodSpec,
            },
            discovery::v1::{Endpoint, EndpointConditions},
        },
        apimachinery::pkg::apis::meta::v1::ObjectMeta,
    };

    fn service_port(
        name: Option<&str>,
        port: i32,
        target_port: Option<IntOrString>,
    ) -> ServicePort {
        ServicePort {
            name: name.map(str::to_owned),
            port,
            target_port,
            protocol: Some("TCP".into()),
            ..Default::default()
        }
    }

    fn endpoint_slice(
        ready: Option<bool>,
        pod: &str,
        port_name: Option<&str>,
        port: Option<i32>,
    ) -> EndpointSlice {
        EndpointSlice {
            address_type: "IPv4".into(),
            endpoints: vec![Endpoint {
                conditions: Some(EndpointConditions {
                    ready,
                    ..Default::default()
                }),
                target_ref: Some(ObjectReference {
                    kind: Some("Pod".into()),
                    name: Some(pod.into()),
                    ..Default::default()
                }),
                ..Default::default()
            }],
            metadata: ObjectMeta::default(),
            ports: Some(vec![SliceEndpointPort {
                name: port_name.map(str::to_owned),
                port,
                protocol: Some("TCP".into()),
                ..Default::default()
            }]),
        }
    }

    #[test]
    fn selects_a_ready_pod_and_its_endpoint_port_for_a_service() {
        let service = service_port(Some("https"), 443, Some(IntOrString::Int(8443)));
        let slices = vec![
            endpoint_slice(Some(false), "not-ready", Some("https"), Some(8443)),
            endpoint_slice(Some(true), "api-0", Some("https"), Some(8443)),
        ];

        assert_eq!(
            select_ready_slice_endpoint(&slices, &service, 1, false),
            Some(("api-0".into(), Some(8443)))
        );
    }

    #[test]
    fn allows_not_ready_endpoints_only_when_the_service_publishes_them() {
        let service = service_port(None, 8080, None);
        let slices = vec![endpoint_slice(Some(false), "stateful-0", None, Some(8080))];

        assert_eq!(
            select_ready_slice_endpoint(&slices, &service, 1, false),
            None
        );
        assert_eq!(
            select_ready_slice_endpoint(&slices, &service, 1, true),
            Some(("stateful-0".into(), Some(8080)))
        );
    }

    fn endpoint_slice_referencing(
        kind: &str,
        name: &str,
        port_name: Option<&str>,
        port: Option<i32>,
    ) -> EndpointSlice {
        EndpointSlice {
            address_type: "IPv4".into(),
            endpoints: vec![Endpoint {
                addresses: vec!["10.244.7.186".into()],
                conditions: Some(EndpointConditions {
                    ready: Some(true),
                    ..Default::default()
                }),
                target_ref: Some(ObjectReference {
                    api_version: Some("wutong.io/v1alpha1".into()),
                    kind: Some(kind.into()),
                    name: Some(name.into()),
                    namespace: Some("paas".into()),
                    ..Default::default()
                }),
                ..Default::default()
            }],
            metadata: ObjectMeta::default(),
            ports: Some(vec![SliceEndpointPort {
                name: port_name.map(str::to_owned),
                port,
                protocol: Some("TCP".into()),
                ..Default::default()
            }]),
        }
    }

    #[test]
    fn names_a_non_pod_endpoint_slice_target_in_the_diagnostic() {
        let service = service_port(Some("tcp-80"), 80, Some(IntOrString::Int(80)));
        let slices = vec![endpoint_slice_referencing(
            "ThirdComponent",
            "3846df0fa53184a6bb79c1a6daf54135",
            Some("tcp-80"),
            Some(9000),
        )];

        assert_eq!(
            select_ready_slice_endpoint(&slices, &service, 1, false),
            None
        );
        assert_eq!(
            slice_endpoint_diagnostics(&slices, &service, 1),
            vec![
                "EndpointSlice endpoints target ThirdComponent/3846df0fa53184a6bb79c1a6daf54135 (10.244.7.186) instead of a Pod"
                    .to_string()
            ]
        );
    }

    #[test]
    fn names_a_non_pod_endpoints_address_target_in_the_diagnostic() {
        let service = service_port(Some("tcp-80"), 80, Some(IntOrString::Int(80)));
        let endpoints = Endpoints {
            metadata: ObjectMeta::default(),
            subsets: Some(vec![EndpointSubset {
                addresses: Some(vec![EndpointAddress {
                    ip: "10.244.7.186".into(),
                    target_ref: Some(ObjectReference {
                        api_version: Some("wutong.io/v1alpha1".into()),
                        kind: Some("ThirdComponent".into()),
                        name: Some("3846df0fa53184a6bb79c1a6daf54135".into()),
                        namespace: Some("paas".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                }]),
                ports: Some(vec![EndpointPort {
                    name: Some("tcp-80".into()),
                    port: 9000,
                    protocol: Some("TCP".into()),
                    ..Default::default()
                }]),
                ..Default::default()
            }]),
        };

        assert_eq!(
            select_ready_legacy_endpoint(&endpoints, &service, 1, false),
            None
        );
        assert_eq!(
            legacy_endpoint_diagnostics(&endpoints, &service, 1),
            vec![
                "Endpoints addresses target ThirdComponent/3846df0fa53184a6bb79c1a6daf54135 (10.244.7.186) instead of a Pod"
                    .to_string()
            ]
        );
    }

    #[test]
    fn reports_endpoints_that_do_not_expose_the_service_port() {
        let service = service_port(Some("tcp-80"), 80, Some(IntOrString::Int(80)));
        let slices = vec![endpoint_slice(
            Some(true),
            "api-0",
            Some("tcp-9000"),
            Some(9000),
        )];

        assert_eq!(
            slice_endpoint_diagnostics(&slices, &service, 1),
            vec![
                "EndpointSlices expose tcp-9000/TCP 9000 but not Service port tcp-80/TCP 80"
                    .to_string()
            ]
        );
    }

    #[test]
    fn resolves_a_named_service_target_port_from_the_selected_pod() {
        let service = service_port(Some("http"), 80, Some(IntOrString::String("web".into())));
        let pod = Pod {
            spec: Some(PodSpec {
                containers: vec![Container {
                    ports: Some(vec![ContainerPort {
                        name: Some("web".into()),
                        container_port: 8080,
                        protocol: Some("TCP".into()),
                        ..Default::default()
                    }]),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        };

        assert_eq!(service_target_port(&service, &pod), Some(8080));
    }

    #[tokio::test]
    async fn registry_loads_saved_forwards_for_future_reconnects() {
        let directory =
            std::env::temp_dir().join(format!("kubehive-port-forward-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let forward = PersistedPortForward {
            id: "saved-forward".into(),
            cluster_id: "cluster".into(),
            namespace: "default".into(),
            target_kind: PortForwardTargetKind::Pod,
            target_name: "api-0".into(),
            local_port: 0,
            assigned_local_port: None,
            host: "localhost".into(),
            protocol: "http".into(),
            remote_port: 8080,
            pod: None,
            pod_port: None,
            paused: false,
        };
        fs::write(
            directory.join("port-forwards.json"),
            serde_json::to_string(&vec![forward]).unwrap(),
        )
        .unwrap();

        let registry = PortForwardRegistry::new(directory.clone());
        let saved = registry.persisted.read().await;
        assert_eq!(saved.len(), 1);
        assert_eq!(saved["saved-forward"].local_port, 0);
        assert_eq!(saved["saved-forward"].target_name, "api-0");
        drop(saved);
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn failed_stop_keeps_persisted_and_paused_state() {
        let directory =
            std::env::temp_dir().join(format!("kubehive-port-forward-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let blocked_config_dir = directory.join("blocked");
        fs::write(&blocked_config_dir, "not a directory").unwrap();
        let registry = PortForwardRegistry::new(blocked_config_dir.clone());
        let persisted = PersistedPortForward {
            id: "forward-id".into(),
            cluster_id: "cluster".into(),
            namespace: "default".into(),
            target_kind: PortForwardTargetKind::Pod,
            target_name: "api-0".into(),
            local_port: 8080,
            assigned_local_port: None,
            host: "localhost".into(),
            protocol: "http".into(),
            remote_port: 8080,
            pod: None,
            pod_port: None,
            paused: true,
        };
        registry
            .persisted
            .write()
            .await
            .insert(persisted.id.clone(), persisted.clone());
        registry
            .paused
            .write()
            .await
            .insert(persisted.id.clone(), persisted.paused_session());

        assert!(registry.stop(&persisted.id).await.is_err());
        assert!(registry.persisted.read().await.contains_key(&persisted.id));
        assert!(registry.paused.read().await.contains_key(&persisted.id));

        fs::remove_file(blocked_config_dir).unwrap();
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn persisted_forward_retains_auto_port_and_browser_options() {
        let persisted = PersistedPortForward {
            id: "forward-id".into(),
            cluster_id: "cluster".into(),
            namespace: "default".into(),
            target_kind: PortForwardTargetKind::Service,
            target_name: "api".into(),
            local_port: 0,
            assigned_local_port: None,
            host: "0.0.0.0".into(),
            protocol: "https".into(),
            remote_port: 443,
            pod: None,
            pod_port: None,
            paused: false,
        };

        let request = persisted.request();
        assert_eq!(request.local_port, 0);
        assert_eq!(request.host, "0.0.0.0");
        assert_eq!(request.protocol, "https");
        assert_eq!(request.target_kind, PortForwardTargetKind::Service);
    }

    #[test]
    fn persisted_forward_matches_one_target_port_regardless_of_local_options() {
        let persisted = PersistedPortForward {
            id: "forward-id".into(),
            cluster_id: "cluster".into(),
            namespace: "default".into(),
            target_kind: PortForwardTargetKind::Service,
            target_name: "api".into(),
            local_port: 0,
            assigned_local_port: None,
            host: "localhost".into(),
            protocol: "http".into(),
            remote_port: 443,
            pod: None,
            pod_port: None,
            paused: false,
        };
        let mut request = persisted.request();
        request.local_port = 8443;
        request.host = "0.0.0.0".into();
        request.protocol = "https".into();
        assert!(persisted.matches_target(&request));
        request.remote_port = 8443;
        assert!(!persisted.matches_target(&request));
    }

    #[test]
    fn paused_persisted_forward_retains_a_listable_session() {
        let persisted = PersistedPortForward {
            id: "forward-id".into(),
            cluster_id: "cluster".into(),
            namespace: "default".into(),
            target_kind: PortForwardTargetKind::Service,
            target_name: "api".into(),
            local_port: 0,
            assigned_local_port: None,
            host: "localhost".into(),
            protocol: "http".into(),
            remote_port: 8080,
            pod: None,
            pod_port: None,
            paused: true,
        };

        let session = persisted.paused_session();
        assert_eq!(session.status, "Paused");
        assert_eq!(session.service_port, Some(8080));
        assert_eq!(session.local_port, 0);
    }

    #[test]
    fn paused_service_forward_retains_resolved_target_pod_and_port() {
        let persisted = PersistedPortForward {
            id: "forward-id".into(),
            cluster_id: "cluster".into(),
            namespace: "default".into(),
            target_kind: PortForwardTargetKind::Service,
            target_name: "api".into(),
            local_port: 0,
            assigned_local_port: None,
            host: "localhost".into(),
            protocol: "http".into(),
            remote_port: 80,
            pod: Some("api-7f9b".into()),
            pod_port: Some(8080),
            paused: true,
        };

        let session = persisted.paused_session();
        assert_eq!(session.status, "Paused");
        assert_eq!(session.pod, "api-7f9b");
        assert_eq!(session.remote_port, 8080);
        assert_eq!(session.service_port, Some(80));
    }

    #[test]
    fn automatic_forward_reuses_its_assigned_local_port() {
        let mut persisted = PersistedPortForward {
            id: "forward-id".into(),
            cluster_id: "cluster".into(),
            namespace: "default".into(),
            target_kind: PortForwardTargetKind::Pod,
            target_name: "api-0".into(),
            local_port: 0,
            assigned_local_port: Some(52341),
            host: "localhost".into(),
            protocol: "http".into(),
            remote_port: 8080,
            pod: None,
            pod_port: None,
            paused: true,
        };

        assert_eq!(persisted.request().local_port, 52341);
        assert_eq!(persisted.paused_session().local_port, 52341);

        persisted.local_port = 8080;
        assert_eq!(persisted.request().local_port, 8080);
    }

    #[tokio::test]
    async fn records_the_port_the_kernel_assigned_to_an_automatic_forward() {
        let directory =
            std::env::temp_dir().join(format!("kubehive-port-forward-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let registry = PortForwardRegistry::new(directory.clone());
        let persisted = PersistedPortForward {
            id: "forward-id".into(),
            cluster_id: "cluster".into(),
            namespace: "default".into(),
            target_kind: PortForwardTargetKind::Pod,
            target_name: "api-0".into(),
            local_port: 0,
            assigned_local_port: None,
            host: "localhost".into(),
            protocol: "http".into(),
            remote_port: 8080,
            pod: None,
            pod_port: None,
            paused: false,
        };
        registry
            .persisted
            .write()
            .await
            .insert(persisted.id.clone(), persisted);

        registry.record_assigned_port("forward-id", 52341).await;
        assert_eq!(
            registry.persisted.read().await["forward-id"].assigned_local_port,
            Some(52341)
        );

        let reloaded = PortForwardRegistry::new(directory.clone());
        assert_eq!(
            reloaded.persisted.read().await["forward-id"]
                .request()
                .local_port,
            52341
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn validates_port_forward_options() {
        assert!(validate_port(0, "Remote").is_err());
        assert!(validate_port(65535, "Remote").is_ok());
        assert_eq!(local_bind_address("localhost").unwrap(), "127.0.0.1");
        assert_eq!(local_bind_address("0.0.0.0").unwrap(), "0.0.0.0");
        assert!(local_bind_address("example.com").is_err());
        assert!(validate_protocol("https").is_ok());
        assert!(validate_protocol("ftp").is_err());
    }
}
