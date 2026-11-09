#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Construit un dataset de démonstration de 100 points de livraison en France.
Les coordonnées proviennent d'OpenStreetMap via Overpass API.
Les demandes, fenêtres horaires et temps de service sont des données de
simulation, pas des informations commerciales réelles.
"""
from __future__ import annotations

import json
import math
import random
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "data" / "france_clients.json"

# Total = 100 clients. Les villes sont des zones de collecte OSM,
# pas des dépôts : le seul dépôt reste Nancy.
CITIES = [
    {"name": "Paris", "lat": 48.8566, "lon": 2.3522, "count": 24},
    {"name": "Nancy", "lat": 48.6921, "lon": 6.1844, "count": 12},
    {"name": "Metz", "lat": 49.1193, "lon": 6.1757, "count": 10},
    {"name": "Strasbourg", "lat": 48.5734, "lon": 7.7521, "count": 10},
    {"name": "Lyon", "lat": 45.7640, "lon": 4.8357, "count": 12},
    {"name": "Lille", "lat": 50.6292, "lon": 3.0573, "count": 8},
    {"name": "Bordeaux", "lat": 44.8378, "lon": -0.5792, "count": 8},
    {"name": "Nantes", "lat": 47.2184, "lon": -1.5536, "count": 6},
    {"name": "Toulouse", "lat": 43.6047, "lon": 1.4442, "count": 6},
    {"name": "Marseille", "lat": 43.2965, "lon": 5.3698, "count": 4},
]

DEPOT = {
    "id": 0,
    "name": "Dépôt central - Nancy",
    "city": "Nancy",
    "lat": 48.6921,
    "lon": 6.1844,
    "demand": 0,
    "ready": 180,      # 03:00, minutes depuis minuit
    "due": 2880,        # horizon de simulation de 48 h
    "service": 0,
}

VEHICLE_COUNT = 10
VEHICLE_CAPACITY = 200
RANDOM_SEED = 2026
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))

def build_query(city):
    lat, lon = city["lat"], city["lon"]
    radius = 7000
    return f"""
