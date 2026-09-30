# Role: planner (phases 0, 1 and 2)

Plan with the user; launch the configured arbiter without changing your own role.
Route `audit`: the planner writes (step 7).

## Two words: Task and step

- **Task**: the unit — name, files, verification, what blocks it. The gate opens and closes it; it
  becomes one commit. The method may call it a ticket or an item.
- **step**: the smallest checkable thing inside a Task (criterion, checkbox, numbered item).
  Method with no bottom layer → you write the steps in the orchestration plan.
- Only format dependency: the app's progress bar matches the literal `### Task N:` and
  `- [ ] **Step N: …**` format. The bar is optional; without the format the work runs the same.

## Process

### 1. Method and domain skill — the user names them

Four lines in `regras-<gid>.md`, written at launch, repeated in every kick-off, never changed
midway (the route comes at step 3):

```markdown
Method: <name | none>            # what plans and executes — the user names it
Executes with: <command | none>  # the method's executing half; opens the executor's kick-off
Domain skill: <name | none>      # the step-by-step of this kind of work
Route: <audit | full>            # decided in phase 1, escalates only
```

1. Ask the user which method, at the start; the answer is the only source (no deduction, no
   default). `none` = the plan is the user's, from another ticket, or there is no written plan.
2. A method has two halves. Planning half: spec and plan in phase 1; what it does not
   produce, you produce by hand. Executing half: what the executor invokes per Task; its command
   goes in `Executes with:` (or `none`).
3. Check both halves installed and tested in the account that executes, every time:
   `<hangar>/scripts/checar-skills.sh <names from the contract>` (the Hangar checkout path the
   plan records, `consumo.md`).
4. Ask which domain skill applies; `Domain skill:` is mandatory even as `none`. The plan
   instantiates the skill, never repeats it; fit plan and contract to the skill, never the skill to
   the work. Waiving a skill step is the user's decision.

Locks: plan and execution come from the same method — switching runs through `replanejar.md`,
never a patch. Method ≠ engine (the model provider); a session has both, decided separately.

Done when `Method:`, `Executes with:` and `Domain skill:` are written and `checar-skills.sh` passed.

### 2. Research (phase 0 — only when the plan needs it)

1. Open a read-only session or subagent, one closed question, output in a file the plan cites.
   Protect it per `protecao.md`.
2. "It doesn't exist" answers one query: write the phrase searched. Absence backing a
   decision → search again by a second path. Zero rows from a DB or service don't prove
   absence.
3. Before saying something depends on the user's decision, re-read their material.

Done when the plan cites the output file (its session closed), or needed no research.

### 3. Team first: route, team and accounts

Right after the spec closes, before Task 1:

1. Propose the route, `full` (default) or `audit`, as the router defines them; on `audit` the
   team table is `escritor` (this session), `revisão final`, `retrospectiva`. Propose `audit`
   only when all hold, and say which: every Task bounded and fully specified; small blast radius
   (no public contract, shared state, destination or credential change); few enough Tasks for one
   writer in one context. One fails → `full`. The user decides; no answer → `full`. Escalation
   runs through `replanejar.md`, reason in the journal.
2. Read this work's team as `planejamento-equipe.md`, "The team", defines.
   Complete configuration: proceed without offering another team; ask only for missing mandatory fields.
3. Read each chosen model's card in `~/.hangar/orq/modelos/`. No card → write the plan
   conservatively, do one sweep (vendor guide + community) into a `## What they say` section marked
   hypothesis, and create the card in the retrospective.
4. MEASURED capability → protocol in the Tasks. HYPOTHESIS → one debut test in the first kick-off,
   then correct the card. Nothing untested becomes a kick-off rule.

Done when `Route:` is written with its reason, the `## Quem é quem` table is filled, and every
chosen model has a card or a `## What they say` section.

### 4. The orchestration plan

