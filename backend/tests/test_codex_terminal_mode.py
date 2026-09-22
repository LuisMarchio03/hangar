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
