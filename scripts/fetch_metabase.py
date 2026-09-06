# -*- coding: utf-8 -*-
r"""Baixa as ocorrências do Metabase e gera data/ocorrencias.json.

Roda junto com a atualização semanal, logo depois do fetch do Databricks.

Autenticação
------------
Precisa de uma chave de API do Metabase. O script procura, nesta ordem:

1. a variável de ambiente METABASE_API_KEY;
2. o arquivo %USERPROFILE%\.nps-isas\metabase.key, cifrado com DPAPI — só o
   seu usuário do Windows consegue abrir, e nem admin de outra conta lê.

Para gravar a chave cifrada (uma vez só), no PowerShell:

    scripts\salvar_chave_metabase.ps1

A chave se cria em Metabase > Configurações > Autenticação > Chaves de API.
Precisa de perfil de administrador; se você não tiver, peça a alguém que tenha
e guarde a chave só no cofre — ela não deve entrar no repositório.

O que é buscado
---------------
O card 380 ("Ocorrências Finalizadas", coleção SAC) exportado em CSV pelo
endpoint /api/card/<id>/query/csv. O CSV cru é jogado num arquivo temporário e
processado por build_ocorrencias.py, que aplica o recorte da Comunidade sem
Captação e calcula o SLA.
"""

import os
import subprocess
import sys
import tempfile

import urllib.error
import urllib.request

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

METABASE_URL = os.environ.get("METABASE_URL", "https://report.isalab.com.br")
CARD_OCORRENCIAS = int(os.environ.get("METABASE_CARD_OCORRENCIAS", "380"))
ARQUIVO_CHAVE = os.path.join(os.path.expanduser("~"), ".nps-isas", "metabase.key")


def chave_do_cofre():
    """Decifra a chave guardada com DPAPI.

    DPAPI amarra o segredo ao usuário do Windows: o arquivo é inútil em outra
    conta ou outra máquina. Usamos isso em vez do Gerenciador de Credenciais
    porque ler de lá exigiria instalar o módulo CredentialManager, que não vem
    com o Windows.
    """
    if os.name != "nt" or not os.path.exists(ARQUIVO_CHAVE):
        return None
    ps = (
        "$ErrorActionPreference='Stop';"
        "$s = Get-Content -Raw '%s' | ConvertTo-SecureString;"
        "[Runtime.InteropServices.Marshal]::PtrToStringAuto("
        "[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"
    ) % ARQUIVO_CHAVE.replace("'", "''")
    try:
        saida = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    valor = (saida.stdout or "").strip()
    return valor or None


def obter_chave():
    chave = os.environ.get("METABASE_API_KEY")
    if chave:
        return chave.strip()
    return chave_do_cofre()


def baixar_csv(chave, destino):
    url = "%s/api/card/%d/query/csv" % (METABASE_URL.rstrip("/"), CARD_OCORRENCIAS)
    req = urllib.request.Request(url, data=b"", method="POST")
    req.add_header("x-api-key", chave)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=300) as resposta:
        with open(destino, "wb") as f:
            while True:
                pedaco = resposta.read(1 << 20)
                if not pedaco:
                    break
                f.write(pedaco)
    return os.path.getsize(destino)


def main():
    chave = obter_chave()
    if not chave:
        print(
            "AVISO: sem chave de API do Metabase — data/ocorrencias.json fica como está.\n"
            "  1) Crie a chave em Metabase > Configurações > Autenticação > Chaves de API\n"
            "  2) Rode: powershell -File scripts\\salvar_chave_metabase.ps1"
        )
        return 0  # não derruba a atualização semanal do NPS por causa disso

    temporario = os.path.join(tempfile.gettempdir(), "ocorrencias_metabase.csv")
    try:
        tamanho = baixar_csv(chave, temporario)
    except urllib.error.HTTPError as e:
        motivo = "chave inválida ou sem permissão no card" if e.code in (401, 403) else e.reason
        print("ERRO: Metabase respondeu %s — %s" % (e.code, motivo))
        return 1
    except urllib.error.URLError as e:
        print("ERRO: não consegui falar com o Metabase — %s" % e.reason)
        return 1

    print("CSV baixado: %.1f MB" % (tamanho / 1048576.0))
    return subprocess.call([sys.executable, os.path.join(RAIZ, "scripts", "build_ocorrencias.py"), temporario])


if __name__ == "__main__":
    sys.exit(main())