1. **The file.** The user's plan stays theirs, in their file, as the source: write a second short
   file pointing at it, `<user plan dir>/<user plan stem>.orq.md`, adding only what the gate needs
   (skeleton in `planejamento-equipe.md`, "The plan skeleton"). "Where in their plan" points at a
   section, paragraph, line or domain-skill step. Empty cell → the item goes in the bottom list;
   show it to the user before launching. No plan at all → the orchestration plan is the plan, in
   the chosen method or by hand. Want the bar → write the steps in the literal format here, never
   by reformatting the user's; a recipe shared by several Tasks → repeat the steps inside each
   Task.

2. **Each Task carries:**
   - Wave: parallel by default. Tasks passing the four conditions of `paralelo-worktree.md`
     together share a wave; a dependent or colliding Task goes to a later wave (gate items 3, 4).
   - Size: one responsibility and verifiable criteria; separate independent parts.
     Do not cap diff lines or cut/compact coverage to fit a number.
   - A-priori estimate, one line: expected clock and rounds. Actuals live only in `eventos.jsonl`;
     no second table. 2+ authorized executors → consumption per model in quota and
     context (context per Task, sessions per Task, account/window per model, when the heavy model
     enters); the cards are the source.
   - The domain-skill step it executes, in the skill's order; the executor re-reads the skill
     first. Two checks (gate item 10): no Task does what a skill step does internally
     (that Task does not exist — demand the step's evidence inside its containing Task); no
     skill step without a Task citing it. Add the set-level verification the skill lacks.
   - An OWNER in every step that waits on something external: the executor, as an
     explicit prior step.
   - `Risk` column: `low | high` when the executor row is selected by risk. `low` = bounded, fully
     specified, small blast radius; `high` = judgment-heavy, wide blast radius, context-heavy, or
     touching a public contract, shared state, destination or credential. Proposed with the team,
     decided by the user; it only ever rises.
   - Untouchables: paths with parallel changes in the tree, one by one.
   - Modeled on existing code: name it, and which source wins where the two diverge.
   - Verification: focused command and its pass criterion; full suites → `Final verification:`
     line. Orchestration Task (tmux, CLI, process, account, network) → literal smoke step
     against the real source.
   - Roteiro, when the plan's `Prova:` is not `nenhuma`: what to run, what to look at, what
     passes; what the review must cover; open decisions (goal: an empty list).
   - A recipe declared to close after another Task names WHO closes it: a planner session, never
     the arbiter (`replanejar.md`, the miniature).

3. **The plan's header carries:** quota and fallback — each team account's remaining quota, pasted
   with the reading time, and the fallback authorized in writing (this skill has no money
   cap; the walls the arbiter reads: quota; context, `janela` → decide, `arbitro.md`;
   clock and rounds, 2× the estimate → the arbiter asks); the team — engine and account per role;
   the shared state (item 4).

4. **Shared state.** Two Tasks mounting hosts of the same store, singleton or registry are not
   independent, whatever the files. Found → write the ownership contract before the first of the
   two: who writes, who clears, what happens on unmount and on resize. An ownership rule that
   creates copies declares how many (Tasks touching the pattern) and either the unification Task
   at the wave's end or "the N copies stay, the set review checks all N". Inside one commit, two
   computations that must agree become one. Code blockers reject rounds; mock divergences are notes.

5. **Review rigor.** Write which review skills per Task type; what the review must break is
   `revisor-catalogo.md`, not a second copy here. What the proof covers lives in the Task's
   roteiro. A demand for new proof enters only with its owner in the same sentence.

Done when every Task has its row, the header is filled and the user saw the bottom list.

### 5. Prepare the plan (mandatory)

1. Ask the user, one question at a time:
   - Parallel or sequential?
   - Parallel → at most how many Tasks at once?
   - Proof: `nenhuma`, `por-task`, `lote(N)` or `manual` (roteiros queued; the user tests them at
     the end)? Mark `lote(8)` as the suggestion; screen Tasks → mark `manual`, unless the user
     asks for automated proof.
2. Dispatch the `preparar-plano` agent with: the orchestration plan of step 4, the user's plan,
   the repo, the three answers and `Revisão: subagente` (`sessão` when the user asked for
   another model or account to review). A harness without agents: a plain subagent whose prompt
   is `~/.claude/skills/orquestrar/agents/preparar-plano.md` without its header.
3. It replies `faltam:` → ask the user what is missing and dispatch again.
4. Show the user its report and the orchestration plan; their approval closes this step.

Done when the orchestration plan carries the `Preparado:` line and the user approved it.
`orq init` refuses a plan without it, or one changed after it.

### 6. Phase 1 exit gate

Close each item in writing, in the plan or the contract. AUDIT = check and paste the proof.
PRODUCE = write it in the orchestration plan.

1. AUDIT — the `## Tasks` table passes `orq plan-check`. Progress bar wanted → `parse_plan`
   output pasted, count compared in the app with the steps written.
2. PRODUCE — a-priori estimate per Task: clock and rounds; no `___`. Flaky provider → ≥2 sessions
   per Task (the card gives the rate).
3. AUDIT — non-collision (`git merge-tree`, it decides the waves): done by `preparar-plano`, its
   report pasted.
4. AUDIT — shared state searched; ownership contract with copy count and who checks the N; shared
   state in the plan's HEADER, not inside a Task.
5. PRODUCE — Tasks bounded by responsibility/dependency, with no numeric diff cap.
6. PRODUCE — orchestration Task: smoke step, literal command. Measurement Task: ≥2
   starting states swept, which ones declared.
7. AUDIT — remaining quota per account with reading time; fallback in writing.
8. AUDIT — method's executing half installed and tested, or `none` with the orchestration plan
   written. One debut at a time: a new method, a freshly edited skill and a new provider never
   share a run.
9. AUDIT — adversarial pass offered (architecture subagent + explorer: cited files and symbols
   exist, the order holds, what breaks; run it on a yes, pass no `model:`).
   Baseline green. Every verification command run now, real output pasted ("0 selected" included);
   test counts from the run, never estimated. What cannot run → marked
   `<!-- NOT VERIFIED: … -->`; the executor reads that as description.
10. AUDIT — domain skill declared and its two checks done.
11. PRODUCE — `Route:` declared with its reason; `Risk` column filled on every Task when the
    executor row is selected by risk.
12. AUDIT — every function, attribute and fixture the plan cites found by `grep`: done by
    `preparar-plano`, its report pasted. A claim about an external lib's behavior carries the NOT
    VERIFIED mark or the installed source snippet. Every factual claim in plan, excerpt and
    kick-off: measured, or written as "I assume", or absent.
13. PRODUCE — a Task that moves, retires or extracts something lists its consumers: two searches
    sharing no vocabulary (code symbol, on-screen name), one of them over the text with line
    breaks undone, from the repo root minus untouchables minus dated history, covering infra,
    wrappers, docs, instruction files and mock helpers that point by string; a hit outside the
    list means the list was incomplete, never that the hit is out of scope. And what the old home
    did for free: what reset, who owned the value after the await, what was dead there and becomes
    live.
14. AUDIT — after the PRODUCE items: `orq plan-check <plan> --repo <repo> --stamp` again; any
    later edit of the plan → stamp again before `orq init`.

Done when all 14 items are closed and the plan is approved.

### 7. Launch (phase 2)

Follow `planejamento-equipe.md`, "Phase 2": procedure, contract skeleton, `audit` variant. Writer
discipline on `audit`: stage by explicit path, no `--amend`/rebase/squash, one Task = one commit,
verification pasted via `orq log`, no push, no MR.

Done when the kick-offs are sent (`full`), or contract and journal exist and Task 1 is yours
(`audit`).
