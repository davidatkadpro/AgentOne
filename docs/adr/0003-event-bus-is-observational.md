# Event bus is observational, not control flow

The event bus is a pub/sub layer for observers (UI streaming, logging, indexing, hooks, metrics). The core turn loop is sequential — the Orchestrator calls providers and tools directly, then emits events at lifecycle points. The Orchestrator does not react to events. Events are an output, not an input. This is "event driven" in the lightweight sense most chat-agent systems use the term, not event sourcing or event-driven state machines.

## Considered alternatives

- **Event-sourced state**: the session's truth lives in the event log; domain tables are projections. Rejected — gives time-travel debugging at the cost of significantly more engineering (idempotent projections, replay tooling, careful event versioning) and isn't justified for a single-user agent.
- **Event-driven control flow**: components only know about events; no central orchestrator. Rejected — adds coordination complexity that earns its weight only when there are many independent async actors, which AgentOne does not have.

## Consequences

- Adding observers (a metrics exporter, a remote logger) is a non-breaking change.
- Skills are not event subscribers (would conflate active capability with ambient watching). System-level event handlers go through Hooks instead, configured outside the skill system.
- The event log table is durable for "what happened" events but transient for high-frequency streaming events (e.g. token deltas) — those are reconstructable from the completed turn.
