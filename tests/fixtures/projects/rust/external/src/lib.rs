use serde::Serialize;

pub fn encode(value: &str) {
    serde_json::to_string(value);
    Serialize::serialize(value);
}
