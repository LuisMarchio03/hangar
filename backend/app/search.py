"""Busca de conteudo cross-session: UM `rg` capado sobre projects_dir varre todos os transcripts
.jsonl (vivos + arquivados) e devolve os trechos casados. Reusa o join live/dead do archive/registry
(realpath do jsonl no conjunto das sessoes vivas) pra a UI saber se abre o chat (viva) ou o arquivo
(morta).

SEGURANCA: o `rg` roda via subprocess com LISTA DE ARGUMENTOS (nunca shell=True, nunca string
interpolada). A query e tratada como STRING LITERAL (-F fixed-string) e passada como ARGUMENTO (-e q)
-> nunca chega a um shell nem e interpretada como regex/flag. Caps HARD impedem que uma query ampla
despeje o mundo."""
import json
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Optional

from pydantic import BaseModel

from app.archive import _contas, _head_info
from app.transcript import parse_obj

# Caps HARD (uma query ampla nao pode despejar o mundo).
_MAX_HITS = 50            # teto global de trechos devolvidos
_MAX_PER_FILE = 3         # trechos por conversa (evita 1 transcript dominar o resultado)
# Linhas casadas lidas por arquivo ANTES do filtro: contexto injetado (CLAUDE.md, lista de skills,
# saída de hook) casa muito mais que a conversa e comeria o teto por arquivo se ele fosse o do rg.
_MAX_LINHAS_POR_ARQUIVO = 200
# Mensagem de conversa cabe folgado nisto; linha maior é saída de ferramenta ou contexto injetado.
_MAX_COLUNAS = 40000
_SNIPPET = 240            # tamanho do trecho legivel
_MAX_Q = 200             # comprimento maximo da query (excedente e truncado)
# ponytail: rede de seguranca; transcript acima disso e raro (rg com -m ja sai cedo por arquivo).
# Sobe se um dia um transcript legitimo passar disso e some da busca.
_MAX_FILESIZE = "64M"

_log = logging.getLogger("hangar.search")
_rg_avisado = False


def _rg() -> str:
    """Caminho do `rg`, resolvido A CADA BUSCA — e nao uma vez no import.

    Duas razoes, as duas medidas no Windows (21/08/2026, onde o ripgrep nao vem com o sistema):

    1. resolver no import congela a resposta pela vida do processo. Instalar o ripgrep com o
       backend de pe deixava a busca vazia ate alguem reiniciar o servico — e no Windows esse e o
       caminho NORMAL, porque o instalador roda com o app ja no ar.
    2. sem o binario, o `Popen` levanta FileNotFoundError e a rota devolve `[]` — indistinguivel de
       "procurei e nao achei nada". Aqui a ausencia passa a deixar rastro no log, uma vez por
       processo (a busca e chamada por digito no celular; um aviso por tecla entupiria o journal).

    O `[]` continua sendo a resposta: a rota devolve `list[SearchHit]` e transformar isto em erro
    HTTP mudaria o contrato dela e a tela do celular junto. O que muda e ter onde olhar.
    """
    global _rg_avisado
    achado = shutil.which("rg")
    if achado:
        return achado
    if not _rg_avisado:
        _rg_avisado = True
        _log.warning("ripgrep (rg) nao esta no PATH: a busca por conteudo entre sessoes vai "
                     "devolver vazio ate ele ser instalado")
    return "rg"


class SearchHit(BaseModel):
    project: str                        # nome do dir em projects/ (cwd sanitizado)
    session_id: str                     # stem do .jsonl
    session_name: Optional[str] = None  # nome tmux se a sessao esta VIVA -> abre o chat; None = arquivo
    cwd: Optional[str] = None           # cwd real da conversa
    line: str                           # trecho legivel (texto da msg), NAO o JSON cru
    mtime: float
    live: bool = False
    role: Optional[str] = None          # "user" | "assistant": quem escreveu a mensagem casada
    event_id: Optional[str] = None      # id do ChatEvent (o mesmo do histórico) pra abrir no ponto
    ts: Optional[float] = None          # quando a mensagem foi escrita


def termos(q: str) -> list[str]:
    """Palavras da busca, minúsculas e sem repetição: todas precisam estar na mesma mensagem."""
    return list(dict.fromkeys(re.findall(r"\S+", (q or "").lower()[:_MAX_Q])))


