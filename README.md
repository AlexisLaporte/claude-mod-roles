# claude-mod-roles

A [Claude Code](https://claude.com/claude-code) mod that gives each long-lived session a **role card**: a short Markdown file that tells the session who it is, what it owns, what it leaves to other sessions, and what needs your explicit go.

Useful when you run many named sessions side by side (a "cto", a "backend", an "ops"…) and want each to keep its role across resumes, compactions and restarts.

## What it does

- `/role` opens a picker with the roles of the project: type to filter, Enter to take one, Esc to close.
- `/role <name>` gives the session that role (and renames the session to it). `/role b…` autocompletes role names, spaces included.
- A name with no card offers to **write the card with the session**, from the folder's `_MODELE.md` template; once the file exists, the session takes the role.
- The card is sent to the model as an instruction file, like a `CLAUDE.md`: present at start, on `--resume`, after `/compact`.
- **Live**: edit the card on disk and the new version reaches the session within 5 seconds, at its next turn, without a restart.
- The role is **bound to the session id**, not to its name: `/rename` does not change it; a fork inherits its parent's role.
- A warning when two live sessions hold the same role.
- The status line shows `rôle : <name>`; a session with no role gets a reminder above the prompt. Outside a project with roles, the mod stays silent.

The interface text is in French.

## Where role cards live

`.claude/roles/<role>.md`, looked up from the session's directory upwards (the nearest folder wins), like `CLAUDE.md`. Commit it with your repository to share roles with your team, or keep it local. Files starting with `_` (such as the `_MODELE.md` template) are not roles. See [`examples/.claude/roles/`](examples/.claude/roles/).

State (which session holds which role) is kept in `~/.local/state/fiche-role/`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install roles --marketplace AlexisLaporte/claude-mod-roles
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install roles --marketplace AlexisLaporte/claude-mod-roles
```

To run it from a clone instead: `claude --plugin-dir /path/to/claude-mod-roles`, or set `CLAUDE_CODE_PLUGIN_DIRS` to that path.

Requires a Claude Code version with mods (hooks modules), 2.1.299 or later. Linux is the tested platform.

## Limits

- A one-shot `claude -p "/role x"` exits before the session is renamed; the role itself is bound.
- An edited card is sent again as a new instruction block: the previous version stays in the conversation history until the next compaction, the latest one prevails.
- A session can still edit its own card like any file.

## License

MIT
