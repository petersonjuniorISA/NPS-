# -*- coding: utf-8 -*-
"""Puxa os comentarios abertos do i-NPS.

Eles nao estao no Databricks: a tabela gold guarda so as notas. O texto vive no
Mongo do Metabase, banco "Survey", colecao "distributions" — cada resposta traz
um array `answers` onde toda pergunta de nota e seguida de uma pergunta livre
("Quer comentar sobre essa resposta?").

O arquivo publicado nao leva nome, CPF nem id do profissional. Sai apenas o mes,
a nota, a classificacao NPS, a especialidade e o texto.
"""
import io
import json
import os
import sys
import urllib.request
from datetime import datetime

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import fetch_metabase as fm

BANCO_SURVEY = 4
PESQUISAS = ("i-nps", "inps-isas")
SAIDA = os.path.join(AQUI, "..", "data", "comentarios.json")
# a pesquisa antiga rodou em 2024 e o painel comeca em maio de 2026: esses
# comentarios nao teriam onde aparecer e so pesariam no arquivo publicado
MES_MINIMO = os.environ.get("COMENTARIOS_DESDE", "2026-01")

# id da pergunta de texto -> tema que ela comenta, com os mesmos rotulos que os
# graficos usam, senao o filtro do painel nao casa com a dimensao clicada
TEMAS = {
    "i-nps": {
        2:  "Experiência Geral",
        4:  "Comunicação",
        6:  "Gestão de Escalas",
        8:  "App Isa Atende",
        10: "Pontualidade Pagamento",
        12: "Suporte Chat",
    },
    # pesquisa antiga: uma nota e uma justificativa, sem quebra por dimensao
    "inps-isas": {2: "Justificativa da nota"},
}
# a nota que cada comentario acompanha fica na pergunta imediatamente anterior
NOTA_DA_PERGUNTA = {"i-nps": {k: k - 1 for k in TEMAS["i-nps"]},
                    "inps-isas": {2: 1}}
# de onde sai o indicador NPS (0 a 10) de cada resposta
PERGUNTA_NPS = {"i-nps": 13, "inps-isas": 1}


def api(caminho, dados=None):
    corpo = json.dumps(dados).encode() if dados is not None else None
    req = urllib.request.Request(fm.METABASE_URL.rstrip("/") + caminho, data=corpo,
                                 method="POST" if corpo is not None else "GET")
    req.add_header("x-api-key", api.chave)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read().decode("utf-8"))


def consultar(pipeline):
    resposta = api("/api/dataset", {
        "database": BANCO_SURVEY, "type": "native",
        "native": {"collection": "distributions", "query": json.dumps(pipeline)}})
    if resposta.get("status") != "completed":
        raise RuntimeError("Metabase recusou a consulta: %s" % json.dumps(resposta)[:400])
    colunas = [c["name"] for c in resposta["data"]["cols"]]
    return [dict(zip(colunas, linha)) for linha in resposta["data"]["rows"]]


def como_lista(valor):
    """O driver do Mongo as vezes devolve o array ja decodificado, as vezes como
    texto JSON. Aceitar os dois evita um tratamento diferente por ambiente."""
    if isinstance(valor, str):
        try:
            valor = json.loads(valor)
        except ValueError:
            return []
    return valor if isinstance(valor, list) else []


def classe_nps(nota):
    if nota is None:
        return None
    return "promotor" if nota >= 9 else "detrator" if nota <= 6 else "neutro"


def numero(valor):
    try:
        return int(float(str(valor).replace(",", ".")))
    except (TypeError, ValueError):
        return None


def especialidade_de(parametros):
    """`specialties` chega como texto separado por virgula. Guardamos so a
    primeira: o painel agrupa por especialidade principal."""
    for p in parametros:
        if p.get("description") == "specialties" and p.get("value"):
            primeira = str(p["value"]).split(",")[0].strip()
            if primeira:
                return primeira
    return None


def coletar():
    linhas = consultar([
        {"$match": {"survey.alias": {"$in": list(PESQUISAS)}, "status": "ANSWERED"}},
        {"$project": {"_id": 0,
                      "alias": "$survey.alias",
                      "mes": {"$dateToString": {"format": "%Y-%m", "date": "$updatedAt"}},
                      "answers": 1, "parameters": 1}},
    ])

    registros = []
    for linha in linhas:
        alias = linha.get("alias")
        temas = TEMAS.get(alias)
        if not temas:
            continue
        respostas = {}
        for a in como_lista(linha.get("answers")):
            if isinstance(a, dict) and a.get("questionId") is not None:
                respostas[int(a["questionId"])] = a.get("value")

        nota_nps = numero(respostas.get(PERGUNTA_NPS[alias]))
        especialidade = especialidade_de(como_lista(linha.get("parameters")))

        for pergunta, tema in temas.items():
            texto = (respostas.get(pergunta) or "").strip() if isinstance(respostas.get(pergunta), str) else ""
            if len(texto) < 3:
                continue
            registros.append({
                "mes": linha.get("mes"),
                "tema": tema,
                "texto": texto,
                "nps": nota_nps,
                "classe": classe_nps(nota_nps),
                "nota_tema": numero(respostas.get(NOTA_DA_PERGUNTA[alias].get(pergunta))),
                "especialidade": especialidade,
            })

    registros = [r for r in registros if r["mes"] and r["mes"] >= MES_MINIMO]
    registros.sort(key=lambda r: (r["mes"], r["tema"], r["texto"]))
    return registros


def main():
    api.chave = fm.obter_chave()
    registros = coletar()

    meses = sorted({r["mes"] for r in registros if r["mes"]})
    temas = sorted({r["tema"] for r in registros})
    payload = {
        "gerado_em": datetime.now().isoformat(timespec="seconds"),
        "fonte": "Metabase - banco Survey, colecao distributions (pesquisas i-nps e inps-isas)",
        "sem_dados_pessoais": "Nao inclui nome, CPF, e-mail nem id do profissional.",
        "desde": MES_MINIMO,
        "meses": meses,
        "temas": temas,
        "comentarios": registros,
    }
    destino = os.path.abspath(SAIDA)
    with io.open(destino, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    print("comentarios: %d registros, %d meses (%s)" % (len(registros), len(meses), ", ".join(meses)))
    for m in meses:
        print("   %s  %d" % (m, sum(1 for r in registros if r["mes"] == m)))
    print("arquivo: %s (%.1f KB)" % (destino, os.path.getsize(destino) / 1024.0))


if __name__ == "__main__":
    main()
