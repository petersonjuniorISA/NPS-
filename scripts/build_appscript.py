# -*- coding: utf-8 -*-
r"""Empacota o painel num Web App do Google Apps Script.

    py scripts\build_appscript.py

Gera em dist/appscript/ os arquivos para colar num projeto do Apps Script:

    Codigo.gs      -> o doGet() que serve a pagina
    painel.html    -> o painel inteiro (HTML + CSS + JS + dados)

Por que tudo num arquivo so
---------------------------
O HtmlService do Apps Script nao serve arquivos: nao existe /data/nps.json
para o painel buscar. Entao CSS, JS e os cinco arquivos de dados sao
embutidos na propria pagina. O app.js ja sabe lidar com isso — quando existe
window.DADOS ele usa dali, senao cai no fetch (que e como funciona num
servidor comum).

Os JSON vao compactados (sem indentacao), o que corta quase metade do peso.

Limites que valem saber
-----------------------
O Apps Script guarda cada arquivo do projeto como texto. O painel com dados
fica na casa das centenas de KB, bem dentro do que ele aguenta. Se um dia o
ocorrencias.json crescer muito, o caminho e parar de embutir e ler de uma
planilha pelo google.script.run.
"""

import io
import json
import os
import re
import shutil

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAIDA = os.path.join(RAIZ, "dist", "appscript")

# nome que o painel usa em window.DADOS -> arquivo de origem
DADOS = {
    "nps": "data/nps.json",
    "metas": "data/metas.json",
    "ocorrencias": "data/ocorrencias.json",
    "zendesk": "data/zendesk_semanal.csv",
    "onboarding": "data/onboarding.json",
    "comentarios": "data/comentarios.json",
}


def ler(caminho):
    with io.open(os.path.join(RAIZ, caminho), encoding="utf-8") as f:
        return f.read()


def compacta_json(texto):
    return json.dumps(json.loads(texto), ensure_ascii=False, separators=(",", ":"))


def montar_dados():
    """Monta o objeto window.DADOS. JSON vira objeto; CSV vira string."""
    partes = []
    for nome, arquivo in DADOS.items():
        bruto = ler(arquivo)
        valor = compacta_json(bruto) if arquivo.endswith(".json") else json.dumps(bruto, ensure_ascii=False)
        partes.append('"%s":%s' % (nome, valor))
    return "{" + ",".join(partes) + "}"


def montar_pagina():
    html = ler("index.html")
    css = ler("css/styles.css")
    config = ler("js/config.js")
    app = ler("js/app.js")
    logo = ler("assets/logo.svg")

    # 1. CSS embutido no lugar do <link>.
    # lambda em vez de string: uma barra invertida no conteudo seria lida como
    # escape do template do re.sub e quebraria a substituicao
    bloco_css = "<style>\n" + css + "\n</style>"
    html = re.sub(r'<link rel="stylesheet" href="css/styles\.css[^"]*">',
                  lambda m: bloco_css, html)

    # 2. o logo vira data URI: nao ha assets/ para servir
    import base64
    logo_uri = "data:image/svg+xml;base64," + base64.b64encode(logo.encode("utf-8")).decode("ascii")
    html = html.replace('src="assets/logo.svg"', 'src="%s"' % logo_uri)
    html = re.sub(r'<link rel="icon"[^>]*>', "", html)

    # 3. dados + config + app no lugar das tags <script src=...>
    scripts = (
        "<script>window.DADOS=" + montar_dados() + ";</script>\n"
        "<script>\n" + config + "\n</script>\n"
        "<script>\n" + app + "\n</script>"
    )
    html = re.sub(r'<script src="js/config\.js[^"]*"></script>\s*<script src="js/app\.js[^"]*"></script>',
                  lambda m: scripts, html)
    return html


CODIGO_GS = '''/**
 * Painel de NPS dos ISAs — Web App.
 *
 * Publicar em: Implantar > Nova implantacao > Tipo: App da Web
 *   Executar como   : Eu
 *   Quem tem acesso : Qualquer pessoa em ISA Saude
 *
 * O XFrameOptionsMode.ALLOWALL e o que permite embutir esta pagina no
 * Google Sites. Sem ele o Sites mostra um quadro em branco.
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('painel')
    .setTitle('NPS dos ISAs')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
'''


# O manifesto fixa a restricao de dominio no proprio projeto, em vez de
# depender de escolher certo no menu de implantacao.
#   access "DOMAIN"          -> so quem tem conta @isasaude.com abre
#   executeAs "USER_DEPLOYING" -> roda como quem publicou
APPSSCRIPT_JSON = """{
  "timeZone": "America/Sao_Paulo",
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "webapp": {
    "access": "DOMAIN",
    "executeAs": "USER_DEPLOYING"
  }
}
"""


def main():
    # o LEIA-ME e escrito a mao e nao deve ser perdido no rebuild
    leia_me = os.path.join(SAIDA, "LEIA-ME.md")
    guardado = ler("dist/appscript/LEIA-ME.md") if os.path.exists(leia_me) else None
    if os.path.isdir(SAIDA):
        shutil.rmtree(SAIDA)
    os.makedirs(SAIDA)
    if guardado:
        with io.open(leia_me, "w", encoding="utf-8") as f:
            f.write(guardado)

    pagina = montar_pagina()
    with io.open(os.path.join(SAIDA, "painel.html"), "w", encoding="utf-8") as f:
        f.write(pagina)
    with io.open(os.path.join(SAIDA, "Codigo.gs"), "w", encoding="utf-8") as f:
        f.write(CODIGO_GS)
    # o clasp empurra .js como .gs; o .gs acima e para colar a mao
    with io.open(os.path.join(SAIDA, "Codigo.js"), "w", encoding="utf-8") as f:
        f.write(CODIGO_GS)
    with io.open(os.path.join(SAIDA, "appsscript.json"), "w", encoding="utf-8") as f:
        f.write(APPSSCRIPT_JSON)

    kb = len(pagina.encode("utf-8")) / 1024.0
    print("OK: dist/appscript/painel.html  (%.0f KB)" % kb)
    print("    dist/appscript/Codigo.gs  (colar a mao)")
    print("    dist/appscript/Codigo.js + appsscript.json  (usados pelo clasp)")

    # conferencias que evitam um deploy quebrado
    problemas = []
    for marca in ("js/app.js", "js/config.js", "css/styles.css", "assets/logo.svg"):
        if marca in pagina:
            problemas.append("ainda referencia " + marca)
    if "window.DADOS" not in pagina:
        problemas.append("os dados nao foram embutidos")
    if problemas:
        print("\nATENCAO:")
        for p in problemas:
            print("  - " + p)
        return 1
    print("\nNenhuma referencia a arquivo externo sobrou — a pagina se basta.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