def _snippet(text: str, termos_: list[str]) -> str:
    """Janela legível do texto em volta do primeiro termo, sem quebras de linha e sem cortar palavra."""
    text = " ".join(text.split())
    if len(text) <= _SNIPPET:
        return text
    i = max(0, text.lower().find(termos_[0])) if termos_ else 0
    start = max(0, i - 60)
    if start:
        espaco = text.find(" ", start)
        start = espaco + 1 if 0 <= espaco < i else start
    fim = start + _SNIPPET
    if fim < len(text):
        espaco = text.rfind(" ", start, fim)
        fim = espaco if espaco > i else fim
    return ("…" if start else "") + text[start:fim] + ("…" if fim < len(text) else "")


def _mensagens(raw: str):
    """Mensagens da conversa (sua ou do assistente) contidas numa linha do transcript. Contexto
    injetado, resultado de ferramenta e meta não entram: não são o que a pessoa procura."""
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(obj, dict):
        return []
    return [ev for ev in parse_obj(obj) if ev.kind in ("user_msg", "assistant_msg") and ev.text]


def _prefixos_internos() -> tuple[str, ...]:
    """Começo do pedido dos `claude -p` do próprio Hangar (Perguntar, refino do loop, resumo do
    bastão). Os gravados antes do --no-session-persistence apareciam como conversa do usuário."""
    from app import bastao, loop
    return tuple(p[:60] for p in (_ASK_SYSTEM, loop._REFINE_SYSTEM, bastao._REESCRITA_PEDIDO))


def _interno(path: str, prefixos: tuple[str, ...]) -> bool:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for _, raw in zip(range(30), fh):
                for ev in _mensagens(raw):
                    if ev.kind == "user_msg":
                        return (ev.text or "").lstrip().startswith(prefixos)
    except OSError:
        return False
    return False


def search(q: str, live_names: dict[str, str], limit: int = _MAX_HITS) -> list[SearchHit]:
    """Mensagens de todas as contas que contêm TODAS as palavras de `q`, em qualquer ordem, sem
    diferenciar maiúscula. Conversas mais recentes primeiro.

    `live_names`: realpath(jsonl) -> nome tmux das sessoes VIVAS (o mesmo join que o archive faz com
    registry.list()); marca `live` e carrega `session_name` pra a UI abrir o chat (viva) ou o arquivo
    (morta). `q` blank/so-espaco -> [].
    """
    t = termos(q)
    if not t:
        return []
    bases = [str(base) for _, _, base in _contas() if base.is_dir()]
    if not bases:
        return []
    # LISTA de argumentos (sem shell). -F: termo literal. -e: vai como VALOR da flag (mesmo
    # comecando com '-' nao vira flag). --no-ignore: nao pular transcript por um .gitignore/ignore.
    # O rg filtra pelo termo mais longo (o mais raro, em geral); os outros conferem na mensagem.
    # --sortr=modified: o teto global corta a varredura, e o que sobra tem de ser o mais recente.
    # Modo texto com -M, não --json: o --json ignora o -M e despejava centenas de MB de contexto
    # injetado e saída de ferramenta só pra serem descartados aqui. --null separa o caminho.
    argv = [
        _rg(), "-F", "-i", "-M", str(_MAX_COLUNAS), "--null", "--no-heading", "--with-filename",
        "--no-line-number", "--color", "never", "--no-messages", "--no-ignore", "--sortr=modified",
        "-m", str(_MAX_LINHAS_POR_ARQUIVO),
        "--max-filesize", _MAX_FILESIZE,
        "-g", "*.jsonl", "-g", "!**/subagents/**",
        "-e", max(t, key=len), "--", *bases,
    ]
    try:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                                encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return []
    hits: list[SearchHit] = []
    cwd_cache: dict[str, Optional[str]] = {}  # realpath -> cwd real (1 leitura de cabecalho/arquivo)
    por_arquivo: dict[str, int] = {}
    internos: dict[str, bool] = {}
    prefixos = _prefixos_internos()
    try:
        for saida in (proc.stdout or []):
            if len(hits) >= limit:
                break   # teto global: para de ler (a leitura por streaming nao bufferiza o mundo)
            path, sep, line = saida.partition("\0")
            if not sep or por_arquivo.get(path, 0) >= _MAX_PER_FILE:
                continue
            casadas = [ev for ev in _mensagens(line) if all(x in (ev.text or "").lower() for x in t)]
            if not casadas:
                continue
            if path not in internos:
                internos[path] = _interno(path, prefixos)
            if internos[path]:
                continue
            p = Path(path)
            real = os.path.realpath(path)
            if real not in cwd_cache:
                # cwd: 1o do proprio JSON casado (barato); senao cabecalho do arquivo (reuso do archive).
                cwd: Optional[str] = None
                try:
                    j = json.loads(line)
                    if isinstance(j, dict):
                        c = j.get("cwd")
                        cwd = c if isinstance(c, str) and c else None
                except (ValueError, TypeError):
                    cwd = None
                if not cwd:
                    _, cwd = _head_info(p)
                cwd_cache[real] = cwd
            name = live_names.get(real)
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                mtime = 0.0
            for ev in casadas[:_MAX_PER_FILE - por_arquivo.get(path, 0)]:
                hits.append(SearchHit(
                    project=p.parent.name, session_id=p.stem, session_name=name,
                    cwd=cwd_cache[real], line=_snippet(ev.text or "", t), mtime=mtime, live=name is not None,
                    role="user" if ev.kind == "user_msg" else "assistant", event_id=ev.id, ts=ev.ts,
                ))
                por_arquivo[path] = por_arquivo.get(path, 0) + 1
    finally:
        if proc.stdout:
            proc.stdout.close()
        proc.terminate()   # bateu o teto -> mata o rg (nao deixa varrendo o resto em vao)
        proc.wait()
    hits.sort(key=lambda h: h.mtime, reverse=True)
    return hits


