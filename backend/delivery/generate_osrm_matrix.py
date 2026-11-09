# -*- coding: utf-8 -*-
"""
Construit une matrice complète distance/durée routière avec OSRM.

Entrée :
  backend/data/france_clients.json

Sortie :
  backend/data/osrm_matrix.json

Le script utilise le serveur public de démonstration OSRM. Pour un prototype,
fractionner la matrice en petits blocs réduit la taille des requêtes. Pour un
usage régulier ou en production, utiliser une instance OSRM dédiée ou un
fournisseur de routage avec une offre adaptée.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
INPUT_FILE = DATA_DIR / "france_clients.json"
OUTPUT_FILE = DATA_DIR / "osrm_matrix.json"

OSRM_BASE_URL = "https://router.project-osrm.org"
BLOCK_SIZE = 20
PAUSE_SECONDS = 0.7
MAX_RETRIES = 3


def load_points():
    if not INPUT_FILE.exists():
        raise FileNotFoundError(
            f"Fichier introuvable : {INPUT_FILE}\n"
            "Vérifie que france_clients.json se trouve dans backend/data/."
        )

    dataset = json.loads(INPUT_FILE.read_text(encoding="utf-8"))
    depot = dataset["depot"]
    customers = dataset["clients"]

    points = [{
        "id": int(depot["id"]),
        "name": depot.get("name", "Dépôt"),
        "lat": float(depot.get("lat", depot.get("latitude"))),
        "lon": float(depot.get("lon", depot.get("longitude"))),
        "type": "depot",
    }]

    for customer in customers:
        points.append({
            "id": int(customer["id"]),
            "name": customer.get("name", f"Client {customer['id']}"),
            "lat": float(customer.get("lat", customer.get("latitude"))),
            "lon": float(customer.get("lon", customer.get("longitude"))),
            "type": "client",
        })

    ids = [point["id"] for point in points]
    if len(ids) != len(set(ids)):
        raise ValueError("Les identifiants des clients et du dépôt doivent être uniques.")

    return dataset, points


def chunks(values, size):
    for start in range(0, len(values), size):
        yield values[start:start + size]


def call_osrm_table(source_points, destination_points):
    # OSRM attend longitude,latitude.
    all_points = source_points + destination_points
    coordinate_string = ";".join(
        f"{point['lon']:.7f},{point['lat']:.7f}" for point in all_points
    )

    source_indices = ";".join(str(i) for i in range(len(source_points)))
    destination_indices = ";".join(
        str(len(source_points) + i) for i in range(len(destination_points))
    )

    url = (
        f"{OSRM_BASE_URL}/table/v1/driving/{quote(coordinate_string, safe=';,.-')}"
        f"?sources={source_indices}"
        f"&destinations={destination_indices}"
        "&annotations=distance,duration"
    )

    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            request = Request(
                url,
                headers={"User-Agent": "DeliveryOptimizer-educational-project/1.0"}
            )
            with urlopen(request, timeout=120) as response:
                payload = json.loads(response.read().decode("utf-8"))

            if payload.get("code") != "Ok":
                raise RuntimeError(f"Réponse OSRM : {payload}")

            return payload["distances"], payload["durations"]

        except (URLError, HTTPError, TimeoutError, json.JSONDecodeError, KeyError, RuntimeError) as exc:
            last_error = exc
            if attempt < MAX_RETRIES:
                time.sleep(2 * attempt)

    raise RuntimeError(f"Échec de la requête OSRM après {MAX_RETRIES} essais : {last_error}")


def main():
    dataset, points = load_points()
    point_ids = [point["id"] for point in points]
    distance_km = {str(point_id): {} for point_id in point_ids}
    duration_min = {str(point_id): {} for point_id in point_ids}

    source_blocks = list(chunks(points, BLOCK_SIZE))
    destination_blocks = list(chunks(points, BLOCK_SIZE))
    total_requests = len(source_blocks) * len(destination_blocks)
    request_number = 0

    print(f"Points à traiter : {len(points)} (1 dépôt + {len(points) - 1} clients)")
    print(f"Calcul de la matrice routière : {total_requests} requêtes OSRM.")
    print("Les coordonnées sont envoyées dans l'ordre longitude,latitude.")

    for source_block in source_blocks:
        for destination_block in destination_blocks:
            request_number += 1
            print(f"[{request_number}/{total_requests}] Calcul des trajets...")

            distances, durations = call_osrm_table(
                source_block, destination_block
            )

            for i, source in enumerate(source_block):
                for j, destination in enumerate(destination_block):
                    distance_m = distances[i][j]
                    duration_s = durations[i][j]

                    if distance_m is None or duration_s is None:
                        raise RuntimeError(
                            "OSRM n'a pas trouvé de trajet routier entre "
                            f"{source['id']} et {destination['id']}."
                        )

                    distance_km[str(source["id"])][str(destination["id"])] = round(
                        float(distance_m) / 1000.0, 3
                    )
                    duration_min[str(source["id"])][str(destination["id"])] = round(
                        float(duration_s) / 60.0, 2
                    )

            time.sleep(PAUSE_SECONDS)

    result = {
        "source": "OSRM public demo server",
        "profile": "driving",
        "distance_unit": "km",
        "duration_unit": "min",
        "number_of_points": len(points),
        "point_ids": point_ids,
        "points": points,
        "distance_km": distance_km,
        "duration_min": duration_min,
        "note": (
            "Distances et durées calculées sur le réseau routier disponible via OSRM. "
            "Les durées sont des estimations de routage, sans information de trafic en temps réel."
        ),
    }

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    print("\nMatrice créée avec succès :")
    print(OUTPUT_FILE)
    print(f"Nombre de points : {len(points)}")
    print(f"Nombre de couples origine-destination : {len(points) ** 2}")
    print(
        "Exemple Nancy -> premier client :",
        distance_km["0"].get("1"), "km,",
        duration_min["0"].get("1"), "min"
    )
    print(
        "\nAttention : cette matrice est calculée, mais elle n'est pas encore "
        "automatiquement injectée dans l'instance ALNS. L'intégration sera l'étape suivante."
    )


if __name__ == "__main__":
    main()
