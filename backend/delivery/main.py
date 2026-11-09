from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import json
import re
from urllib.request import urlopen
from urllib.parse import quote

from .solver_bridge import run_alns  # Julia (ou ALNS Python si matrice OSRM)

app = FastAPI(
    title="DeliveryOptimizer",
    description="API d'optimisation des tournées de livraison",
    version="1.1"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_DIR = Path(__file__).parent / "data"
SOLOMON_FILE = DATA_DIR / "C1_2_1.txt"
FRANCE_FILE = DATA_DIR / "france_clients.json"
OSRM_MATRIX_FILE = DATA_DIR / "osrm_matrix.json"
PETITE_FILE = DATA_DIR / "petite_20.json"
DEMANDE_FILE = DATA_DIR / "demande.json"
HORAIRES_FILE = DATA_DIR / "horaires.json"
GRANDE_FILE = DATA_DIR / "grande.json"

# ==========================================
# CATALOGUE CENTRALISE DES INSTANCES
# ==========================================

INSTANCES = {
    "solomon": {
        "id": "solomon",
        "nom": "Solomon C1_2_1",
        "description": "Instance benchmark classique de tournées de livraison.",
        "categorie": "Benchmark",
        "nombre_clients": 200,
        "disponible": True
    },

    "france": {
        "id": "france",
        "nom": "France - 100 clients",
        "description": "Instance géographique avec distances routières calculées par OSRM.",
        "categorie": "Géographique",
        "nombre_clients": 100,
        "disponible": True
    },

    "petite": {
        "id": "petite",
        "nom": "Petite livraison",
        "description": "Petite instance pour tester les tournées sur un réseau réduit.",
        "categorie": "Test",
        "nombre_clients": 20,
        "disponible": True
    },

    "demande": {
        "id": "demande",
        "nom": "Forte demande",
        "description": "Instance conçue pour tester les contraintes de capacité.",
        "categorie": "Test",
        "nombre_clients": 50,
        "disponible": True
    },

    "horaires": {
        "id": "horaires",
        "nom": "Fenêtres horaires",
        "description": "Instance conçue pour tester les contraintes temporelles.",
        "categorie": "Test",
        "nombre_clients": 30,
        "disponible": True
    },
    "grande": {
        "id": "grande",
        "nom": "Grande capacité",
        "description": "Instance conçue pour tester les contraintes de grande capacité.",
        "categorie": "Test",
        "nombre_clients": 200,
        "disponible": True
    }
    
}


@app.get("/")
def accueil():
    return {
        "message": "Bienvenue sur DeliveryOptimizer !",
        "status": "Backend opérationnel"
    }


@app.get("/api/test")
def test():
    return {"message": "La communication avec le backend fonctionne !"}

# ==========================================
# API : LISTE DES INSTANCES
# ==========================================

@app.get("/api/instances")
def lister_instances():
    return {
        "status": "success",
        "total": len(INSTANCES),
        "instances": list(INSTANCES.values())
    }


def charger_instance_solomon():
    if not SOLOMON_FILE.exists():
        raise HTTPException(
            status_code=404,
            detail="Le fichier C1_2_1.txt est introuvable dans backend/data/"
        )

    lignes = SOLOMON_FILE.read_text(encoding="utf-8").splitlines()
    nombre_vehicules = None
    capacite = None

    for i, ligne in enumerate(lignes):
        if "NUMBER" in ligne.upper() and "CAPACITY" in ligne.upper():
            for suivante in lignes[i + 1:i + 5]:
                valeurs = re.findall(r"-?\d+(?:\.\d+)?", suivante)
                if len(valeurs) == 2:
                    nombre_vehicules = int(float(valeurs[0]))
                    capacite = float(valeurs[1])
                    break
            break

    clients = []
    for ligne in lignes:
        valeurs = re.findall(r"-?\d+(?:\.\d+)?", ligne)
        if len(valeurs) == 7:
            valeurs = [float(v) for v in valeurs]
            clients.append({
                "id": int(valeurs[0]),
                "x": valeurs[1],
                "y": valeurs[2],
                "demand": valeurs[3],
                "ready": valeurs[4],
                "due": valeurs[5],
                "service": valeurs[6]
            })

    if not clients:
        raise HTTPException(
            status_code=500,
            detail="Aucune ligne client valide n'a été trouvée dans Solomon."
        )

    depot = next((c for c in clients if c["id"] == 0), None)
    if depot is None:
        raise HTTPException(status_code=500, detail="Dépôt Solomon introuvable.")

    customers = [c for c in clients if c["id"] != 0]
    return {
        "nom_instance": "C1_2_1",
        "mode": "solomon",
        "nombre_vehicules": nombre_vehicules,
        "capacite_vehicule": capacite,
        "nombre_clients": len(customers),
        "depot": depot,
        "clients": customers
    }


def charger_instance_france():
    if not FRANCE_FILE.exists():
        raise HTTPException(
            status_code=404,
            detail="france_clients.json est introuvable dans backend/data/."
        )
    if not OSRM_MATRIX_FILE.exists():
        raise HTTPException(
            status_code=404,
            detail="osrm_matrix.json est introuvable. Génère d'abord la matrice OSRM."
        )

    try:
        dataset = json.loads(FRANCE_FILE.read_text(encoding="utf-8"))
        travel_data = json.loads(OSRM_MATRIX_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Impossible de lire les données France : {exc}"
        )

    depot = dataset.get("depot")
    customers = dataset.get("clients", [])
    if not depot or len(customers) != 100:
        raise HTTPException(
            status_code=400,
            detail="Le dataset France doit contenir un dépôt et exactement 100 clients."
        )

    expected_ids = {str(depot["id"])} | {str(c["id"]) for c in customers}
    matrix_ids = set(travel_data.get("distance_km", {}).keys())
    duration_ids = set(travel_data.get("duration_min", {}).keys())

    if expected_ids != matrix_ids or expected_ids != duration_ids:
        raise HTTPException(
            status_code=400,
            detail=(
                "La matrice OSRM ne correspond pas au dataset France. "
                "Régénère osrm_matrix.json à partir de france_clients.json."
            )
        )

    # Vérifie que chaque origine possède une distance et une durée vers chaque destination.
    for origin_id in expected_ids:
        distance_row = travel_data["distance_km"].get(origin_id, {})
        duration_row = travel_data["duration_min"].get(origin_id, {})
        if not expected_ids.issubset(set(distance_row)) or not expected_ids.issubset(set(duration_row)):
            raise HTTPException(
                status_code=400,
                detail=f"Matrice OSRM incomplète pour le point {origin_id}."
            )

    return {
        "nom_instance": "FRANCE_100",
        "mode": "france",
        "nombre_vehicules": int(dataset["nombre_vehicules"]),
        "capacite_vehicule": float(dataset["capacite_vehicule"]),
        "nombre_clients": len(customers),
        "depot": depot,
        "clients": customers,
        "travel_data": travel_data,
        "source_geographique": dataset.get("source_geographique"),
        "attribution": dataset.get("attribution"),
        "note": dataset.get("note")
    }

def charger_instance_petite():
    if not PETITE_FILE.exists():
        raise HTTPException(
            status_code=404,
            detail="petite_20.json est introuvable dans backend/data/."
        )

    try:
        instance = json.loads(
            PETITE_FILE.read_text(encoding="utf-8")
        )
    except (json.JSONDecodeError, OSError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Impossible de lire petite_20.json : {exc}"
        )

    depot = instance.get("depot")
    clients = instance.get("clients", [])

    if not depot or len(clients) != 20:
        raise HTTPException(
            status_code=400,
            detail="L'instance PETITE_20 doit contenir un dépôt et exactement 20 clients."
        )

    if len({c["id"] for c in clients}) != 20:
        raise HTTPException(
            status_code=400,
            detail="Les identifiants des clients doivent être uniques."
        )

    return {
        "nom_instance": "PETITE_20",
        "mode": "petite",
        "nombre_vehicules": int(instance["nombre_vehicules"]),
        "capacite_vehicule": float(instance["capacite_vehicule"]),
        "nombre_clients": len(clients),
        "depot": depot,
        "clients": clients
    }

def charger_instance_synthetique(fichier, nom, mode, nombre_attendu):
    if not fichier.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Le fichier {fichier.name} est introuvable dans backend/data/."
        )

    try:
        instance = json.loads(
            fichier.read_text(encoding="utf-8")
        )
    except (json.JSONDecodeError, OSError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Impossible de lire {fichier.name} : {exc}"
        )

    depot = instance.get("depot")
    clients = instance.get("clients", [])

    if not depot or len(clients) != nombre_attendu:
        raise HTTPException(
            status_code=400,
            detail=(
                f"L'instance {nom} doit contenir un dépôt "
                f"et exactement {nombre_attendu} clients."
            )
        )

    ids = [c.get("id") for c in clients]

    if len(set(ids)) != nombre_attendu or 0 in ids:
        raise HTTPException(
            status_code=400,
            detail=f"Les identifiants des clients de {nom} sont invalides."
        )

    return {
        "nom_instance": nom,
        "mode": mode,
        "nombre_vehicules": int(instance["nombre_vehicules"]),
        "capacite_vehicule": float(instance["capacite_vehicule"]),
        "nombre_clients": len(clients),
        "depot": depot,
        "clients": clients
    }


