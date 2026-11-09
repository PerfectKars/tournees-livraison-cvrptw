"""Convertit (instance .txt + solution .sol) en un JSON de tournées pour le front.

Format d'instance : Solomon / Homberger (CVRPLIB).
Format de solution : "Route #k: id id id ..." puis "Cost <valeur>".

Usage :
    python sol_to_json.py instance.txt solution.sol [-o sortie.json]
                          [--colis colis.json] [--seed 42]

Seule la bibliothèque standard est utilisée.
"""
import argparse
import json
import math
import random
import re
import sys
from pathlib import Path

EPS = 1e-6


class ErreurBackend(Exception):
    """Erreur identifiée : `etape` dit où ça a cassé, `message` pourquoi."""

    def __init__(self, etape, message):
        super().__init__(message)
        self.etape = etape
        self.message = message


def read_instance(path):
    """Lit une instance (.txt Solomon/Homberger ou .vrp XTW). Renvoie un dict."""
    try:
        if str(path).endswith(".vrp"):
            return read_vrp(path)
        return read_solomon(path)
    except ErreurBackend:
        raise
    except OSError as e:
        raise ErreurBackend("lecture_instance", f"Fichier illisible : {e}")


def read_solomon(path):
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()

    nb_vehicles = capacity = None
    for k, line in enumerate(lines):
        if "NUMBER" in line.upper() and "CAPACITY" in line.upper():
            for nxt in lines[k + 1:]:
                parts = nxt.split()
                if len(parts) == 2 and all(p.isdigit() for p in parts):
                    nb_vehicles, capacity = int(parts[0]), int(parts[1])
                    break
            break
    if capacity is None:
        raise ErreurBackend(
            "lecture_instance",
            f"{path} : en-tête 'NUMBER CAPACITY' introuvable "
            "(ce n'est pas une instance Solomon/Homberger ?)")

    customers = {}
    for line in lines:
        parts = line.split()
        if len(parts) != 7:
            continue
        try:
            v = [float(p) for p in parts]
        except ValueError:
            continue  # ligne d'en-tête du tableau, pas un client
        customers[int(v[0])] = {
            "id": int(v[0]), "x": v[1], "y": v[2], "demande": int(v[3]),
            "ouverture": v[4], "fermeture": v[5], "service": v[6],
        }
    return finish_instance(path, lines[0].strip(), nb_vehicles, capacity, customers)


def read_vrp(path):
    """Format XTW (TSPLIB). Les noeuds sont numérotés de 1 (dépôt) à N ;
    on les renumérote de 0 à N-1 pour coller au format Solomon et aux .sol."""
    header, sections, current = {}, {}, None
    with open(path, encoding="utf-8") as f:
        for num, raw in enumerate(f, start=1):
            line = raw.strip()
            if not line or line == "EOF":
                continue
            if line.endswith("SECTION"):
                current = line
                sections[current] = []
            elif current is None and ":" in line:
                k, _, v = line.partition(":")
                header[k.strip()] = v.strip()
            elif current is not None:
                try:
                    sections[current].append([float(t) for t in line.split()])
                except ValueError:
                    raise ErreurBackend(
                        "lecture_instance",
                        f"{path}, ligne {num} : nombres attendus, trouvé '{line}'")

    needed = ("NODE_COORD_SECTION", "DEMAND_SECTION",
              "SERVICE_TIME_SECTION", "TIME_WINDOW_SECTION")
    for name in needed:
        if not sections.get(name):
            raise ErreurBackend("lecture_instance",
                                f"{path} : section {name} absente ou vide")
    if "CAPACITY" not in header:
        raise ErreurBackend("lecture_instance", f"{path} : CAPACITY absent")

    customers = {}
    try:
        for r in sections["NODE_COORD_SECTION"]:
            i = int(r[0]) - 1
            customers[i] = {"id": i, "x": r[1], "y": r[2]}
        for r in sections["DEMAND_SECTION"]:
            customers[int(r[0]) - 1]["demande"] = int(r[1])
        for r in sections["SERVICE_TIME_SECTION"]:
            customers[int(r[0]) - 1]["service"] = r[1]
        for r in sections["TIME_WINDOW_SECTION"]:
            c = customers[int(r[0]) - 1]
            c["ouverture"], c["fermeture"] = r[1], r[2]
    except (KeyError, IndexError):
        raise ErreurBackend("lecture_instance",
                            f"{path} : noeud absent ou ligne incomplète dans une section")
    # Le format XTW ne limite pas la flotte : on autorise un véhicule par client.
    return finish_instance(path, header.get("NAME", Path(path).stem),
                           len(customers) - 1, int(header["CAPACITY"]), customers)


