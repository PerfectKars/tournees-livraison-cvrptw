"""Étude expérimentale : ALNS (Julia) contre recherche tabou, sur les instances
de référence, avec courbes de convergence, CO2 et écart à la meilleure solution
connue (gap).

Les deux solveurs ont le même budget de temps et la même graine. Le solveur
Julia tourne sans arrêt anticipé (pas de cible de gap) : on mesure sa vraie
qualité. Attention : l'ALNS utilise 4 chaînes en parallèle (4 coeurs), la
recherche tabou une seule chaîne.

Usage, depuis backend/ :
    python etude.py --temps 60 --seeds 42 43 44              # toutes les instances
    python etude.py --jeux solomon --max-clients 100 --temps 10
    python etude.py homberger/C1_2_1 solomon/C101 --temps 30   # instances choisies

Les résultats sont ajoutés à resultats_solveur/etude.json (un calcul déjà fait
n'est pas refait : on peut interrompre puis relancer) et exportés en CSV.
"""
import argparse
import csv
import json
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

from julia_runner import (ITER_SANS_LIMITE, UN_SEUL_CALCUL, lancer_julia,
                          lire_trace, reduire_trace)
from recherche_tabou import ecrire_sol, resoudre
from sol_to_json import (ErreurBackend, convert, read_cost, read_instance,
                         write_solomon)

ROOT = Path(__file__).resolve().parent.parent
INSTANCES = ROOT / "instances"
SORTIE = ROOT / "resultats_solveur" / "etude.json"
CHAINES_ALNS = 4


def trouver(nom):
    """Chemin d'une instance 'jeu/nom' (nom validé : pas de sortie de instances/)."""
    if not re.fullmatch(r"[\w-]+/[\w.-]+", nom) or ".." in nom:
        raise ErreurBackend("instance", f"Nom invalide '{nom}'")
    for ext in (".txt", ".vrp"):
        p = INSTANCES / f"{nom}{ext}"
        if p.is_file():
            return p
    raise ErreurBackend("instance", f"Instance inconnue : {nom}")


def famille(nom):
    """C1, C2, R1, R2, RC1, RC2 d'après le nom (Solomon C101, Homberger C1_2_1) ;
    'XTW' pour le jeu XTW."""
    m = re.match(r"^(RC|R|C)(\d)", nom.split("/")[1])
    return m.group(1) + m.group(2) if m else "XTW"


def evaluer(source, sol, ref):
    """Repasse la solution dans le convertisseur, qui vérifie capacité et fenêtres
    horaires, puis calcule distance, CO2 et gap (même arrondi que la référence)."""
    r = convert(str(source), str(sol))
    gap = None
    if ref:
        gap = round(100 * (r["cout_convention_benchmark"] / ref - 1), 3)
    return {"vehicules": r["nb_vehicules_utilises"], "distance": r["distance_totale"],
            "co2_kg": r["co2"]["total_kg"], "gap": gap, "valide": r["valide"]}


def comparer_instance(nom, temps=30.0, seed=42):
    """Lance le tabou puis l'ALNS sur une instance. Renvoie un dictionnaire
    sérialisable (résultats + courbes de convergence des deux solveurs)."""
    source = trouver(nom)
    ref_sol = source.with_suffix(".sol")
    ref = read_cost(ref_sol) if ref_sol.exists() else None
    inst = read_instance(source)
    ref_veh = None
    if ref_sol.exists():
        n = len(re.findall(r"(?im)^\s*route\s*#", ref_sol.read_text(encoding="utf-8")))
        ref_veh = n or None

    res = {"instance": nom, "jeu": nom.split("/")[0], "famille": famille(nom),
           "clients": len(inst["clients"]) - 1, "seed": seed, "temps_budget": temps,
           "reference": ref, "vehicules_ref": ref_veh}
    # Un seul calcul à la fois pour les deux solveurs : sinon un autre calcul
    # en parallèle fausserait les temps.
    with UN_SEUL_CALCUL, tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        # --- recherche tabou (un coeur) ---
        routes, st = resoudre(inst, iterations=10**9, temps_max=temps, seed=seed)
        ecrire_sol(routes, tmp / "tabou.sol")
        res["tabou"] = {**evaluer(source, tmp / "tabou.sol", ref),
                        "secondes": st["secondes"],
                        "trace": reduire_trace(st["trace"])}
        # --- ALNS Julia (le solveur lit le format Solomon) ---
        solomon = tmp / f"{source.stem}.txt"
        write_solomon(inst, solomon)
        t0 = time.time()
        sol = lancer_julia(tmp, solomon, ITER_SANS_LIMITE, CHAINES_ALNS, seed,
                           gap=None, temps_max=temps)
        res["alns"] = {**evaluer(source, sol, ref),
                       "secondes": round(time.time() - t0, 2),
                       "trace": lire_trace(tmp / "julia.log")}
    # Dernier point = résultat final, pour que les courbes finissent au bon niveau.
    for s in ("alns", "tabou"):
        t = res[s]["trace"]
        if not t or t[-1][2] != res[s]["distance"]:
            t.append([min(res[s]["secondes"], temps), res[s]["vehicules"],
                      res[s]["distance"]])
    return res


