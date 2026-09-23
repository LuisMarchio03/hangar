"""Entrega de recado pelo socket nativo do Claude Code (cross-session messaging, CLI 2.1.224+).

Protocolo medido em 21/09/2026 com um socket falso capturando o que o `SendMessage` escreve:
socket Unix em `$XDG_RUNTIME_DIR/cc-socks/<pid>.sock`, uma linha JSON por mensagem, sem
autenticação no Linux (o token só é exigido no Windows). Quadro:

    {"msgV":1,"msg_id":"<uuid>","type":"user",
     "message":{"role":"user","content":"<cross-session-message from=\"uds:<socket do remetente>\"
                from-name=\"<nome>\" from-mode=\"bypass|prompting\">\\ntexto\\n</cross-session-message>"},
     "priority":"next","from":"uds:<socket do remetente>"}

`from` é endereço de RESPOSTA: retenção ou recusa voltam como `peer_message_status` nesse socket;
entrega aceita não devolve nada. Por isso o backend liga um inbox próprio (`Inbox`) e o usa como
`from`. Mensagem mandada durante a inicialização fica na fila do receptor.

A política `crossSessionInbound` do receptor segura recado cujo `from-mode` não bate com a classe
dele (bypass × prompting). Aqui o `from-mode` é o do REMETENTE quando conhecido; sem ele, a classe
do receptor — é o que o caminho antigo (tmux) sempre fez, sem checagem nenhuma.
"""
from __future__ import annotations

import json
import logging
import os
import re
import socket
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

_log = logging.getLogger("hangar.uds")

_PREFIXO_RE = re.compile(r"^\[(de|grupo|painel):\s*([^\]]+)\]\s*", re.DOTALL)
_TIMEOUT_S = 3.0


def _cc_socks() -> Optional[Path]:
    if os.name != "posix":
        return None
    run = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    p = Path(run) / "cc-socks"
    return p if p.is_dir() else None