# Stopwords pt/en (busca lexical "onde falei sobre X" — RAG). Curta de proposito: so o ruido comum
# que degradaria o OR de termos; palavra de conteudo fica.
_ASK_STOPWORDS = {
    # pt
    "que", "qual", "quais", "quando", "onde", "como", "por", "porque", "para", "pra", "com", "sem",
    "dos", "das", "uma", "uns", "umas", "meu", "minha", "seu", "sua", "nos", "nas", "isso", "isto",
    "aquilo", "sobre", "falei", "falamos", "conversa", "conversamos", "disse", "mencionei", "assunto",
    "ele", "ela", "eles", "elas", "voce", "vc", "eu", "tem", "ter", "foi", "era", "sao", "num", "numa",
    # en
    "the", "and", "for", "with", "was", "were", "did", "does", "what", "when", "where", "which", "who",
    "about", "said", "told", "talked", "spoke", "mentioned", "this", "that", "these", "those", "you",
    "have", "has", "had", "are", "our", "their",
}


def extract_terms(question: str, max_terms: int = 6) -> list[str]:
    """Termos da pergunta pra busca lexical: minusculiza, tira stopwords pt/en e palavras <3 chars,
    dedup preservando ordem, no maximo `max_terms`."""
    out: list[str] = []
    seen: set[str] = set()
    for w in re.findall(r"\w+", (question or "").lower(), re.UNICODE):
        if len(w) < 3 or w in _ASK_STOPWORDS or w in seen:
            continue
        seen.add(w)
        out.append(w)
        if len(out) >= max_terms:
            break
    return out


_ASK_SYSTEM = (
    "Você responde onde um assunto apareceu nas conversas do usuário, a partir de TRECHOS de "
    "transcripts. Responda curto em pt-BR: diga em QUAL(is) sessão(ões) o assunto apareceu e o "
    "contexto, citando os NOMES EXATOS das sessões como aparecem nos rótulos. Se os trechos não "
    "responderem à pergunta, diga que não encontrou. Sem preâmbulo, sem markdown."
)


def build_ask_prompt(question: str, hits: list[SearchHit]) -> str:
    """Prompt do ask-history: pergunta + trechos rotulados '[sessão NOME — viva|arquivada]: trecho'."""
    lines = [_ASK_SYSTEM, "", f"PERGUNTA: {question}", "", "Trechos das conversas:"]
    for h in hits:
        name = h.session_name or h.project or h.session_id[:8]
        estado = "viva" if h.live else "arquivada"
        lines.append(f"[sessão {name} — {estado}]: {h.line}")
    return "\n".join(lines)


def search_terms(terms: list[str], live_names: dict[str, str], cap: int = 30) -> list[SearchHit]:
    """Busca OR: roda `search` por termo, dedup por (session_id, trecho), ordena por mtime desc, cap.
    Cada termo ja e capado em `search`; o cap global segura o custo do prompt do ask-history."""
    seen: set[tuple[str, str]] = set()
    out: list[SearchHit] = []
    for t in terms:
        for h in search(t, live_names, limit=cap):
            key = (h.session_id, h.line)
            if key in seen:
                continue
            seen.add(key)
            out.append(h)
    out.sort(key=lambda h: h.mtime, reverse=True)
    return out[:cap]