def finish_instance(path, nom, nb_vehicles, capacity, customers):
    """Vérifie que l'instance est complète puis renvoie le dict final."""
    if 0 not in customers:
        raise ErreurBackend("lecture_instance", f"{path} : dépôt (id 0) introuvable")
    if len(customers) < 2:
        raise ErreurBackend("lecture_instance", f"{path} : aucun client trouvé")
    manquants = [i for i in range(len(customers)) if i not in customers]
    if manquants:
        raise ErreurBackend("lecture_instance",
                            f"{path} : ids non consécutifs, manque {manquants[:5]}")
    for c in customers.values():
        if c["ouverture"] > c["fermeture"]:
            raise ErreurBackend("lecture_instance",
                                f"{path} : client {c['id']} a une fenêtre inversée")
    return {"nom": nom, "nb_vehicules": nb_vehicles,
            "capacite": capacity, "clients": customers}


def write_solomon(instance, path):
    """Écrit l'instance au format Solomon, le seul que lit le solveur Julia."""
    def num(v):
        return str(int(v)) if float(v).is_integer() else repr(float(v))

    lignes = [instance["nom"], "", "VEHICLE", "NUMBER     CAPACITY",
              f"  {instance['nb_vehicules']}   {instance['capacite']}", "",
              "CUSTOMER",
              "CUST NO.  XCOORD.  YCOORD.  DEMAND  READY TIME  DUE DATE  SERVICE TIME", ""]
    for i in sorted(instance["clients"]):
        c = instance["clients"][i]
        lignes.append("  ".join(num(v) for v in (
            c["id"], c["x"], c["y"], c["demande"],
            c["ouverture"], c["fermeture"], c["service"])))
    Path(path).write_text("\n".join(lignes) + "\n", encoding="utf-8")


def write_matrix(matrix, order, path):
    """Écrit la matrice de trajet lue par le solveur Julia (<instance>.matrix).

    matrix : dict {origine: {destination: valeur}} (clés texte ou entières),
    order  : identifiants dans l'ordre des lignes (dépôt d'abord).
    Une paire absente lève ErreurBackend : pas de valeur de remplacement.
    """
    def valeur(a, b):
        ligne = matrix.get(str(a), matrix.get(a))
        v = None if ligne is None else ligne.get(str(b), ligne.get(b))
        if v is None:
            raise ErreurBackend("instance", f"Trajet absent de la matrice : {a} -> {b}")
        return float(v)

    lignes = [" ".join(repr(valeur(a, b)) for b in order) for a in order]
    Path(path).write_text("\n".join(lignes) + "\n", encoding="utf-8")


def read_solution(path):
    """Lit un .sol. Renvoie (liste de routes, coût ou None)."""
    routes, cost = [], None
    try:
        with open(path, encoding="utf-8") as f:
            for num, line in enumerate(f, start=1):
                line = line.strip()
                m = re.match(r"Route\s*#\s*\d+\s*:\s*(.*)", line, re.I)
                if m:
                    try:
                        ids = [int(t) for t in m.group(1).split()]
                    except ValueError:
                        raise ErreurBackend(
                            "lecture_solution",
                            f"{path}, ligne {num} : identifiant non numérique")
                    if ids:
                        routes.append(ids)
                    continue
                m = re.match(r"Cost\s*:?\s*([0-9.eE+-]+)", line, re.I)
                if m:
                    cost = float(m.group(1))
    except OSError as e:
        raise ErreurBackend("lecture_solution", f"Fichier illisible : {e}")
    if not routes:
        raise ErreurBackend("lecture_solution",
                            f"{path} : aucune ligne 'Route #k:' trouvée")
    return routes, cost


def make_colis(instance, seed=42):
    """Colis de démonstration : découpe la demande de chaque client en colis.

    Les poids sont entiers et leur somme vaut exactement la demande du client.
    En production, ils viendraient de la base de colis du back-end.
    """
    rng = random.Random(seed)
    colis = {}
    for cid, c in instance["clients"].items():
        if cid == 0:
            continue
        reste, liste, n = c["demande"], [], 1
        while reste > 0:
            poids = reste if reste <= 5 else rng.randint(1, min(reste, 15))
            liste.append({"id": f"P-{cid:03d}-{n}", "poids": poids})
            reste -= poids
            n += 1
        colis[cid] = liste
    return colis


def convention_benchmark(path):
    """Façon dont les benchmarks arrondissent les distances (constaté en
    recalculant les .sol de référence) : XTW arrondit à l'entier le plus
    proche, Solomon et Homberger tronquent à 0,1."""
    if str(path).endswith(".vrp"):
        return lambda d: int(d + 0.5)
    return lambda d: math.floor(d * 10 + 1e-9) / 10


def cout_benchmark(inst, routes, arrondi):
    """Coût de la solution avec l'arrondi du benchmark (pour un gap comparable)."""
    c = inst["clients"]
    return sum(arrondi(dist(c[a], c[b]))
               for r in routes for a, b in zip([0] + r, r + [0]))


