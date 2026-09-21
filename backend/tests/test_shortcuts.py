"""Atalhos configuráveis: validação do campo `shortcuts` e endpoint shell dispara-e-esquece.

O que esta suíte trava: config quebrada é recusada na GRAVAÇÃO com o item apontado (o resolve do
front é tolerante e cairia no conjunto nativo, calado), e o endpoint shell roda no cwd da sessão
sem esperar o comando terminar.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app import runtime_config as rc
from app.api import app
from app.config import settings


@pytest.fixture(autouse=True)
def _isola(tmp_path, monkeypatch):
    monkeypatch.setattr(rc, "_backend_config_base", lambda: tmp_path)
    yield


@pytest.fixture
def cliente():
    """Mesmo arranjo de test_api.py: sem armar o token, toda rota devolve 401."""
    anterior = settings.auth_token
    settings.auth_token = "secret"
    yield TestClient(app)
    settings.auth_token = anterior


def _lista(*itens) -> str:
    return json.dumps(list(itens))


# --- validação na gravação -------------------------------------------------------------------

def test_lista_valida_e_aceita_e_vazio_volta_ao_padrao():
    valor = _lista(
        {"id": "terminal", "type": "internal", "action": "terminal"},
        {"id": "a1", "type": "send_text", "label": "Relatório", "text": "/relatorio-pm",
         "icon": "emoji:📋", "send_direct": True},
        {"id": "a2", "type": "shell", "label": "Editor", "command": "code .", "confirm": True},
    )
    rc.aplicar({"shortcuts": valor})
    assert rc.get("shortcuts") == valor
    rc.aplicar({}, remover={"shortcuts"})
    assert rc.get("shortcuts") == ""


def test_json_quebrado_e_recusado():
    with pytest.raises(ValueError, match="JSON invalido"):
        rc.aplicar({"shortcuts": "{nao é json"})


def test_type_desconhecido_e_recusado_apontando_o_item():
    with pytest.raises(ValueError, match="item 2"):
        rc.aplicar({"shortcuts": _lista(
            {"id": "terminal", "type": "internal", "action": "terminal"},
            {"id": "x", "type": "foguete"},
        )})


def test_internal_com_action_desconhecida_e_recusado():
    with pytest.raises(ValueError, match="action desconhecida"):
        rc.aplicar({"shortcuts": _lista({"id": "x", "type": "internal", "action": "jetpack"})})


def test_item_sem_campo_obrigatorio_e_recusado():
    with pytest.raises(ValueError, match="sem texto"):
        rc.aplicar({"shortcuts": _lista({"id": "x", "type": "send_text", "label": "Oi"})})
    with pytest.raises(ValueError, match="sem comando"):
        rc.aplicar({"shortcuts": _lista({"id": "x", "type": "shell", "label": "Oi", "command": " "})})
    with pytest.raises(ValueError, match="sem rotulo"):
        rc.aplicar({"shortcuts": _lista({"id": "x", "type": "shell", "command": "true"})})
    with pytest.raises(ValueError, match="sem id"):
        rc.aplicar({"shortcuts": _lista({"type": "internal", "action": "rodar"})})


def test_lista_precisa_ser_lista():
    with pytest.raises(ValueError, match="esperado uma lista"):
        rc.aplicar({"shortcuts": json.dumps({"id": "x"})})


# --- endpoint shell --------------------------------------------------------------------------

def test_shell_exige_auth(cliente):
    assert cliente.post("/api/sessions/s/shortcut-shell",
                        json={"command": "true"}).status_code == 401


def test_shell_sessao_inexistente_da_404(cliente, monkeypatch):
    from app import api
    monkeypatch.setattr(api, "_cached_info_sync", lambda name: None)
    r = cliente.post("/api/sessions/nada/shortcut-shell", json={"command": "true"},
                     headers={"Authorization": "Bearer secret"})
    assert r.status_code == 404


def test_shell_roda_no_cwd_da_sessao_sem_esperar(cliente, monkeypatch, tmp_path):
    from app import api
    monkeypatch.setattr(api, "_session_cwd", lambda name: str(tmp_path))
    r = cliente.post("/api/sessions/s/shortcut-shell", json={"command": "pwd > prova.txt"},
                     headers={"Authorization": "Bearer secret"})
    assert r.status_code == 202 and r.json() == {"ok": True}
    # dispara-e-esquece: a resposta volta antes do fim; espera-se o arquivo aparecer
    import time
    prova = tmp_path / "prova.txt"
    for _ in range(50):
        if prova.exists() and prova.read_text().strip():
            break
        time.sleep(0.1)
    assert prova.read_text().strip() == str(tmp_path)


def test_shell_comando_vazio_da_400(cliente, monkeypatch, tmp_path):
    from app import api
    monkeypatch.setattr(api, "_session_cwd", lambda name: str(tmp_path))
    r = cliente.post("/api/sessions/s/shortcut-shell", json={"command": "   "},
                     headers={"Authorization": "Bearer secret"})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "erro_shortcut_vazio"
