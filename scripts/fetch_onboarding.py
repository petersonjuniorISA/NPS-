# -*- coding: utf-8 -*-
"""Monta a base semanal de onboarding de ISAs.

Fonte: Metabase. Os eventos de cadastro e de ativacao ficam no Mongo
"Professional History" (colecao professionalevents); o retrato de hoje sai do
Postgres "Professional".

Tudo o que o Mongo devolve ja vem agregado por dia — puxar profissional a
profissional estouraria o limite de linhas da API e nao acrescentaria nada,
porque o painel so mostra semana.
"""
import csv
import io
import json
import os
import sys
import urllib.parse
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

METAS = os.path.join(AQUI, "..", "data", "metas.json")
METAS_PADRAO = {"tempo_ativacao_dias": 2, "taxa_ativacao_pct": 40, "temporarios": 0}


def metas_do_onboarding():
    """As metas moram em data/metas.json, fora de `objetivos` — sao semanais e
    o farol do semestre e mensal."""
    try:
        with io.open(METAS, encoding="utf-8") as f:
            bloco = (json.load(f) or {}).get("onboarding") or {}
    except (IOError, ValueError):
        bloco = {}
    saida = dict(METAS_PADRAO)
    saida.update({k: v for k, v in bloco.items() if k in METAS_PADRAO})
    return saida


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


def csv_de(payload):
    """O /api/dataset devolve no maximo 2000 linhas; o /csv devolve tudo.

    Aqui sao ~8 mil cadastros e ~5 mil ativacoes, entao e por aqui que elas
    passam. Aceita consulta nativa nos dois bancos, Postgres e Mongo."""
    corpo = ("query=" + urllib.parse.quote(json.dumps(payload))).encode()
    req = urllib.request.Request(fm.METABASE_URL.rstrip("/") + "/api/dataset/csv",
                                 data=corpo, method="POST")
    req.add_header("x-api-key", pedir.chave)
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req, timeout=900) as r:
        texto = r.read().decode("utf-8")
    linhas = list(csv.reader(io.StringIO(texto)))
    if not linhas:
        return []
    cabecalho = linhas[0]
    return [dict(zip(cabecalho, l)) for l in linhas[1:]]


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


def cadastros_do_banco():
    """Todo mundo que se cadastrou desde o corte, direto da tabela.

    E aqui que a coorte tem de nascer: o evento professional.created nao cobre
    todos os cadastros (em 09/09, 81 eventos para 118 linhas na tabela), e a
    data de cadastro e o denominador do tempo medio e da taxa de ativacao.
    """
    return csv_de({"database": BANCO_CADASTRO, "type": "native", "native": {"query":
        "select id, to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS') as criado "
        "from professional where deleted_at is null and created_at >= '%s'" % DESDE}})


def ativacoes_por_profissional():
    """Quando cada um ativou. A tabela nao guarda essa data — so o evento."""
    pipeline = [
        {"$match": {"eventType": "professional.activated"}},
        {"$group": {"_id": "$professionalId", "t": {"$min": {"$toDate": "$time"}}}},
    ]
    return csv_de({"database": BANCO_EVENTOS, "type": "native",
                   "native": {"collection": COLECAO, "query": json.dumps(pipeline)}})


