use super::*;
use kube::api::PostParams;
use serde_json::{Map, Value};

fn job_batch_descriptor() -> ApiResourceDescriptor {
    ApiResourceDescriptor {
        api_version: "batch/v1".into(),
        group: "batch".into(),
        version: "v1".into(),
        kind: "Job".into(),
        plural: "jobs".into(),
        namespaced: true,
        verbs: vec!["create".into(), "get".into(), "list".into()],
        categories: Vec::new(),
    }
}

/// Suspends or resumes a CronJob by patching `spec.suspend`.
pub async fn set_cronjob_suspend(
    registry: &ClusterRegistry,
    request: CronJobSuspendRequest,
) -> Result<ResourceDetail, String> {
    if request.target.resource.kind != "CronJob" {
        return Err("Only CronJobs support suspend/resume".into());
    }
    let client = registry.client(&request.target.cluster_id).await?;
    let api = dynamic_api(
        client,
        &request.target.resource,
        request.target.namespace.as_deref(),
        true,
    )?;
    let patch = json!({"spec": {"suspend": request.suspend}});
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

/// Creates a Job from a CronJob's `spec.jobTemplate`, mirroring
/// `kubectl create job --from=cronjob/<name>`. The new Job carries an
/// ownerReference back to the CronJob so it groups with scheduled runs.
pub async fn trigger_cronjob(
    registry: &ClusterRegistry,
    target: ResourceTarget,
) -> Result<ResourceDetail, String> {
    if target.resource.kind != "CronJob" {
        return Err("Only CronJobs can be triggered".into());
    }
    let namespace = target
        .namespace
        .as_deref()
        .filter(|value| !value.is_empty() && *value != "All namespaces")
        .ok_or_else(|| "A namespace is required to trigger a CronJob".to_string())?;
    let client = registry.client(&target.cluster_id).await?;
    let cronjobs = dynamic_api(client.clone(), &target.resource, Some(namespace), true)?;
    let cronjob = cronjobs.get(&target.name).await.map_err(kube_error)?;
    let cronjob_value = serde_json::to_value(&cronjob)
        .map_err(|error| format!("Unable to read CronJob manifest: {error}"))?;
    let Some(template) = cronjob_value.pointer("/spec/jobTemplate").cloned() else {
        return Err(format!("CronJob/{} has no spec.jobTemplate", target.name));
    };
    let Some(template_spec) = template.pointer("/spec").cloned() else {
        return Err(format!(
            "CronJob/{} has no spec.jobTemplate.spec",
            target.name
        ));
    };
    let uid = cronjob_value
        .pointer("/metadata/uid")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("CronJob/{} has no metadata.uid", target.name))?;

    let suffix = to_base36(Utc::now().timestamp_millis());
    let marker = format!("-manual-{suffix}");
    let budget = 63_usize.saturating_sub(marker.len());
    let prefix: String = target.name.chars().take(budget).collect();
    let prefix = prefix.trim_end_matches('-');
    let job_name = format!("{prefix}{marker}");

    let jobs = dynamic_api(client, &job_batch_descriptor(), Some(namespace), true)?;
    let config = TriggeredJobConfig {
        job_name: &job_name,
        namespace,
        target: &target,
        uid,
        template_metadata: template.pointer("/metadata"),
        template_spec: &template_spec,
    };
    let mut object = build_triggered_job(&config)?;
    for attempt in 0..3 {
        match jobs.create(&PostParams::default(), &object).await {
            Ok(created) => return detail_from_object(created, &job_batch_descriptor()),
            Err(kube::Error::Api(response)) if response.code == 409 && attempt < 2 => {
                object.metadata.name = Some(format!("{job_name}-r{}", attempt + 1));
            }
            Err(error) => return Err(kube_error(error)),
        }
    }
    unreachable!("the create loop always returns")
}

struct TriggeredJobConfig<'a> {
    job_name: &'a str,
    namespace: &'a str,
    target: &'a ResourceTarget,
    uid: &'a str,
    template_metadata: Option<&'a Value>,
    template_spec: &'a Value,
}

fn build_triggered_job(config: &TriggeredJobConfig<'_>) -> Result<DynamicObject, String> {
    let mut metadata = Map::new();
    metadata.insert("name".into(), json!(config.job_name));
    metadata.insert("namespace".into(), json!(config.namespace));
    for key in ["labels", "annotations"] {
        if let Some(value) = config.template_metadata.and_then(|meta| meta.get(key)) {
            if value.is_object() {
                metadata.insert(key.into(), value.clone());
            }
        }
    }
    metadata.insert(
        "ownerReferences".into(),
        json!([{
            "apiVersion": config.target.resource.api_version,
            "kind": "CronJob",
            "name": config.target.name,
            "uid": config.uid,
            "controller": true,
            "blockOwnerDeletion": true,
        }]),
    );
    let job = json!({
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": Value::Object(metadata),
        "spec": config.template_spec,
    });
    serde_json::from_value(job).map_err(|error| format!("Unable to build Job manifest: {error}"))
}

fn to_base36(mut value: i64) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while value > 0 {
        digits.push(ALPHABET[(value % 36) as usize]);
        value /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_default()
}
