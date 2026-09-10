use std::{
    path::{Path, PathBuf},
    process, thread,
    time::Duration,
};

use clap::{CommandFactory, Parser, Subcommand};
use styrir::{Config, DispatchState, Dispatcher, ProcessExecutor};

#[derive(Parser)]
#[command(
    name = "styrir",
    about = "Configurable command queue dispatcher",
    disable_help_subcommand = true
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Poll queues once and dispatch at most one item per queue.
    Dispatch {
        #[arg(long, default_value = "styrir.toml")]
        config: PathBuf,
    },
    /// Continuously poll queues, respecting the configured agent cap.
    Serve {
        #[arg(long, default_value = "styrir.toml")]
        config: PathBuf,
    },
    Help,
    Docs,
}

fn main() {
    let result = match Cli::parse().command {
        Some(Command::Dispatch { config }) => run_once(&config),
        Some(Command::Serve { config }) => serve(&config),
        Some(Command::Help) | None => {
            Cli::command().print_help().expect("stdout is writable");
            Ok(())
        }
        Some(Command::Docs) => {
            print_docs();
            Ok(())
        }
    };
    if let Err(error) = result {
        eprintln!("Styrir failed: {error}");
        process::exit(1);
    }
}

fn load(
    path: &Path,
) -> Result<(Dispatcher<ProcessExecutor>, DispatchState, PathBuf), Box<dyn std::error::Error>> {
    let config = Config::from_toml(&std::fs::read_to_string(path)?)?;
    let state_path = PathBuf::from(&config.serve.state_path);
    let state = DispatchState::load(&state_path)?;
    Ok((Dispatcher::new(config, ProcessExecutor), state, state_path))
}
fn run_once(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let (mut dispatcher, mut state, state_path) = load(path)?;
    let report = dispatcher.poll(&mut state)?;
    state.save(&state_path)?;
    println!("{} dispatched, {} active", report.dispatched, report.active);
    Ok(())
}
fn serve(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let (mut dispatcher, mut state, state_path) = load(path)?;
    loop {
        let report = dispatcher.poll(&mut state)?;
        state.save(&state_path)?;
        if report.dispatched == 0 {
            thread::sleep(Duration::from_secs(
                dispatcher.config().serve.poll_interval_secs,
            ));
        }
    }
}
fn print_docs() {
    print!(
        r#"# Styrir

`styrir serve` polls queues in declaration order. It dispatches the first item not already active from each queue, up to `[serve].max_agents`. When a complete poll dispatches no items, it waits `[serve].poll_interval_secs` before polling again. `styrir dispatch` performs one such poll.

Queue commands write JSON arrays. Per item, mapped dispatches run in order. `stdin` selects `item` (the default), `none`, or an earlier capture. `capture` saves stdout as `json` (the default) or trimmed `text`; a complete argv element may safely reference it with `{{{{ capture.path }}}}`. Commands are argv arrays and never use a shell. Styrir persists active `{{ queue, item }}` records in `[serve].state_path`. After a successful queue poll, an active item is released when it is absent from that queue. Failed polls retain all active items.

```toml
[serve]
max_agents = 4
poll_interval_secs = 30
state_path = "styrir-state.json"

[[queue]]
name = "skald-building"
command = ["skald", "list", "--status", "building", "--json"]

[[dispatch]]
queue = "skald-building"
command = ["heimr-dispatch"]
capture = "workspace"

[[dispatch]]
queue = "skald-building"
command = ["gardr", "run", "start", "--workspace", "{{{{ workspace.path }}}}"]
stdin = "none"
```
"#
    );
}
