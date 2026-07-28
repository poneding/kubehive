use crate::{
    models::{PortForwardSession, StartPortForwardRequest},
    registry::ClusterRegistry,
};
use k8s_openapi::api::core::v1::Pod;
use kube::Api;
use std::{collections::HashMap, sync::Arc};
use tokio::{io::copy_bidirectional, net::TcpListener, sync::RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct RunningForward {
    session: PortForwardSession,
    cancellation: CancellationToken,
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
        let client = registry.client(&request.cluster_id).await?;
        let pods: Api<Pod> = Api::namespaced(client, &request.namespace);
        // Validate the target before opening a local listener.
        pods.get(&request.pod)
            .await
            .map_err(|error| format!("Unable to find pod {}: {error}", request.pod))?;
        let listener = TcpListener::bind(("127.0.0.1", request.local_port))
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
            pod: request.pod,
            local_port,
            remote_port: request.remote_port,
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
                let pods = pods.clone();
                let pod = session_for_task.pod.clone();
                let remote_port = session_for_task.remote_port;
                let state_for_connection = state.clone();
                let id_for_connection = id.clone();
                tauri::async_runtime::spawn(async move {
                    let result = async {
                        let mut forwarder = pods
                            .portforward(&pod, &[remote_port])
                            .await
                            .map_err(|error| error.to_string())?;
                        let mut remote_stream =
                            forwarder.take_stream(remote_port).ok_or_else(|| {
                                "Kubernetes did not provide a port-forward stream".to_string()
                            })?;
                        copy_bidirectional(&mut local_stream, &mut remote_stream)
                            .await
                            .map_err(|error| error.to_string())?;
                        drop(remote_stream);
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
            state.sessions.write().await.remove(&id);
        });
        Ok(session)
    }

    async fn set_error(&self, id: &str, error: String) {
        if let Some(running) = self.sessions.write().await.get_mut(id) {
            running.session.status = "Error".into();
            running.session.error = Some(error);
        }
    }
}
