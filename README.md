# Claude Deck

A desktop-app-style sidebar around the real Claude Code CLI. Each chat is the
unmodified `claude` binary running in an embedded terminal, so slash commands,
pickers, the status line and your settings all behave as they do in a terminal.

- Open: `~/Applications/Claude Deck.app`
- Rebuild after moving this folder or changing `mac/`: `npm run build`
- Changes to `server.mjs` or `public/` apply on the next app launch

Chats and terminals can be dragged from the sidebar into a grid. The layout is
saved in Deck's preferences; terminals themselves end when the app quits.

Cmd+click a path or link in any terminal: folders and files show in Finder (nothing
is launched), web links open in the browser, and `.md` files preview in a pane.

| Part | Job |
| --- | --- |
| `mac/main.swift` | Native window; starts and stops the server |
| `server.mjs` | Indexes `~/.claude/projects`, runs `claude` in pseudo-terminals |
| `public/` | Sidebar and xterm.js terminals |

Deck reads `~/.claude` and Claude Desktop's session metadata but never writes to
them. Renames, hides and preferences live in
`~/Library/Application Support/Claude Deck/`. The local server listens on
127.0.0.1 only and requires a per-launch token.
