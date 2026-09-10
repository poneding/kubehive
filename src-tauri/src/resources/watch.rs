use super::*;
use futures::{StreamExt, TryStreamExt};
use kube::api::{Api, DynamicObject, WatchEvent};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tauri::ipc::Channel;
use tokio::{sync::RwLock, time::MissedTickBehavior};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Default)]
pub struct WatchRegistry {
    cancellations: RwLock<HashMap<String, CancellationToken>>,
}

const LIST_CHUNK_SIZE: u32 = 500;
const WATCH_BATCH_INTERVAL: Duration = Duration::from_millis(32);

impl WatchRegistry {
    async fn insert(&self, id: String, token: CancellationToken) {
        self.cancellations.write().await.insert(id, token);
    }

    /// Cancels and forgets one subscription; returns `false` when it was already gone.
    pub async fn stop(&self, id: &str) -> bool {
        if let Some(token) = self.cancellations.write().await.remove(id) {
            token.cancel();
            true
        } else {
            false
        }
    }
}

struct WatchSession {
    api: Api<DynamicObject>,
    request: ResourceListRequest,
    channel: Channel<ResourceWatchMessage>,
    subscription_id: String,
    cancellation: CancellationToken,
}

struct WatchCycle {
    version: String,
    pending: HashMap<String, ResourceWatchEvent>,
    needs_relist: bool,
    retry_delay: bool,
}

/// Starts a background list/watch stream for one resource type and returns the subscription id.
/// The first channel message is a snapshot; later messages are `batch`, `error`, or a fresh `snapshot` after a 410 relist.
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
    let session = WatchSession {
        api,
        request,
        channel,
        subscription_id: id.clone(),
        cancellation,
    };
    let subscription_id = id.clone();
    tauri::async_runtime::spawn(async move {
        run_watch_loop(session).await;
        watches.stop(&subscription_id).await;
    });
    Ok(id)
}

async fn run_watch_loop(session: WatchSession) {
    let mut version = session
        .request
        .resource_version
        .clone()
        .unwrap_or_else(|| "0".into());

    loop {
        if session.cancellation.is_cancelled() {
            break;
        }
        let params = watch_params(&session.request);
        let stream = match session.api.watch(&params, &version).await {
            Ok(stream) => stream.boxed(),
            Err(error) => {
                if !handle_watch_open_error(&session, &mut version, error).await {
                    break;
                }
                continue;
            }
        };
        let mut cycle = consume_watch_events(&session, stream, version).await;
        version = cycle.version.clone();
        if session.cancellation.is_cancelled() {
            break;
        }
        if flush_watch_events(
            &session.channel,
            &session.subscription_id,
            &version,
            &mut cycle.pending,
        )
        .is_err()
        {
            session.cancellation.cancel();
            break;
        }
        if cycle.needs_relist {
            match send_watch_snapshot(
                &session.api,
                &session.request,
                &session.channel,
                &session.subscription_id,
            )
            .await
            {
                Ok(next_version) => version = next_version,
                Err(error) => {
                    if send_watch_error(&session.channel, &session.subscription_id, &version, error)
                        .is_err()
                    {
                        session.cancellation.cancel();
                        break;
                    }
                    cycle.retry_delay = true;
                }
            }
        }
        if cycle.retry_delay && !wait_for_watch_retry(&session).await {
            break;
        }
    }
}

async fn consume_watch_events<S>(
    session: &WatchSession,
    mut stream: S,
    version: String,
) -> WatchCycle
where
    S: futures::TryStream<Ok = WatchEvent<DynamicObject>, Error = kube::Error> + Unpin,
{
    let mut version = version;
    let mut pending = HashMap::<String, ResourceWatchEvent>::new();
    let mut flush = tokio::time::interval(WATCH_BATCH_INTERVAL);
    flush.set_missed_tick_behavior(MissedTickBehavior::Skip);
    flush.tick().await;
    let mut needs_relist = false;
    let mut retry_delay = false;

    loop {
        tokio::select! {
            _ = session.cancellation.cancelled() => break,
            _ = flush.tick() => {
                if flush_watch_events(&session.channel, &session.subscription_id, &version, &mut pending).is_err() {
                    session.cancellation.cancel();
                    break;
                }
            }
            value = stream.try_next() => match value {
                Ok(Some(event)) => match event {
                    WatchEvent::Added(object) => queue_watch_record(&mut pending, "added", object, &session.request.resource, session.request.compact, &mut version),
                    WatchEvent::Modified(object) => queue_watch_record(&mut pending, "modified", object, &session.request.resource, session.request.compact, &mut version),
                    WatchEvent::Deleted(object) => queue_watch_record(&mut pending, "deleted", object, &session.request.resource, session.request.compact, &mut version),
                    WatchEvent::Bookmark(bookmark) => version = bookmark.metadata.resource_version,
                    WatchEvent::Error(error) => {
                        if error.code == 410 {
                            needs_relist = true;
                        } else {
                            retry_delay = true;
                            if send_watch_error(&session.channel, &session.subscription_id, &version, error.to_string()).is_err() {
                                session.cancellation.cancel();
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
                        if send_watch_error(&session.channel, &session.subscription_id, &version, error.to_string()).is_err() {
                            session.cancellation.cancel();
                        }
                    }
                    break;
                }
            }
        }
    }

    WatchCycle {
        version,
        pending,
        needs_relist,
        retry_delay,
    }
}

async fn handle_watch_open_error(
    session: &WatchSession,
    version: &mut String,
    error: kube::Error,
) -> bool {
    if matches!(&error, kube::Error::Api(response) if response.code == 410) {
        match send_watch_snapshot(
            &session.api,
            &session.request,
            &session.channel,
            &session.subscription_id,
        )
        .await
        {
            Ok(next_version) => {
                *version = next_version;
                return true;
            }
            Err(snapshot_error) => {
                if send_watch_error(
                    &session.channel,
                    &session.subscription_id,
                    version,
                    snapshot_error,
                )
                .is_err()
                {
                    session.cancellation.cancel();
                    return false;
                }
            }
        }
    } else if send_watch_error(
        &session.channel,
        &session.subscription_id,
        version,
        error.to_string(),
    )
    .is_err()
    {
        session.cancellation.cancel();
        return false;
    }
    wait_for_watch_retry(session).await
}

async fn wait_for_watch_retry(session: &WatchSession) -> bool {
    tokio::select! {
        _ = session.cancellation.cancelled() => false,
        _ = tokio::time::sleep(Duration::from_secs(2)) => true,
    }
}

pub(super) fn queue_watch_record(
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

pub(crate) async fn list_resource_pages(
    api: &Api<DynamicObject>,
    request: &ResourceListRequest,
) -> Result<ResourceListResponse, String> {
    let mut continue_token: Option<String> = None;
    let mut resource_version = "0".to_string();
    let mut items = Vec::new();
    loop {
        let mut params = super::list_params(request).limit(LIST_CHUNK_SIZE);
        if let Some(token) = continue_token.as_deref() {
            params = params.continue_token(token);
        }
        let list = api.list(&params).await.map_err(super::kube_error)?;
        if let Some(version) = list.metadata.resource_version {
            resource_version = version;
        }
        continue_token = list.metadata.continue_.filter(|token| !token.is_empty());
        items.extend(
            list.items
                .into_iter()
                .map(|object| super::record_from_object(object, &request.resource, request.compact))
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
