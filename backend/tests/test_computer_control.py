"""Tela do hangar-computer-control: grava em todos os .claude.json, desligar tira de todos e religar
volta com a configuração de antes."""
import json
from types import SimpleNamespace

import pytest

from app import computer_control as cc


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(cc.Path, "home", lambda: tmp_path)
    conta = tmp_path / ".claude-x"
    conta.mkdir()
    (conta / ".claude.json").write_text(json.dumps({"oauthAccount": {"a": 1}}), encoding="utf-8")
    monkeypatch.setattr(cc, "list_config_dirs", lambda: [SimpleNamespace(path=str(conta))])
    projeto = tmp_path / "Projetos" / cc.NAME
    (projeto / ".venv" / "bin").mkdir(parents=True)
    (projeto / ".venv" / "bin" / "python").write_text("")
    (projeto / "servidor_mcp.py").write_text("")
    (projeto / "alvo-agent.json").write_text("{}")
    (tmp_path / ".claude.json").write_text("{}", encoding="utf-8")
    return tmp_path


def _pedido(home, **extra):
    projeto = home / "Projetos" / cc.NAME
    return {"enabled": True, "project_dir": str(projeto), "agent_config": str(projeto / "alvo-agent.json"),
            "llm_url": "http://x/v1/chat/completions", "llm_model": "m1", "llm_effort": "high",
            "llm_key": "chave-do-llm-123", "jev_key": "chave-do-jev-456", **extra}


def _entrada(p):
    return (json.loads(p.read_text()).get("mcpServers") or {}).get(cc.NAME)


def test_liga_desliga_e_religa_sem_perder_a_configuracao(home):
    principal, conta = home / ".claude.json", home / ".claude-x" / ".claude.json"
    cc.save(_pedido(home))
    assert _entrada(principal) == _entrada(conta)
    assert _entrada(principal)["env"]["LLM_MODEL"] == "m1"
    assert json.loads(conta.read_text())["oauthAccount"] == {"a": 1}   # resto do arquivo intocado

    estado = cc.save({"enabled": False})
    assert _entrada(principal) is None and _entrada(conta) is None
    assert estado["enabled"] is False and estado["llm_model"] == "m1"   # a tela não perde os campos

    cc.save(_pedido(home, llm_key=None, jev_key=None))   # chave vazia = mantém a guardada
    env = _entrada(conta)["env"]
    assert env["LLM_PROXY_KEY"] == "chave-do-llm-123" and env["TYPESAFE_API_KEY"] == "chave-do-jev-456"


def test_estado_nunca_devolve_a_chave_inteira(home):
    cc.save(_pedido(home))
    texto = json.dumps(cc.state())
    assert "chave-do-llm-123" not in texto and "chave-do-jev-456" not in texto


def test_cria_alvo_ssh_e_recusa_repetido_e_local_fora_do_windows(home, monkeypatch):
    projeto = str(home / "Projetos" / cc.NAME)
    estado = cc.create_target({"project_dir": projeto, "name": "delphi-03", "transport": "ssh",
                               "host": "delphi-03", "proxy_command": "", "request_timeout": 40})
    alvo = next(t for t in estado["targets"] if t["name"] == "delphi-03")
    cfg = json.loads(open(alvo["path"]).read())
    assert cfg["transport"] == "ssh" and cfg["host"] == "delphi-03" and cfg["request_timeout"] == 40
    with pytest.raises(cc.ComputerControlError) as e:
        cc.create_target({"project_dir": projeto, "name": "delphi-03", "transport": "ssh", "host": "x"})
    assert e.value.code == "erro_computer_control_target_exists"
    monkeypatch.setattr(cc.os, "name", "posix")
    with pytest.raises(cc.ComputerControlError) as e:
        cc.create_target({"project_dir": projeto, "name": "eu", "transport": "local"})
    assert e.value.code == "erro_computer_control_local_only_windows"


def test_instalar_versao_publicada_leva_alvos_e_troca_pra_uvx(home, monkeypatch):
    projeto = home / "Projetos" / cc.NAME
    (projeto / "alvo-agent.json").write_text(json.dumps(
        {"transport": "ssh", "host": "h", "agent_path": str(projeto / "dist" / "windows-agent.exe")}))
    cc.save(_pedido(home))

    def falso_get(url, timeout):
        return json.dumps({"tag_name": "v0.1.0"}).encode() if "api.github.com" in url else b"MZ-exe"
    monkeypatch.setattr(cc, "_get", falso_get)
    monkeypatch.setattr(cc.shutil, "which", lambda n: "/usr/bin/uvx" if n == "uvx" else None)

    estado = cc.install()
    entrada = _entrada(home / ".claude-x" / ".claude.json")
    assert entrada["command"] == "/usr/bin/uvx"
    assert entrada["args"] == ["--from", f"git+https://github.com/{cc.REPO}@v0.1.0", cc.NAME]
    alvos = home / ".hangar" / "computer-control" / "targets"
    assert entrada["env"]["HCC_AGENTS_DIR"] == str(alvos)
    assert entrada["env"]["HCC_AGENT_CONFIG"] == str(alvos / "alvo-agent.json")
    assert "PYTHONPATH" not in entrada["env"] and entrada["env"]["LLM_MODEL"] == "m1"
    assert json.loads((alvos / "alvo-agent.json").read_text())["agent_path"] == str(
        home / ".hangar" / "computer-control" / "windows-agent.exe")
    assert (projeto / "alvo-agent.json").is_file()   # a pasta local não é apagada
    assert estado["mode"] == "package" and estado["installed_tag"] == "v0.1.0"


def test_preserva_variavel_que_a_tela_nao_controla(home):
    principal = home / ".claude.json"
    cc.save(_pedido(home))
    dados = json.loads(principal.read_text())
    dados["mcpServers"][cc.NAME]["env"]["VIRTUAL_ENV"] = ""
    principal.write_text(json.dumps(dados))
    cc.save(_pedido(home))
    assert _entrada(principal)["env"]["VIRTUAL_ENV"] == ""
