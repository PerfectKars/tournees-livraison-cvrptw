"""Compare la recherche tabou (simple) et le solveur Julia sur une instance :
véhicules, distance, CO2, gap par rapport à la référence, temps de calcul.

Usage : python comparer_solveurs.py homberger/C1_2_1 [--temps-tabou 30]
            [--iterations-julia 5000] [--seed 42] [-o resultat.json]
"""
import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

from julia_runner import UN_SEUL_CALCUL, lancer_julia
from recherche_tabou import ecrire_sol, resoudre
from sol_to_json import ErreurBackend, convert, read_instance, read_solution, write_solomon

INSTANCES = Path(__file__).resolve().parent.parent / "instances"


def trouver(nom):
    for ext in (".txt", ".vrp"):
        p = INSTANCES / f"{nom}{ext}"
        if p.is_file():
            return p
    raise ErreurBackend("instance", f"Instance inconnue : {nom}")


def ligne(nom, source, sol, secondes, ref):
    """Résumé d'une solution : on la repasse dans le convertisseur, qui vérifie
    capacité et fenêtres et calcule distance et CO2."""
    r = convert(str(source), str(sol))
    gap = None
    if ref:  # même arrondi des distances que la référence, pour un gap comparable
        gap = round(100 * (r["cout_convention_benchmark"] / ref - 1), 2)
    return {"solveur": nom, "vehicules": r["nb_vehicules_utilises"],
            "distance": r["distance_totale"], "co2_kg": r["co2"]["total_kg"],
            "gap_pourcent": gap, "valide": r["valide"], "secondes": secondes}


def comparer(nom, temps_tabou=30.0, iterations_julia=5000, seed=42):
    source = trouver(nom)
    ref_sol = source.with_suffix(".sol")
    ref = read_solution(ref_sol)[1] if ref_sol.exists() else None
    inst = read_instance(source)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        # recherche tabou
        routes, st = resoudre(inst, iterations=10**9, temps_max=temps_tabou, seed=seed)
        ecrire_sol(routes, tmp / "tabou.sol")
        lignes = [ligne("recherche tabou", source, tmp / "tabou.sol", st["secondes"], ref)]
        # solveur Julia (il lit le format Solomon : on convertit l'instance)
        solomon = tmp / f"{source.stem}.txt"
        write_solomon(inst, solomon)
        if ref_sol.exists():
            shutil.copy(ref_sol, tmp / ref_sol.name)
        t0 = time.time()
        with UN_SEUL_CALCUL:
            sol = lancer_julia(tmp, solomon, iterations_julia, 4, seed)
        lignes.append(ligne("Julia ALNS", source, sol, round(time.time() - t0, 1), ref))
    return {"instance": nom, "reference": ref, "resultats": lignes}


def afficher(res):
    print(f"Instance {res['instance']} (référence : {res['reference']})")
    print(f"{'solveur':<16}{'véhic.':>7}{'distance':>11}{'CO2 (kg)':>10}{'gap %':>8}{'temps (s)':>11}  valide")
    for l in res["resultats"]:
        gap = "-" if l["gap_pourcent"] is None else f"{l['gap_pourcent']:.2f}"
        print(f"{l['solveur']:<16}{l['vehicules']:>7}{l['distance']:>11.1f}"
              f"{l['co2_kg']:>10.1f}{gap:>8}{l['secondes']:>11}  {l['valide']}")
    t, j = res["resultats"]
    if j["co2_kg"] > 0:
        print(f"CO2 évité par Julia par rapport au tabou : "
              f"{100 * (1 - j['co2_kg'] / t['co2_kg']):.1f} %")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("instance", help="ex. homberger/C1_2_1")
    ap.add_argument("--temps-tabou", type=float, default=30.0)
    ap.add_argument("--iterations-julia", type=int, default=5000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("-o", "--output")
    a = ap.parse_args()
    try:
        res = comparer(a.instance, a.temps_tabou, a.iterations_julia, a.seed)
    except ErreurBackend as e:
        print(f"ERREUR [{e.etape}] {e.message}", file=sys.stderr)
        return 2
    afficher(res)
    if a.output:
        Path(a.output).write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
