# Styrir

> The `deploy/paperclip/` directory holds the self-hosted Paperclip deployment
> (slice 1 of the adoption ticket) that will eventually be bridged to this
> dispatcher's replacement. See `deploy/paperclip/README.md`. The dispatcher
> below is being replaced (slice 3); it is left in place here, not extended.

Styrir is a configurable local command dispatcher. It has no built-in queue provider, workflow engine, or Restate integration.

## Service

`styrir serve` polls queues in declaration order. Each poll dispatches the first non-active item from each queue until it reaches the global agent limit. Styrir persists active `{ queue, item }` records itself. A successful queue poll releases items which no longer appear in that queue; a failed poll releases none. If a full poll dispatches nothing, the service waits for the configured interval before trying again.

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

[[dispatch]]
queue = "skald-building"
command = ["gardr-dispatch"]
```

Queue commands write JSON arrays to stdout. Each array element runs an ordered dispatch pipeline. A stage's `stdin` is `item` (default), `none`, or a prior capture name. `capture` saves stage stdout as `json` (default) or trimmed `text`. Later command arguments may use a complete-element template such as `{{ workspace.path }}` or `{{ item.id }}`; templates never invoke a shell. The Heimr adapter is configuration-owned; it can return `{"path":"/workspace"}` for Gardr to consume.

## Usage

```sh
styrir dispatch # one polling round
styrir serve
styrir serve --config path/to/styrir.toml
styrir docs
```
