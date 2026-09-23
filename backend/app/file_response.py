"""Arquivos ativos não podem executar na origem autenticada do Hangar."""
import base64
import html
import mimetypes
from pathlib import Path

from fastapi.responses import FileResponse, StreamingResponse


def file_response(path: str | Path, *, headers: dict[str, str] | None = None):
    path = Path(path)
    media = mimetypes.guess_type(path)[0] or "application/octet-stream"
    headers = {
        **(headers or {}),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
    }
    if media in ("text/html", "application/xhtml+xml"):
        def document():
            # Blocos múltiplos de três permitem concatenar base64 sem padding intermediário.
            with path.open("rb") as source:
                title = html.escape(path.name, quote=True)
                yield (
                    '<!doctype html><html><head><meta charset="utf-8">'
                    '<meta name="viewport" content="width=device-width, initial-scale=1">'
                    f'<title>{title}</title><style>html,body{{margin:0;height:100%;overflow:hidden}}'
                    'iframe{display:block;width:100%;height:100%;border:0}</style></head><body>'
                    f'<iframe title="{title}" sandbox="allow-scripts allow-popups" '
                    'referrerpolicy="no-referrer" '
                    f'src="data:{media};charset=utf-8;base64,'
                ).encode()
                while chunk := source.read(48 * 1024):
                    yield base64.b64encode(chunk)
                yield b'"></iframe></body></html>'

        return StreamingResponse(document(), media_type="text/html", headers=headers)
    if media in ("image/svg+xml", "application/xml", "text/xml"):
        # Como imagem continua igual; aberto como documento, não ganha acesso ao token da URL.
        headers["Content-Security-Policy"] = "sandbox; script-src 'none'"
    return FileResponse(path, media_type=media, headers=headers)
