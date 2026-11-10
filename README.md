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

## Durée du calcul du solveur Julia
- **Limite : 60 s de calcul** (`TEMPS_MAX` dans `backend/julia_runner.py`, hors démarrage de Julia). Le recuit simulé refroidit selon le temps, il finit donc de refroidir à la limite.
- **Instance avec solution de référence** (`/solve`, fichier `.sol` à côté de l'instance) : arrêt anticipé dès que la distance est à 7 % ou moins de la référence (`GAP_CIBLE`) avec au plus autant de véhicules qu'elle ; sinon le solveur utilise les 60 s et garde le meilleur résultat. Les calculs faciles finissent en 1 à 3 s.
- **Sans référence** (modes du front : `france`, `petite`...) : budget d'itérations selon la taille (200 par client, entre 5 000 et 60 000) et limite de 60 s ; il n'y a pas de gap à calculer.
- En ligne de commande : 11e argument du solveur = temps maximal en secondes (`-` laisse la valeur par défaut des arguments 6 à 10).
- Limite connue : si le solveur utilise beaucoup moins de véhicules que la référence (R2, RC2...) ou un de plus, la distance ne rejoint pas les 7 % et le calcul utilise les 60 s.

## Page « Analyses » : benchmark du solveur
La page **Analyses** du front lance le solveur sur des instances de référence (CVRPLIB : `instances/solomon` et `instances/homberger`, 30 instances avec leur meilleure solution connue) et les compare à cette référence :
- sélection des instances (par taille, « Petites », « Moyennes », « Toutes »), calcul une instance après l'autre ;
- cartes (instances calculées, gap moyen, objectif 7 % atteint, temps total), trois graphes (gap, véhicules, temps) et un tableau avec le motif d'arrêt de chaque calcul (objectif atteint ou 60 s écoulées) ;
- le calcul continue si l'on change de page, et les résultats sont gardés dans le navigateur (bouton « Effacer les résultats »).

Côté API :
- `GET /instances` renvoie aussi `clients`, `reference_cout` et `reference_vehicules` ;
- `POST /solve` puis `GET /solve/{id}` : le résultat contient `solveur.motif_arret` (`gap`, `temps` ou `iterations`), `temps_max` et `gap_cible_pourcent` ;
- les modes du tableau de bord (`france`, `petite`...) se lancent en tâche de fond : `POST /api/optimize/start?mode=...` renvoie `job_id`, puis `GET /api/optimize/status/{job_id}` donne l'état et, une fois `termine`, `resultats` (même format que `POST /api/optimize`, qui reste disponible). Le bouton du tableau de bord affiche le temps écoulé au lieu de bloquer la page.
