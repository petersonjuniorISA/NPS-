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

A chave está em Claude Desktop > Configurações > Extensões > Metabase, ou se
cria em Metabase > Configurações > Autenticação > Chaves de API.

Como a consulta é feita
-----------------------
Monta a própria pergunta em MBQL e manda pro POST /api/dataset/csv, em vez de
exportar um card salvo. Isso importa por dois motivos:

- O card 380 ("Ocorrências Finalizadas") só devolve o que já foi encerrado.
  Aqui vêm todos os status, então o painel consegue separar em aberto de
  finalizado.
- O card traz a coluna Description inteira, o que fazia o CSV passar de 16 MB.
  Pedindo só as cinco colunas necessárias, cai para uma fração disso.

Os IDs de campo abaixo são da coleção `tickets` (tabela 184 do banco 6,
"Tickets", MongoDB). Foram conferidos contra o card 713, que é o número
oficial de ocorrências da Comunidade: agosto/2026 fecha em 197 finalizadas
nos dois caminhos.
"""

import json
import os
import subprocess
import sys
import tempfile

import urllib.error
import urllib.parse
import urllib.request

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

METABASE_URL = os.environ.get("METABASE_URL", "https://report.isalab.com.br")
ARQUIVO_CHAVE = os.path.join(os.path.expanduser("~"), ".nps-isas", "metabase.key")

BANCO_TICKETS = 6
TABELA_TICKETS = 184
CAMPOS = {
    "departamento": 1737,   # department.description
    "tipo": 1753,           # type.description
    "status": 1751,         # status.description
    "aberto_em": 1734,      # createdAt
    "fechado_em": 1725,     # updatedAt
}


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
        # o .Trim() e obrigatorio: Set-Content deixa uma quebra de linha no fim
        # e o ConvertTo-SecureString rejeita o blob com ela
        "$s = (Get-Content -Raw '%s').Trim() | ConvertTo-SecureString;"
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


def consulta_mbql():
    campo = lambda nome: ["field", CAMPOS[nome], None]
    return {
        "database": BANCO_TICKETS,
        "type": "query",
        "query": {
            "source-table": TABELA_TICKETS,
            "fields": [campo(n) for n in ("departamento", "tipo", "status",
                                          "aberto_em", "fechado_em")],
            # so a Comunidade interessa; o resto do ticket system e de outras areas
            "filter": ["starts-with", campo("departamento"), "Comunidade"],
        },
    }


def baixar_csv(chave, destino):
    url = "%s/api/dataset/csv" % METABASE_URL.rstrip("/")
    corpo = ("query=" + urllib.parse.quote(json.dumps(consulta_mbql()))).encode()
    req = urllib.request.Request(url, data=corpo, method="POST")
    req.add_header("x-api-key", chave)
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req, timeout=600) as resposta:
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
            "  1) Pegue a chave em Claude Desktop > Configurações > Extensões > Metabase\n"
            "  2) Rode: powershell -File scripts\\salvar_chave_metabase.ps1"
        )
        return 0  # não derruba a atualização semanal do NPS por causa disso

    temporario = os.path.join(tempfile.gettempdir(), "ocorrencias_metabase.csv")
    try:
        tamanho = baixar_csv(chave, temporario)
    except urllib.error.HTTPError as e:
        motivo = "chave inválida ou sem permissão" if e.code in (401, 403) else e.reason
        print("ERRO: Metabase respondeu %s — %s" % (e.code, motivo))
        return 1
    except urllib.error.URLError as e:
        print("ERRO: não consegui falar com o Metabase — %s" % e.reason)
        return 1

    print("CSV baixado: %.2f MB" % (tamanho / 1048576.0))
    return subprocess.call([sys.executable,
                            os.path.join(RAIZ, "scripts", "build_ocorrencias.py"),
                            temporario])


if __name__ == "__main__":
    sys.exit(main())
