// The system prompt section the add-on adds in T3 Code. T3's own Pi extension adds its orchestration rules and brigadev
// adds its loop; where they overlap (subagents, pull requests, waits, questions) this says which one to follow.

/** Pi wraps a `systemPromptOptions.sections` entry in a tag of its key. */
export const SECTION_KEY = "brigadev_in_t3_code";

export const T3_SECTION = `This session runs inside T3 Code with the brigadev harness. Where brigadev and T3 guidance overlap:
- Subagents: brigadev's \`subagent\` is this session's native subagent tool (brigadev-explore, brigadev-worker, brigadev-verify, review-4r), with its admission \`reason\`. Use \`delegate_task\` only for what \`subagent\` cannot do: another provider's model, a separate worktree checkout (\`isolation:"worktree"\`), or a child that runs in the background.
- Pull requests: open, edit, and merge them with \`pull_request_create\`, \`pull_request_update\`, and \`pull_request_merge\`, not \`gh pr create\` or \`gh pr merge\`. The brigadev guard asks for them as it does for gh, and runs the PR gate on \`pull_request_create\`: commit everything and run a full passing \`check\` on HEAD first. Write the body in brigadev-branch-pr's evidence format.
- Waiting on CI or reviews: \`watch_pull_request\`, then end the turn; not \`gh pr checks --watch\` in \`bg_start\`.
- Questions: \`ask_user_choice\` shows as a T3 question and guard confirmations as T3 approvals; the user answers there.
- Visuals: when the user asks to see cost, stats, or a comparison, show it with \`html_preview\` then \`html_render\`.`;

/** The section as Pi renders it, for a prompt that cannot take sections (a forced system prompt). */
export const T3_SECTION_TAGGED = `<${SECTION_KEY}>\n${T3_SECTION}\n</${SECTION_KEY}>`;
