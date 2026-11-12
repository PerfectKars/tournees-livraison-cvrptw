"""Recherche tabou pour le CVRPTW : solveur de comparaison, volontairement simple.

Principe (en 3 temps) :
  1. Solution de départ : plus proche voisin, en respectant capacité et fenêtres.
  2. À chaque itération, on tire au hasard des mouvements (déplacer un client,
     échanger deux clients) et on applique le meilleur, MÊME s'il dégrade la
     solution : cela permet de sortir des minima locaux.
  3. Pour ne pas tourner en rond, un client qui vient de bouger est « tabou » :
     on ne le rebouge pas pendant quelques itérations, sauf si le mouvement
     bat le meilleur résultat connu (critère d'aspiration).

Objectif : la distance totale, plus une prime par route utilisée (pour viser
peu de camions, comme le solveur Julia). Pas de calcul incrémental ni de structure
rapide : on recalcule les routes touchées en entier.

Usage : python recherche_tabou.py instance.txt sortie.sol [--iterations N]
                                   [--temps S] [--seed N]
"""
import argparse
import math
import random
import sys
import time

from sol_to_json import ErreurBackend, read_instance

EPS = 1e-6


class Probleme:
    def __init__(self, inst):
        self.c = inst["clients"]            # dict id -> fiche (x, y, demande, ...)
        self.capacite = inst["capacite"]
        self.n = len(self.c)                # dépôt compris (id 0)
        self.d = [[math.hypot(self.c[i]["x"] - self.c[j]["x"],
                              self.c[i]["y"] - self.c[j]["y"])
                   for j in range(self.n)] for i in range(self.n)]
        # Prime pour supprimer une route : le coût de la plus longue tournée à un
        # seul client. Ainsi vider une route vaut mieux que gagner quelques km.
        self.prime = 2 * max(self.d[0])

    def cout_route(self, route):
        """Distance de la route (dépôt -> clients -> dépôt), ou None si elle
        viole la capacité ou une fenêtre de temps."""
        depot = self.c[0]
        t, charge, prec, dist = depot["ouverture"], 0, 0, 0.0
        for i in route:
            c = self.c[i]
            dist += self.d[prec][i]
            t = max(t + self.d[prec][i], c["ouverture"])   # on attend si trop tôt
            if t > c["fermeture"] + EPS:
                return None
            t += c["service"]
            charge += c["demande"]
            prec = i
        if charge > self.capacite or t + self.d[prec][0] > depot["fermeture"] + EPS:
            return None
        return dist + self.d[prec][0]

    def solution_initiale(self):
        """Plus proche voisin : on remplit une route tant qu'un client rentre."""
        restants, routes = set(range(1, self.n)), []
        while restants:
            route = []
            while True:
                ok = [i for i in restants if self.cout_route(route + [i]) is not None]
                if not ok:
                    break
                prec = route[-1] if route else 0
                i = min(ok, key=lambda j: self.d[prec][j])
                route.append(i)
                restants.remove(i)
            if not route:
                raise ErreurBackend("solveur", f"client {min(restants)} infaisable "
                                    "même seul dans une route")
            routes.append(route)
        return routes

    def mouvement(self, routes, couts, rng):
        """Tire un mouvement au hasard. Renvoie (delta de l'objectif, nouvelles routes,
        nouveaux coûts, clients déplacés) ou None s'il est infaisable."""
        a, b = rng.randrange(len(routes)), rng.randrange(len(routes))
        i = rng.randrange(len(routes[a]))
        x = routes[a][i]
        if rng.random() < 0.5:                       # déplacer x vers la route b
            ra = routes[a][:i] + routes[a][i + 1:]
            base = ra if a == b else routes[b]
            essais = [base[:p] + [x] + base[p:] for p in range(len(base) + 1)]
            valides = [(self.cout_route(r), r) for r in essais]
            valides = [(c, r) for c, r in valides if c is not None]
            if not valides:                          # nulle part où le placer
                return None
            placee = min(valides, key=lambda v: v[0])[1]    # meilleure position
            neuf = {a: placee} if a == b else {a: ra, b: placee}
            bouges = [x]
        else:                                        # échanger x avec un client de b
            if a == b:
                return None
            j = rng.randrange(len(routes[b]))
            y = routes[b][j]
            ra, rb = routes[a][:], routes[b][:]
            ra[i], rb[j] = y, x
            neuf, bouges = {a: ra, b: rb}, [x, y]
        nouveaux = {k: self.cout_route(r) for k, r in neuf.items()}
        if None in nouveaux.values():
            return None
        delta = sum(nouveaux.values()) - sum(couts[k] for k in neuf)
        vides = sum(1 for r in neuf.values() if not r)
        return delta - self.prime * vides, neuf, nouveaux, bouges


