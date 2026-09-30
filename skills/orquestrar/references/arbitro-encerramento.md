# Arbiter — the end of the work

Read when the code Tasks are done (step 6 of `arbitro.md`), and when you step down. The two
closing items are written at launch (`arbitro.md`, step 1) and executed here.

`orq` below = `~/.claude/skills/orquestrar/scripts/orq.py --dir <durable dir>`.

## Closing items — written at launch, before the first session

Write them to `<durable dir>/fechamento.md`; one `orq log` line points at it.

```markdown
## Closing — own items, written at LAUNCH

- [ ] **Branch review** — trigger: every code Task approved. Fresh session, `<base>..tip`.
      Kick-off adds `Executor for findings: <session | none yet — ask the arbiter for one>`.
- [ ] **Retrospective (phase 5)** — trigger: the branch is in the user's hands and nothing in
      flight. Fresh session, `retrospectiva.md`. Product: a proposed patch for the skill, at
      `~/.hangar/orq/<date>-<gid>.md`. Kick-off carries: `Durable dir: <path>` ·
      `Branch range: <base>..<tip>` · `Skill repo: <path> (commit before the work: <hash>)` ·
      `Cards: ~/.hangar/orq/modelos/`. Before the request, generate `medicao/relatorio.json`
      per `consumo.md` and include its path, with the sources/periods left unmeasured; do it
      before moving the transcripts.
```

- Both roles have a row in `## Quem é quem` since launch (account, model, effort). Missing row → stop and ask, like any off-plan Task.
- The retrospective's trigger is never conditional on things having gone badly.
- Phase 5 launched after the first approval, with findings still becoming Tasks → append the addendum to `<durable dir>/fechamento.md` at that same moment:

```markdown
- [ ] **Retrospective addendum** — trigger: nothing in flight. Scope: the Tasks that entered
      after `<hash of the 1st approval>`. Fresh session, numbering continuing from the last P.
```

## The user's roteiro (`Prova: manual`)

Every code Task approved, before the branch review: `orq batch take`; write
`<durable dir>/roteiro-manual.md`, one section per Task it printed, in that order, each with that
Task's roteiro whole and the commit it proves; send the user the path and test it with them.
A failure becomes a Task through the gate (`arbitro.md`, steps 2–5).

Done when the user has the path.

## The last proof batch (`Prova: lote(N)`)

Every code Task approved, before the branch review: `orq batch take`; a batch printed → run it
through `prova-lote.md`. Done when every batch taken has its `pareceres/lote-<n>.md` and its fix
Task, if any, is approved.

## Phase 4 — the branch review

1. Trigger: every code Task approved. Never "after Task N". A manual Task (asset upload, domain, third-party account) is not a code Task.
2. Open a fresh session (recipe in `arbitro-lancamento.md`) that took part in nothing; never a subagent of yours (a per-Task reviewer may be a fresh subagent; this one may not).
3. Keep the execution watchdog running with `-e` until cleanup of completed sessions finishes.
   Final review outside `orq ball`: monitor it in standalone mode from `arbitro-vigia.md`,
   with another unit name and `vigia.sh <branch-review session> <arbiter> -m 5 -d
   <durable dir>/registro.md`; wait for ARMED. Stop only this monitor when the phase finishes.
   Do not disarm execution cleanup at a phase transition.
4. Kick-off: the page pointer, `Role: branch review`, the range `<base>..<tip>`, the parallel paths to ignore, what is out of scope; which commits in the range the pipeline produced and which are foreign, and whether the foreign ones are reviewed or declared out of scope. A foreign commit that is the base of a Task gets a directed question.
5. With the review open the tree freezes (per-Task rounds too; a docs-only commit earns a DEVOLVIDO). Must touch: announce first, with what; commit, never disk-only; send the new hash and what changed file by file; say what did not change, with the proof command `git diff --stat <hash-under-review> <new-hash> -- <code-dirs>` (empty = their work stands). "The file changed between two reads" → own it, give the new hash, freeze.
6. Findings return to the normal cycle (`arbitro.md`, steps 2–5). A rejecting final review needs a live executor: open one — the code is theirs, never yours, not even for one line. Record the author of each round's code in the contract, not only the hash (`eventos.jsonl` keeps it in the `veredito`'s `sessao` field). The user asked you for code directly → the request ends, you return to the gate.
7. Two final reviews in parallel: hold findings that overlap until both deliver, and tell each you are holding.
8. Closing sentence to the user carries, beyond "approved": which commits in the range came from outside the pipeline; by which step (deploy, publish, install) the approved code reaches where they will use it. Push and MR are the user's.

