---
id: 2026-09-21-hangar-send-socket-nativo
titulo: hangar-send entrega sozinho pelo socket do Claude Code; retomar conversa vê todas as contas
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.local/bin/hangar-send
destrutivo: false
---

Recado entre sessões passa a entrar direto no socket do Claude Code da sessão de destino, no
meio do turno dela, com o tmux e a fila só como reserva; o `hangar-send` nunca mais responde
"use outra ferramenta". O bloco "Sessões-irmãs" do CLAUDE.md global é reescrito com essa regra,
por isso o instalador do hangar-send roda de novo. No modal de sessão nova, "Continuar uma
conversa desta pasta" lista as conversas de todas as contas, mostra a conta de cada uma e deixa
mover a conversa pra outra conta antes de retomar.