def charger_instance_demande():
    return charger_instance_synthetique(
        DEMANDE_FILE, "FORTE_DEMANDE", "demande", 50
    )


def charger_instance_horaires():
    return charger_instance_synthetique(
        HORAIRES_FILE, "FENETRES_HORAIRES", "horaires", 30
    )


def charger_instance_grande():
    return charger_instance_synthetique(
        GRANDE_FILE, "GRANDE_CAPACITE", "grande", 200
    )

def charger_instance(mode="solomon"):
    mode = (mode or "solomon").lower()

    if mode not in INSTANCES:
        raise HTTPException(
            status_code=400,
            detail=f"Instance inconnue : {mode}"
        )

    if not INSTANCES[mode]["disponible"]:
        raise HTTPException(
            status_code=400,
            detail=f"L'instance '{mode}' n'est pas encore disponible."
        )

    chargeurs = {
        "solomon": charger_instance_solomon,
        "france": charger_instance_france,
        "petite": charger_instance_petite,
        "petite": charger_instance_petite,
        "demande": charger_instance_demande,
        "horaires": charger_instance_horaires,
        "grande": charger_instance_grande
    }

    return chargeurs[mode]()


@app.get("/api/instance")
def lire_instance(mode: str = Query(default="solomon")):
    instance = charger_instance(mode)
    # Ne pas envoyer la matrice complète au navigateur : elle est réservée à ALNS.
    return {
        key: value
        for key, value in instance.items()
        if key != "travel_data"
    }