def resoudre(inst, iterations=20000, temps_max=60.0, seed=42,
             echantillon=50, duree_tabou=10):
    """Lance la recherche tabou. Renvoie (routes, statistiques)."""
    debut, rng = time.time(), random.Random(seed)
    pb = Probleme(inst)
    routes = pb.solution_initiale()
    couts = [pb.cout_route(r) for r in routes]
    courant = sum(couts) + pb.prime * len(routes)    # objectif suivi
    meilleur, meilleures_routes = courant, [r[:] for r in routes]
    depart, tabou, it = sum(couts), {}, 0
    # Courbe de convergence : [secondes, véhicules, distance] à chaque
    # amélioration du meilleur (sert aux graphes de la page Analyses).
    trace = [[0.0, len(routes), round(depart, 2)]]

    for it in range(1, iterations + 1):
        if time.time() - debut > temps_max:
            break
        choix = None
        for _ in range(echantillon):                 # voisinage échantillonné
            m = pb.mouvement(routes, couts, rng)
            if m is None:
                continue
            delta, _, _, bouges = m
            est_tabou = any(tabou.get(x, 0) > it for x in bouges)
            aspiration = courant + delta < meilleur - 1e-9
            if (not est_tabou or aspiration) and (choix is None or delta < choix[0]):
                choix = m
        if choix is None:
            continue
        delta, neuf, nouveaux, bouges = choix
        for k, r in neuf.items():                    # on applique le mouvement
            routes[k], couts[k] = r, nouveaux[k]
        courant += delta
        for x in bouges:                             # ces clients deviennent tabous
            tabou[x] = it + duree_tabou + rng.randint(0, 5)
        if any(not r for r in routes):               # route vidée : un camion de moins
            routes = [r for r in routes if r]
            couts = [pb.cout_route(r) for r in routes]
        if courant < meilleur - 1e-9:
            meilleur, meilleures_routes = courant, [r[:] for r in routes]
            trace.append([round(time.time() - debut, 2), len(routes),
                          round(sum(couts), 2)])

    return meilleures_routes, {
        "iterations": it, "cout_depart": round(depart, 3),
        "cout": round(sum(pb.cout_route(r) for r in meilleures_routes), 3),
        "secondes": round(time.time() - debut, 2), "trace": trace}


def ecrire_sol(routes, chemin):
    """Même format de routes que le solveur Julia : 'Route #k: ids'."""
    with open(chemin, "w", encoding="utf-8") as f:
        for k, r in enumerate(routes, 1):
            f.write(f"Route #{k}: {' '.join(map(str, r))}\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("instance")
    ap.add_argument("sortie")
    ap.add_argument("--iterations", type=int, default=20000)
    ap.add_argument("--temps", type=float, default=60.0, help="secondes maximum")
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()
    try:
        routes, stats = resoudre(read_instance(a.instance), a.iterations,
                                 a.temps, a.seed)
    except ErreurBackend as e:
        print(f"ERREUR [{e.etape}] {e.message}", file=sys.stderr)
        return 2
    ecrire_sol(routes, a.sortie)
    print(f"{len(routes)} tournées, coût {stats['cout']} "
          f"(départ {stats['cout_depart']}), {stats['iterations']} itérations, "
          f"{stats['secondes']} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