[out:json][timeout:90];
(
  nwr(around:{radius},{lat},{lon})["name"]["shop"];
  nwr(around:{radius},{lat},{lon})["name"]["office"];
  nwr(around:{radius},{lat},{lon})["name"]["amenity"~"pharmacy|hospital|clinic|school|university|college|restaurant|fast_food|bank|post_office|fuel|library|community_centre"];
);
out center tags;
"""

def fetch_overpass(city):
    query = build_query(city).strip()
    body = urlencode({"data": query}).encode("utf-8")
    last_error = None

    for endpoint in OVERPASS_ENDPOINTS:
        try:
            req = Request(
                endpoint,
                data=body,
                headers={
                    "User-Agent": "DeliveryOptimizer-educational-project/1.0",
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                },
                method="POST",
            )
            with urlopen(req, timeout=120) as response:
                payload = json.loads(response.read().decode("utf-8"))
            return payload.get("elements", [])
        except (URLError, HTTPError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            time.sleep(2)

    raise RuntimeError(
        f"Impossible de récupérer les lieux OSM pour {city['name']}. "
        f"Dernière erreur : {last_error}"
    )

def element_coordinates(element):
    if "lat" in element and "lon" in element:
        return float(element["lat"]), float(element["lon"])
    center = element.get("center") or {}
    if "lat" in center and "lon" in center:
        return float(center["lat"]), float(center["lon"])
    return None, None

def element_label(tags, city_name):
    name = tags.get("name", "Point de livraison")
    street = tags.get("addr:street")
    number = tags.get("addr:housenumber")
    postcode = tags.get("addr:postcode")
    address = " ".join(part for part in [number, street] if part)
    if postcode:
        address = f"{address}, {postcode}" if address else postcode
    return name, address, tags.get("shop") or tags.get("amenity") or tags.get("office") or "poi"

def collect_candidates(city):
    elements = fetch_overpass(city)
    candidates = []
    seen = set()

    for element in elements:
        key = (element.get("type"), element.get("id"))
        if key in seen:
            continue
        seen.add(key)

        tags = element.get("tags") or {}
        lat, lon = element_coordinates(element)
        if lat is None or lon is None or not tags.get("name"):
            continue

        # Garde-fou : le point doit rester dans le rayon de collecte.
        if haversine_km(city["lat"], city["lon"], lat, lon) > 8.5:
            continue

        name, address, category = element_label(tags, city["name"])
        candidates.append({
            "osm_type": element.get("type"),
            "osm_id": element.get("id"),
            "name": name,
            "address": address,
            "category": category,
            "city": city["name"],
            "lat": round(lat, 7),
            "lon": round(lon, 7),
        })

    return candidates

def choose_spread(candidates, count, rng):
    """Sélectionne des points répartis dans la zone, pas 100 fois le même secteur."""
    if len(candidates) < count:
        raise RuntimeError(
            f"Seulement {len(candidates)} lieux OSM trouvés, {count} nécessaires."
        )

    pool = candidates[:]
    first = rng.randrange(len(pool))
    selected = [pool.pop(first)]

    while len(selected) < count:
        best_index = None
        best_distance = -1.0

        for i, candidate in enumerate(pool):
            nearest = min(
                haversine_km(
                    candidate["lat"], candidate["lon"],
                    chosen["lat"], chosen["lon"]
                )
                for chosen in selected
            )
            if nearest > best_distance:
                best_distance = nearest
                best_index = i

        selected.append(pool.pop(best_index))

    return selected

def estimate_drive_minutes_from_nancy(lat, lon):
    # Estimation provisoire pour positionner les créneaux.
    # Elle sera remplacée par les durées OSRM lors de la création de la matrice.
    straight_km = haversine_km(DEPOT["lat"], DEPOT["lon"], lat, lon)
    road_km_estimate = straight_km * 1.30
    return int((road_km_estimate / 70.0) * 60 + 20)

def make_time_window(lat, lon, rng):
    # Horizon de simulation 48 h. Les fenêtres sont synthétiques et décalées
    # selon l'éloignement du dépôt pour éviter des horaires irréalistes à 08:00
    # pour les clients très éloignés.
    drive_min = estimate_drive_minutes_from_nancy(lat, lon)
    expected_arrival = DEPOT["ready"] + drive_min
    ready = max(360, expected_arrival - rng.randint(15, 60))
    ready += rng.randint(0, 30)
    due = min(2760, ready + rng.randint(360, 540))
    if due <= ready:
        due = ready + 360
    return ready, due

def main():
    rng = random.Random(RANDOM_SEED)
    customers = []
    next_id = 1

    print("Récupération de lieux nommés depuis OpenStreetMap...")
    for index, city in enumerate(CITIES):
        print(f"[{index + 1}/{len(CITIES)}] {city['name']} : recherche de lieux...")
        candidates = collect_candidates(city)
        selected = choose_spread(candidates, city["count"], rng)

        for place in selected:
            ready, due = make_time_window(place["lat"], place["lon"], rng)
            customers.append({
                "id": next_id,
                "name": place["name"],
                "address": place["address"],
                "city": place["city"],
                "category": place["category"],
                "lat": place["lat"],
                "lon": place["lon"],
                "demand": rng.randint(10, 20),
                "ready": ready,
                "due": due,
                "service": rng.randint(10, 25),
                "osm": {
                    "type": place["osm_type"],
                    "id": place["osm_id"],
                },
            })
            next_id += 1

        # Respecte un intervalle entre les requêtes publiques.
        time.sleep(1.5)

    if len(customers) != 100:
        raise RuntimeError(f"Le dataset contient {len(customers)} clients au lieu de 100.")

    total_demand = sum(c["demand"] for c in customers)
    dataset = {
        "nom_instance": "FRANCE_100",
        "source_geographique": "OpenStreetMap via Overpass API",
        "attribution": "© OpenStreetMap contributors",
        "note": (
            "Les lieux et coordonnées sont issus d'OpenStreetMap. "
            "Demandes, fenêtres horaires et temps de service sont synthétiques. "
            "Les fenêtres utilisent une estimation provisoire du trajet depuis Nancy; "
            "elles devront être recalibrées avec les durées routières OSRM."
        ),
        "nombre_vehicules": VEHICLE_COUNT,
        "capacite_vehicule": VEHICLE_CAPACITY,
        "horizon_minutes": 2880,
        "depot": DEPOT,
        "nombre_clients": len(customers),
        "demande_totale": total_demand,
        "clients": customers,
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(dataset, ensure_ascii=False, indent=2), encoding="utf-8")
    print()
    print(f"Dataset créé : {OUTPUT}")
    print(f"Clients : {len(customers)}")
    print(f"Demande totale : {total_demand} / capacité totale disponible : {VEHICLE_COUNT * VEHICLE_CAPACITY}")
    print("Attention : les fenêtres horaires sont provisoires jusqu'au calcul OSRM.")

if __name__ == "__main__":
    main()
