"""Testes do AppServerClient: framing NDJSON + correlacao request<->response por id, via
transporte fake em memoria (sem spawnar o binario `codex` real, ver docs/codex-app-server-contract.md)."""
import asyncio
import json
import logging
import os
import shutil

import pytest
from unittest.mock import AsyncMock, patch

from app.adapters.codex.appserver import _MAX_FALHAS_LEITURA, _READ_LIMIT, AppServerClient


class _FakeWriter:
    """Escreve em memoria - substitui asyncio.StreamWriter (que exige um transport real de
    verdade pra existir). So guarda o que foi escrito pra o teste inspecionar."""

    def __init__(self) -> None:
        self.lines: list[bytes] = []
        self.closed = False

    def write(self, data: bytes) -> None:
        self.lines.append(data)

    async def drain(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        pass


def _fake_reader(*chunks: bytes, limit: int = _READ_LIMIT) -> asyncio.StreamReader:
    """asyncio.StreamReader alimentado manualmente com feed_data/feed_eof - stub padrao da
    stdlib pra simular stdout do subprocess sem precisar de pipe/socket real. `limit` espelha
    o `limit=` que start() passa pro create_subprocess_exec (default = producao)."""
    reader = asyncio.StreamReader(limit=limit)
    for chunk in chunks:
        reader.feed_data(chunk)
    return reader


def _client_with(reader: asyncio.StreamReader, writer: _FakeWriter) -> AppServerClient:
    client = AppServerClient()
    client._attach(reader, writer)  # seam de teste: injeta transporte sem spawnar subprocess
    return client


async def test_request_writes_ndjson_line_and_resolves_by_id():
    writer = _FakeWriter()
    reader = _fake_reader()  # sem EOF ainda: mantem a leitura viva ate a resposta chegar
    client = _client_with(reader, writer)

    req_task = asyncio.create_task(client.request("m", {}))
    await asyncio.sleep(0)  # deixa o write acontecer antes de alimentar a resposta

    assert len(writer.lines) == 1
    line = writer.lines[0]
    assert line.endswith(b"\n")
    assert json.loads(line) == {"jsonrpc": "2.0", "id": 1, "method": "m", "params": {}}

    reader.feed_data(b'{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n')
    result = await req_task
    assert result == {"ok": True}

    await client.close()


async def test_message_without_id_goes_to_notifications_not_request():
    writer = _FakeWriter()
    reader = _fake_reader(
        b'{"jsonrpc":"2.0","method":"remoteControl/status/changed","params":{"x":1}}\n'
    )
    client = _client_with(reader, writer)

    notif = await asyncio.wait_for(client.notifications().__anext__(), timeout=1)
    assert notif == {"jsonrpc": "2.0", "method": "remoteControl/status/changed", "params": {"x": 1}}

    await client.close()


async def test_pending_request_rejected_on_stream_eof():
    """Sem Future orfao: se o stream fecha antes da resposta chegar, a request pendente
    precisa destravar com erro, nao ficar pendurada pra sempre."""
    writer = _FakeWriter()
    reader = _fake_reader()
    client = _client_with(reader, writer)

    req_task = asyncio.create_task(client.request("m", {}))
    await asyncio.sleep(0)
    reader.feed_eof()

    with pytest.raises(ConnectionError):
        await req_task

    await client.close()


class _ContadorDeLogs(logging.Handler):
    """Conta registros e ABORTA depois do teto. Sem isto, a regressao (laco quente que nunca cede o
    event loop) travaria a suite pra sempre em vez de falhar: nenhum timeout async chega a rodar."""

    def __init__(self, teto: int) -> None:
        super().__init__()
        self.total = 0
        self._teto = teto

    def emit(self, record: logging.LogRecord) -> None:
        self.total += 1
        if self.total >= self._teto:
            raise _LacoQuente(f"read loop girou {self.total} vezes sem ceder o event loop")


class _LacoQuente(Exception):
    pass


async def test_transport_error_on_read_ends_loop_instead_of_spinning():
    """Cano fechado no Windows chega como ConnectionResetError, nao como EOF - e o StreamReader
    relevanta essa MESMA excecao em toda leitura seguinte, sem suspender. Se o loop tratar isso como
    erro de linha e continuar, gira quente: nao cede o event loop (backend inteiro sem resposta), nao
    aceita cancel, e o traceback cresce a cada relevantada. Erro de transporte tem que encerrar."""
    contador = _ContadorDeLogs(teto=50)
    logger_alvo = logging.getLogger("app.adapters.codex.appserver")
    logger_alvo.addHandler(contador)
    try:
        writer = _FakeWriter()
        reader = _fake_reader()
        client = _client_with(reader, writer)

        req_task = asyncio.create_task(client.request("m", {}))
        await asyncio.sleep(0)
        reader.set_exception(ConnectionResetError(64, "O nome da rede nao esta mais disponivel"))

        # o loop encerra sozinho: task termina, pendentes destravam e a morte e sinalizada
        await asyncio.wait_for(client._reader_task, timeout=2)
        with pytest.raises(ConnectionError):
            await req_task
        assert client.closed is True
        assert contador.total < 50, "erro de transporte foi logado em laco"
    finally:
        logger_alvo.removeHandler(contador)

    await client.close()


async def test_recoverable_read_errors_stop_at_the_cap():
    """Erro de leitura recuperavel (linha > _READ_LIMIT vira ValueError depois de drenar o buffer)
    segue adiante, mas nao pra sempre: se a leitura nunca andar, o teto encerra o loop."""

    class _ReaderSempreValueError(asyncio.StreamReader):
        def __init__(self) -> None:
            super().__init__()
            self.tentativas = 0

        async def readline(self) -> bytes:
            self.tentativas += 1
            raise ValueError("Separator is not found, and chunk exceed the limit")

    contador = _ContadorDeLogs(teto=_MAX_FALHAS_LEITURA + 2)
    logger_alvo = logging.getLogger("app.adapters.codex.appserver")
    logger_alvo.addHandler(contador)
    try:
        reader = _ReaderSempreValueError()
        client = _client_with(reader, _FakeWriter())

        await asyncio.wait_for(client._reader_task, timeout=2)
        assert reader.tentativas == _MAX_FALHAS_LEITURA
        assert client.closed is True

        await client.close()
    finally:
        logger_alvo.removeHandler(contador)


async def test_oversized_line_processed_and_reader_stays_alive():
    """Notification maior que o limite antigo de 64 KiB (ex: diff grande) e processada com o
    novo limit, sem matar a reader - e o cliente segue respondendo requests depois."""
    big_text = "x" * (128 * 1024)  # > 64 KiB
    big_notif = json.dumps({"jsonrpc": "2.0", "method": "item/fileChange/patchUpdated",
                            "params": {"diff": big_text}}).encode() + b"\n"
    writer = _FakeWriter()
    reader = _fake_reader(big_notif)  # usa o _READ_LIMIT de producao
    client = _client_with(reader, writer)

    notif = await asyncio.wait_for(client.notifications().__anext__(), timeout=1)
    assert notif["method"] == "item/fileChange/patchUpdated"
    assert len(notif["params"]["diff"]) == 128 * 1024

    # reader continua viva: uma request posterior ainda resolve
    req_task = asyncio.create_task(client.request("m", {}))
    await asyncio.sleep(0)
    reader.feed_data(b'{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n')
    assert await asyncio.wait_for(req_task, timeout=1) == {"ok": True}

    await client.close()


async def test_non_dict_json_line_does_not_kill_reader():
    """JSON valido mas nao-objeto (ex: `42`, `[]`) nao pode derrubar a reader - a proxima
    resposta ainda tem que resolver."""
    writer = _FakeWriter()
    reader = _fake_reader(b"42\n", b"[]\n")
    client = _client_with(reader, writer)

    req_task = asyncio.create_task(client.request("m", {}))
    await asyncio.sleep(0)
    reader.feed_data(b'{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n')
    assert await asyncio.wait_for(req_task, timeout=1) == {"ok": True}

    await client.close()


async def test_orphan_response_not_enqueued_in_notifications():
    """Resposta com `id` mas sem Future pendente (request que ja deu timeout) e dropada, NAO
    vai pra notifications(); so a notification real (com `method`) aparece."""
    writer = _FakeWriter()
    reader = _fake_reader(
        b'{"jsonrpc":"2.0","id":999,"result":{"stale":true}}\n',          # resposta orfa
        b'{"jsonrpc":"2.0","method":"turn/completed","params":{"y":2}}\n',  # notification real
    )
    client = _client_with(reader, writer)

    notif = await asyncio.wait_for(client.notifications().__anext__(), timeout=1)
    assert notif["method"] == "turn/completed"  # a orfa foi pulada, nao enfileirada

    await client.close()


async def test_close_clean_after_limit_overrun_line():
    """Linha problematica (estoura ate o _READ_LIMIT -> LimitOverrunError no readline) nao
    trava nem mata a reader; request posterior resolve e close() encerra limpo, sem hang."""
    writer = _FakeWriter()
    # reader com limite pequeno pra forcar o overrun sem alocar MiB; sem newline dentro do limite.
    reader = _fake_reader(b"Z" * 500, limit=128)
    client = _client_with(reader, writer)

    req_task = asyncio.create_task(client.request("m", {}))
    await asyncio.sleep(0)
    reader.feed_data(b'{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n')
    assert await asyncio.wait_for(req_task, timeout=1) == {"ok": True}  # reader sobreviveu

    await asyncio.wait_for(client.close(), timeout=1)  # sem hang


async def test_shared_websocket_transport_returns_endpoint_and_handles_request():
    class _FakeWebSocket:
        def __init__(self):
            self.sent = []
            self.incoming = asyncio.Queue()

        async def send(self, data):
            self.sent.append(data)

        async def recv(self):
            return await self.incoming.get()

        async def close(self):
            pass

    class _FakeProcess:
        returncode = None

        def terminate(self):
            self.returncode = 0

        async def wait(self):
            return self.returncode

    ws, proc = _FakeWebSocket(), _FakeProcess()
    with patch("app.adapters.codex.appserver.asyncio.create_subprocess_exec",
               AsyncMock(return_value=proc)) as spawn, \
         patch("app.adapters.codex.appserver.websockets.connect",
               AsyncMock(return_value=ws)):
        client = AppServerClient()
        endpoint = await client.start_shared("ws://127.0.0.1:45123", codex_home="/tmp/codex-work")
        assert endpoint == "ws://127.0.0.1:45123"
        spawn.assert_awaited_once()
        assert spawn.call_args.kwargs["env"]["CODEX_HOME"] == "/tmp/codex-work"

        task = asyncio.create_task(client.request("thread/list", {"limit": 1}))
        await asyncio.sleep(0)
        sent = json.loads(ws.sent[0])
        await ws.incoming.put(json.dumps({"id": sent["id"], "result": {"data": []}}))
        assert await task == {"data": []}
        await client.close()


@pytest.mark.integration
@pytest.mark.skipif(
    os.environ.get("CP_CODEX_INTEGRATION") != "1" or shutil.which("codex") is None,
    reason="smoke manual: requer CP_CODEX_INTEGRATION=1 e `codex` logado no PATH",
)
async def test_real_codex_initialize_smoke():
    client = AppServerClient()
    await client.start()
    try:
        result = await client.request("initialize", {
            "clientInfo": {"name": "hangar-test", "title": None, "version": "0.0.1"},
            "capabilities": None,
        })
        assert result
    finally:
        await client.close()
