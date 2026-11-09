
import json
import random
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"


def generer_instance(
    nom,
    mode,
    nombre_clients,
    nombre_vehicules,
    capacite,
    seed,
    demande_min,
    demande_max,
    due_depot=600,
    fenetres=False
):
    rng = random.Random(seed)

    depot = {
        "id": 0,
        "x": 50,
        "y": 50,
        "ready": 0,
        "due": due_depot,
        "service": 0
    }

    clients = []

    for i in range(1, nombre_clients + 1):

        if fenetres:
            ready = rng.choice([0, 30, 60, 90, 120])
            due = rng.choice([480, 540, 570, 600])
        else:
            ready = 0
            due = due_depot

        clients.append({
            "id": i,
            "x": round(rng.uniform(5, 95), 2),
            "y": round(rng.uniform(5, 95), 2),
            "demand": rng.randint(demande_min, demande_max),
            "ready": ready,
            "due": due,
            "service": 10
        })

    instance = {
        "nom_instance": nom,
        "mode": mode,
        "nombre_vehicules": nombre_vehicules,
        "capacite_vehicule": capacite,
        "depot": depot,
        "clients": clients
    }

    fichier = DATA_DIR / f"{mode}.json"

    with open(fichier, "w", encoding="utf-8") as f:
        json.dump(instance, f, indent=4, ensure_ascii=False)

    demande_totale = sum(c["demand"] for c in clients)

    print(f"\n{nom}")
    print(f"  Clients : {nombre_clients}")
    print(f"  Véhicules : {nombre_vehicules}")
    print(f"  Capacité par véhicule : {capacite}")
    print(f"  Demande totale : {demande_totale}")
    print(f"  Capacité totale : {nombre_vehicules * capacite}")
    print(f"  Fichier créé : {fichier.name}")


if __name__ == "__main__":

    DATA_DIR.mkdir(exist_ok=True)

    # 1. Instance avec de fortes demandes
    generer_instance(
        nom="FORTE_DEMANDE",
        mode="demande",
        nombre_clients=50,
        nombre_vehicules=5,
        capacite=200,
        seed=100,
        demande_min=10,
        demande_max=20
    )

    # 2. Instance avec des fenêtres horaires
    generer_instance(
        nom="FENETRES_HORAIRES",
        mode="horaires",
        nombre_clients=30,
        nombre_vehicules=5,
        capacite=100,
        seed=200,
        demande_min=5,
        demande_max=12,
        fenetres=True
    )

    # 3. Grande instance avec une grande capacité
    generer_instance(
        nom="GRANDE_CAPACITE",
        mode="grande",
        nombre_clients=200,
        nombre_vehicules=20,
        capacite=1000,
        seed=300,
        demande_min=30,
        demande_max=70,
        due_depot=1000
    )

    print("\nLes trois instances ont été générées.")
