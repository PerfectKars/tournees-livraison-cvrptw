"""Tests du convertisseur et de l'API. Lancer : .venv/bin/python -m pytest -q"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from sol_to_json import (ErreurBackend, convention_benchmark, convert,  # noqa: E402
                         cout_benchmark, read_instance, read_solution,
                         write_solomon)

INST = Path(__file__).resolve().parent.parent.parent / "instances"
C102 = INST / "solomon" / "C102"
XTW = INST / "xtw" / "XTW-n129"


def test_reference_c102_coute_827_3_avec_arrondi_solomon():
    """Les .sol de référence utilisent des distances tronquées à 0,1."""
    inst = read_instance(f"{C102}.txt")
    routes, cost = read_solution(f"{C102}.sol")
    assert cost_ok(cout_benchmark(inst, routes, convention_benchmark(f"{C102}.txt")), cost)


def test_reference_xtw_coute_22347_avec_arrondi_entier():
    inst = read_instance(f"{XTW}.vrp")
    routes, cost = read_solution(f"{XTW}.sol")
    assert cost_ok(cout_benchmark(inst, routes, convention_benchmark(f"{XTW}.vrp")), cost)


def cost_ok(a, b):
    return abs(a - b) < 0.05


def test_xtw_renumerote_de_0_a_n_moins_1():
    inst = read_instance(f"{XTW}.vrp")
    assert sorted(inst["clients"]) == list(range(129))
    assert inst["capacite"] == 665


def test_ecriture_solomon_puis_relecture_identique(tmp_path):
    inst = read_instance(f"{XTW}.vrp")
    write_solomon(inst, tmp_path / "x.txt")
    assert read_instance(tmp_path / "x.txt")["clients"] == inst["clients"]


def test_client_en_double_est_refuse(tmp_path):
    sol = tmp_path / "a.sol"
    sol.write_text("Route #1: 1 2 3\nRoute #2: 3 4\nCost 1\n")
    res = convert(f"{C102}.txt", str(sol))
    assert not res["valide"]
    assert any("double" in e for e in res["erreurs"])


def test_solution_incomplete_est_refusee(tmp_path):
    sol = tmp_path / "a.sol"
    sol.write_text("Route #1: 1 2 3\nCost 1\n")
    assert not convert(f"{C102}.txt", str(sol))["valide"]


def test_mauvais_couple_instance_solution(tmp_path):
    sol = tmp_path / "a.sol"
    sol.write_text("Route #1: 1 2 500\n")
    with pytest.raises(ErreurBackend) as e:
        convert(f"{C102}.txt", str(sol))
    assert e.value.etape == "validation"


def test_fichier_inexistant_donne_une_erreur_claire():
    with pytest.raises(ErreurBackend) as e:
        read_instance("nexiste.txt")
    assert e.value.etape == "lecture_instance"


def test_fichier_qui_nest_pas_une_instance(tmp_path):
    f = tmp_path / "x.txt"
    f.write_text("bonjour\n")
    with pytest.raises(ErreurBackend):
        read_instance(f)


def test_api_refuse_les_noms_dangereux():
    from fastapi.testclient import TestClient
    import api
    client = TestClient(api.app)
    for nom in ("../etc/passwd", "/etc/passwd", "xtw/../../x"):
        r = client.post("/solve", json={"instance": nom})
        assert r.status_code in (400, 404, 422), nom
    assert client.post("/solve", json={"instance": "xtw/inconnue"}).status_code == 404
    assert client.get("/solve/zzz").status_code == 404


def test_api_liste_les_trois_jeux():
    from fastapi.testclient import TestClient
    import api
    jeux = {i["jeu"] for i in TestClient(api.app).get("/instances").json()}
    assert jeux == {"solomon", "homberger", "xtw"}
