# Ideas

Where the exploration agents write. Nothing here is built or decided. **One folder per run.**

## Runs
| Run | Question | Outcome |
|---|---|---|

## Inside a run folder
`README.md` (the run card: question, read order, outcome, decisions), then the files in the order they were written:

| File | Agent |
|---|---|
| `0-data.md` | main session: the numbers and rules the agents start from |
| `1-premises.md`, `1-premises-lazy-skip.md` | premise-breaker, then trogg-skip |
| `2-fields.md`, `2-fields-lazy-borrow.md` | field-crosser, then trogg-borrow |
| `3-sizing.md`, `3-sizing-lazy-poke.md` | idea-sizer, then trogg-poke |
| `4-result.md` | main session: what the tests showed |

## One round
1. `/ideas new <topic>` makes `ideas/<date>-<nn>-<topic>/` with a run card and a `0-data.md` to fill.
2. premise-breaker and field-crosser, then each one's trogg, then both revise.
3. idea-sizer on both, then trogg-poke.
4. Run the kill tests the person picks, write `4-result.md`, finish the run card.

An idea becomes work only when the person picks it.
