use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn push_unique(parts: &mut Vec<String>, value: impl Into<String>) {
    let value = value.into();
    if !value.is_empty() && !parts.contains(&value) {
        parts.push(value);
    }
}

fn status_causes(status: &Status) -> impl Iterator<Item = (&str, &str)> {
    status
        .details
        .as_ref()
        .and_then(|details| details.causes.as_ref())
        .into_iter()
        .flatten()
        .map(|cause| {
            (
                non_empty(cause.reason.as_deref()).unwrap_or(""),
                non_empty(cause.message.as_deref()).unwrap_or(""),
            )
        })
}

pub(crate) fn status_failure(status: Option<&Status>) -> Option<String> {
    let status = status?;
    let summary = non_empty(status.status.as_deref());
    if summary.is_some_and(|value| value.eq_ignore_ascii_case("success")) {
        return None;
    }

    let message = non_empty(status.message.as_deref());
    let reason = non_empty(status.reason.as_deref());
    let causes = status_causes(status).collect::<Vec<_>>();
    let has_failure = summary.is_some()
        || status.code.is_some_and(|code| code >= 400)
        || message.is_some_and(|value| !value.eq_ignore_ascii_case("success"))
        || reason.is_some()
        || causes.iter().any(|(cause_reason, cause_message)| {
            !cause_reason.is_empty() || (!cause_message.is_empty() && *cause_message != "0")
        });
    if !has_failure {
        return None;
    }

    let mut parts = Vec::new();
    if let Some(message) = message {
        push_unique(&mut parts, message);
    }
    for (cause_reason, cause_message) in causes {
        let detail = if cause_reason.eq_ignore_ascii_case("ExitCode") && !cause_message.is_empty() {
            format!("exit code {cause_message}")
        } else if !cause_reason.is_empty() && !cause_message.is_empty() {
            format!("{cause_reason}: {cause_message}")
        } else if !cause_message.is_empty() {
            cause_message.to_string()
        } else {
            cause_reason.to_string()
        };
        push_unique(&mut parts, detail);
    }
    if let Some(reason) = reason {
        push_unique(&mut parts, reason);
    }
    if parts.is_empty() {
        if let Some(summary) = summary {
            push_unique(&mut parts, summary);
        }
        if let Some(code) = status.code {
            push_unique(&mut parts, format!("status code {code}"));
        }
    }
    Some(if parts.is_empty() {
        "Remote command failed".into()
    } else {
        parts.join("; ")
    })
}

pub(crate) fn status_text(status: Option<&Status>) -> Option<String> {
    status_failure(status).or_else(|| {
        let status = status?;
        non_empty(status.message.as_deref())
            .or_else(|| non_empty(status.status.as_deref()))
            .or_else(|| non_empty(status.reason.as_deref()))
            .map(str::to_string)
    })
}

pub(crate) fn command_succeeded(status: Option<&Status>, stderr: &str) -> bool {
    if status_failure(status).is_some() {
        return false;
    }
    status
        .and_then(|status| non_empty(status.status.as_deref()))
        .is_some_and(|summary| summary.eq_ignore_ascii_case("success"))
        || stderr.trim().is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{StatusCause, StatusDetails};

    #[test]
    fn accepts_an_explicit_success_status() {
        let status = Status {
            status: Some("Success".into()),
            ..Default::default()
        };
        assert_eq!(status_failure(Some(&status)), None);
        assert!(command_succeeded(Some(&status), ""));
        assert_eq!(status_text(Some(&status)).as_deref(), Some("Success"));
    }

    #[test]
    fn rejects_failure_status_without_a_message() {
        let status = Status {
            status: Some("Failure".into()),
            ..Default::default()
        };
        assert_eq!(status_failure(Some(&status)).as_deref(), Some("Failure"));
        assert!(!command_succeeded(Some(&status), ""));
    }

    #[test]
    fn includes_exit_code_causes_in_failure_details() {
        let status = Status {
            status: Some("Failure".into()),
            details: Some(StatusDetails {
                causes: Some(vec![StatusCause {
                    reason: Some("ExitCode".into()),
                    message: Some("13".into()),
                    ..Default::default()
                }]),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            status_failure(Some(&status)).as_deref(),
            Some("exit code 13")
        );
    }

    #[test]
    fn missing_status_uses_stderr_as_the_success_fallback() {
        assert!(command_succeeded(None, ""));
        assert!(!command_succeeded(None, "permission denied"));
    }
}
