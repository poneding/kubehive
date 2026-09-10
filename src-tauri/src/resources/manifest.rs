use super::*;
use kube::api::{Api, DynamicObject, Patch, PatchParams, ValidationDirective};
use serde_json::{Map, Value};

/// Parses and validates a single-object manifest without contacting a cluster.
pub(crate) fn parse_manifest(manifest: &str, format: ManifestFormat) -> Result<Value, String> {
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

/// Removes API-server-owned fields before calculating an exact merge patch.
pub(crate) fn normalize_manifest_for_diff(value: &mut Value) {
    super::sanitize_manifest_object(value);
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
///   `spec.taints` take effect regardless of which field manager owns them
///   (server-side apply would silently skip such removals).
///
/// Returns `None` when the two objects are equivalent.
pub(crate) fn merge_patch_between(base: &Value, desired: &Value) -> Option<Value> {
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

struct ManifestDocument {
    value: Value,
    api_version: String,
    kind: String,
    name: String,
}

fn parse_manifest_document(
    manifest: &str,
    format: ManifestFormat,
) -> Result<ManifestDocument, String> {
    let mut value = parse_manifest(manifest, format)?;
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
    if let Some(object) = value.as_object_mut() {
        object.remove("status");
    }
    Ok(ManifestDocument {
        value,
        api_version,
        kind,
        name,
    })
}

fn merge_manifest(
    current: &DynamicObject,
    desired: &Value,
    descriptor: &ApiResourceDescriptor,
) -> Result<Option<Value>, String> {
    let mut base = serde_json::to_value(current)
        .map_err(|error| format!("Unable to read current {} state: {error}", descriptor.kind))?;
    let mut desired = desired.clone();
    normalize_manifest_for_diff(&mut base);
    normalize_manifest_for_diff(&mut desired);
    Ok(merge_patch_between(&base, &desired))
}

async fn apply_new_resource(
    api: &Api<DynamicObject>,
    name: &str,
    value: &Value,
    descriptor: &ApiResourceDescriptor,
    dry_run: bool,
    force: bool,
) -> Result<ResourceDetail, String> {
    let mut params = PatchParams::apply("kubehive").validation_strict();
    if dry_run {
        params = params.dry_run();
    }
    if force {
        params = params.force();
    }
    let object = api
        .patch(name, &params, &Patch::Apply(value))
        .await
        .map_err(kube_error)?;
    detail_from_object(object, descriptor)
}

async fn apply_existing_resource(
    api: &Api<DynamicObject>,
    current: DynamicObject,
    name: &str,
    value: &Value,
    descriptor: &ApiResourceDescriptor,
    dry_run: bool,
) -> Result<ResourceDetail, String> {
    let Some(patch) = merge_manifest(&current, value, descriptor)? else {
        return detail_from_object(current, descriptor);
    };
    let params = PatchParams {
        field_manager: Some("kubehive".into()),
        field_validation: Some(ValidationDirective::Strict),
        dry_run,
        ..PatchParams::default()
    };
    let object = api
        .patch(name, &params, &Patch::Merge(&patch))
        .await
        .map_err(kube_error)?;
    detail_from_object(object, descriptor)
}

async fn apply_manifest_resource(
    api: &Api<DynamicObject>,
    document: &ManifestDocument,
    descriptor: &ApiResourceDescriptor,
    dry_run: bool,
    force: bool,
) -> Result<ResourceDetail, String> {
    match api.get(&document.name).await {
        Ok(current) => {
            apply_existing_resource(
                api,
                current,
                &document.name,
                &document.value,
                descriptor,
                dry_run,
            )
            .await
        }
        Err(error) if matches!(&error, kube::Error::Api(response) if response.code == 404) => {
            apply_new_resource(
                api,
                &document.name,
                &document.value,
                descriptor,
                dry_run,
                force,
            )
            .await
        }
        Err(error) => Err(kube_error(error)),
    }
}

/// Applies a single-object manifest.
/// New objects use server-side apply; existing objects use an exact RFC 7386 merge patch so field removals take effect regardless of which field manager owns them. Honors dry-run and force.
pub async fn apply_manifest(
    registry: &ClusterRegistry,
    request: ApplyManifestRequest,
) -> Result<ResourceDetail, String> {
    let document = parse_manifest_document(&request.manifest, request.format)?;
    let client = registry.client(&request.cluster_id).await?;
    let descriptor = match request.resource.as_ref() {
        Some(resource)
            if resource.api_version == document.api_version && resource.kind == document.kind =>
        {
            resource.clone()
        }
        _ => resolve_descriptor(client.clone(), &document.api_version, &document.kind).await?,
    };
    let namespace = document
        .value
        .pointer("/metadata/namespace")
        .and_then(Value::as_str);
    let api = dynamic_api(client, &descriptor, namespace, true)?;
    apply_manifest_resource(&api, &document, &descriptor, request.dry_run, request.force).await
}
