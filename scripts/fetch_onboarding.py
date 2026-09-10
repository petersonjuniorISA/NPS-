# -*- coding: utf-8 -*-
"""Monta a base semanal de onboarding de ISAs.

Fonte: Metabase. Os eventos de cadastro e de ativacao ficam no Mongo
"Professional History" (colecao professionalevents); o retrato de hoje sai do
Postgres "Professional".

Tudo o que o Mongo devolve ja vem agregado por dia — puxar profissional a
profissional estouraria o limite de linhas da API e nao acrescentaria nada,
porque o painel so mostra semana.
"""
import io
import json
import os
import sys
import urllib.request
from datetime import date, datetime, timedelta

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import fetch_metabase as fm

BANCO_EVENTOS = 17          # Professional History (mongo)
BANCO_CADASTRO = 10         # Professional (postgres)
COLECAO = "professionalevents"
SAIDA = os.path.join(AQUI, "..", "data", "onboarding.json")
DESDE = os.environ.get("ONBOARDING_DESDE", "2026-01-01")

# status que ainda dependem de alguem da operacao para o cadastro andar
STATUS_ASSISTIDO = ("UNDER_REVIEW", "PENDING_REVIEW", "INCOMPLETE")
# uma ativacao leva ~30 dias: a taxa das semanas mais novas ainda vai subir, e
# mostra-las como queda seria mentira. O painel marca essas como parciais.
JANELA_ATIVACAO = int(os.environ.get("ONBOARDING_JANELA", "30"))


def pedir(payload):
    req = urllib.request.Request(fm.METABASE_URL.rstrip("/") + "/api/dataset",
                                 data=json.dumps(payload).encode(), method="POST")
    req.add_header("x-api-key", pedir.chave)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=900) as r:
        resposta = json.loads(r.read().decode("utf-8"))
    if resposta.get("status") != "completed":
        erro = (resposta.get("via") or [{}])[0].get("error") or json.dumps(resposta)[:400]
        raise RuntimeError("Metabase recusou a consulta: %s" % str(erro)[:400])
    colunas = [c["name"] for c in resposta["data"]["cols"]]
    return [dict(zip(colunas, linha)) for linha in resposta["data"]["rows"]]


def mongo(pipeline):
    return pedir({"database": BANCO_EVENTOS, "type": "native",
                  "native": {"collection": COLECAO, "query": json.dumps(pipeline)}})


def sql(consulta):
    return pedir({"database": BANCO_CADASTRO, "type": "native", "native": {"query": consulta}})


# ---------------------------------------------------------------- semanas ---
def segunda(dia):
    """Toda semana do painel comeca na segunda — a mesma regra que o NPS usa."""
    return dia - timedelta(days=dia.weekday())


def dia_de(texto):
    return datetime.strptime(str(texto)[:10], "%Y-%m-%d").date()


def rotulo(inicio):
    fim = inicio + timedelta(days=6)
    return "%d/%d a %d/%d" % (inicio.day, inicio.month, fim.day, fim.month)


# ------------------------------------------------------------- consultas ---
PAR_EVENTOS = [
    {"$match": {"eventType": {"$in": ["professional.created", "professional.activated"]}}},
    {"$group": {"_id": {"p": "$professionalId", "e": "$eventType"},
                "t": {"$min": {"$toDate": "$time"}}}},
    {"$group": {"_id": "$_id.p",
                "criado": {"$min": {"$cond": [{"$eq": ["$_id.e", "professional.created"]}, "$t", None]}},
                "ativado": {"$min": {"$cond": [{"$eq": ["$_id.e", "professional.activated"]}, "$t", None]}}}},
]


def por_dia_de_cadastro():
    """Coorte: de quem se cadastrou no dia X, quantos ja foram ativados."""
    return mongo(PAR_EVENTOS + [
        {"$match": {"criado": {"$ne": None}}},
        {"$project": {"dia": {"$dateToString": {"format": "%Y-%m-%d", "date": "$criado"}},
                      "ativou": {"$cond": [{"$eq": ["$ativado", None]}, 0, 1]}}},
        {"$group": {"_id": "$dia", "cadastros": {"$sum": 1}, "ativados": {"$sum": "$ativou"}}},
        {"$sort": {"_id": 1}},
    ])


def por_dia_de_ativacao():
    """Fluxo: quantos foram ativados no dia X e quanto tempo levaram."""
    return mongo(PAR_EVENTOS + [
        {"$match": {"ativado": {"$ne": None}}},
        {"$project": {
            "dia": {"$dateToString": {"format": "%Y-%m-%d", "date": "$ativado"}},
            "dias": {"$cond": [{"$eq": ["$criado", None]}, None,
                     {"$divide": [{"$subtract": ["$ativado", "$criado"]}, 86400000]}]}}},
        {"$group": {"_id": "$dia", "ativados": {"$sum": 1},
                    "soma_dias": {"$sum": {"$ifNull": ["$dias", 0]}},
                    "com_cadastro": {"$sum": {"$cond": [{"$eq": ["$dias", None]}, 0, 1]}}}},
        {"$sort": {"_id": 1}},
    ])


