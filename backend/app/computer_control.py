"""Liga, desliga e configura o MCP `hangar-computer-control` (opera um desktop Windows por objetivo).

A entrada mora em `mcpServers` do `~/.claude.json` principal e do `.claude.json` de cada conta. O
espelho das contas só acrescenta, nunca apaga, então quem desliga precisa tirar de cada arquivo. Só
a chave desse MCP é tocada: o resto do arquivo é estado do CLI daquela conta.
"""
import json
import os
import re
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from app import atomico
from app.config import list_config_dirs

NAME = "hangar-computer-control"
PRESET_URL = "http://127.0.0.1:8317/v1/chat/completions"
EFFORTS = ("", "low", "medium", "high")


class ComputerControlError(Exception):
    def __init__(self, status: int, code: str, msg: str, **params):
        super().__init__(msg)
        self.status, self.code, self.msg, self.params = status, code, msg, params


def _main_file() -> Path:
    return Path.home() / ".claude.json"


def _config_files() -> list[Path]:
    """`~/.claude.json` e o `.claude.json` de cada conta que já tem um (conta nunca aberta ganha
    a entrada pelo espelho na primeira reconciliação)."""
    default_dir = (Path.home() / ".claude").resolve()
    files = [_main_file()]
    for c in list_config_dirs():
        d = Path(c.path)
        if d.resolve() != default_dir and (d / ".claude.json").is_file():
            files.append(d / ".claude.json")
    return files


def _read(p: Path) -> dict:
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise ComputerControlError(500, "erro_computer_control_read", f"não consegui ler {p}: {e}",
                                   file=str(p), error=str(e))
    if not isinstance(data, dict):
        raise ComputerControlError(500, "erro_computer_control_read", f"{p} não é um objeto JSON",
                                   file=str(p), error="")
    return data


def _write(p: Path, data: dict) -> None:
    tmp = p.with_name(f"{p.name}.hangar-novo.{os.getpid()}.{uuid.uuid4().hex[:8]}")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    atomico.substituir(tmp, p)


def _entry(p: Path) -> dict | None:
    e = (_read(p).get("mcpServers") or {}).get(NAME)
    return e if isinstance(e, dict) else None


def _parked_file() -> Path:
    return Path.home() / ".hangar" / "computer-control.json"


def _known_entry() -> dict | None:
    """A entrada ativa ou, desligado, a que foi guardada ao desligar: religar não pode voltar sem
    modelo, esforço e chaves."""
    active = _entry(_main_file())
    if active is not None:
        return active
    parked = _read(_parked_file())
    return parked or None


def _park(entry: dict) -> None:
    p = _parked_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)   # tem chave: só o dono lê
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(entry, fh, indent=2)
    atomico.substituir(tmp, p)


def _cliproxy_keys() -> list[str]:
    """`api-keys` do ~/.cli-proxy-api/config.yaml. Lido à mão: é uma lista simples de strings e o
    backend não tem biblioteca de YAML."""
    try:
        lines = (Path.home() / ".cli-proxy-api" / "config.yaml").read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    keys: list[str] = []
    inside = False
    for ln in lines:
        if re.match(r"^api-keys\s*:", ln):
            inside = True
            continue
        if inside:
            item = re.match(r"^\s*-\s*['\"]?([^'\"#\s]+)", ln)
            if item:
                keys.append(item.group(1))
            elif ln.strip() and not ln.startswith((" ", "\t", "-")):
                break
    return keys


def _jev_from_settings() -> str:
    try:
        env = json.loads((Path.home() / ".claude" / "settings.json").read_text(encoding="utf-8")).get("env") or {}
    except (OSError, ValueError):
        return ""
    v = env.get("TYPESAFE_API_KEY") if isinstance(env, dict) else None
    return v if isinstance(v, str) else ""


def _tail(key: str) -> str:
    return key[-4:] if len(key) >= 8 else ""


def state() -> dict:
    """O que a tela mostra. Chave nunca sai inteira: só se existe e os 4 últimos caracteres."""
    enabled = _entry(_main_file()) is not None
    entry = _known_entry()
    env = (entry or {}).get("env") or {}
    args = (entry or {}).get("args") or []
    project = str(Path(args[0]).parent) if args else str(Path.home() / "Projetos" / NAME)
    llm_key = env.get("LLM_PROXY_KEY", "")
    jev = env.get("TYPESAFE_API_KEY", "")
    jev_settings = _jev_from_settings()
    cliproxy = _cliproxy_keys()
    agents = sorted(str(p) for p in Path(project).glob("*-agent.json")) if Path(project).is_dir() else []
    return {
        "enabled": enabled,
        "project_dir": project,
        "agent_config": env.get("HCC_AGENT_CONFIG", agents[0] if agents else ""),
        "agent_configs": agents,
        "llm_url": env.get("LLM_PROXY_URL", PRESET_URL),
        "llm_model": env.get("LLM_MODEL", ""),
        "llm_effort": env.get("LLM_EFFORT", ""),
        "llm_key_set": bool(llm_key),
        "llm_key_tail": _tail(llm_key),
        "jev_key_set": bool(jev or jev_settings),
        "jev_key_tail": _tail(jev or jev_settings),
        "jev_key_from_settings": not jev and bool(jev_settings),
        "cliproxy": {"preset_url": PRESET_URL, "has_keys": bool(cliproxy),
                     "key_is_cliproxy": bool(llm_key) and llm_key in cliproxy},
        "files": [{"path": str(p), "enabled": _entry(p) is not None} for p in _config_files()],
    }


