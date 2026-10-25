# Claude Code Mods

> Part of my [portfolio](https://github.com/Spendry/portfolio).

Mods for [Claude Code](https://claude.com/claude-code) that change what it does and what it shows. Each one is a hooks module: it runs inside Claude Code, hooks prompts, tool calls and turns, and draws a line above the prompt or a pane beside the transcript. The five here are **deviation-kernel**, **cache-meter**, **goal-board**, **file-tree** and **idea-agents**. All five ship with tests that run without a live session.

| Mod | What it does | Costs anything? |
|---|---|---|
| [deviation-kernel](deviation-kernel/) | Keeps the assumptions your project refuses in Claude's system prompt on every request, and catches an edit that brings one back at the step where it lands. | One small Haiku call after each long answer (can be switched off) |
| [cache-meter](cache-meter/) | Shows how long the prompt cache stays warm, what a miss would cost to rewrite, how full the context is, and the session's cost at API rates. | No |
| [goal-board](goal-board/) | Shows each session's goal, task progress and ETA, and `/goals` lists every running session on the machine. | No |
| [file-tree](file-tree/) | Shows the working directory as a file tree in a pane on the right, with folders you open and close and the files Claude just changed marked. | No |
| [idea-agents](idea-agents/) | Gives a project six exploration agents (three that explore ideas, a lazy "trogg" for each) and one `ideas/` folder per run, and tells Claude how to run a round. | Only when you run a round: the agents' own model use (the troggs run on Haiku) |

Install any one of them on its own.

## Set it up with Claude

Paste this into Claude Code, in a terminal session:

````
Set up mods from the GitHub repo Spendry/claude-code-mods for me. Work through these steps and stop where a step says to ask me.

1. Run `claude --version`. The mods need 2.1.287 or later; if it's older, tell me how to update and stop.
2. Show me the table of mods from the repo README (https://github.com/Spendry/claude-code-mods) and ask which ones I want. Don't pick for me.
3. Clone https://github.com/Spendry/claude-code-mods into a temporary folder. For each mod I chose, run `claude plugin validate <that folder>/<mod>`, read its `hooks/register.ts`, and tell me in plain words what it can touch (the `calls:` line lists it). Ask me whether to go ahead.
4. Run `claude plugin marketplace add Spendry/claude-code-mods`, then install each mod I approved with `claude plugin install <mod>@claude-code-mods --scope user`. A note that options are not yet set is expected; the defaults apply until I change them. Delete the temporary clone.
5. Run `claude plugin list` and confirm each one shows as enabled.
6. If I chose deviation-kernel: ask which project it's for, and interview me there for the assumptions that project refuses on purpose. Do not suggest refusals of your own; the point of the kernel is that they come from me. For each one I give you, help me word it, propose tells (words or /regex/ that would show up when it's broken) and an "instead:", then show me the KERNEL.md and write it to the project root only when I say so. Then ask which mode I want (ask, warn or block), explain the difference in one line each, and tell me to type `/kernel mode <mode>` in that project's session to set it.
7. If I chose cache-meter: ask whether I pay API rates or use a subscription, and explain that on a subscription its dollar figures are the API-equivalent, not my bill.
8. Finish with a short list of what I still have to do myself (from the "What only you can do" section of the README).
````

Claude runs the install. It can't decide your project's refusals or see the bands for you; that part stays yours.

## What only you can do

- **Pick the mods.** Each one changes how sessions behave. Read its section below before turning it on.
- **Decide what your project refuses.** deviation-kernel is only as good as its `KERNEL.md`. Claude can help you word a refusal and suggest tells, but which assumptions to refuse is your design decision. Start with two or three. You can add more later with `/kernel add`.
- **Exempt your idea notes.** Notes that weigh a refused assumption have to name it. List their folders under `## Exempt` in `KERNEL.md` (for example `- ideas/**`) so the guard skips them; code everywhere else stays checked.
- **Check the tells after a few days.** A tell that fires on harmless text wastes your attention. A refusal with no tell at all goes unguarded at the edit step. `/kernel log` shows what tripped and what you decided.
- **Look at it in a terminal.** The bands and panes draw in a terminal session and in the Claude desktop app's Code tab. In the VS Code extension's chat panel the hooks still run (the kernel still guards edits) but nothing draws above the prompt, and `/goals` and `/cache` answer in text instead.
- **Keep cache-meter's prices current.** They are typed into `cache-meter/hooks/register.ts` with the date they were checked. A model not in the table is priced at the first row's rates and shown with `≈`.

## Install by hand

At the prompt of a Claude Code terminal session, one line per mod:

```
/plugin install deviation-kernel --marketplace Spendry/claude-code-mods
/plugin install cache-meter --marketplace Spendry/claude-code-mods
/plugin install goal-board --marketplace Spendry/claude-code-mods
/plugin install file-tree --marketplace Spendry/claude-code-mods
/plugin install idea-agents --marketplace Spendry/claude-code-mods
```

Answer `y` to add the marketplace, then pick the user scope so the mod loads in every session. A mod with options shows a screen to set them. `/plugin` lists what's active.

To turn every mod off for one session: `claude --safe-mode`. To update: `claude plugin update <mod>@claude-code-mods`, then `/reload-plugins`.

Built and tested against Claude Code 2.1.296; needs 2.1.287 or later.

---

## deviation-kernel

What it guarantees: the project's refused assumptions are in Claude's system prompt on every request, with nothing to paste and nothing lost to compaction. An edit that brings one back is caught at that step.

The problem it answers: a design that refuses a standard assumption tends to lose that refusal while the ordinary parts get filled in. Claude reaches for the conventional component in each slot, and the conventional component carries the assumption the design rejected.

**Setup.** Put a `KERNEL.md` at the project root (or `.claude/KERNEL.md`). `/kernel init` writes a template; [KERNEL.example.md](KERNEL.example.md) shows a filled-in one. Each refusal is one line:

```
- R1: one global clock paces every stage | tells: global clock, clock tree, /clk_?en/ | instead: each stage hands off by local request/acknowledge
```

In a folder with no kernel, the first prompt you type there asks whether Claude should help you write one: now, after that message, not this session, or never in that folder. Mid-project, Claude reads the project's own record first so its questions point at what you set out to do, then asks you for the refusals (it proposes none of its own) and writes `KERNEL.md` only when you say so. Your home folder is never asked. Turn the offer off with the `offerKernel` option.

**What happens.**

- The kernel goes into the system prompt, along with instructions to check each filler against each refusal and to take the conventional answer wherever the kernel isn't touched.
- When an Edit or Write brings in a tell that wasn't already in the text it replaces, the mod acts by mode:
  - `ask` (default): holds the edit and asks you. Refusing sends Claude the refusal and its `instead:`.
  - `warn`: lets it through and flags it to Claude with your next prompt.
  - `block`: refuses the edit outright.
- After each answer over 300 characters, a Haiku call reads it against the kernel for drift the tells miss, such as a standard component that carries a refused assumption without naming it. Hits show in the band and go to Claude with your next prompt. Press `drop` in the band if a flag is wrong. Turn this off with the `semanticCheck` option if you don't want the extra calls.

**Commands.** `/kernel` opens the kernel and recent trips · `/kernel init` · `/kernel add <text> | tells: a, b | instead: ...` · `/kernel mode ask|warn|block` · `/kernel check` (a full audit of the conversation so far, served mostly from cache) · `/kernel log` · `/kernel reload`.

**Limits.** Tells are matched as whole words or regexes, so a tell also fires on a line that rejects the assumption ("no central scheduler"). The semantic check tells the two apart; the keyword check does not. The kernel file is never edited by Claude unless you ask.

## cache-meter

What it guarantees: you can see how long the cached prefix has left, what a miss would cost to rewrite, context fill and session cost, without asking.

```
cache ▰▰▰▰▱▱▱▱ 2:41 · miss $0.50 · ctx 84k/200k 42% · session $4.10 API
```

- A toast one minute before the cache goes cold while you're idle.
- `/cache` gives the full breakdown, including the hit and miss price of the next request.
- **Cache lifetime.** The `cacheTtl` option defaults to `auto`. It assumes the 5-minute cache until a request reads from cache after more than five idle minutes, which only the 1-hour cache can serve. It then switches to 1h, toasts once, and remembers that for later sessions. The rewrite price changes with it (1.25x input for 5m, 2x for 1h). Set `5m` or `1h` to fix it.
- **Prices** are API list prices in a table at the top of `hooks/register.ts`. On a subscription the dollar figures are what the same work would cost at API rates, not what you're billed.

## goal-board

What it guarantees: each session shows its goal, task progress and ETA, and one command shows every running session on this machine.

- The goal is your first prompt (its first line, shortened) until you set one with `/goal <text>`. `/goal clear` resets it.
- Progress comes from Claude's own task tools (TaskCreate and TaskUpdate, or TodoWrite on older builds).
- ETA = average time per finished task × tasks left. It appears once the first task completes.
- `/goals` opens the board of all sessions: working, idle or done, the current task, and the ETA.
- Sessions share one store on your machine, and each writes only its own record. A session that ends with all its tasks done stays on the board as done. Any other session drops off when it ends. Every record is cleared after 12 hours idle. Nothing leaves your machine.

## file-tree

What it guarantees: you can see the project's files while Claude works on them, and which ones it has changed this session.

```
╭──────────────────────────────────────────╮
│ work     ‹ up  home  refresh  collapse   │
│ ──────────────────────────────────────── │
│ ├─ ▸ notes                               │
│ └─ ▾ relay · here                        │
│    ├─ ▾ src                              │
│    │  ├─ ● main.ts                       │
│    │  └─   util.ts                       │
│    └─   README.md                        │
│                                          │
│ 1 changed · 1 up from relay              │
╰──────────────────────────────────────────╯
```

- The pane opens beside the transcript when the session starts, in the fullscreen layout on a terminal 144 columns or wider. Below that, or on the main screen, `/files` opens it (above the prompt on the main screen). `/files` again closes it.
- Click a folder, or Tab to it and press Enter, to open or close it. With the pane focused, `r` refreshes and `c` collapses every folder.
- `‹ up` (or `u`) moves the tree's root up one folder per press, like `cd ..`, until it reaches the drive or filesystem root. The working folder stays open under its parent and is marked `· here`. `home` (or `h`) puts the root back on the working folder. Only the view moves; Claude's working directory stays where it was.
- It's kept dark so it stays behind the conversation: a muted orange rounded border on a darker background, every name dimmed, and only changed files in (dim) green.
- **Options.** `background` is the hex color painted behind the tree; the default `#0f0f0f` is half of Windows Terminal's Dark+ background. Set it to half of your own terminal's background, or leave it empty to keep the terminal's. `coverFrame` (on by default) draws the orange border over Claude Code's own square pane frame, so the side facing the conversation is orange; Claude Code still shows its thin grey line along the top. Turn it off to draw the border just inside the frame instead.
- Long names and paths are cut to fit the pane with `…`: a file or folder name keeps its start, the path in the footer keeps its end.
- A file Claude wrote or edited this session shows a green `●`. A folder holding one has its name in green, so a change inside a closed folder still shows.
- The tree refreshes after every Write, Edit, NotebookEdit, Bash or PowerShell call. A change made outside Claude shows on the next refresh.
- **The duel.** At the bottom of the pane, above the footer, two small stick figures fence while Claude is working and meditate while it waits. The animation is a set of short clips (approach, lunge, exchange, feint, a win for either side; breathing and an aura while seated; disengage, bow and kneel, and rise between the two). Each clip ends on the resting frame of its stance, so the next one, picked at random from those that start there, joins on without a jump. It repaints only its own cells four times a second and hides when the pane is too narrow. Turn it off with the `duel` option.
- `.git`, `node_modules`, `__pycache__`, `.venv`, `venv` and `.next` are left out. A tree is cut at 1,500 rows; close a folder to see the rest.

## idea-agents

What it guarantees: a project can get a second set of eyes on a stuck problem, from agents that propose and size ideas but never touch its code, with every run kept in its own folder you can read later.

- **The six.** `premise-breaker` lists the assumptions under a problem and flips each one. `field-crosser` brings mechanisms from other fields, at least half outside computing. `idea-sizer` checks the ideas against numbers the project already measured and gives each a kill test. Each has a lazy helper on Haiku, a "trogg": **Skip** asks "why do it at all?", **Borrow** "what already does this?", **Poke** "what's the dumbest quick try?". The upper agents read their trogg's note and say in one line what they took.
- **The offer.** On your first typed prompt in a project without them, it asks once whether to install them into `.claude/agents/`. It never overwrites an agent the project already has. Then it asks whether Claude should tailor them to the project (its building blocks, gates, results files); Claude shows each change and writes it only when you say so. Home folders and folders you said never for are skipped.
- **One folder per run.** `/ideas new <topic>` makes `ideas/<date>-<nn>-<topic>/` with a run card (`README.md`: question, read order, outcome, decisions) and `0-data.md` to fill. The agents write `1-premises.md`, `2-fields.md`, `3-sizing.md` and their lazy notes next to it; the main session writes `4-result.md`.
- **The guide.** Where the agents are installed, Claude carries a short guide for running a round: who runs when, that the main session runs the troggs (subagents can't start subagents), that a gate's bar never moves, and that held-out data is scored once.
- `/ideas` shows what's installed and the latest run. `/ideas install` adds missing agents. `/ideas tailor` starts the tailoring.
- New agent files load as agent types at the next session start. Until then Claude runs them through the general-purpose agent.

---

## Working on the mods

Each mod is a folder with `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.ts` (or `.tsx` for a mod that draws a pane) and `tests/`. The marketplace file at `.claude-plugin/marketplace.json` lists them.

- `claude plugin validate <mod folder>` reports what the mod hooks and calls, and anything the engine would refuse.
- `claude plugin test <mod folder>` runs its tests without a session.
- To work on a clone, add the clone as a marketplace (`claude plugin marketplace add <path to clone>`) and install from it. A folder marketplace is read from the folder itself, so after an edit `/reload-plugins` picks up the change with no reinstall.

A new mod is a new folder plus one entry in `marketplace.json`.

## License

MIT. See [LICENSE](LICENSE).
