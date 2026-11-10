"""Tests du convertisseur et de l'API. Lancer : .venv/bin/python -m pytest -q"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from sol_to_json import (ErreurBackend, convention_benchmark, convert,  # noqa: E402
                         cout_benchmark, read_instance, read_solution,
                         write_matrix, write_solomon)

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


def test_front_optimize_petite_sert_les_20_clients_avec_julia():
    """Le pont du front : mêmes clés qu'avant, tous les clients servis, fenêtres ok."""
    import shutil
    if not shutil.which("julia"):
        pytest.skip("Julia absent")
    from fastapi.testclient import TestClient
    import api
    r = TestClient(api.app).post("/api/optimize?mode=petite&iterations=5")
    assert r.status_code == 200
    res = r.json()["resultats"]
    assert {"routes", "route_details", "cost", "number_of_routes",
            "number_of_customers", "iterations"} <= set(res)
    assert sorted(c for t in res["routes"] for c in t) == list(range(1, 21))
    assert res["co2"]["total_kg"] == pytest.approx(
        sum(d["co2_kg"] for d in res["route_details"]), abs=0.01)
    assert all(s["within_time_window"] for d in res["route_details"] for s in d["stops"])


def test_ecriture_matrice_dans_l_ordre_depot_puis_clients(tmp_path):
    matrice = {"0": {"0": 0.0, "7": 5.0, "3": 9.0},
               "7": {"0": 4.0, "7": 0.0, "3": 2.5},
               "3": {"0": 8.0, "7": 1.5, "3": 0.0}}
    sortie = tmp_path / "i.matrix"
    write_matrix(matrice, [0, 7, 3], sortie)
    lignes = [l.split() for l in sortie.read_text().splitlines()]
    assert lignes == [["0.0", "5.0", "9.0"], ["4.0", "0.0", "2.5"], ["8.0", "1.5", "0.0"]]


def test_matrice_avec_paire_absente_leve_une_erreur(tmp_path):
    with pytest.raises(ErreurBackend):
        write_matrix({"0": {"0": 0.0}}, [0, 1], tmp_path / "i.matrix")


def test_co2_est_distance_fois_facteur():
    import co2
    assert co2.co2_kg(100, 0.25) == 25.0
    res = convert(f"{C102}.txt", f"{C102}.sol", facteur_co2=0.5)
    assert res["co2"]["total_kg"] == pytest.approx(0.5 * res["distance_totale"], abs=0.01)
    assert res["co2"]["facteur_kg_par_km"] == 0.5


def test_recherche_tabou_donne_une_solution_valide_et_reproductible(tmp_path):
    from recherche_tabou import ecrire_sol, resoudre
    inst = read_instance(f"{C102}.txt")
    r1, st1 = resoudre(inst, iterations=200, temps_max=60, seed=1)
    r2, _ = resoudre(inst, iterations=200, temps_max=60, seed=1)
    assert r1 == r2                                   # même graine, même résultat
    assert st1["cout"] <= st1["cout_depart"] + 1e-9   # jamais pire que le départ
    ecrire_sol(r1, tmp_path / "t.sol")
    res = convert(f"{C102}.txt", str(tmp_path / "t.sol"))
    assert res["valide"], res["erreurs"]


def test_reference_avec_seulement_le_cout(tmp_path):
    from sol_to_json import read_cost
    f = tmp_path / "ref.sol"
    f.write_text("Cost: 828.14\n")
    assert read_cost(f) == 828.14
