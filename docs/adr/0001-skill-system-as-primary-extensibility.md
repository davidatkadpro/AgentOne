# Skill system as primary extensibility; Core Tools are architectural-only

A Core Tool is included only if it is load-bearing for the system architecture — skill discovery (`list_skills`, `load_skill`), the provider tier (`consult_expert`), and the memory substrate (`search_history`, `wiki_*`). Everything else — including filesystem, shell, and HTTP — lives in a Skill. Base Profiles supply the conventional defaults so most agents behave normally out of the box, but the default set is opt-out, not baked in. This keeps the always-loaded tool surface small, makes sandboxed agents a profile change rather than a code change, and unifies extensibility under one mechanism (Skills) rather than splitting it across plugins and tools.

## Considered alternatives

- **Maximalist core (~30 tools):** every plausible primitive baked in. Rejected — defeats the "minimal default surface" goal.
- **Practical core (~15 tools, file/shell/http included):** the obvious middle. Rejected because it leaks architecture: `read_file` becomes unconditionally available, the permission model needs a second layer to restrict it, and sandboxing becomes a special case.
- **Single ur-tool (`exec` only):** maximally minimal. Rejected — the model is much better with structured tool calls than constructing correct shell.
