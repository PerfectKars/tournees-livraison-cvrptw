"""Pont entre le front-end et le solveur.

Le front appelle POST /api/optimize et attend un dictionnaire `resultats`
(routes, route_details, cost, ...). Cette fonction garde exactement ce format
mais fait calculer les tournées par le solveur Julia.

Instance avec matrice routière OSRM (mode 'france') : la matrice des durées
est écrite dans <instance>.matrix, que le solveur Julia lit à la place des
distances euclidiennes. Le solveur minimise alors les durées de trajet (une
seule matrice) ; les kilomètres affichés sont recalculés ensuite avec la
matrice OSRM. Sans matrice, le solveur travaille à vol d'oiseau comme avant.
"""
import shutil
import tempfile
import time
from pathlib import Path

import co2
from julia_runner import UN_SEUL_CALCUL, lancer_julia
from sol_to_json import read_solution, write_matrix, write_solomon

from .alns import prepare_instance, summarize_route

CHAINES = 4
# Itérations par chaîne : 200 par client, entre 5 000 et 60 000. Mesuré sur
# 5 instances (100 à 1000 clients, 2 graines) : les petites instances gagnent
# encore à 200 itérations par client (R1_2_1 : écart 4,0 % -> 2,2 %), alors que
# les grandes plafonnent dès 50 à 100 par client (RC2_10_10 : 7,5 % à 15 s,
# 7,9 % à 58 s). Le plafond de 60 000 garde environ 18 s pour 1000 clients.
# Le nombre envoyé par le front est ignoré : il était prévu pour l'ancien
# solveur Python (5 à 500), bien trop faible pour Julia. Le nombre réellement
# utilisé est renvoyé dans le résultat.
ITER_PAR_CLIENT = 200
ITER_MIN, ITER_MAX = 5_000, 60_000


def iterations_julia(nb_clients):
    return max(ITER_MIN, min(ITER_MAX, ITER_PAR_CLIENT * nb_clients))


def run_alns(instance, iterations=500, removal_rate=0.15, seed=None):
    return run_julia(instance, seed if seed is not None else 42)


def run_julia(instance, seed):
    customers, depot, capacity, vehicle_count, travel_data = prepare_instance(instance)

    # Le solveur veut des ids consécutifs 0..n (0 = dépôt) : on renumérote
    # les clients dans l'ordre et on garde la correspondance pour le retour.
    ids = [c["id"] for c in instance["clients"]]
    nouveau_id = {cid: k for k, cid in enumerate(ids, start=1)}
    ancien_id = {k: cid for cid, k in nouveau_id.items()}

    def fiche(point, k):
        return {"id": k, "x": point["x"], "y": point["y"],
                "demande": int(point["demand"]), "ouverture": point["ready"],
                "fermeture": point["due"], "service": point["service"]}

    inst = {"nom": instance["nom_instance"], "nb_vehicules": vehicle_count,
            "capacite": int(capacity),
            "clients": {0: fiche(depot, 0),
                        **{nouveau_id[cid]: fiche(customers[cid], nouveau_id[cid])
                           for cid in ids}}}

    work = Path(tempfile.mkdtemp(prefix="front_"))
    try:
        fichier = work / "instance.txt"
        iterations = iterations_julia(len(ids))
        write_solomon(inst, fichier)
        if travel_data:
            # Lignes dans l'ordre des ids du solveur : dépôt, puis clients.
            write_matrix(travel_data["duration_min"], [depot["id"], *ids],
                         fichier.with_suffix(".matrix"))
        t0 = time.time()
        with UN_SEUL_CALCUL:
            sol = lancer_julia(work, fichier, iterations, CHAINES, seed)
        routes_k, _ = read_solution(sol)
        duree = round(time.time() - t0, 2)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    routes = [[ancien_id[k] for k in r] for r in routes_k]
    details = []
    for r in routes:
        d = summarize_route(r, customers, depot, travel_data)
        d["capacity"] = capacity
        d["co2_kg"] = co2.co2_kg(d["distance_km"])
        details.append(d)

    return {
        "routes": routes,
        "route_details": details,
        "cost": round(sum(d["distance_km"] for d in details), 2),
        "number_of_routes": len(routes),
        "co2": co2.resume(details),
        # Le solveur rend toujours son meilleur résultat : si la flotte
        # annoncée est insuffisante, le front peut l'afficher.
        "limite_depassee": len(routes) > vehicle_count,
        "nombre_vehicules_disponibles": vehicle_count,
        "number_of_customers": len(customers),
        "iterations": iterations,
        "history": [], "destroy_weights": [], "repair_weights": [],
        "solver": "julia", "solver_seconds": duree,
    }
