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

## The board

**Seven original advisors** (default board): Capital Allocator, Offer Architect, Growth Hacker, Operator, Contrarian, Customer Advocate, Long-Game Strategist.

**Seven specialist departments**: Financial, Legal and Compliance, International Trade, Market Intelligence, Technology and Innovation, Risk Management, Negotiation and Procurement.

**Two independent agents**: the **Research Agent** (investigates before the debate and returns a cited, dated brief that separates verified facts, estimates, assumptions and unavailable information) and the **Devil's Advocate** (issues a formal objection that can stop an unconditional Proceed).

**Modes** (`--mode`): `startup`, `investment`, `acquisition`, `expansion`, `supplier`, `rescue`, `strategic`. Each seats the right people and sets criterion weights (`.claude/skills/roast-room/modes.json`).

## How a session works

1. **Frame** the decision. The Chair never invents numbers.
2. **Research brief** by the Research Agent, before anyone argues.
3. **Financial model**: deterministic, three scenarios (optimistic, expected, pessimistic): gross revenue, COGS, gross, operating and net profit, margins, break-even, ROI, payback, peak funding need. No AI involved in the arithmetic.
4. **Debate** in rounds. Seats may revise their view when new evidence appears.
5. **Devil's Advocate** formal objection (blocking, major, minor).
6. **Verdict** computed by the server from transparent weighted criteria (financial, market, operational, risk, strategic, legal), with weights in `criteria.json` that you can change. Result: **Proceed / Proceed Conditionally / Postpone / Reject**, with the per-criterion scores, caps applied, conditions before implementation, and a step-by-step reasoning trail.
7. **What-if**: change an input ("sales 40% lower"), the model and verdict are recomputed and compared.

Caps only make a verdict more cautious: a ruin flag caps at Postpone; a blocking objection, a capital shortfall or under-50% criteria coverage cap at Proceed Conditionally; a financial model that never pays back caps the financial score at 4.

Confidence is **subjective board confidence** (evidence quality, agreement, coverage). It is not a calibrated probability.

See [docs/example-verdict.pdf](docs/example-verdict.pdf) (an illustrative session; the research section deliberately claims nothing because no live research was run).

## Status

| Area | Status |
|---|---|
| Financial engine, three scenarios, what-if, compare (`app/finance.js`) | **Implemented and tested** (hand-checked numbers) |
| Weighted verdict, caps, conditions, reasoning trail (`app/verdict.js`) | **Implemented and tested** |
| Devil's Advocate formal objection | **Implemented** (agent + verdict logic tested; the agent's quality is untested against live runs) |
| Research Agent | **Implemented as an agent definition**; needs a real Claude Code run with web search to evaluate. Not yet tested live |
| Specialist departments and modes | **Implemented** as agents, roster and mode weights; not yet exercised in a live multi-agent run |
| Live room UI (research, finance, objection, verdict, what-if panels) | **Implemented**; render logic verified against real data, visual layout not checked in a browser |
| PDF report: summary, proposal, research, financials, criteria, reasoning, objection, conditions, what-if, advisors, transcript, sources | **Implemented and tested** |
| 30/60/90-day execution plan with progress tracking | Planned, not implemented |
| Business profiles, founder memory, decision history, forecast-vs-actual tracking | Planned, not implemented |
| Authentication, multi-user isolation, audit logs, rate limiting | Planned, not implemented (this is a local tool today) |
| Multi-provider model adapters, token and cost tracking | Not applicable today: Claude Code runs the agents. Planned only if it becomes a hosted service |
| Subscriptions, billing, teams, enterprise controls | Planned, not implemented |

## Financial model limits

No working-capital or inventory-timing model (early cash need for product businesses is understated), tax on positive months only with no loss carry-forward, constant monthly growth, and no seasonality. The model lists these in every result. The optimistic and pessimistic multipliers are default stress assumptions in `app/finance.js`, not research findings.

## Layout

| Path | What |
|---|---|
| `.claude/skills/roast-room/` | The skill: protocol, `roster.json`, `criteria.json`, `modes.json`, brains |
| `.claude/agents/` | Advisors, departments, Devil's Advocate, Research Agent |
| `app/` | Zero-dependency Node server, finance engine, verdict engine, web room, PDF builder, tests |
| `sessions/` | Saved councils (git-ignored) |
| `docs/` | Example session and PDF |

## Add an advisor

1. Create `.claude/skills/roast-room/brains/<id>/` with `frameworks.md`, `principles.md`, `voice.md` and `quotes.json`.
2. Copy any file in `.claude/agents/` to `<id>.md` and edit it.
3. Add a seat to `roster.json` with the `criteria` it scores.

Use them like anyone else: `/roast-room ask <id> ...` or `--seats <id>,...`.

## How the room talks to Claude

The Chair posts JSON events to `POST /api/events` (`start`, `round`, `message`, `research`, `objection`, `scores`). Engines: `POST /api/sessions/<id>/finance`, `/whatif`, `/finalize`, and stateless `POST /api/finance/simulate|whatif|compare`. The page listens on `/api/stream` (Server-Sent Events). `GET /report/<session>.pdf` builds the PDF. No dependencies, Node 18+.

```bash
npm test      # 22 tests: scoring, finance (hand-checked), verdict, API, PDF, security basics
PORT=5000 npm start
```

## License

MIT
