---
name: shell
description: Run a shell command with a timeout. Output is captured; the working directory is the project root. Use for everything that needs a system invocation — git, ripgrep, scripts, build tools.
tools:
  - id: shell_exec
    handler: ./tools/shell-exec.ts
    description: Execute a shell command. Returns stdout, stderr, exit code, duration. Times out after the configured limit.
---

# Shell

Run arbitrary commands in the project working directory. Output is captured
and returned as text.

## Guidelines

- Prefer read-only commands when you can; destructive commands should be
  explicit and explained.
- Always supply a `timeout_ms` if the command might run more than 10 seconds.
- The working directory is the AgentOne project root unless `cwd` is given.
- Use environment variables sparingly; the inherited environment is the
  shell's, which may include secrets.
