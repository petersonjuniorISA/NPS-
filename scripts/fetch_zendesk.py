# -*- coding: utf-8 -*-
"""Puxa os tickets do Zendesk e monta data/zendesk_tickets.json.

Por que a API e nao o Metabase
------------------------------
O Metabase da ISA nao tem o Zendesk: la so estao os tickets da Comunidade
(banco "Tickets", operacao de cuidado). O suporte vive no Zendesk, e a unica
porta para ele e a API REST.

    py scripts/fetch_zendesk.py                # coleta e grava o JSON
    py scripts/fetch_zendesk.py --diagnostico  # so mostra canais e tags

O `--diagnostico` existe porque a divisao humano x IA nao esta escrita em
lugar nenhum do ticket: ela e deduzida de tags e canal. Antes de confiar no
numero, rode o diagnostico e confira em data/classificacao_zendesk.json se as
tags listadas sao mesmo as que a conta usa.

Credenciais
-----------
    ZENDESK_SUBDOMINIO   ex.: isasaude          (de isasaude.zendesk.com)
    ZENDESK_EMAIL        e-mail do usuario da API
    ZENDESK_TOKEN        token de API

Podem vir do ambiente ou do cofre DPAPI, gravado por
scripts/salvar_chave_zendesk.ps1 — o mesmo esquema da chave do Metabase.
"""
import argparse
import base64
import collections
import io
import json
import os
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
SAIDA = os.path.join(RAIZ, "data", "zendesk_tickets.json")
CLASSES = os.path.join(RAIZ, "data", "classificacao_zendesk.json")
COFRE = os.path.join(os.path.expanduser("~"), ".nps-isas", "zendesk.json")

# quanto de historico puxar na primeira vez
DESDE = os.environ.get("ZENDESK_DESDE", "2026-01-01")
PAGINA_MAX = 1000            # limite do proprio endpoint incremental
ESPERA_LIMITE = 60           # segundos a esperar quando a API pede calma

MESES_PT = {1: "Janeiro", 2: "Fevereiro", 3: "Março", 4: "Abril", 5: "Maio",
            6: "Junho", 7: "Julho", 8: "Agosto", 9: "Setembro", 10: "Outubro",
            11: "Novembro", 12: "Dezembro"}


# --------------------------------------------------------------- credencial ---
def do_cofre():
    """Le o arquivo cifrado com DPAPI, igual ao da chave do Metabase.

    DPAPI amarra o segredo ao usuario do Windows: o arquivo e inutil em outra
    conta ou outra maquina.
    """
    if os.name != "nt" or not os.path.exists(COFRE):
        return {}
    ps = (
        "$ErrorActionPreference='Stop';"
        # o .Trim() e obrigatorio: Set-Content deixa uma quebra de linha no fim
        # e o ConvertTo-SecureString rejeita o blob com ela
        "$s = (Get-Content -Raw '%s').Trim() | ConvertTo-SecureString;"
        "[Runtime.InteropServices.Marshal]::PtrToStringAuto("
        "[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"
    ) % COFRE.replace("'", "''")
    try:
        saida = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return {}
    bruto = (saida.stdout or "").strip()
    if not bruto:
        return {}
    try:
        return json.loads(bruto)
    except ValueError:
        return {}


def credenciais():
    guardado = do_cofre()
    dados = {
        # o subdominio da ISA e conhecido; fica como padrao para sobrar so
        # e-mail e token a preencher
        "subdominio": (os.environ.get("ZENDESK_SUBDOMINIO")
                       or guardado.get("subdominio") or "isasaude"),
        "email": os.environ.get("ZENDESK_EMAIL") or guardado.get("email"),
        "token": os.environ.get("ZENDESK_TOKEN") or guardado.get("token"),
    }
    faltando = [k for k, v in dados.items() if not v]
    return dados, faltando


# ---------------------------------------------------------------------- API ---
class SemPermissao(Exception):
    """O endereco existe, mas esta conta nao alcanca — tipicamente falta de
    papel de admin."""