def instante(txt):
    """Aceita os dois formatos que chegam: 2026-09-08T10:20:30 e o ISO com Z."""
    if not txt:
        return None
    limpo = str(txt).replace("Z", "").split(".")[0].replace(" ", "T")
    try:
        return datetime.strptime(limpo[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None


def coorte(limite_dias):
    """Cruza cadastro com ativacao e devolve um registro por profissional."""
    quando_ativou = {}
    for l in ativacoes_por_profissional():
        ident = l.get("_id") or l.get("id")
        t = instante(l.get("t"))
        if ident and t:
            quando_ativou[ident] = t

    pessoas = []
    for l in cadastros_do_banco():
        criado = instante(l.get("criado"))
        if not criado:
            continue
        ativado = quando_ativou.get(l.get("id"))
        dias = (ativado - criado).total_seconds() / 86400.0 if ativado and ativado >= criado else None
        pessoas.append({"criado": criado, "ativado": ativado, "dias": dias})

    fora = len(quando_ativou) - sum(1 for p in pessoas if p["ativado"])
    if fora > 0:
        print("   (%d ativacoes sao de cadastros anteriores a %s)" % (fora, DESDE))
    return pessoas


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
def semanas(pessoas, situacao, limite_dias):
    caixas = {}

    def caixa(dia):
        ini = segunda(dia)
        return caixas.setdefault(ini, {"inicio": ini.isoformat(), "label": rotulo(ini),
                                       "cadastros": 0, "ativados_da_coorte": 0,
                                       "soma_dias": 0.0, "em_meta": 0,
                                       "ativacoes_na_semana": 0,
                                       "temporarios": 0, "assistido": 0})

    for p in pessoas:
        c = caixa(p["criado"].date())
        c["cadastros"] += 1
        if p["dias"] is not None:
            c["ativados_da_coorte"] += 1
            c["soma_dias"] += p["dias"]
            if p["dias"] <= limite_dias:
                c["em_meta"] += 1
        # o fluxo da operacao: quantas ativacoes aconteceram naquela semana,
        # venham de que turma vierem
        if p["ativado"]:
            caixa(p["ativado"].date())["ativacoes_na_semana"] += 1

    for l in situacao:
        c = caixa(dia_de(l["semana"]))
        c["temporarios"] += int(l["temporarios"])
        c["assistido"] += int(l["assistido"])

    corte = segunda(dia_de(DESDE))
    ordenadas = [caixas[k] for k in sorted(caixas) if k >= corte]

    for c in ordenadas:
        ativados = c["ativados_da_coorte"]
        c["tempo_medio_ativacao"] = round(c["soma_dias"] / ativados, 1) if ativados else None
        c["pct_na_meta"] = round(100.0 * c["em_meta"] / ativados, 1) if ativados else None
        c["taxa_ativacao"] = round(100.0 * ativados / c["cadastros"], 1) if c["cadastros"] else None
        idade = (date.today() - dia_de(c["inicio"])).days
        c["coorte_fechada"] = idade >= JANELA_ATIVACAO
        del c["soma_dias"]
    return ordenadas


def main():
    pedir.chave = fm.obter_chave()
    metas = metas_do_onboarding()
    limite = metas["tempo_ativacao_dias"]

    pessoas = coorte(limite)
    situacao = coorte_por_semana()
    hoje = retrato_de_hoje()

    lista = semanas(pessoas, situacao, limite)
    assistido = sum(hoje.get(s, 0) for s in STATUS_ASSISTIDO)

    payload = {
        "gerado_em": datetime.now().isoformat(timespec="seconds"),
        "fonte": "Metabase - Professional History (professionalevents) e Professional (postgres)",
        "desde": DESDE,
        "janela_ativacao_dias": JANELA_ATIVACAO,
        "metas": metas,
        "como_medimos": (
            "Tempo medio de ativacao: data do evento professional.activated menos o "
            "created_at do cadastro, so de quem ja ativou, agrupado pela semana de cadastro "
            "— a mesma conta do Farol. %% na meta = quantos ativaram em ate %d dias."
            % limite),
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
        print("   %s  cadastros %-4s ativados %-4s tempo %-6s na meta %-7s taxa %-6s temp %s"
              % (c["inicio"], c["cadastros"], c["ativados_da_coorte"], c["tempo_medio_ativacao"],
                 c["pct_na_meta"], c["taxa_ativacao"], c["temporarios"]))
    print("   hoje: %d temporarios, %d em onboarding assistido %s"
          % (payload["hoje"]["temporarios"], assistido, payload["hoje"]["detalhe_assistido"]))
    print("arquivo: %s (%.1f KB)" % (destino, os.path.getsize(destino) / 1024.0))


if __name__ == "__main__":
    main()
