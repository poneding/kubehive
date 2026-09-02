//! Follow-mode pod log streaming.
//!
//! `pod_logs` in [`crate::resources`] fetches a tail snapshot; this module keeps
//! the connection open instead and pushes each new line over an IPC channel, so
//! the UI appends rather than re-fetching the whole buffer on a timer. The
//! attach/backoff/batch shape mirrors the resource watch in [`crate::resources`].
use crate::{
    models::{PodLogEvent, PodLogStreamRequest},
    registry::ClusterRegistry,
};
use chrono::{DateTime, Utc};
use futures::{AsyncBufReadExt, StreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, LogParams};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tauri::ipc::Channel;
use tokio::{sync::RwLock, time::MissedTickBehavior};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// Coarse enough that a chatty container cannot force a re-render every frame,
/// fine enough that a line still feels like it appears instantly.
const FLUSH_INTERVAL: Duration = Duration::from_millis(120);
/// Ceiling on one batch so a burst cannot hand the UI an unbounded array.
const MAX_BATCH_LINES: usize = 2_000;
/// Delay before re-attaching after the stream drops with an error.
const RETRY_DELAY: Duration = Duration::from_secs(2);
const DEFAULT_TAIL_LINES: i64 = 1_000;
const MAX_TAIL_LINES: i64 = 10_000;

#[derive(Default)]
pub struct LogStreamRegistry {
    cancellations: RwLock<HashMap<String, CancellationToken>>,
}

impl LogStreamRegistry {
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

enum Outcome {
    Cancelled,
    /// The container stopped writing; kubernetes closed the stream normally.
    Ended,
    Failed(String),
}

/// Structural check for the RFC3339 stamp kubelet prefixes onto each line.
fn looks_like_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 20
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && value.ends_with('Z')
}

fn parse_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|stamp| stamp.with_timezone(&Utc))
}

/// Splits kubelet's timestamp off a streamed line: the stamp drives reconnect
/// bookkeeping, the body is what the UI renders.
fn split_log_line(line: String, keep_timestamp: bool) -> (Option<String>, String) {
    let boundary = match line.find(' ') {
        Some(index) if looks_like_timestamp(&line[..index]) => index,
        _ => return (None, line),
    };
    let stamp = line[..boundary].to_string();
    let body = if keep_timestamp {
        line
    } else {
        line[boundary + 1..].to_string()
    };
    (Some(stamp), body)
}

/// True when `stamp` is newer than the last line already delivered. Unparsable
/// stamps keep the line: showing a duplicate beats silently dropping output.
fn is_newer(stamp: &str, boundary: &str) -> bool {
    match (parse_timestamp(stamp), parse_timestamp(boundary)) {
        (Some(left), Some(right)) => left > right,
        _ => true,
    }
}

/// `resume_from` is set only when re-attaching: ask for everything after the last
/// line we delivered instead of replaying the tail window again. `since_time` has
/// second granularity, so per-line stamps still filter the overlap.
fn stream_params(request: &PodLogStreamRequest, resume_from: Option<&str>) -> LogParams {
    LogParams {
        container: request.container.clone(),
        follow: true,
        // Always on the wire: the stamps are how a reconnect avoids duplicates.
        // They are stripped before sending unless the reader asked to see them.
        timestamps: true,
        since_time: resume_from.and_then(parse_timestamp),
        tail_lines: match resume_from {
            Some(_) => None,
            None => Some(
                request
                    .tail_lines
                    .unwrap_or(DEFAULT_TAIL_LINES)
                    .clamp(1, MAX_TAIL_LINES),
            ),
        },
        ..Default::default()
    }
}

fn send(
    channel: &Channel<PodLogEvent>,
    stream_id: &str,
    event_type: &str,
    lines: Vec<String>,
    error: Option<String>,
) -> Result<(), tauri::Error> {
    channel.send(PodLogEvent {
        stream_id: stream_id.to_string(),
        event_type: event_type.to_string(),
        lines,
        error,
    })
}

/// Reads one attached stream to completion, batching lines on a timer.
/// `last_stamp` and `skip_until` carry reconnect state across attaches.
async fn pump(
    pods: &Api<Pod>,
    request: &PodLogStreamRequest,
    channel: &Channel<PodLogEvent>,
    stream_id: &str,
    cancellation: &CancellationToken,
    last_stamp: &mut Option<String>,
) -> Outcome {
    let resume_from = last_stamp.clone();
    let params = stream_params(request, resume_from.as_deref());
    let reader = match pods.log_stream(&request.pod, &params).await {
        Ok(reader) => reader,
        Err(error) => return Outcome::Failed(error.to_string()),
    };
    if send(channel, stream_id, "connected", Vec::new(), None).is_err() {
        return Outcome::Cancelled;
    }

    let mut lines = Box::pin(reader.lines());
    let mut batch: Vec<String> = Vec::new();
    let mut skip_until = resume_from;
    let mut flush = tokio::time::interval(FLUSH_INTERVAL);
    flush.set_missed_tick_behavior(MissedTickBehavior::Skip);
    flush.tick().await;

    loop {
        tokio::select! {
            _ = cancellation.cancelled() => return Outcome::Cancelled,
            _ = flush.tick() => {
                if !batch.is_empty()
                    && send(channel, stream_id, "lines", std::mem::take(&mut batch), None).is_err() {
                    return Outcome::Cancelled;
                }
            }
            next = lines.next() => match next {
                Some(Ok(line)) => {
                    let (stamp, body) = split_log_line(line, request.timestamps);
                    if let Some(stamp) = stamp {
                        // Lines at or before the resume point were already delivered.
                        if skip_until.as_deref().is_some_and(|boundary| !is_newer(&stamp, boundary)) {
                            continue;
                        }
                        skip_until = None;
                        *last_stamp = Some(stamp);
                    }
                    batch.push(body);
                    if batch.len() >= MAX_BATCH_LINES
                        && send(channel, stream_id, "lines", std::mem::take(&mut batch), None).is_err() {
                        return Outcome::Cancelled;
                    }
                }
                Some(Err(error)) => {
                    let _ = send(channel, stream_id, "lines", std::mem::take(&mut batch), None);
                    return Outcome::Failed(error.to_string());
                }
                None => {
                    let _ = send(channel, stream_id, "lines", std::mem::take(&mut batch), None);
                    return Outcome::Ended;
                }
            },
        }
    }
}