def coorte_por_semana():
    """Onde esta hoje quem se cadastrou em cada semana.

    Reconstruir o estoque de temporarios pelos eventos nao funciona: a saida do
    status quase nunca passa por `professional.status.changed` (a ativacao tem
    evento proprio), entao o saldo semanal nao fecha. O cadastro atual, por
    outro lado, e um fato — basta agrupar pela semana de entrada.
    """
    return sql(
        "select to_char(date_trunc('week', p.created_at), 'YYYY-MM-DD') as semana, "
        "       count(*) as cadastrados, "
        "       count(*) filter (where p.\"statusId\" = 'ACTIVE_TEMPORARY') as temporarios, "
        "       count(*) filter (where p.\"statusId\" in ('UNDER_REVIEW','PENDING_REVIEW','INCOMPLETE')) as assistido "
        "from professional p "
        "where p.deleted_at is null and p.created_at >= '%s' "
        "group by 1 order by 1" % DESDE)


def retrato_de_hoje():
    linhas = sql("select coalesce(p.\"statusId\", 'SEM_STATUS') as status, count(*) as n "
                 "from professional p where p.deleted_at is null group by 1")
    return {l["status"]: int(l["n"]) for l in linhas}


# ------------------------------------------------------------------ monta ---
def semanas(cadastros, ativacoes, coorte):
    caixas = {}

    def caixa(dia):
        ini = segunda(dia)
        return caixas.setdefault(ini, {"inicio": ini.isoformat(), "label": rotulo(ini),
                                       "cadastros": 0, "ativados_da_coorte": 0,
                                       "ativados": 0, "soma_dias": 0.0, "com_cadastro": 0,
                                       "temporarios": 0, "assistido": 0})

    for l in cadastros:
        c = caixa(dia_de(l["_id"]))
        c["cadastros"] += int(l["cadastros"])
        c["ativados_da_coorte"] += int(l["ativados"])
    for l in ativacoes:
        c = caixa(dia_de(l["_id"]))
        c["ativados"] += int(l["ativados"])
        c["soma_dias"] += float(l["soma_dias"] or 0)
        c["com_cadastro"] += int(l["com_cadastro"])
    for l in coorte:
        c = caixa(dia_de(l["semana"]))
        c["temporarios"] += int(l["temporarios"])
        c["assistido"] += int(l["assistido"])

    corte = segunda(dia_de(DESDE))
    ordenadas = [caixas[k] for k in sorted(caixas) if k >= corte]

    for c in ordenadas:
        c["tempo_medio_ativacao"] = round(c["soma_dias"] / c["com_cadastro"], 1) if c["com_cadastro"] else None
        c["taxa_ativacao"] = round(100.0 * c["ativados_da_coorte"] / c["cadastros"], 1) if c["cadastros"] else None
        idade = (date.today() - dia_de(c["inicio"])).days
        c["coorte_fechada"] = idade >= JANELA_ATIVACAO
        del c["soma_dias"]
    return ordenadas


def main():
    pedir.chave = fm.obter_chave()
    cadastros = por_dia_de_cadastro()
    ativacoes = por_dia_de_ativacao()
    coorte = coorte_por_semana()
    hoje = retrato_de_hoje()

    lista = semanas(cadastros, ativacoes, coorte)
    assistido = sum(hoje.get(s, 0) for s in STATUS_ASSISTIDO)

    payload = {
        "gerado_em": datetime.now().isoformat(timespec="seconds"),
        "fonte": "Metabase - Professional History (professionalevents) e Professional (postgres)",
        "desde": DESDE,
        "janela_ativacao_dias": JANELA_ATIVACAO,
        "hoje": {
            "por_status": hoje,
            "temporarios": hoje.get("ACTIVE_TEMPORARY", 0),
            "em_onboarding_assistido": assistido,
            "detalhe_assistido": {s: hoje.get(s, 0) for s in STATUS_ASSISTIDO},
        },
        "semanas": lista,
    }
    destino = os.path.abspath(SAIDA)
    with io.open(destino, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    print("onboarding: %d semanas desde %s" % (len(lista), DESDE))
    for c in lista[-6:]:
        print("   %s  cadastros %-4s ativados %-4s tempo %-6s taxa %-6s temp %-4s assistido %s"
              % (c["inicio"], c["cadastros"], c["ativados"], c["tempo_medio_ativacao"],
                 c["taxa_ativacao"], c["temporarios"], c["assistido"]))
    print("   hoje: %d temporarios, %d em onboarding assistido %s"
          % (payload["hoje"]["temporarios"], assistido, payload["hoje"]["detalhe_assistido"]))
    print("arquivo: %s (%.1f KB)" % (destino, os.path.getsize(destino) / 1024.0))


if __name__ == "__main__":
    main()
