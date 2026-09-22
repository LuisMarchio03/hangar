"""A troca preserva a conversa e restaura o modo antigo quando o terminal falha."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.adapters.codex import adapter as module, sessions


@pytest.fixture
def transition(tmp_path, monkeypatch):
    from app import registry
    monkeypatch.setattr(sessions, "_dir", lambda: tmp_path / "sidecars")
    rollout = tmp_path / "rollout.jsonl"
    rollout.write_text("{}\n")
    sessions.save("sess", "thread-1", str(rollout), str(tmp_path), headless=True,
                  key="identity", codex_home=str(tmp_path), codex_account="work",
                  permission_mode="Ask for approval", jev=True)
    adapter = module.CodexAdapter()
    client = SimpleNamespace(server_requests={}, close=AsyncMock())
    adapter._sessions["sess"] = dict(client=client, turn_state_known=True, in_progress=False,
                                     async_questions=SimpleNamespace(pending=lambda: None))
    monkeypatch.setattr(adapter, "read_settings", AsyncMock(return_value={"model": "model", "effort": "high", "mode": "plan"}))
    monkeypatch.setattr(adapter, "close_sync", lambda name, **kwargs: adapter._sessions.pop(name, None))
    monkeypatch.setattr(adapter, "set_mode", AsyncMock())
    monkeypatch.setattr(adapter, "_conectar", AsyncMock(return_value=client))
    monkeypatch.setattr(adapter, "_subir_sem_terminal", AsyncMock(return_value=client))
    monkeypatch.setattr(module.PromptQueue, "load", lambda _: [])
    monkeypatch.setattr(registry, "_exigir_lancador_codex", lambda: None)
    monkeypatch.setattr(registry, "_env_sessao", lambda *a, **k: {"env": {}})
    monkeypatch.setattr(registry, "_esperar_saida", lambda pids: None)
    monkeypatch.setattr(module.codex_contas, "resolve_account", lambda _: SimpleNamespace(id="work", home=tmp_path))
    monkeypatch.setattr(module.tmux, "has_session", lambda _: False)
    monkeypatch.setattr(module.tmux, "pane_pid", lambda _: None)
    monkeypatch.setattr(module, "pid_vivo", lambda _: True)
    probe = SimpleNamespace(endpoint=None, connect=AsyncMock(), close=AsyncMock(),
                            request=AsyncMock(return_value={"data": ["thread-1"]}))
    monkeypatch.setattr(module, "AppServerClient", lambda: probe)
    return adapter, client, probe


async def test_terminal_preserves_identity_and_permissions(transition, monkeypatch):
    adapter, client, probe = transition
    calls = []
    def create(name, cwd, command, **kwargs):
        assert client.close.await_count == 1
        calls.append((command, kwargs))
        sessions.update(name, endpoint="ws://local", app_pid=123, tui_pid=456)
        return True
    monkeypatch.setattr(module.tmux, "new_session", create)
    await adapter.open_terminal("sess")
    command, kwargs = calls[0]
    assert "--resume thread-1" in command and "--codex-account work" in command
    assert "--model model" in command and "--effort high" in command
    assert "--approval-policy on-request" in command and "--sandbox read-only" in command
    assert kwargs["env"]["CP_SESSION_KEY"] == "identity"
    meta = sessions.load("sess")
    assert not meta["headless"] and meta["key"] == "identity" and meta["jev"]
    assert meta["permission_mode"] == "Ask for approval"
    adapter.set_mode.assert_awaited_once_with("sess", "plan")
    probe.close.assert_awaited_once()


async def test_failed_terminal_restores_headless_conversation(transition, monkeypatch):
    adapter, client, _ = transition
    monkeypatch.setattr(module.tmux, "new_session", lambda *a, **k: False)
    with pytest.raises(RuntimeError, match="continua sem terminal"):
        await adapter.open_terminal("sess")
    restored = sessions.load("sess")
    assert restored["headless"] and restored["thread_id"] == "thread-1"
    assert restored["key"] == "identity" and restored["permission_mode"] == "Ask for approval"
    adapter._subir_sem_terminal.assert_awaited_once_with("sess", restored)


async def test_empty_conversation_keeps_original_process(transition):
    adapter, client, _ = transition
    sessions.update("sess", rollout_path="")
    with pytest.raises(ValueError, match="primeira mensagem"):
        await adapter.open_terminal("sess")
    client.close.assert_not_awaited()
    assert sessions.load("sess")["headless"]


@pytest.fixture
def terminal_transition(transition, monkeypatch):
    adapter, client, _ = transition
    sessions.update("sess", headless=False, permission_mode="Full Access")
    client.request = AsyncMock(return_value={
        "thread": {"id": "thread-1", "status": {"type": "idle"}},
        "approvalPolicy": "on-request", "sandbox": {"type": "readOnly"},
        "model": "current-model", "reasoningEffort": "low",
    })
    monkeypatch.setattr(module.tmux, "kill_session", lambda _: True)
    monkeypatch.setattr(adapter, "_start_tmux_watcher", lambda _: None)
    async def start(name, meta):
        adapter._sessions[name] = {"thread_id": meta["thread_id"], "client": client}
        return client
    adapter._subir_sem_terminal.side_effect = start
    return adapter, client


async def test_headless_preserves_current_permissions_and_thread(terminal_transition):
    adapter, client = terminal_transition
    await adapter.open_headless("sess")
    meta = sessions.load("sess")
    assert meta["headless"] and meta["thread_id"] == "thread-1"
    assert meta["permission_mode"] == "Ask for approval"
    assert (meta["model"], meta["effort"]) == ("current-model", "low")
    assert meta["key"] == "identity" and meta["codex_account"] == "work" and meta["jev"]
    assert meta["endpoint"] is None and meta["app_pid"] is None
    client.close.assert_awaited_once()
    client.request.assert_awaited_once_with("thread/resume", {"threadId": "thread-1"})
    adapter.set_mode.assert_awaited_once_with("sess", "plan")


async def test_headless_failure_restores_terminal(terminal_transition, monkeypatch):
    adapter, client = terminal_transition
    adapter._subir_sem_terminal.side_effect = RuntimeError("cano falhou")
    launched = []
    monkeypatch.setattr(module.tmux, "new_session", lambda *a, **k: launched.append(a) or True)
    monkeypatch.setattr(adapter, "_wait_terminal", AsyncMock(return_value={"thread_id": "thread-1"}))
    with pytest.raises(RuntimeError, match="continua no terminal"):
        await adapter.open_headless("sess")
    meta = sessions.load("sess")
    assert not meta["headless"] and meta["thread_id"] == "thread-1"
    assert len(launched) == 1 and "--resume thread-1" in launched[0][2]
    assert "--sandbox read-only" in launched[0][2]
    adapter._conectar.assert_awaited_once()


async def test_headless_does_not_start_if_terminal_survives(terminal_transition, monkeypatch):
    adapter, client = terminal_transition
    monkeypatch.setattr(module.tmux, "kill_session", lambda _: False)
    with pytest.raises(RuntimeError, match="modo foi mantido"):
        await adapter.open_headless("sess")
    client.close.assert_not_awaited()
    adapter._subir_sem_terminal.assert_not_awaited()
    assert not sessions.load("sess")["headless"]


async def test_headless_refuses_unsupported_permissions(terminal_transition, monkeypatch):
    adapter, client = terminal_transition
    client.request.return_value["approvalPolicy"] = "on-failure"
    monkeypatch.setattr(module.tmux, "kill_session", lambda _: pytest.fail("terminal encerrado"))
    with pytest.raises(ValueError, match="não é suportada"):
        await adapter.open_headless("sess")
    adapter._subir_sem_terminal.assert_not_awaited()


async def test_native_terminal_preserves_jev_from_process(terminal_transition, monkeypatch):
    from app import registry
    adapter, _ = terminal_transition
    sessions.update("sess", app_pid=123, jev=False, key=None)
    monkeypatch.setattr(registry, "_jev_do_processo", lambda pid: pid == 123)
    monkeypatch.setattr(module, "pid_vivo", lambda _: False)
    await adapter.open_headless("sess")
    meta = sessions.load("sess")
    assert meta["jev"] and meta["key"]


async def test_failed_cano_must_exit_before_terminal_rollback(terminal_transition, monkeypatch):
    adapter, _ = terminal_transition
    adapter._subir_sem_terminal.side_effect = module.sem_terminal.ShutdownPending("ainda encerrando")
    monkeypatch.setattr(module.tmux, "new_session", lambda *a, **k: pytest.fail("dois escritores"))
    with pytest.raises(module.sem_terminal.ShutdownPending):
        await adapter.open_headless("sess")


async def test_surviving_terminal_keeps_owner_to_prevent_legacy_restart(terminal_transition, monkeypatch):
    adapter, _ = terminal_transition
    sessions.update("sess", app_pid=123, endpoint="ws://terminal")
    monkeypatch.setattr(module, "pid_vivo", lambda pid: pid == 123)
    with pytest.raises(RuntimeError, match="terminal ainda está encerrando"):
        await adapter.open_headless("sess")
    meta = sessions.load("sess")
    assert meta["app_pid"] == 123 and meta["endpoint"] == "ws://terminal"
    adapter._subir_sem_terminal.assert_not_awaited()


async def test_surviving_legacy_pane_does_not_restart_automatically(terminal_transition, monkeypatch):
    from app import procinfo
    adapter, _ = terminal_transition
    monkeypatch.setattr(module.tmux, "pane_pid", lambda _: 123)
    monkeypatch.setattr(procinfo, "_descendant_pids", lambda _: [])
    monkeypatch.setattr(module, "pid_vivo", lambda pid: pid == 123)
    with pytest.raises(RuntimeError, match="terminal ainda está encerrando"):
        await adapter.open_headless("sess")
    assert await adapter.ensure_running("sess") is None


@pytest.mark.parametrize("alive", [False, True])
async def test_failed_start_waits_for_cano_and_children(transition, monkeypatch, alive):
    from app import registry, procinfo
    adapter, _, _ = transition
    async def start(meta):
        sessions.update("sess", cano={"pid": 123})
        return {"pid": 123}
    monkeypatch.setattr(module.sem_terminal, "subir", start)
    monkeypatch.setattr(module.sem_terminal, "conectar", AsyncMock(return_value=None))
    monkeypatch.setattr(module.sem_terminal, "matar", lambda _: None)
    monkeypatch.setattr(procinfo, "_descendant_pids", lambda _: [456])
    waited = []
    monkeypatch.setattr(registry, "_esperar_saida", lambda pids: waited.append(pids))
    monkeypatch.setattr(module, "pid_vivo", lambda pid: alive and pid == 456)
    with pytest.raises(module.sem_terminal.ShutdownPending if alive else RuntimeError):
        await module.CodexAdapter._subir_sem_terminal(adapter, "sess", sessions.load("sess"))
    assert waited == [[123, 456]]
    if alive:
        assert sessions.load("sess")["cano"] == {"pid": 123}
        assert adapter._falhas_subida["sess"] == adapter.TETO_SUBIDAS
    else:
        assert sessions.load("sess")["cano"] is None
