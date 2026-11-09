
import json
import random
from pathlib import Path

# Génération reproductible
random.seed(42)

DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)

# Paramètres de l'instance
NOMBRE_CLIENTS = 20
NOMBRE_VEHICULES = 5
CAPACITE_VEHICULE = 100

# Dépôt central
depot = {
    "id": 0,
    "x": 50.0,
    "y": 50.0,
    "demand": 0,
    "ready": 0,
    "due": 600,
    "service": 0
}

clients = []

for i in range(1, NOMBRE_CLIENTS + 1):
    clients.append({
        "id": i,
        "x": round(random.uniform(5, 95), 2),
        "y": round(random.uniform(5, 95), 2),
        "demand": random.randint(5, 15),
        "ready": 0,
        "due": 600,
        "service": 10
    })

instance = {
    "nom_instance": "PETITE_20",
    "mode": "petite",
    "nombre_vehicules": NOMBRE_VEHICULES,
    "capacite_vehicule": CAPACITE_VEHICULE,
    "nombre_clients": NOMBRE_CLIENTS,
    "depot": depot,
    "clients": clients
}

fichier = DATA_DIR / "petite_20.json"

with open(fichier, "w", encoding="utf-8") as f:
    json.dump(instance, f, indent=4, ensure_ascii=False)

demande_totale = sum(c["demand"] for c in clients)

print("===================================")
print(" INSTANCE PETITE LIVRAISON CREEE")
print("===================================")
print(f"Fichier : {fichier}")
print(f"Clients : {NOMBRE_CLIENTS}")
print(f"Vehicules : {NOMBRE_VEHICULES}")
print(f"Capacite par vehicule : {CAPACITE_VEHICULE}")
print(f"Demande totale : {demande_totale}")
print(f"Capacite totale : {NOMBRE_VEHICULES * CAPACITE_VEHICULE}")
print("===================================")