def chamar(url, cred):
    """GET autenticado, respeitando o 429 do Zendesk em vez de desistir."""
    par = "%s/token:%s" % (cred["email"], cred["token"])
    cabecalho = "Basic " + base64.b64encode(par.encode()).decode()
    for tentativa in range(4):
        req = urllib.request.Request(url)
        req.add_header("Authorization", cabecalho)
        req.add_header("Accept", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 and tentativa < 3:
                espera = int(e.headers.get("Retry-After") or ESPERA_LIMITE)
                print("   limite da API; esperando %ds" % espera)
                time.sleep(min(espera, ESPERA_LIMITE))
                continue
            if e.code == 401:
                raise SystemExit(
                    "ERRO: o Zendesk recusou a credencial (401). Confira o e-mail e o "
                    "token — e se o acesso por token esta ligado na conta.")
            if e.code == 403:
                # quem chamou decide o que fazer: na exportacao incremental isso
                # e falta de papel de admin, e ha um caminho alternativo
                raise SemPermissao(url)
            raise SystemExit("ERRO: Zendesk respondeu %s em %s" % (e.code, url))
        except urllib.error.URLError as e:
            raise SystemExit("ERRO: nao consegui falar com o Zendesk — %s" % e.reason)
    raise SystemExit("ERRO: o Zendesk seguiu limitando as chamadas.")


def quem_sou(cred):
    """Pergunta ao Zendesk qual e o papel desta credencial.

    Vale o request extra: o erro mais provavel aqui e de permissao, e saber o
    papel de antemao troca um 403 seco por uma frase que diz o que pedir."""
    try:
        u = (chamar("https://%s.zendesk.com/api/v2/users/me.json" % cred["subdominio"],
                    cred) or {}).get("user") or {}
    except (SemPermissao, SystemExit):
        return None
    return {"nome": u.get("name"), "papel": u.get("role"),
            "admin": bool(u.get("role") == "admin")}


def baixar_tickets(cred, desde):
    """Tenta o caminho bom; se a conta nao for admin, usa o caminho possivel.

    A exportacao incremental e restrita a administradores. Numa conta de
    agente ela responde 403, e ai vale a listagem comum ordenada da mais nova
    para a mais antiga, parando quando passa da data pedida — mesmos campos,
    mesmo sideload de metricas, so que paginando mais.
    """
    try:
        return exportacao_incremental(cred, desde)
    except SemPermissao:
        print("   sem permissao de admin para a exportacao incremental;")
        print("   usando a listagem comum de tickets (funciona com conta de agente)")
        return listagem_comum(cred, desde)


def listagem_comum(cred, desde):
    """Lista tickets do mais novo para o mais antigo e para na data de corte."""
    corte = datetime.strptime(desde, "%Y-%m-%d")
    url = ("https://%s.zendesk.com/api/v2/tickets.json"
           "?page[size]=100&sort_by=created_at&sort_order=desc"
           "&include=metric_sets" % cred["subdominio"])
    tickets, metricas, paginas = [], {}, 0
    while url:
        pagina = chamar(url, cred)
        for m in (pagina.get("metric_sets") or []):
            if m.get("ticket_id") is not None:
                metricas[m["ticket_id"]] = m
        passou_do_corte = False
        for t in (pagina.get("tickets") or []):
            abriu = momento(t.get("created_at"))
            if abriu and abriu < corte:
                passou_do_corte = True
                continue
            tickets.append(t)
        paginas += 1
        print("   pagina %d — %d tickets dentro do periodo" % (paginas, len(tickets)))
        if passou_do_corte:
            break
        proxima = (pagina.get("links") or {}).get("next")
        tem_mais = (pagina.get("meta") or {}).get("has_more")
        url = proxima if (proxima and tem_mais) else None
    return tickets, metricas


def exportacao_incremental(cred, desde):
    """O caminho bom: devolve tudo sem o teto de 1000 resultados da busca."""
    inicio = int(datetime.strptime(desde, "%Y-%m-%d")
                 .replace(tzinfo=timezone.utc).timestamp())
    url = ("https://%s.zendesk.com/api/v2/incremental/tickets.json"
           "?start_time=%d&include=metric_sets" % (cred["subdominio"], inicio))
    tickets, metricas, paginas = [], {}, 0
    while url:
        pagina = chamar(url, cred)
        tickets.extend(pagina.get("tickets") or [])
        for m in (pagina.get("metric_sets") or []):
            if m.get("ticket_id") is not None:
                metricas[m["ticket_id"]] = m
        paginas += 1
        print("   pagina %d — %d tickets acumulados" % (paginas, len(tickets)))
        if pagina.get("end_of_stream") or not pagina.get("next_page"):
            break
        url = pagina["next_page"]
    return tickets, metricas


# ------------------------------------------------------------ classificacao ---
def carregar_classes():
    with io.open(CLASSES, encoding="utf-8") as f:
        return json.load(f)


def e_da_ia(ticket, cfg):
    regra = cfg.get("ia") or {}
    tags = {str(t).lower() for t in (ticket.get("tags") or [])}
    if tags & {str(t).lower() for t in regra.get("tags", [])}:
        return True
    canal = ((ticket.get("via") or {}).get("channel") or "").lower()
    if canal in {str(c).lower() for c in regra.get("canais", [])}:
        return True
    if regra.get("sem_responsavel_conta_como_ia") and not ticket.get("assignee_id"):
        return True
    return False


def assunto_de(ticket, cfg):
    """A primeira tag que nao esteja na lista de ignoradas.

    Zendesk nao tem campo de assunto padronizado — o que a operacao usa e tag.
    """
    regra = cfg.get("assunto") or {}
    ignorar = {str(t).lower() for t in regra.get("ignorar", [])}
    prefixo = regra.get("prefixo")
    for t in (ticket.get("tags") or []):
        baixa = str(t).lower()
        if baixa in ignorar:
            continue
        if prefixo:
            if baixa.startswith(prefixo.lower()):
                return t[len(prefixo):] or t
            continue
        return t
    return "Sem tag"


def caixa_de_status(ticket, cfg):
    regra = cfg.get("status") or {}
    st = (ticket.get("status") or "").lower()
    if st in {s.lower() for s in regra.get("finalizado", [])}:
        return "finalizadas"
    if st in {s.lower() for s in regra.get("cancelado", [])}:
        return "canceladas"
    return "em_aberto"


# ----------------------------------------------------------------- agregacao ---
def momento(txt):
    if not txt:
        return None
    try:
        return datetime.strptime(str(txt)[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None


def resumo(itens):
    """As mesmas contas de ocorrencias.json, para o painel ler os dois igual.

    Mediana ao lado da media de proposito: um ticket parado 18 dias puxa a
    media e some na mediana.
    """
    horas = sorted(i["horas"] for i in itens
                   if i["caixa"] == "finalizadas" and i["horas"] is not None)
    dados = {
        "total": len(itens),
        "finalizadas": sum(1 for i in itens if i["caixa"] == "finalizadas"),
        "em_aberto": sum(1 for i in itens if i["caixa"] == "em_aberto"),
        "canceladas": sum(1 for i in itens if i["caixa"] == "canceladas"),
        "humano": sum(1 for i in itens if not i["ia"]),
        "ia": sum(1 for i in itens if i["ia"]),
    }
    if horas:
        dados["sla_medio_h"] = round(statistics.mean(horas), 1)
        dados["sla_mediano_h"] = round(statistics.median(horas), 1)
        dados["sla_medio_dias"] = round(statistics.mean(horas) / 24, 1)
        dados["sla_mediano_dias"] = round(statistics.median(horas) / 24, 1)
        dados["sla_max_h"] = round(horas[-1], 1)
    primeiras = sorted(i["primeira_resposta_min"] for i in itens
                       if i["primeira_resposta_min"] is not None)
    if primeiras:
        dados["tma_min"] = round(statistics.median(primeiras), 1)
    return dados


def por_chave(itens, chave, limite=None):
    saida = {}
    for i in itens:
        saida.setdefault(i[chave], []).append(i)
    ordenado = sorted(saida.items(), key=lambda x: -len(x[1]))
    if limite:
        ordenado = ordenado[:limite]
    return {k: resumo(v) for k, v in ordenado}


def montar(tickets, metricas, cfg):
    itens = []
    for t in tickets:
        abriu = momento(t.get("created_at"))
        if not abriu:
            continue
        caixa = caixa_de_status(t, cfg)
        # so o finalizado tem tempo de resolucao; no aberto o updated_at e
        # apenas a ultima mexida no ticket
        m = metricas.get(t.get("id")) or {}
        cheia = (m.get("full_resolution_time_in_minutes") or {}).get("calendar")
        horas = None
        if caixa == "finalizadas":
            if cheia is not None:
                horas = float(cheia) / 60.0
            else:
                fechou = momento(t.get("updated_at"))
                if fechou and fechou >= abriu:
                    horas = (fechou - abriu).total_seconds() / 3600.0
        itens.append({
            "mes": abriu.strftime("%Y-%m"),
            "inicio_semana": (abriu - timedelta(days=abriu.weekday())).strftime("%Y-%m-%d"),
            "caixa": caixa,
            "ia": e_da_ia(t, cfg),
            "assunto": assunto_de(t, cfg),
            "horas": horas,
            "primeira_resposta_min": (m.get("reply_time_in_minutes") or {}).get("calendar"),
        })

    meses = {}
    for i in itens:
        meses.setdefault(i["mes"], []).append(i)

    saida = {}
    for mes, doMes in sorted(meses.items()):
        semanas = {}
        for i in doMes:
            semanas.setdefault(i["inicio_semana"], []).append(i)
        saida[mes] = dict(
            resumo(doMes),
            label=MESES_PT[int(mes[5:7])],
            por_assunto=por_chave(doMes, "assunto", 12),
            semanas=[dict(resumo(v), inicio=k,
                          label=datetime.strptime(k, "%Y-%m-%d").strftime("%d/%m"))
                     for k, v in sorted(semanas.items())],
        )
    return itens, saida


# --------------------------------------------------------------- diagnostico ---
def diagnostico(tickets, cfg):
    """Mostra o que a conta realmente usa, para a classificacao ser conferida
    contra a realidade em vez de contra uma suposicao minha."""
    canais = collections.Counter()
    tags = collections.Counter()
    status = collections.Counter()
    sem_dono = 0
    for t in tickets:
        canais[((t.get("via") or {}).get("channel") or "—")] += 1
        status[t.get("status") or "—"] += 1
        if not t.get("assignee_id"):
            sem_dono += 1
        for x in (t.get("tags") or []):
            tags[x] += 1

    print()
    print("=== %d tickets desde %s ===" % (len(tickets), DESDE))
    print()
    print("canais (via.channel):")
    for k, n in canais.most_common(15):
        print("   %6d  %s" % (n, k))
    print()
    print("status:")
    for k, n in status.most_common():
        print("   %6d  %s" % (n, k))
    print()
    print("   %6d  sem responsavel (assignee_id vazio)" % sem_dono)
    print()
    print("tags mais frequentes:")
    for k, n in tags.most_common(30):
        print("   %6d  %s" % (n, k))

    marcadas = sum(1 for t in tickets if e_da_ia(t, cfg))
    print()
    print("=== com a classificacao atual ===")
    print("   %d de %d (%.1f%%) contam como IA"
          % (marcadas, len(tickets), 100.0 * marcadas / max(1, len(tickets))))
    print()
    print("Se esse percentual nao bate com o que a operacao sabe, ajuste as")
    print("tags e canais em data/classificacao_zendesk.json e rode de novo.")


# --------------------------------------------------------------------- main ---
def main():
    p = argparse.ArgumentParser(description="Coleta os tickets do Zendesk.")
    p.add_argument("--diagnostico", action="store_true",
                   help="so mostra canais, status e tags; nao grava nada")
    p.add_argument("--desde", default=DESDE, help="data inicial (AAAA-MM-DD)")
    args = p.parse_args()

    cred, faltando = credenciais()
    if faltando:
        print("AVISO: sem credencial do Zendesk (%s) — data/zendesk_tickets.json "
              "fica como está." % ", ".join(faltando))
        print("  1) Pegue um token de API em Zendesk > Admin > Apps e integrações > API")
        print("  2) Rode: powershell -File scripts\\salvar_chave_zendesk.ps1")
        return 0   # nao derruba a atualizacao semanal por causa disso

    cfg = carregar_classes()
    eu = quem_sou(cred)
    if eu:
        print("Conectado como %s (%s)" % (eu["nome"], eu["papel"]))
    print("Baixando tickets de %s.zendesk.com desde %s..." % (cred["subdominio"], args.desde))
    try:
        tickets, metricas = baixar_tickets(cred, args.desde)
    except SemPermissao:
        print()
        print("ERRO: esta conta nao tem permissao para ler os tickets pela API.")
        if eu and not eu["admin"]:
            print("      O papel dela e '%s'; a leitura em massa pede admin." % eu["papel"])
        print()
        print("      Peca a quem administra o Zendesk:")
        print("      1. Admin Center > Apps e integracoes > APIs > Zendesk API")
        print("         ligar 'Acesso por token' e gerar um token.")
        print("      2. Que o token seja usado com o e-mail de uma conta admin —")
        print("         com conta de agente a API nao devolve a base inteira.")
        return 1

    if args.diagnostico:
        diagnostico(tickets, cfg)
        return 0

    itens, meses = montar(tickets, metricas, cfg)
    payload = {
        "gerado_em": datetime.now(timezone.utc).isoformat(),
        "fonte": "Zendesk · API incremental de tickets (%s.zendesk.com)" % cred["subdominio"],
        "desde": args.desde,
        "classificacao": {
            "fonte": "data/classificacao_zendesk.json",
            "por_que_existe": cfg.get("por_que_existe"),
            "revisado_em": cfg.get("revisado_em"),
            "ia": {"tags": (cfg.get("ia") or {}).get("tags", []),
                   "canais": (cfg.get("ia") or {}).get("canais", [])},
        },
        "observacao": ("Humano x IA é deduzido de tags e canal — o ticket não tem "
                       "esse campo. O SLA é calculado só sobre os finalizados."),
        "meses": meses,
    }
    with io.open(SAIDA, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    ia = sum(1 for i in itens if i["ia"])
    print("OK: %d tickets em %d meses (%d IA, %d humano) -> %s"
          % (len(itens), len(meses), ia, len(itens) - ia, SAIDA))
    print("   confira a divisão humano x IA com: py scripts/fetch_zendesk.py --diagnostico")
    return 0


if __name__ == "__main__":
    sys.exit(main())