After the final verdict, explicitly close the final-review session by the name actually
opened, checking that no work/subagent is in flight. The watchdog closes Task pairs:
check `orq done` and the live session list. An absent candidate is closed; one still present
is not closed. Respect group/identity protection and record closing failures.

Done when the branch review approved, the closing sentence is sent, and its session is closed;
remaining cleanup stays active until closure.

## The branch reopened after approval

- Two or more post-approval commits touching the same space → set review of the delta: fresh session, scope = the delta only, same format as the final review.
- A review finding enters as a Task through the gate. A new user request is new work: state the price before accepting — "It goes in, and the cost is one more set review before the push — or it waits until after the push, on its own branch." They choose; the push is theirs. The price is the set review, not the waiting time.

## Retrospective (phase 5)

Fire the closing item on its trigger: the branch in the user's hands, nothing in flight. Open the fresh session by the recipe in `arbitro-lancamento.md`, on the `retrospectiva` row; the kick-off carries the lines the closing item lists. Standalone monitor: "Phase 4", step 3, with the retrospective instead of final review; stop
only this monitor on completion. The execution watchdog remains responsible for cleanup.

Explicitly close the completed retrospective session by its opened name, with no work
in flight. Record `orq event execucao_fim --resultado <result>` and check `orq done` and the
live session list; keep the watchdog until eligible candidates are closed. Do not close the
current arbiter, an open Task's session or someone moved to another group/identity. Record
and report unresolved impediments; do not declare all closed or silently disarm.

Done when the patch exists at `~/.hangar/orq/<date>-<gid>.md`, execucao_fim is logged,
cleanup is confirmed, the monitors are disarmed and the retrospective is closed.

## Arbiter succession

When you leave: your context past your row's `janela` (default 50%) and your decision by cost says swap (`arbitro-vigia.md`, "Rotation"). A changed `árbitro` row applies to your successor, whenever the succession happens for another reason.

1. Finish the task at hand: the open gate closes or rejects; every background subagent of yours has returned. Dispatch no new Task.
2. `<durable dir>/passagem.md`, headed `# Handover to the next arbiter (<output of date -Iseconds>)`: the line `my running subagents: none`; current Task and gate state; live sessions per role (name, account, model, effort, measured ctx) and which are retired; HEAD and `git status`; what is on disk uncommitted; pending items and what remains of the plan; the user's decisions not yet rules, one by one, dated; traps paid; absolute paths of plan, `regras-<gid>.md`, `licoes.md`, `eventos.jsonl`, durable dir; the last line written to `eventos.jsonl`; the closing items with who carries each. No line cap, no context copy: what the successor cannot discover from the files pointed at.
3. Open the successor by the usual recipe on the `árbitro` row as it stands. Right after `--new`, before its kick-off: `orq event sessao_trocada --de <you> --para <successor> --motivo <reason>`; from then on `orq` and the watchdog route to the successor by themselves, and the successor leaves the watchdog untouched. Kick-off: invoke the `orquestrar` skill with the arbiter role; the `<durable dir>/passagem.md` path, the rules, the plan; "take over: you are the arbiter from now on; once you confirm, close me: `hangar-send --close <your name>`".
4. Change the `árbitro` row's session name to the new name.
5. `orq log` ("left at <ctx>, successor `<name>` took over"); stop sending work. You never close yourself: the successor does.

Done when the successor confirmed the takeover and the `árbitro` row names them; the successor then closes your session.

Locks for every baton pass, any role:

- Who leaves marks the origin of every decision written: `user, <date>` · `my decision, <date>` · `proposed, no answer`.
- Who arrives acts on nothing marked proposed or without origin; confirms with the user, not with the session that left.
- The handover points at the closing items and at files; it restates nothing and never says "read the previous transcript".
- Who leaves launches no subagent after deciding to leave and hands over only once each one it launched has returned.
- Who arrives closes the session that left only when its handover reads `my running subagents: none`; otherwise it asks that session to wait them out first.

### Succession without a handover

The previous arbiter is gone and `<durable dir>/passagem.md` does not exist; you are the successor:

1. Rebuild the handover from the files: the last lines of `eventos.jsonl` and of the journal, the sessions file, and `git status` of the main line and of every open Task's worktree. Write it to `<durable dir>/passagem.md` with the fields of step 2 above. Done when every open Task has its gate state, live sessions and uncommitted work named.
2. `orq event sessao_trocada --de <previous> --para <you> --motivo <reason>`, then re-arm the watchdog over yourself. Done when its armed alarm reaches you.
3. Replace every executor or reviewer of an open Task that is gone by `arbitro-vigia.md`, "A vanished session", naming the staged or frozen work in the replacement kick-off. Done when each open Task has a live pair and both recorded their wake-up.
