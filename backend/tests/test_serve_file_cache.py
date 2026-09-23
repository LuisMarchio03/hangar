"""Cache do anexo citado na conversa (GET /api/sessions/{name}/file).

A miniatura de 96px carrega o arquivo ORIGINAL, entao sem cache toda repintura da lista rebaixava o
PNG inteiro. Aqui vale o par: `cache-control` pra nao perguntar por 60s, e 304 pra quando perguntar.
"""
import base64
import re

import pytest
from fastapi.testclient import TestClient

from app import api, transcript
from app.api import app
from app.config import settings
from app.models import SessionInfo


@pytest.fixture
def cliente():
    anterior = settings.auth_token
    settings.auth_token = "secret"
    yield TestClient(app)
    settings.auth_token = anterior


@pytest.fixture
def sessao(tmp_path, monkeypatch):
    """Sessao de mentira apontando pro tmp_path, com a trava do transcript satisfeita."""
    jsonl = tmp_path / "conversa.jsonl"
    jsonl.write_text("{}\n", encoding="utf-8")
    info = SessionInfo(name="s1", cwd=str(tmp_path), jsonl=str(jsonl), tracked=True)
    monkeypatch.setattr(api, "_cached_info_sync", lambda nome: info if nome == "s1" else None)
    return tmp_path


def _pegar(cliente, arquivo, **kw):
    return cliente.get("/api/sessions/s1/file", params={"path": arquivo},
                       headers={"Authorization": "Bearer secret", **kw.pop("headers", {})}, **kw)


# A trava da rota e `citation_cwds`, que devolve caminho citado -> cwds que o citaram. Dublar a
# antiga `path_in_transcript` nao move nada: ela nao e mais chamada, e os tres testes de sucesso
# batiam no 403 do caminho real. O caso NEGATIVO passava por acidente pelo mesmo motivo — dicionario
# vazio ali e o que faz a prova valer de verdade. Lista de cwds vazia = so o cwd da sessao serve de
# base, que e o que estes testes querem.
def _citado(monkeypatch):
    monkeypatch.setattr(transcript, "citation_cwds", lambda jsonl, needles: {n: [] for n in needles})


def _nao_citado(monkeypatch):
    monkeypatch.setattr(transcript, "citation_cwds", lambda jsonl, needles: {})


def test_anexo_volta_com_cache_e_etag(cliente, sessao, monkeypatch):
    _citado(monkeypatch)
    (sessao / "foto.png").write_bytes(b"\x89PNG-um")

    r = _pegar(cliente, "foto.png")
    assert r.status_code == 200
    assert r.content == b"\x89PNG-um"
    assert r.headers["cache-control"] == "max-age=60"
    assert r.headers["etag"]


def test_mesmo_etag_volta_304_sem_corpo(cliente, sessao, monkeypatch):
    _citado(monkeypatch)
    (sessao / "foto.png").write_bytes(b"\x89PNG-um")

    etag = _pegar(cliente, "foto.png").headers["etag"]
    r = _pegar(cliente, "foto.png", headers={"If-None-Match": etag})
    assert r.status_code == 304
    assert r.content == b""
    assert r.headers["cache-control"] == "max-age=60"


def test_arquivo_reescrito_invalida_o_etag(cliente, sessao, monkeypatch):
    """O ETag carrega mtime+tamanho: reescrever no MESMO caminho tem que voltar a mandar o corpo,
    senao um mock regenerado ficaria preso na versao velha ate o navegador desistir sozinho."""
    _citado(monkeypatch)
    alvo = sessao / "mock.html"
    alvo.write_text("<p>um</p>", encoding="utf-8")
    etag_velho = _pegar(cliente, "mock.html").headers["etag"]

    import os
    alvo.write_text("<p>dois</p>", encoding="utf-8")
    os.utime(alvo, (0, 0))  # mtime diferente sem depender do relogio do teste

    r = _pegar(cliente, "mock.html", headers={"If-None-Match": etag_velho})
    assert r.status_code == 200
    source = re.search(r'src="data:text/html;charset=utf-8;base64,([^\"]+)"', r.text)
    assert source is not None
    assert base64.b64decode(source[1]) == b"<p>dois</p>"


def test_304_nao_fura_a_trava_do_transcript(cliente, sessao, monkeypatch):
    """304 e resposta SOBRE um arquivo: quem nao pode ve-lo tambem nao pode saber que ele mudou.
    Sem esta ordem, um If-None-Match viraria oraculo de existencia/mtime de qualquer caminho."""
    _nao_citado(monkeypatch)
    (sessao / "segredo.png").write_bytes(b"x")

    r = _pegar(cliente, "segredo.png", headers={"If-None-Match": '"qualquer"'})
    assert r.status_code == 403


@pytest.mark.parametrize("upload", [False, True])
def test_html_runs_only_inside_an_isolated_document(cliente, sessao, monkeypatch, upload):
    _citado(monkeypatch)
    path = sessao / "document.html"
    content = b'<button onclick="this.textContent=42">Run</button>' + b" " * 100_000
    content += b'</iframe><script>window.parent.localStorage.getItem("cp_servers")</script>'
    path.write_bytes(content)
    monkeypatch.setattr(api, "resolve_upload", lambda *args: path)
    route = "/api/sessions/s1/uploads/document.html" if upload else "/api/sessions/s1/file"
    stat = path.stat()
    response = cliente.get(route, params={"path": str(path), "token": "secret"}, headers={
        "If-None-Match": f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"',
    })

    assert response.status_code == 200
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert 'sandbox="allow-scripts allow-popups"' in response.text
    assert 'referrerpolicy="no-referrer"' in response.text
    assert '<meta name="viewport"' in response.text
    assert "<script>" not in response.text
    source = re.search(r'src="data:text/html;charset=utf-8;base64,([^\"]+)"', response.text)
    assert source is not None
    assert base64.b64decode(source[1], validate=True) == content


def test_svg_stays_an_image_without_document_scripts(cliente, sessao, monkeypatch):
    _citado(monkeypatch)
    content = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    (sessao / "image.svg").write_bytes(content)
    response = _pegar(cliente, "image.svg")
    assert response.content == content
    assert response.headers["content-type"] == "image/svg+xml"
    assert response.headers["content-security-policy"] == "sandbox; script-src 'none'"
