---
id: 2026-09-23-hangar-send-new-remoto
titulo: hangar-send cria sessão em outro servidor com --new servidor::nome
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.local/bin/hangar-send
destrutivo: false
---

`hangar-send --new servidor::nome` abre a sessão direto na outra máquina do `peers.json`, com as
mesmas opções da sessão local; a pasta e a conta são as de lá (sem pasta, a home de lá). O bloco
"Sessões-irmãs" do CLAUDE.md global passa a dizer isso, por isso o instalador do hangar-send roda
de novo.
