# Roast Room

Bring a hard business decision and a council of seven AI advisors argues it out, then hands you a scored verdict and a one-click PDF.

Built for [Claude Code](https://claude.com/claude-code). Claude is the **Chair**: it frames your decision, runs three rounds, keeps score, and writes the verdict. The web room is optional and only watches.

```bash
git clone https://github.com/<your-username>/roast-room.git
cd roast-room
```

## Run a roast

1. Start the room: `npm start`, then open http://localhost:4730 and leave it open.
2. Open Claude Code in this folder: `claude`
3. Type `/roast-room` and your decision.

```
/roast-room I run a coaching business at $30k a month with 15 clients at $2,000 each.
Should I raise to $3,500 for everyone, raise for new clients only, or keep $2,000?
```

If you leave something out, the Chair asks before the council starts.

More ways to run it:

- `/roast-room --quick ...` seats four advisors for two rounds. Use it for smaller, reversible calls. It uses far less of your plan.
- `/roast-room --seats allocator,contrarian ...` seats only the advisors you name.
- `/roast-room ask architect ...` gets one answer from one seat.
- `/roast-room --all ...` seats every advisor in `roster.json`.
- `/roast-room board` shows who sits at the table by default and lets you change it.

The room is optional. The council runs the same in Claude Code without it. See [docs/example-verdict.pdf](docs/example-verdict.pdf) for a sample output.

## The council

| Seat | Pillar |
|---|---|
| The Capital Allocator | Money and ruin risk |
| The Offer Architect | Pricing and offer design |
| The Growth Hacker | Distribution and demand |
| The Operator | Execution and capacity |
| The Contrarian | What could be wrong |
| The Customer Advocate | Customers and retention |
| The Long-Game Strategist | Brand and long-term position |

## How it works

- **Each seat scores every option** from 0 to 10, weighted 1 to 5 by how much that seat's pillar matters to your decision.
- **Ruin cap.** If a seat flags a plausible path to losing the business, that option is capped at 4.0 and the verdict says why.
- **Anti-groupthink.** If every seat agrees after round one, the Chair forces a real argument for the runner-up.
- **Confidence** comes from the lead over second place, how much the seats agree, and how solid your numbers were.
- **Honest quotes.** A seat only quotes a real person verbatim when the line is in its brain with a source. `python .claude/skills/roast-room/scripts/check_quotes.py sessions/<session>` checks every quote in a council against the brains.

## Layout

| Path | What |
|---|---|
| `.claude/skills/roast-room/` | The skill: protocol, scoring rules, roster, and the seven brains |
| `.claude/agents/` | The seven seat agents |
| `app/` | The room: a zero-dependency Node server, the web page, and the PDF builder |
| `sessions/` | Saved councils (git-ignored) |
| `docs/` | Example session and PDF |

## Add an advisor

1. Create `.claude/skills/roast-room/brains/<id>/` with `frameworks.md`, `principles.md`, `voice.md` and `quotes.json`.
2. Copy any file in `.claude/agents/` to `<id>.md` and edit it.
3. Add a seat to `.claude/skills/roast-room/roster.json`.

Use them like anyone else: `/roast-room ask <id> ...` or `--seats <id>,...`.

## How the room talks to Claude

The Chair posts JSON events to `POST /api/events` (`start`, `round`, `message`, `scores`, `verdict`). The page listens on `/api/stream` (Server-Sent Events). `GET /report/<session>.pdf` builds the PDF. No dependencies, Node 18+.

```bash
npm test      # scoring, ruin cap, API and PDF smoke test
PORT=5000 npm start
```

## License

MIT