def _pid_vivo(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def socket_da_sessao(session_id: str, config_dir: Optional[str]) -> Optional[str]:
    """Socket de inbox da sessão Claude cujo transcript é `session_id`, lendo o registro do
    próprio CLI (`<config>/sessions/<pid>.json`, com `messagingSocketPath`). Vale pra sessão com
    e sem terminal: o pid ali é o do `claude`, não o do runner que o Hangar conhece."""
    if _cc_socks() is None:
        return None
    dirs = []
    if config_dir:
        dirs.append(Path(config_dir) / "sessions")
    dirs.append(Path.home() / ".claude" / "sessions")
    vistos: set[Path] = set()
    for d in dirs:
        try:
            r = d.resolve()
        except OSError:
            continue
        if r in vistos or not r.is_dir():
            continue
        vistos.add(r)
        for f in r.glob("*.json"):
            try:
                meta = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if meta.get("sessionId") != session_id:
                continue
            sock = meta.get("messagingSocketPath")
            try:
                pid = int(meta.get("pid"))
            except (TypeError, ValueError):
                continue
            if isinstance(sock, str) and sock and _pid_vivo(pid) and Path(sock).exists():
                return sock
    return None


def separar_prefixo(texto: str) -> tuple[Optional[str], str]:
    """("nome do remetente", texto sem o prefixo) para "[de: X] …"; (None, texto) sem prefixo."""
    m = _PREFIXO_RE.match(texto)
    if not m:
        return None, texto
    return m.group(2).strip(), texto[m.end():]


class Inbox:
    """Socket próprio do backend em `cc-socks/<pid>.sock` pra receber `peer_message_status`
    (retido/recusado) dos recados que ele mandou. Um por processo; `ao_status(msg_id, estado,
    detalhe)` é chamado fora da thread do servidor."""

    def __init__(self) -> None:
        self.path: Optional[str] = None
        self._srv: Optional[socket.socket] = None
        self._thread: Optional[threading.Thread] = None
        self._ao_status: Optional[Callable[[str, str, str], None]] = None

    def ligar(self, ao_status: Callable[[str, str, str], None]) -> Optional[str]:
        base = _cc_socks()
        if base is None or self._srv is not None:
            return self.path
        caminho = base / f"{os.getpid()}.sock"
        try:
            caminho.unlink(missing_ok=True)
            srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            srv.bind(str(caminho))
            os.chmod(caminho, 0o600)
            srv.listen(16)
        except OSError:
            _log.warning("inbox nativo não ligou em %s", caminho, exc_info=True)
            return None
        self._srv, self.path, self._ao_status = srv, str(caminho), ao_status
        self._thread = threading.Thread(target=self._loop, name="uds-inbox", daemon=True)
        self._thread.start()
        return self.path

    def desligar(self) -> None:
        srv, self._srv = self._srv, None
        if srv is not None:
            try:
                srv.close()
            except OSError:
                pass
        if self.path:
            Path(self.path).unlink(missing_ok=True)

    def _loop(self) -> None:
        while self._srv is not None:
            try:
                conn, _ = self._srv.accept()
            except OSError:
                return
            threading.Thread(target=self._atender, args=(conn,), daemon=True).start()

    def _atender(self, conn: socket.socket) -> None:
        conn.settimeout(_TIMEOUT_S)
        buf = b""
        try:
            while True:
                ch = conn.recv(65536)
                if not ch:
                    break
                buf += ch
        except OSError:
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass
        for linha in buf.decode("utf-8", "replace").splitlines():
            linha = linha.strip()
            if not linha:
                continue
            try:
                q = json.loads(linha)
            except ValueError:
                _log.warning("inbox nativo: linha que nao e JSON descartada: %r", linha[:120])
                continue
            if not isinstance(q, dict):
                _log.warning("inbox nativo: quadro que nao e objeto descartado: %r", linha[:120])
                continue
            if q.get("type") == "peer_message_status" or q.get("action") == "peer_message_status":
                mid = q.get("orig_msg_id") or q.get("msg_id") or ""
                estado = str(q.get("state") or q.get("status") or "")
                detalhe = str(q.get("detail") or q.get("reason") or "")
                _log.info("recibo nativo msg_id=%s estado=%s detalhe=%s", mid, estado, detalhe)
                if self._ao_status and mid:
                    try:
                        self._ao_status(str(mid), estado, detalhe)
                    except Exception:                # noqa: BLE001
                        _log.exception("ao_status falhou msg_id=%s", mid)
            else:
                _log.info("quadro nativo ignorado no inbox: %s", linha[:200])


INBOX = Inbox()


def enviar(sock: str, texto: str, remetente: str, modo: str,
           msg_id: Optional[str] = None, priority: str = "next") -> str:
    """Escreve UM recado no socket `sock`. Devolve o msg_id. Levanta OSError se não conectar ou não
    escrever — quem chama cai pro próximo degrau (plugin, tmux, fila)."""
    mid = msg_id or str(uuid.uuid4())
    origem = f"uds:{INBOX.path}" if INBOX.path else f"uds:hangar-{os.getpid()}"
    corpo = texto.strip("\n")
    conteudo = (f'<cross-session-message from="{origem}" from-name="{remetente}" '
                f'from-mode="{modo}">\n{corpo}\n</cross-session-message>')
    quadro = {"msgV": 1, "msg_id": mid, "type": "user",
              "message": {"role": "user", "content": conteudo},
              "priority": priority, "from": origem}
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(_TIMEOUT_S)
    try:
        s.connect(sock)
        s.sendall((json.dumps(quadro, ensure_ascii=False) + "\n").encode("utf-8"))
        # Fecha só a escrita e espera o outro lado soltar: fechar na hora, antes de ele ler, já
        # perdeu quadro em teste (conexão de 0 bytes do lado dele).
        try:
            s.shutdown(socket.SHUT_WR)
            t0 = time.time()
            while time.time() - t0 < 1.0:
                if not s.recv(4096):
                    break
        except OSError:
            pass
    finally:
        s.close()
    return mid
