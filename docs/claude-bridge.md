# claude-bridge and Claude Code hooks

`pi-claude-bridge` starts Claude Code with your user settings on every turn, so your Claude Code hooks and plugin hooks run inside Pi turns and inject their output into the model's context. With a memory plugin installed this shows up as replies reacting to hook instructions meant for interactive Claude Code, extra output tokens, and files written into the repository.

- `/brigadev:doctor` detects it.
- `/brigadev:doctor fix-bridge-hooks` asks first, then adds one line (`disableAllHooks: true`) to the installed bridge. Normal Claude Code sessions keep their hooks.
- A bridge update undoes the line: the doctor warns at the next session start; run the fix again.

The upstream request for a provider option is drafted in [upstream/pi-claude-bridge-disable-hooks.md](upstream/pi-claude-bridge-disable-hooks.md) (not posted).