def dist(a, b):
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def build_route(index, ids, instance, colis):
    """Calcule horaires, charge et distance d'une route, et ses violations."""
    cust = instance["clients"]
    depot = cust[0]
    t = depot["ouverture"]  # départ du dépôt à l'ouverture
    pos, load, total = depot, 0, 0.0
    arrets, violations = [], []

    for ordre, cid in enumerate(ids, start=1):
        c = cust[cid]
        d = dist(pos, c)
        total += d
        arrivee = t + d
        debut = max(arrivee, c["ouverture"])  # attente éventuelle
        if debut > c["fermeture"] + EPS:
            violations.append(f"client {cid} : service à {debut:.1f} "
                              f"> fermeture {c['fermeture']:.1f}")
        t = debut + c["service"]
        load += c["demande"]
        pos = c
        arrets.append({
            "ordre": ordre, "client": cid, "x": c["x"], "y": c["y"],
            "arrivee": round(arrivee, 3), "attente": round(debut - arrivee, 3),
            "debut_service": round(debut, 3), "depart": round(t, 3),
            "fenetre": [c["ouverture"], c["fermeture"]],
            "demande": c["demande"], "colis": colis.get(cid, []),
        })

    retour_d = dist(pos, depot)
    total += retour_d
    retour = t + retour_d
    if retour > depot["fermeture"] + EPS:
        violations.append(f"retour dépôt à {retour:.1f} "
                          f"> fermeture {depot['fermeture']:.1f}")
    if load > instance["capacite"]:
        violations.append(f"charge {load} > capacité {instance['capacite']}")

    return {
        "id": index, "depot": {"x": depot["x"], "y": depot["y"]},
        "arrets": arrets, "charge": load, "capacite": instance["capacite"],
        "distance": round(total, 3), "heure_retour": round(retour, 3),
        "chargement": [   # ordre de chargement : dernier livré = premier chargé
            p for a in reversed(arrets) for p in a["colis"]
        ],
        "valide": not violations, "violations": violations,
    }


def convert(instance_path, sol_path, colis=None, seed=42):
    inst = read_instance(instance_path)
    routes, cost_sol = read_solution(sol_path)
    if colis is None:
        colis = {}  # les instances n'ont pas de colis : seule la demande compte

    vus = [cid for r in routes for cid in r]
    n = len(inst["clients"]) - 1
    erreurs = []
    if sorted(vus) != list(range(1, n + 1)):
        manquants = sorted(set(range(1, n + 1)) - set(vus))
        doubles = sorted({c for c in vus if vus.count(c) > 1})
        erreurs.append(f"clients manquants {manquants[:10]}, "
                       f"en double {doubles[:10]}")
    inconnus = [c for c in vus if c not in inst["clients"]]
    if inconnus:
        raise ErreurBackend(
            "validation",
            f"le .sol cite des clients absents de l'instance : {inconnus[:10]} "
            "(mauvais couple instance / solution ?)")
    if len(routes) > inst["nb_vehicules"]:
        erreurs.append(f"{len(routes)} routes > {inst['nb_vehicules']} véhicules")

    tournees = [build_route(k, r, inst, colis) for k, r in enumerate(routes, 1)]
    cout = round(sum(t["distance"] for t in tournees), 3)
    for t in tournees:
        erreurs += [f"tournée {t['id']} : {v}" for v in t["violations"]]
    if cost_sol is not None and abs(cost_sol - cout) > 0.5:
        erreurs.append(f".sol annonce {cost_sol}, recalcul {cout}")

    cout_bench = cout_benchmark(inst, routes, convention_benchmark(instance_path))
    return {
        "instance": inst["nom"], "nb_clients": n,
        "cout_convention_benchmark": round(cout_bench, 3),
        "nb_vehicules_disponibles": inst["nb_vehicules"],
        "nb_vehicules_utilises": len(tournees),
        "limite_depassee": len(tournees) > inst["nb_vehicules"],
        "distance_totale": cout, "cout_annonce": cost_sol,
        "valide": not erreurs, "erreurs": erreurs, "tournees": tournees,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("instance")
    ap.add_argument("solution")
    ap.add_argument("-o", "--output")
    ap.add_argument("--colis", help="JSON {client_id: [{id, poids}]}")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--demo-colis", action="store_true",
                    help="génère des colis fictifs (démonstration seulement)")
    a = ap.parse_args()

    colis = None
    if a.colis:
        with open(a.colis, encoding="utf-8") as f:
            colis = {int(k): v for k, v in json.load(f).items()}

    if a.demo_colis and colis is None:
        colis = make_colis(read_instance(a.instance), a.seed)
    try:
        res = convert(a.instance, a.solution, colis, a.seed)
    except ErreurBackend as e:
        print(f"ERREUR [{e.etape}] {e.message}", file=sys.stderr)
        return 2
    out = json.dumps(res, ensure_ascii=False, indent=2)
    if a.output:
        with open(a.output, "w", encoding="utf-8") as f:
            f.write(out)
    else:
        print(out)
    print(f"{res['instance']} : {res['nb_vehicules_utilises']} tournées, "
          f"distance {res['distance_totale']}, "
          f"{'VALIDE' if res['valide'] else 'INVALIDE'}", file=sys.stderr)
    for e in res["erreurs"][:10]:
        print("  !", e, file=sys.stderr)
    return 0 if res["valide"] else 1


if __name__ == "__main__":
    sys.exit(main())
