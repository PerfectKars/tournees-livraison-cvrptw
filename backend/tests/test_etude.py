"""Tests de l'étude ALNS / recherche tabou. Lancer : .venv/bin/python -m pytest -q"""
import csv
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from etude import (comparer_instance, ecrire_etude, exporter_csv, famille,  # noqa: E402
                   lire_etude, trouver)
from julia_runner import lire_trace, reduire_trace  # noqa: E402
from recherche_tabou import resoudre  # noqa: E402
from sol_to_json import ErreurBackend, read_instance  # noqa: E402

JOURNAL = """Threads Julia : 4
[7.1 s] chaîne 2, it. 10 | véhicules 12 | distance 1081.51 | gap distance 30.10 %
[8.5 s] chaîne 1, it. 80 | véhicules 11 | distance 951.51 | gap distance 15.00 %
ligne sans rapport
[9.0 s] chaîne 3, it. 90 | véhicules 10 | distance 828.94
"""


def test_lire_trace_lit_les_ameliorations_du_journal(tmp_path):
    log = tmp_path / "julia.log"
    log.write_text(JOURNAL, encoding="utf-8")
    assert lire_trace(log) == [[7.1, 12, 1081.51], [8.5, 11, 951.51], [9.0, 10, 828.94]]


def test_lire_trace_journal_absent_renvoie_liste_vide(tmp_path):
    assert lire_trace(tmp_path / "absent.log") == []


def test_reduire_trace_garde_premier_et_dernier_point():
    points = [[float(i), 10, 1000.0 - i] for i in range(1000)]
    r = reduire_trace(points, 50)
    assert len(r) == 50 and r[0] == points[0] and r[-1] == points[-1]
    assert reduire_trace(points[:10], 50) == points[:10]


def test_famille_depuis_le_nom():
    assert famille("solomon/C101") == "C1"
    assert famille("solomon/RC208") == "RC2"
    assert famille("homberger/R1_2_1") == "R1"
    assert famille("xtw/XTW-n129") == "XTW"


def test_instance_inconnue_ou_piegee_refusee():
    for nom in ("solomon/nope", "solomon/../x", "/etc/passwd"):
        with pytest.raises(ErreurBackend):
            trouver(nom)


def test_tabou_renvoie_une_courbe_qui_descend():
    inst = read_instance(trouver("solomon/C101"))
    _, st = resoudre(inst, iterations=10**9, temps_max=2, seed=42)
    trace = st["trace"]
    assert len(trace) > 2 and trace[0][0] == 0.0
    assert trace[-1][2] < trace[0][2]            # la distance finale est plus courte
    assert [p[0] for p in trace] == sorted(p[0] for p in trace)  # temps croissant


def test_ecriture_lecture_et_csv(tmp_path):
    ligne = {"instance": "solomon/C101", "famille": "C1", "clients": 100, "seed": 42,
             "temps_budget": 10, "reference": 827.3, "vehicules_ref": 10,
             "alns": {"vehicules": 10, "distance": 828.9, "co2_kg": 165.8, "gap": 0.2,
                      "valide": True, "secondes": 20.0, "trace": []},
             "tabou": {"vehicules": 11, "distance": 900.0, "co2_kg": 180.0, "gap": 8.8,
                       "valide": True, "secondes": 10.0, "trace": []}}
    chemin = tmp_path / "etude.json"
    assert lire_etude(chemin) == []
    ecrire_etude([ligne], chemin)
    assert lire_etude(chemin) == [ligne]
    exporter_csv([ligne], tmp_path / "etude.csv")
    lignes = list(csv.reader(open(tmp_path / "etude.csv", encoding="utf-8")))
    assert len(lignes) == 3 and lignes[1][5] == "ALNS" and lignes[2][5] == "tabou"


def test_comparaison_complete_sur_une_petite_instance():
    r = comparer_instance("solomon/C101", temps=4, seed=42)
    for s in ("alns", "tabou"):
        assert r[s]["valide"] and r[s]["vehicules"] > 0 and r[s]["co2_kg"] > 0
        assert r[s]["trace"] and r[s]["trace"][-1][2] == r[s]["distance"]
    assert r["reference"] == 827.3 and r["famille"] == "C1"