def liste_instances(args):
    """Instances à traiter : celles données, sinon toutes celles qui ont une
    solution de référence, filtrées par jeu et par taille."""
    if args.instances:
        return args.instances
    noms = []
    for p in sorted(INSTANCES.glob("*/*")):
        if p.suffix not in (".txt", ".vrp") or not p.with_suffix(".sol").exists():
            continue
        if args.jeux and p.parent.name not in args.jeux:
            continue
        noms.append((len(read_instance(p)["clients"]) - 1, f"{p.parent.name}/{p.stem}"))
    return [n for c, n in sorted(noms) if c <= args.max_clients]


def lire_etude(chemin=SORTIE):
    try:
        return json.loads(Path(chemin).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def ecrire_etude(lignes, chemin=SORTIE):
    chemin = Path(chemin)
    chemin.parent.mkdir(parents=True, exist_ok=True)
    temporaire = chemin.with_suffix(".tmp")  # écriture atomique : pas de fichier à moitié écrit
    temporaire.write_text(json.dumps(lignes, ensure_ascii=False), encoding="utf-8")
    temporaire.replace(chemin)


def exporter_csv(lignes, chemin):
    """Une ligne par (instance, graine, solveur), sans les courbes."""
    colonnes = ["instance", "famille", "clients", "seed", "temps_budget", "solveur",
                "vehicules", "vehicules_ref", "distance", "reference", "gap_pourcent",
                "co2_kg", "secondes", "valide"]
    with open(chemin, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(colonnes)
        for r in lignes:
            for s, libelle in (("alns", "ALNS"), ("tabou", "tabou")):
                x = r[s]
                w.writerow([r["instance"], r["famille"], r["clients"], r["seed"],
                            r["temps_budget"], libelle, x["vehicules"],
                            r["vehicules_ref"], x["distance"], r["reference"],
                            x["gap"], x["co2_kg"], x["secondes"], x["valide"]])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("instances", nargs="*", help="ex. homberger/C1_2_1 (défaut : toutes)")
    ap.add_argument("--jeux", nargs="+", choices=["solomon", "homberger", "xtw"])
    ap.add_argument("--max-clients", type=int, default=10**6)
    ap.add_argument("--temps", type=float, default=60.0, help="secondes par solveur")
    ap.add_argument("--seeds", type=int, nargs="+", default=[42])
    ap.add_argument("-o", "--sortie", default=str(SORTIE))
    a = ap.parse_args()

    try:
        noms = liste_instances(a)
        lignes = lire_etude(a.sortie)
        deja = {(r["instance"], r["seed"], r["temps_budget"]) for r in lignes}
        total = len(noms) * len(a.seeds)
        print(f"{len(noms)} instances x {len(a.seeds)} graines, {a.temps:g} s par "
              f"solveur : environ {total * 2 * (a.temps + 5) / 60:.0f} min.")
        for i, (nom, seed) in enumerate([(n, s) for n in noms for s in a.seeds], 1):
            if (nom, seed, a.temps) in deja:
                print(f"[{i}/{total}] {nom} graine {seed} : déjà calculé")
                continue
            r = comparer_instance(nom, a.temps, seed)
            lignes.append(r)
            ecrire_etude(lignes, a.sortie)  # sauvegarde après chaque calcul
            print(f"[{i}/{total}] {nom} graine {seed} : ALNS gap {r['alns']['gap']} %"
                  f" ({r['alns']['vehicules']} v.), tabou gap {r['tabou']['gap']} %"
                  f" ({r['tabou']['vehicules']} v.)", flush=True)
        exporter_csv(lignes, Path(a.sortie).with_suffix(".csv"))
        print(f"Résultats : {a.sortie} et {Path(a.sortie).with_suffix('.csv')}")
    except ErreurBackend as e:
        print(f"ERREUR [{e.etape}] {e.message}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
