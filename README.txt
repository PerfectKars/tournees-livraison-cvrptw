# Tournées de livraison (CVRPTW) — projet CESI A3

Projet d'optimisation combinatoire : calcul de tournées de livraison avec capacité et fenêtres de temps.

```
livrables/           notebook de modélisation (livrable 1)
solver/              solveur ALNS en Julia + guide d'utilisation
backend/             API FastAPI : lance le solveur Julia et renvoie les tournées en JSON
backend/delivery/    code Python du front (instances de démo, ALNS Python, routes /api/...)
frontend/            interface React + carte 3D (Vite)
instances/           benchmarks (solomon/, homberger/, xtw/), avec solutions de référence
resultats_solveur/   exemples de sorties du solveur
autres/              anciennes versions et documents annexes
```

## Lancer le back-end
```
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn api:app --port 8000      # documentation : http://localhost:8000/docs
.venv/bin/python -m pytest -q              # tests
```
Julia doit être installé (`julia --version`).

## Lancer l'application complète
Deux terminaux :
```
cd backend  && .venv/bin/uvicorn api:app --port 8000
cd frontend && npm install && npm run dev       # http://localhost:5173
```
Le front appelle `/api/instance`, `/api/optimize` et `/api/routes/geometry`. Les tournées sont calculées par le solveur Julia. Le mode `france` lui fournit la matrice routière OSRM (fichier `.matrix`, durées de trajet) ; les autres modes restent à vol d'oiseau. Le tracé des routes sur la carte demande une connexion internet (serveur public OSRM).

## Comparer deux solveurs (et le CO2)
```
cd backend
.venv/bin/python comparer_solveurs.py homberger/C1_2_1 --temps-tabou 30
```
Compare la recherche tabou (`backend/recherche_tabou.py`, simple, volontairement non optimisée) au solveur Julia : véhicules, distance, CO2, gap, temps.

Le CO2 est calculé dans `backend/co2.py` (distance x facteur d'émission). **Le facteur par défaut (0,20 kg/km) est une hypothèse** : à remplacer par la valeur de la Base Empreinte de l'ADEME (variable d'environnement `CO2_FACTEUR_KG_KM`). Sur les instances de benchmark les distances sont des unités abstraites : le CO2 n'a de sens que sur des distances en km (mode `france`).
