//! Configurable command queues and dispatchers.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub serve: ServeConfig,
    #[serde(default, rename = "queue")]
    pub queues: Vec<Queue>,
    #[serde(default, rename = "dispatch")]
    pub dispatches: Vec<Dispatch>,
}

#[derive(Debug, Deserialize)]
pub struct ServeConfig {
    #[serde(default = "default_max_agents")]
    pub max_agents: usize,
    #[serde(default = "default_poll_interval_secs")]
    pub poll_interval_secs: u64,
    #[serde(default = "default_state_path")]
    pub state_path: String,
}

fn default_max_agents() -> usize {
    1
}
fn default_poll_interval_secs() -> u64 {
    30
}
fn default_state_path() -> String {
    "styrir-state.json".into()
}

impl Default for ServeConfig {
    fn default() -> Self {
        Self {
            max_agents: default_max_agents(),
            poll_interval_secs: default_poll_interval_secs(),
            state_path: default_state_path(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct Queue {
    pub name: String,
    pub command: Vec<String>,
}
#[derive(Debug, Deserialize)]
pub struct Dispatch {
    pub queue: String,
    pub command: Vec<String>,
    #[serde(default = "default_stdin")]
    pub stdin: String,
    pub capture: Option<String>,
    #[serde(default)]
    pub capture_format: CaptureFormat,
}

fn default_stdin() -> String {
    "item".into()
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureFormat {
    #[default]
    Json,
    Text,
}

#[derive(Clone, Debug)]
enum Captured {
    Json(Value),
    Text(String),
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("invalid Styrir configuration: {0}")]
    Invalid(#[from] toml::de::Error),
    #[error("queue name may not be empty")]
    EmptyQueueName,
    #[error("queue {0} is declared more than once")]
    DuplicateQueue(String),
    #[error("queue {0} has no command")]
    EmptyQueueCommand(String),
    #[error("dispatch for queue {0} has no command")]
    EmptyDispatchCommand(String),
    #[error("dispatch refers to unknown queue {0}")]
    UnknownQueue(String),
}

impl Config {
    pub fn from_toml(input: &str) -> Result<Self, ConfigError> {
        let config: Self = toml::from_str(input)?;
        config.validate()?;
        Ok(config)
    }
    fn validate(&self) -> Result<(), ConfigError> {
        let mut names = BTreeSet::new();
        for queue in &self.queues {
            if queue.name.is_empty() {
                return Err(ConfigError::EmptyQueueName);
            }
            if !names.insert(&queue.name) {
                return Err(ConfigError::DuplicateQueue(queue.name.clone()));
            }
            if queue.command.is_empty() {
                return Err(ConfigError::EmptyQueueCommand(queue.name.clone()));
            }
        }
        for dispatch in &self.dispatches {
            if dispatch.command.is_empty() {
                return Err(ConfigError::EmptyDispatchCommand(dispatch.queue.clone()));
            }
            if !names.contains(&dispatch.queue) {
                return Err(ConfigError::UnknownQueue(dispatch.queue.clone()));
            }
        }
        Ok(())
    }
    fn dispatches_for(&self, queue: &str) -> impl Iterator<Item = &Dispatch> {
        self.dispatches
            .iter()
            .filter(move |dispatch| dispatch.queue == queue)
    }
}

/// Commands are argv arrays; input is supplied directly to stdin, never via a shell.
pub trait CommandExecutor {
    fn run(&mut self, command: &[String], input: Option<&[u8]>) -> Result<String, String>;
}
#[derive(Default)]
pub struct ProcessExecutor;
impl CommandExecutor for ProcessExecutor {
    fn run(&mut self, command: &[String], input: Option<&[u8]>) -> Result<String, String> {
        let (program, args) = command
            .split_first()
            .ok_or_else(|| "empty command".to_owned())?;
        let mut child = Command::new(program)
            .args(args)
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("{program}: {error}"))?;
        if let Some(input) = input {
            child
                .stdin
                .as_mut()
                .expect("stdin is piped")
                .write_all(input)
                .map_err(|error| format!("{program}: {error}"))?;
        }
        let output = child
            .wait_with_output()
            .map_err(|error| format!("{program}: {error}"))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            Err(format!(
                "{program} exited {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct DispatchState {
    pub active: Vec<ActiveDispatch>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ActiveDispatch {
    pub queue: String,
    pub item: Value,
}

impl DispatchState {
    pub fn load(path: &Path) -> Result<Self, StateError> {
        match fs::read_to_string(path) {
            Ok(input) => serde_json::from_str(&input).map_err(StateError::Invalid),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(StateError::Read(error)),
        }
    }
    pub fn save(&self, path: &Path) -> Result<(), StateError> {
        let encoded = serde_json::to_vec_pretty(self).map_err(StateError::Encode)?;
        let temporary = path.with_extension("tmp");
        fs::write(&temporary, encoded).map_err(StateError::Write)?;
        fs::rename(temporary, path).map_err(StateError::Write)
    }
    fn contains(&self, queue: &str, item: &Value) -> bool {
        self.active
            .iter()
            .any(|active| active.queue == queue && active.item == *item)
    }
}

#[derive(Debug, Error)]
pub enum StateError {
    #[error("could not read dispatch state: {0}")]
    Read(#[source] std::io::Error),
    #[error("invalid dispatch state: {0}")]
    Invalid(#[source] serde_json::Error),
    #[error("could not encode dispatch state: {0}")]
    Encode(#[source] serde_json::Error),
    #[error("could not write dispatch state: {0}")]
    Write(#[source] std::io::Error),
}
#[derive(Debug, Error)]
pub enum DispatchError {
    #[error("queue {queue} failed: {error}")]
    QueueCommand { queue: String, error: String },
    #[error("queue {queue} must write a JSON array: {error}")]
    InvalidQueueOutput {
        queue: String,
        error: serde_json::Error,
    },
    #[error("dispatch command for queue {queue} failed: {error}")]
    DispatchCommand { queue: String, error: String },
    #[error("could not encode queue item: {0}")]
    EncodeItem(#[from] serde_json::Error),
    #[error("dispatch input {input} for queue {queue} is unavailable")]
    MissingInput { queue: String, input: String },
    #[error("invalid command template {template} for queue {queue}")]
    InvalidTemplate { queue: String, template: String },
    #[error("template {template} for queue {queue} does not resolve")]
    MissingTemplateValue { queue: String, template: String },
    #[error("captured JSON for queue {queue} is invalid: {error}")]
    InvalidCapture {
        queue: String,
        error: serde_json::Error,
    },
}
#[derive(Debug, Default, Eq, PartialEq)]
pub struct PollReport {
    pub dispatched: usize,
    pub active: usize,
}

pub struct Dispatcher<C> {
    config: Config,
    commands: C,
}
impl<C: CommandExecutor> Dispatcher<C> {
    pub fn new(config: Config, commands: C) -> Self {
        Self { config, commands }
    }
    /// Poll every queue once, releasing only items absent from a successfully polled source queue.
    pub fn poll(&mut self, state: &mut DispatchState) -> Result<PollReport, DispatchError> {
        let mut dispatched = 0;
        for queue in &self.config.queues {
            let output = self.commands.run(&queue.command, None).map_err(|error| {
                DispatchError::QueueCommand {
                    queue: queue.name.clone(),
                    error,
                }
            })?;
            let items: Vec<Value> = serde_json::from_str(&output).map_err(|error| {
                DispatchError::InvalidQueueOutput {
                    queue: queue.name.clone(),
                    error,
                }
            })?;
            state
                .active
                .retain(|active| active.queue != queue.name || items.contains(&active.item));
            if state.active.len() >= self.config.serve.max_agents {
                continue;
            }
            let Some(item) = items.iter().find(|item| !state.contains(&queue.name, item)) else {
                continue;
            };
            let mut captures = BTreeMap::new();
            for dispatch in self.config.dispatches_for(&queue.name) {
                let command = dispatch
                    .command
                    .iter()
                    .map(|argument| resolve_argument(argument, item, &captures, &queue.name))
                    .collect::<Result<Vec<_>, _>>()?;
                let input = resolve_input(&dispatch.stdin, item, &captures, &queue.name)?;
                let output = self
                    .commands
                    .run(&command, input.as_deref())
                    .map_err(|error| DispatchError::DispatchCommand {
                        queue: queue.name.clone(),
                        error,
                    })?;
                if let Some(name) = &dispatch.capture {
                    let captured = match dispatch.capture_format {
                        CaptureFormat::Json => {
                            Captured::Json(serde_json::from_str(&output).map_err(|error| {
                                DispatchError::InvalidCapture {
                                    queue: queue.name.clone(),
                                    error,
                                }
                            })?)
                        }
                        CaptureFormat::Text => Captured::Text(output.trim().into()),
                    };
                    captures.insert(name.clone(), captured);
                }
            }
            state.active.push(ActiveDispatch {
                queue: queue.name.clone(),
                item: item.clone(),
            });
            dispatched += 1;
        }
        Ok(PollReport {
            dispatched,
            active: state.active.len(),
        })
    }
    pub fn config(&self) -> &Config {
        &self.config
    }
}

fn resolve_input(
    input: &str,
    item: &Value,
    captures: &BTreeMap<String, Captured>,
    queue: &str,
) -> Result<Option<Vec<u8>>, DispatchError> {
    if input == "none" {
        return Ok(None);
    }
    let captured = if input == "item" {
        Captured::Json(item.clone())
    } else {
        captures
            .get(input)
            .cloned()
            .ok_or_else(|| DispatchError::MissingInput {
                queue: queue.into(),
                input: input.into(),
            })?
    };
    match captured {
        Captured::Json(value) => Ok(Some(serde_json::to_vec(&value)?)),
        Captured::Text(value) => Ok(Some(value.into_bytes())),
    }
}

fn resolve_argument(
    argument: &str,
    item: &Value,
    captures: &BTreeMap<String, Captured>,
    queue: &str,
) -> Result<String, DispatchError> {
    let Some(path) = argument
        .strip_prefix("{{")
        .and_then(|value| value.strip_suffix("}}"))
    else {
        return Ok(argument.into());
    };
    let template = path.trim();
    if template.is_empty() {
        return Err(DispatchError::InvalidTemplate {
            queue: queue.into(),
            template: argument.into(),
        });
    }
    let mut parts = template.split('.');
    let first = parts.next().expect("non-empty template");
    let mut value = match first {
        "item" => Captured::Json(item.clone()),
        name => captures
            .get(name)
            .cloned()
            .ok_or_else(|| DispatchError::MissingTemplateValue {
                queue: queue.into(),
                template: argument.into(),
            })?,
    };
    for part in parts {
        value = match value {
            Captured::Json(Value::Object(map)) => {
                map.get(part).cloned().map(Captured::Json).ok_or_else(|| {
                    DispatchError::MissingTemplateValue {
                        queue: queue.into(),
                        template: argument.into(),
                    }
                })?
            }
            _ => {
                return Err(DispatchError::MissingTemplateValue {
                    queue: queue.into(),
                    template: argument.into(),
                });
            }
        };
    }
    match value {
        Captured::Text(value) => Ok(value),
        Captured::Json(Value::String(value)) => Ok(value),
        Captured::Json(value) => Ok(value.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct FakeExecutor {
        calls: Vec<(Vec<String>, Option<Vec<u8>>)>,
        responses: Vec<Result<String, String>>,
    }
    impl CommandExecutor for FakeExecutor {
        fn run(&mut self, command: &[String], input: Option<&[u8]>) -> Result<String, String> {
            self.calls.push((command.into(), input.map(Into::into)));
            self.responses.remove(0)
        }
    }
    fn config() -> Config {
        Config::from_toml(
            r#"
        [serve]
        max_agents = 2
        poll_interval_secs = 5
        state_path = "state.json"
        [[queue]]
        name = "skald"
        command = ["skald", "list", "--json"]
        [[dispatch]]
        queue = "skald"
        command = ["heimr-dispatch"]
        [[dispatch]]
        queue = "skald"
        command = ["gardr-dispatch"]
    "#,
        )
        .unwrap()
    }
    #[test]
    fn poll_dispatches_the_first_non_active_item_and_tracks_it() {
        let mut dispatcher = Dispatcher::new(
            config(),
            FakeExecutor {
                calls: vec![],
                responses: vec![
                    Ok(r#"[{"id":"one"},{"id":"two"}]"#.into()),
                    Ok(String::new()),
                    Ok(String::new()),
                ],
            },
        );
        let mut state = DispatchState::default();
        assert_eq!(
            dispatcher.poll(&mut state).unwrap(),
            PollReport {
                dispatched: 1,
                active: 1
            }
        );
        assert_eq!(state.active[0].item, serde_json::json!({"id":"one"}));
        assert_eq!(
            dispatcher.commands.calls[1].1.as_deref(),
            Some(&b"{\"id\":\"one\"}"[..])
        );
    }
    #[test]
    fn successful_poll_releases_an_item_that_left_its_source_queue() {
        let mut dispatcher = Dispatcher::new(
            config(),
            FakeExecutor {
                calls: vec![],
                responses: vec![Ok("[]".into())],
            },
        );
        let mut state = DispatchState {
            active: vec![ActiveDispatch {
                queue: "skald".into(),
                item: serde_json::json!({"id":"one"}),
            }],
        };
        assert_eq!(
            dispatcher.poll(&mut state).unwrap(),
            PollReport {
                dispatched: 0,
                active: 0
            }
        );
    }
    #[test]
    fn queue_failure_does_not_release_active_items() {
        let mut dispatcher = Dispatcher::new(
            config(),
            FakeExecutor {
                calls: vec![],
                responses: vec![Err("unavailable".into())],
            },
        );
        let mut state = DispatchState {
            active: vec![ActiveDispatch {
                queue: "skald".into(),
                item: serde_json::json!({"id":"one"}),
            }],
        };
        assert!(matches!(
            dispatcher.poll(&mut state),
            Err(DispatchError::QueueCommand { .. })
        ));
        assert_eq!(state.active.len(), 1);
    }
    #[test]
    fn later_stage_uses_captured_json_in_an_argv_template() {
        let config = Config::from_toml(
            r#"
            [[queue]]
            name = "skald"
            command = ["queue"]
            [[dispatch]]
            queue = "skald"
            command = ["heimr"]
            capture = "workspace"
            capture_format = "json"
            [[dispatch]]
            queue = "skald"
            command = ["gardr", "--workspace", "{{ workspace.path }}"]
            stdin = "none"
        "#,
        )
        .unwrap();
        let mut dispatcher = Dispatcher::new(
            config,
            FakeExecutor {
                calls: vec![],
                responses: vec![
                    Ok(r#"[{"id":"one"}]"#.into()),
                    Ok(r#"{"path":"/work/one"}"#.into()),
                    Ok(String::new()),
                ],
            },
        );
        dispatcher.poll(&mut DispatchState::default()).unwrap();
        assert_eq!(
            dispatcher.commands.calls[2].0,
            ["gardr", "--workspace", "/work/one"]
        );
        assert_eq!(dispatcher.commands.calls[2].1, None);
    }

    #[test]
    fn configuration_rejects_unknown_queue_mapping() {
        assert!(matches!(
            Config::from_toml("[[dispatch]]\nqueue = 'missing'\ncommand = ['x']"),
            Err(ConfigError::UnknownQueue(_))
        ));
    }
}
