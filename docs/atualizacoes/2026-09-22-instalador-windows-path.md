---
id: 2026-09-22-instalador-windows-path
titulo: Instalador do Windows sobrevive a um PATH torto e explica o HTTPS do Tailscale
destrutivo: false
---

Nada a rodar nesta máquina: o que mudou é o próprio instalador, nas próximas execuções dele.
Num Windows cujo PATH está gravado como texto simples (`REG_SZ`), o instalador perdia o
`powershell.exe` no meio e parava com "powershell não reconhecido"; agora ele expande o PATH
lido do registro, acrescenta em vez de substituir e chama o PowerShell pelo caminho fixo. No
login do Tailscale ele passa a dizer, com o navegador já aberto, que é preciso ligar o MagicDNS e
o "Enable HTTPS" no site — antes isso só aparecia no passo 5d, depois de o `tailscale serve`
falhar. O rótulo "Node 20+" vira "Node LTS (mínimo 20)": o que se instala é a LTS atual.
