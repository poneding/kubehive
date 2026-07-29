use crate::{
    models::{PortForwardSession, PortForwardTargetKind, StartPortForwardRequest},
    registry::ClusterRegistry,
};
use k8s_openapi::{
    api::{
        core::v1::{Endpoints, Pod, Service, ServicePort},
        discovery::v1::{EndpointPort as SliceEndpointPort, EndpointSlice},
    },
    apimachinery::pkg::util::intstr::IntOrString,
};
use kube::{api::ListParams, Api, Client};
use std::{collections::HashMap, sync::Arc};
use tokio::{io::copy_bidirectional, net::TcpListener, sync::RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct RunningForward {
    session: PortForwardSession,
    cancellation: CancellationToken,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedForwardTarget {
    pod: String,
    remote_port: u16,
    service_port: Option<u16>,
}

#[derive(Default)]
pub struct PortForwardRegistry {
    sessions: RwLock<HashMap<String, RunningForward>>,
}

impl PortForwardRegistry {
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
        sessions.sort_by_key(|session| session.local_port);
        sessions
    }

    pub async fn stop(&self, id: &str) -> bool {
        if let Some(session) = self.sessions.write().await.remove(id) {
            session.cancellation.cancel();
            true
        } else {
            false
        }
    }

    pub async fn start(
        self: Arc<Self>,
        registry: Arc<ClusterRegistry>,
        request: StartPortForwardRequest,
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
        let id = Uuid::new_v4().to_string();
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
                        let copied = tokio::select! {
                            _ = connection_cancellation.cancelled() => Ok(()),
                            result = copy_bidirectional(&mut local_stream, &mut remote_stream) => {
                                result.map(|_| ()).map_err(|error| error.to_string())
                            },
                        };
                        drop(remote_stream);
                        copied?;
                        if connection_cancellation.is_cancelled() {
                            return Ok(());
                        }
                        forwarder.join().await.map_err(|error| error.to_string())
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
) -> Result<(String, Option<u16>), String> {
    let slices: Api<EndpointSlice> = Api::namespaced(client.clone(), namespace);
    let selector =
        ListParams::default().labels(&format!("kubernetes.io/service-name={service_name}"));
    let mut diagnostics = Vec::new();

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
            diagnostics
                .push("EndpointSlices contain no ready Pod endpoint for that Service port".into());
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
            diagnostics
                .push("Endpoints contains no ready Pod endpoint for that Service port".into());
        }
        Ok(None) => diagnostics.push("Endpoints resource does not exist".into()),
        Err(error) => diagnostics.push(format!("Unable to read Endpoints fallback: {error}")),
    }

    Err(format!(
        "Unable to resolve a ready Pod endpoint for Service {namespace}/{service_name} port {}. {}",
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
            if !publish_not_ready_addresses
                && endpoint
                    .conditions
                    .as_ref()
                    .and_then(|conditions| conditions.ready)
                    == Some(false)
            {
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

fn pod_name_from_reference(
    reference: Option<&k8s_openapi::api::core::v1::ObjectReference>,
) -> Option<String> {
    let reference = reference?;
    if reference.kind.as_deref() != Some("Pod") {
        return None;
    }
    reference.name.clone()
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
            core::v1::{Container, ContainerPort, ObjectReference, PodSpec},
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
