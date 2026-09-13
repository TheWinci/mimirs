//! Local newline-delimited MCP 2025-11-25. Stdout contains protocol messages only.
mod tools;
use crate::{embedding, retrieval::query::Retriever};
use anyhow::Result;
use clap::Args;
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
};

const VERSION: &str = "2025-11-25";
const MAX_INPUT: usize = 1_048_576;
#[derive(Args, Clone)]
pub struct Options {
    #[arg(long, default_value = ".")]
    pub root: PathBuf,
    #[arg(long)]
    pub repository: Option<String>,
    #[arg(long)]
    pub default_branch: Option<String>,
    #[arg(long)]
    pub state: Option<PathBuf>,
}
#[derive(Default, PartialEq)]
enum Phase {
    #[default]
    New,
    Initializing,
    Ready,
}
struct Server {
    options: Options,
    phase: Phase,
    retriever: Retriever,
}
fn error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
fn success(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}
fn tool_error(error: &anyhow::Error) -> String {
    let text = format!("{error:#}");
    if text.len() <= 4096 {
        return text;
    }
    let mut end = 4060;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{} [error shortened]", &text[..end])
}
impl Server {
    fn handle(
        &mut self,
        message: Value,
        make_embedder: impl FnOnce() -> Result<embedding::Embedder>,
    ) -> Option<Value> {
        let object = match message.as_object() {
            Some(o) => o,
            None => return Some(error(Value::Null, -32600, "expected one JSON-RPC object")),
        };
        let id = object.get("id").cloned();
        if message["jsonrpc"] == "2.0"
            && id.is_some()
            && object.get("method").is_none()
            && (object.contains_key("result") || object.contains_key("error"))
        {
            return None;
        }
        let notification = id.is_none() && message["method"].is_string();
        let invalid = message["jsonrpc"] != "2.0"
            || !message["method"].is_string()
            || id
                .as_ref()
                .is_some_and(|v| !v.is_string() && !v.is_i64() && !v.is_u64())
            || object.get("params").is_some_and(|p| !p.is_object());
        if invalid {
            return if notification {
                None
            } else {
                Some(error(Value::Null, -32600, "invalid JSON-RPC request"))
            };
        }
        let method = message["method"].as_str().unwrap();
        if notification {
            if method == "notifications/initialized" && self.phase == Phase::Initializing {
                self.phase = Phase::Ready;
            }
            // Unknown notifications, including cancellation of completed synchronous work, have no reply.
            return None;
        }
        let id = id.unwrap_or(Value::Null);
        let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
        let response = match method {
            "ping" => success(id, json!({})),
            "initialize" => {
                if self.phase != Phase::New {
                    error(id, -32600, "already initialized")
                } else if !params["protocolVersion"].is_string()
                    || !params["capabilities"].is_object()
                    || !params["clientInfo"]["name"].is_string()
                    || !params["clientInfo"]["version"].is_string()
                {
                    error(
                        id,
                        -32602,
                        "initialize requires protocolVersion, capabilities and clientInfo",
                    )
                } else {
                    self.phase = Phase::Initializing;
                    // Unsupported requested versions negotiate our sole supported version.
                    success(
                        id,
                        json!({"protocolVersion":VERSION,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"mimirs","version":env!("CARGO_PKG_VERSION")}}),
                    )
                }
            }
            _ if self.phase != Phase::Ready => error(
                id,
                -32002,
                "initialize and send notifications/initialized before using tools",
            ),
            "tools/list" => {
                if params.get("cursor").is_some() {
                    error(id, -32602, "unknown cursor; this tool list fits one page")
                } else {
                    success(id, tools::list())
                }
            }
            "tools/call" => {
                let Some(name) = params["name"].as_str() else {
                    return Some(error(id, -32602, "tools/call requires a tool name"));
                };
                if !tools::NAMES.contains(&name) {
                    error(id, -32602, "unknown tool")
                } else if params.get("task").is_some() {
                    error(id, -32602, "task-augmented calls are not supported")
                } else if params.get("arguments").is_some_and(|a| !a.is_object()) {
                    error(id, -32602, "arguments must be an object")
                } else {
                    let args = params
                        .get("arguments")
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    let result = match tools::call(
                        &self.options,
                        &mut self.retriever,
                        name,
                        args,
                        make_embedder,
                    ) {
                        Ok(value) => {
                            json!({"content":[{"type":"text","text":serde_json::to_string(&value).expect("value")}],"isError":false})
                        }
                        Err(e) => {
                            json!({"content":[{"type":"text","text":tool_error(&e)}],"isError":true})
                        }
                    };
                    success(id, result)
                }
            }
            _ => error(id, -32601, "method not found"),
        };
        Some(response)
    }
}

fn serve(input: &mut impl BufRead, output: &mut impl Write, server: &mut Server) -> Result<()> {
    loop {
        // Read at most a bounded line. An oversized peer is disconnected, not buffered indefinitely.
        let mut line = Vec::new();
        let count = std::io::Read::take(&mut *input, (MAX_INPUT + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            break;
        }
        if line.len() > MAX_INPUT {
            serde_json::to_writer(
                &mut *output,
                &error(Value::Null, -32600, "MCP input line exceeds 1048576 bytes"),
            )?;
            writeln!(output)?;
            output.flush()?;
            break;
        }
        let response = match serde_json::from_slice::<Value>(&line) {
            Ok(value) => server.handle(value, embedding::production),
            Err(_) => Some(error(Value::Null, -32700, "invalid JSON")),
        };
        if let Some(value) = response {
            serde_json::to_writer(&mut *output, &value)?;
            writeln!(output)?;
            output.flush()?;
        }
    }
    Ok(())
}
pub fn run(mut options: Options) -> Result<()> {
    options.root = options.root.canonicalize()?;
    let mut server = Server {
        options,
        phase: Phase::New,
        retriever: Retriever::default(),
    };
    serve(
        &mut io::stdin().lock(),
        &mut io::stdout().lock(),
        &mut server,
    )
}

#[cfg(test)]
#[path = "../tests/unit/mcp.rs"]
mod tests;
