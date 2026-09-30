# Write protection for research, review and verification sessions

Read when planning or opening a research, review, final-review or verification session.

## Opening and proof

Add `--read-only` to the opening command the contract defines, plus the authorized account or
engine flags:

```bash
hangar-send --new <name> <repo> --provider <provider> --model <model> --effort <effort> --read-only
```

- The flag protects the repository of the `cwd`, including a subfolder or worktree; keep
  reports outside that tree.
- The opening fails when the machine cannot protect: do not retry without the flag. At
  planning, resolve missing support before releasing the review. A native restriction of
  another harness replaces this one only with the same write proof.
- After updating Hangar, restart the backend before using the flag (an older backend refuses
  the field with HTTP 422).
- Before reading the diff or running the script, check the pane's real command and prove it
  inside the session: opening an existing code file for writing must be refused; a temporary
  file in the artifacts folder must accept writes:

  ```python
  import errno, os, tempfile
  try:
      fd = os.open("<existing code file>", os.O_WRONLY)
  except OSError as error:
      assert error.errno in (errno.EROFS, errno.EACCES, errno.EPERM), error
  else:
      os.close(fd)
      raise RuntimeError("code still accepts writes")
  with tempfile.TemporaryFile(dir="<artifacts folder>") as artifact:
      artifact.write(b"ok")
  ```

- Record the proof in the first report; repeat it in every new session. An old session gains
  no protection from new instructions. A research subagent needs inherited protection or a
  checked native restriction, not a role description.

## Tests that write

Checks that write (cache, artifacts) and mutation run in a disposable copy outside the
protected tree, from the frozen round object (or the approved tip in the final review):

```bash
git clone --no-hardlinks --no-checkout -- <repo> <new-sandbox>
git -C <new-sandbox> checkout --detach <object>
```

- Check the copy's `HEAD` before testing; use the environment preparation the plan defines.
- Never `git worktree add` from the protected checkout.
- Only the copy receives the mutation; product and test fixes stay with the executor.
- Each mutation starts from the round object: restore the file from the object and compare it
  byte for byte before the next cut.
- Copy results to the durable folder; remove only the sandbox this round created.

## Limits

- Linux with `bwrap` only; no equivalent claimed on Windows.
- It blocks writes through the protected paths; it does not isolate external services, the
  Hangar API, tmux or `/proc` paths. The script also forbids asking another process to alter
  the checkout.
- Reopening a session preserves the flag and repeats the proof; protection is never inferred
  from the session name. A live resume that would recreate the pane is refused: reopen with
  `--read-only`; a conversation resumed from the Archive needs the flag too.
