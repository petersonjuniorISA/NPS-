# -*- coding: utf-8 -*-
r"""Sobe a versao dos assets no index.html.

    py scripts\bump_versao.py

O GitHub Pages serve CSS e JS com max-age=600, entao sem trocar o ?v= uma
publicacao nova so aparece 10 minutos depois. Este script existe porque fazer
isso com `sed 's/?v=39/?v=40/'` falha em silencio quando o numero atual nao e
o que voce imaginou — foi o que aconteceu e deixou o painel servindo CSS
velho por varias edicoes seguidas.

Aqui a versao e lida do arquivo, incrementada e conferida no fim.
"""

import io
import os
import re
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALVO = os.path.join(RAIZ, "index.html")


def main():
    s = io.open(ALVO, encoding="utf-8").read()
    versoes = [int(v) for v in re.findall(r"\?v=(\d+)", s)]
    if not versoes:
        print("ERRO: nenhum ?v= encontrado em index.html")
        return 1

    atual = max(versoes)
    nova = atual + 1
    s = re.sub(r"\?v=\d+", "?v=%d" % nova, s)
    io.open(ALVO, "w", encoding="utf-8").write(s)

    conferencia = set(re.findall(r"\?v=(\d+)", s))
    if conferencia != {str(nova)}:
        print("ERRO: ficaram versoes diferentes: %s" % sorted(conferencia))
        return 1
    print("versao dos assets: %d -> %d  (%d referencias)" % (atual, nova, len(versoes)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
