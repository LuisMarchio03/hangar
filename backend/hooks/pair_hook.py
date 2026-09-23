#!/usr/bin/env python3
# SessionStart (startup|resume|clear|compact): reinjeta o protocolo do grupo. O prompt que o
# --pair injeta some no /clear, na compactação e no --resume; o sidecar não. Lê
# <pair_dir>/<nome>.json e devolve o texto como additionalContext. Sem grupo, sem saída. Falha
# em silêncio (nunca trava a abertura). O pair_dir vem por argv porque é o do BACKEND: sessão
# em outra conta (--conta) tem CLAUDE_CONFIG_DIR próprio, e o sidecar não mora lá.
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from app.pair_texto import texto_grupo  # noqa: E402  (stdlib-only; app/__init__.py é vazio)


def _tmux(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["tmux", *args], capture_output=True, text=True, timeout=3)


def _nome_headless() -> str | None:
    # Sessão SEM terminal: a chave do sidecar (env do processo) não muda no rename nem no /clear.
    chave = os.environ.get("CP_SESSION_KEY")
    if not chave:
        return None
    pasta = os.path.join(os.path.expanduser("~"), ".hangar", "claude-headless")
    try:
        arquivos = os.listdir(pasta)
    except OSError:
        return None
    for arq in arquivos:
        if not arq.endswith(".json"):
            continue
        try:
            with open(os.path.join(pasta, arq), encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            continue   # sidecar alheio em escrita ou corrompido não pode esconder o certo
        if isinstance(meta, dict) and meta.get("key") == chave and meta.get("name"):
            return meta["name"]
    return None


def _nome_da_sessao() -> str | None:
    # Mesma ordem do me() do hangar-send: sidecar da sessão sem terminal -> pane (dono de verdade;
    # conta ocorrências porque o psmux repete %N entre sessões) -> carimbo do nascimento, se a
    # sessão ainda se chamar assim.
    nome = _nome_headless()
    if nome:
        return nome
    pane = os.environ.get("TMUX_PANE")
    if pane:
        try:
            linhas = _tmux("list-panes", "-a", "-F", "#{pane_id}\t#{session_name}").stdout.splitlines()
        except Exception:
            linhas = []
        achados = [l.split("\t", 1)[1] for l in linhas if "\t" in l and l.split("\t", 1)[0] == pane]
        if len(achados) == 1:
            return achados[0]
    nome = os.environ.get("CP_SESSION_NAME")
    if nome:
        try:
            if _tmux("has-session", "-t", f"={nome}").returncode == 0:
                return nome
        except Exception:
            pass
    return None


def main() -> None:
    pair_dir = sys.argv[1]
    nome = _nome_da_sessao()
    if not nome:
        return
    # Mesmo saneamento do PairLink (pqueue._sanitize), copiado: o hook não importa app.pqueue.
    chave = re.sub(r"[^A-Za-z0-9_.-]", "-", nome)
    with open(os.path.join(pair_dir, chave + ".json"), encoding="utf-8") as fh:
        d = json.load(fh)
    peers = [p for p in (d.get("peers") or []) if p] if isinstance(d, dict) else []
    if not peers:
        return
    gid = d.get("gid") or ""
    cross = any("::" in p for p in peers)
    contrato = None if (cross or not gid) else os.path.join(pair_dir, f"grupo-{gid}.md")
    # Hook de SessionStart só existe no Claude Code: o próprio harness é fixo, o dos outros vem do sidecar.
    h = d.get("harness")
    harness = h if isinstance(h, dict) else {}
    texto = texto_grupo(nome, peers, d.get("task", ""), contrato, {**harness, nome: "claude"})
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
                                             "additionalContext": texto}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
