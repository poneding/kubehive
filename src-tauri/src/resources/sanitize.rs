use super::*;

pub(crate) fn sanitize_manifest_object(value: &mut Value) {
    if let Some(metadata) = value
        .pointer_mut("/metadata")
        .and_then(Value::as_object_mut)
    {
        metadata.remove("managedFields");
    }
}

/// Keeps list/watch payloads compact and masks sensitive data before broadcast.
pub(crate) fn sanitize_object(value: &mut Value, kind: &str, compact: bool) {
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
            if compact {
                for key in ["data", "binaryData"] {
                    if let Some(map) = object.get_mut(key).and_then(Value::as_object_mut) {
                        for value in map.values_mut() {
                            *value = Value::String("••••••••".into());
                        }
                    }
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
