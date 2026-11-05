# Draft issue for elidickinson/pi-claude-bridge

> Not posted. Review, then file with:
> `gh issue create --repo elidickinson/pi-claude-bridge --title "<title>" --body-file <this section>`

**Title:** Option to disable Claude Code hooks on the provider path

---

The provider path starts Claude Code with `settingSources: ["user"]`, so every hook in `~/.claude/settings.json` and every enabled plugin's hooks run on each Pi turn. Since the bridge re-invokes Claude Code per turn, `SessionStart` and `UserPromptSubmit` hooks fire on every turn, and their `additionalContext` reaches the model.

With a memory plugin and a few CLI hooks installed, this shows up as:

- the model opening its replies by reacting to hook instructions meant for interactive Claude Code ("The hook asks for a ToolSearch call, but that tool isn't available…");
- hooks writing files into the working repository on every turn;
- memory plugins recording Pi subagent tasks as user prompts.

Measured on 0.10.0, same trivial prompt (`claude-haiku-5-5`, thinking off, two runs each):

| | hooks on | `disableAllHooks: true` |
|---|---|---|
| prompt tokens | 11,837 / 11,904 | 11,103 / 11,103 |
| output tokens | 399 / 301 | 4 / 4 |
| wall time | 14.5 s / 12.2 s | 4.9 s / 5.6 s |

**Proposal:** a provider option, for example `"provider": { "disableHooks": true }` in `claude-bridge.json`, that adds Claude Code's own `disableAllHooks` setting to the provider-path `settings`:

```diff
 			settings: {
 				...claudeCodeSettings(providerSettings),
 				claudeMdExcludes: CLAUDE_MD_EXCLUDES,
 				includeGitInstructions: false,
+				...(providerSettings.disableHooks ? { disableAllHooks: true } : {}),
 			},
```

It keeps `settingSources: ["user"]`, so Bedrock/Vertex `env` and `apiKeyHelper` keep working, and normal Claude Code sessions are unaffected. Opt-in keeps current behavior for anyone relying on hooks inside Pi.

Happy to open a PR if this direction works for you.