@app.post("/api/routes/geometry")


@app.post("/api/routes/geometry")
def geometries_tournees(payload: dict):
    """
    Calcule les géométries routières OSRM pour toutes les instances.
    Les coordonnées synthétiques sont projetées autour de Nancy.
    Ne modifie ni les distances ALNS ni l'optimisation.
    """
    import json
    from urllib.request import urlopen
    from urllib.parse import quote

    try:
        mode = str(payload.get("mode", "france")).lower()
        routes = payload.get("routes", [])

        if mode not in INSTANCES:
            raise HTTPException(
                status_code=400,
                detail=f"Instance inconnue : {mode}"
            )

        if not isinstance(routes, list):
            raise HTTPException(
                status_code=400,
                detail="Le champ routes doit être une liste."
            )

        instance = charger_instance(mode)

        depot = instance["depot"]
        clients = instance["clients"]

        # Conversion des points en coordonnées GPS.
        # France : coordonnées GPS réelles.
        # Autres instances : projection des coordonnées x/y autour de Nancy.
        def to_lonlat(point):
            if mode == "france":
                return [
                    float(point["lon"]),
                    float(point["lat"])
                ]

            return [
                6.1844 + (float(point["x"]) - float(depot["x"])) * 0.00025,
                48.6921 + (float(point["y"]) - float(depot["y"])) * 0.00025
            ]

        points = {
            str(depot["id"]): depot
        }

        points.update({
            str(client["id"]): client
            for client in clients
        })

        features = []

        for index, route in enumerate(routes):

            if not isinstance(route, list):
                raise HTTPException(
                    status_code=400,
                    detail=f"La tournée {index + 1} doit être une liste."
                )

            ordered_ids = (
                [str(depot["id"])]
                + [str(client_id) for client_id in route]
                + [str(depot["id"])]
            )

            if any(pid not in points for pid in ordered_ids):
                raise HTTPException(
                    status_code=400,
                    detail=f"Identifiant inconnu dans la tournée {index + 1}."
                )

            coordinates = [
                to_lonlat(points[pid])
                for pid in ordered_ids
            ]

            # OSRM accepte un nombre limité de coordonnées par requête.
            # On découpe les longues tournées en morceaux avec un point commun.
            chunk_size = 80
            start = 0

            full_geometry = []
            snapped_waypoints = []

            total_distance = 0
            total_duration = 0

            while start < len(coordinates) - 1:

                chunk = coordinates[start:start + chunk_size]

                if len(chunk) < 2:
                    break

                coord_string = ";".join(
                    f"{lon},{lat}"
                    for lon, lat in chunk
                )

                url = (
                    "https://router.project-osrm.org/route/v1/driving/"
                    + quote(coord_string, safe=";,")
                    + "?overview=full&geometries=geojson&steps=false"
                )

                with urlopen(url, timeout=45) as response:
                    data = json.loads(
                        response.read().decode("utf-8")
                    )

                if data.get("code") != "Ok" or not data.get("routes"):
                    raise ValueError(
                        data.get("message", "OSRM n'a pas trouvé de route.")
                    )

                result = data["routes"][0]

                geometry = result["geometry"]["coordinates"]

                waypoints = [
                    waypoint["location"]
                    for waypoint in data["waypoints"]
                ]

                # Évite les doublons au raccord entre deux morceaux.
                if start == 0:
                    full_geometry.extend(geometry)
                    snapped_waypoints.extend(waypoints)
                else:
                    full_geometry.extend(geometry[1:])
                    snapped_waypoints.extend(waypoints[1:])

                total_distance += result["distance"]
                total_duration += result["duration"]

                # Le dernier point du morceau devient le premier du suivant.
                start += chunk_size - 1

            features.append({
                "type": "Feature",
                "properties": {
                    "vehicle": index + 1,
                    "distance_km": round(total_distance / 1000, 2),
                    "duration_min": round(total_duration / 60, 2),
                    "waypoints": snapped_waypoints
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": full_geometry
                }
            })

        return {
            "type": "FeatureCollection",
            "mode": mode,
            "features": features,
            "message": "Géométries routières OSRM calculées."
        }

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Impossible de calculer les routes OSRM : {exc}"
        )


@app.post("/api/optimize")
def optimiser(
    iterations: int = Query(default=500, ge=1, le=5000),
    removal_rate: float = Query(default=0.15, gt=0, le=1),
    mode: str = Query(default="solomon")
):
    try:
        instance = charger_instance(mode)
        resultats = run_alns(
            instance=instance,
            iterations=iterations,
            removal_rate=removal_rate,
            seed=42
        )

        return {
            "status": "success",
            "message": "Optimisation ALNS terminée",
            "instance": instance["nom_instance"],
            "mode": instance["mode"],
            "resultats": resultats
        }

    except HTTPException:
        raise
    except ValueError as erreur:
        raise HTTPException(status_code=400, detail=str(erreur))
    except Exception as erreur:
        raise HTTPException(
            status_code=500,
            detail=f"Erreur pendant l'optimisation : {str(erreur)}"
        )