def save(body: dict) -> dict:
    """Grava (ligado) ou remove (desligado) a entrada em todos os `.claude.json`. Chave vazia no
    pedido mantém a que já está gravada: a tela nunca recebeu a chave inteira pra devolver."""
    files = _config_files()
    if not body.get("enabled"):
        active = _entry(_main_file())
        if active is not None:
            _park(active)
        for p in files:
            data = _read(p)
            mcp = data.get("mcpServers")
            if isinstance(mcp, dict) and NAME in mcp:
                del mcp[NAME]
                _write(p, data)
        return state()

    project = Path(str(body.get("project_dir") or "").strip()).expanduser()
    python = project / ".venv" / "bin" / "python"
    if not (project / "servidor_mcp.py").is_file() or not python.exists():
        raise ComputerControlError(400, "erro_computer_control_dir",
                                   f"{project} não tem servidor_mcp.py e .venv/bin/python", dir=str(project))
    agent = str(body.get("agent_config") or "").strip()
    if not Path(agent).is_file():
        raise ComputerControlError(400, "erro_computer_control_agent", f"o arquivo {agent} não existe", file=agent)
    url = str(body.get("llm_url") or "").strip()
    if not re.match(r"^https?://", url):
        raise ComputerControlError(400, "erro_computer_control_url",
                                   "a URL do LLM precisa começar com http:// ou https://")
    effort = str(body.get("llm_effort") or "")
    if effort not in EFFORTS:
        raise ComputerControlError(400, "erro_computer_control_effort", f"esforço inválido: {effort}", effort=effort)

    previous = (_known_entry() or {}).get("env") or {}
    llm_key = str(body.get("llm_key") or "")
    if body.get("use_cliproxy_key"):
        keys = _cliproxy_keys()
        if not keys:
            raise ComputerControlError(400, "erro_computer_control_cliproxy_key",
                                       "o ~/.cli-proxy-api/config.yaml não tem nenhuma api-key")
        llm_key = previous.get("LLM_PROXY_KEY") if previous.get("LLM_PROXY_KEY") in keys else keys[0]
    llm_key = llm_key or previous.get("LLM_PROXY_KEY", "")
    jev = str(body.get("jev_key") or "") or previous.get("TYPESAFE_API_KEY", "") or _jev_from_settings()

    managed = {"PYTHONPATH": str(project), "HCC_AGENT_CONFIG": agent, "LLM_PROXY_URL": url,
               "LLM_MODEL": str(body.get("llm_model") or "").strip(), "LLM_EFFORT": effort,
               "LLM_PROXY_KEY": llm_key, "TYPESAFE_API_KEY": jev}
    # O resto do env é de quem montou o MCP e fica como está (o VIRTUAL_ENV vazio de propósito
    # impede herdar o venv do processo que abre a sessão). Das variáveis desta tela, vazia = ausente.
    env = {k: v for k, v in previous.items() if k not in managed}
    env.update({k: v for k, v in managed.items() if v})
    entry = {"command": str(python), "args": [str(project / "servidor_mcp.py")], "env": env}
    for p in files:
        data = _read(p)
        if not data and p != _main_file():
            continue
        current = data.get("mcpServers")
        servers: dict = current if isinstance(current, dict) else {}
        if servers.get(NAME) == entry:
            continue
        data["mcpServers"] = {**servers, NAME: entry}
        _write(p, data)
    return state()


def list_models(url: str, key: str | None, use_saved_key: bool, use_cliproxy_key: bool) -> list[str]:
    """Modelos do endpoint (`GET .../v1/models` com Bearer), pra escolher em vez de digitar."""
    if not re.match(r"^https?://", url or ""):
        raise ComputerControlError(400, "erro_computer_control_url",
                                   "a URL do LLM precisa começar com http:// ou https://")
    if use_cliproxy_key:
        keys = _cliproxy_keys()
        key = keys[0] if keys else ""
    elif use_saved_key or not key:
        key = ((_known_entry() or {}).get("env") or {}).get("LLM_PROXY_KEY", "")
    base = re.sub(r"/chat/completions/?$", "", url.rstrip("/"))
    request = urllib.request.Request(f"{base}/models", headers={"Authorization": f"Bearer {key}"} if key else {})
    try:
        with urllib.request.urlopen(request, timeout=8) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise ComputerControlError(502, "erro_computer_control_models",
                                   f"o endpoint respondeu {e.code} ao listar modelos", error=f"HTTP {e.code}")
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise ComputerControlError(502, "erro_computer_control_models", f"não consegui listar os modelos: {e}",
                                   error=str(e))
    items = data.get("data") if isinstance(data, dict) else None
    return sorted({i["id"] for i in items or [] if isinstance(i, dict) and isinstance(i.get("id"), str)})