/// Opens a follow stream and returns its id; the caller stops it with
/// [`LogStreamRegistry::stop`], which also happens when the session closes.
pub async fn start_log_stream(
    registry: Arc<ClusterRegistry>,
    streams: Arc<LogStreamRegistry>,
    request: PodLogStreamRequest,
    channel: Channel<PodLogEvent>,
) -> Result<String, String> {
    let client = registry.streaming_client(&request.cluster_id).await?;
    let pods: Api<Pod> = Api::namespaced(client, &request.namespace);
    let id = Uuid::new_v4().to_string();
    let cancellation = CancellationToken::new();
    streams.insert(id.clone(), cancellation.clone()).await;
    let stream_id = id.clone();

    tauri::async_runtime::spawn(async move {
        let mut last_stamp: Option<String> = None;
        loop {
            if cancellation.is_cancelled() {
                break;
            }
            match pump(
                &pods,
                &request,
                &channel,
                &stream_id,
                &cancellation,
                &mut last_stamp,
            )
            .await
            {
                Outcome::Cancelled => break,
                // A finished container will not produce more output: report it and
                // stop instead of reconnecting in a loop.
                Outcome::Ended => {
                    let _ = send(&channel, &stream_id, "ended", Vec::new(), None);
                    break;
                }
                Outcome::Failed(error) => {
                    if send(&channel, &stream_id, "error", Vec::new(), Some(error)).is_err() {
                        break;
                    }
                    tokio::select! {
                        _ = cancellation.cancelled() => break,
                        _ = tokio::time::sleep(RETRY_DELAY) => {}
                    }
                }
            }
        }
        streams.stop(&stream_id).await;
    });

    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> PodLogStreamRequest {
        PodLogStreamRequest {
            cluster_id: "demo".into(),
            namespace: "default".into(),
            pod: "api-0".into(),
            container: Some("api".into()),
            tail_lines: Some(500),
            timestamps: false,
        }
    }

    #[test]
    fn split_log_line_strips_the_kubelet_timestamp_unless_asked() {
        let line = "2026-09-01T10:00:00.123456789Z hello world".to_string();
        let (stamp, body) = split_log_line(line.clone(), false);
        assert_eq!(stamp.as_deref(), Some("2026-09-01T10:00:00.123456789Z"));
        assert_eq!(body, "hello world");

        let (stamp, body) = split_log_line(line.clone(), true);
        assert_eq!(stamp.as_deref(), Some("2026-09-01T10:00:00.123456789Z"));
        assert_eq!(body, line);
    }

    #[test]
    fn split_log_line_keeps_output_that_has_no_timestamp() {
        let (stamp, body) = split_log_line("plain log line".to_string(), false);
        assert!(stamp.is_none());
        assert_eq!(body, "plain log line");
    }

    #[test]
    fn is_newer_compares_instants_not_strings() {
        // Lexicographically "…00.12Z" sorts after "…00.123Z"; numerically it is older.
        assert!(!is_newer(
            "2026-09-01T10:00:00.12Z",
            "2026-09-01T10:00:00.123Z"
        ));
        assert!(is_newer(
            "2026-09-01T10:00:00.124Z",
            "2026-09-01T10:00:00.123Z"
        ));
        assert!(!is_newer(
            "2026-09-01T10:00:00.123Z",
            "2026-09-01T10:00:00.123Z"
        ));
        // Unparsable stamps keep the line rather than dropping output.
        assert!(is_newer("not-a-stamp", "2026-09-01T10:00:00.123Z"));
    }

    #[test]
    fn first_attach_replays_the_tail_window() {
        let params = stream_params(&request(), None);
        assert!(params.follow);
        assert!(params.timestamps);
        assert_eq!(params.tail_lines, Some(500));
        assert!(params.since_time.is_none());
    }

    #[test]
    fn reattach_resumes_after_the_last_delivered_line() {
        let params = stream_params(&request(), Some("2026-09-01T10:00:00.123456789Z"));
        assert!(params.follow);
        assert_eq!(params.tail_lines, None);
        assert_eq!(
            params.since_time,
            parse_timestamp("2026-09-01T10:00:00.123456789Z")
        );
    }

    #[test]
    fn tail_window_is_clamped_to_a_sane_range() {
        let mut oversized = request();
        oversized.tail_lines = Some(50_000);
        assert_eq!(
            stream_params(&oversized, None).tail_lines,
            Some(MAX_TAIL_LINES)
        );

        let mut missing = request();
        missing.tail_lines = None;
        assert_eq!(
            stream_params(&missing, None).tail_lines,
            Some(DEFAULT_TAIL_LINES)
        );
    }
}
