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
Le front appelle `/api/instance`, `/api/optimize` et `/api/routes/geometry`. Les tournées sont calculées par le solveur Julia. Le mode `france` lui fournit la matrice routière OSRM en deux fichiers : `<instance>.matrix` (durées en minutes, pour les fenêtres horaires) et `<instance>.dist` (distances en km, c'est le coût minimisé) ; les autres modes restent à vol d'oiseau, sans fichier. Les deux fichiers sont optionnels et indépendants : sans `.dist`, le coût est la matrice `.matrix` elle-même. Le tracé des routes sur la carte demande une connexion internet (serveur public OSRM).

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

## Étude expérimentale : ALNS contre recherche tabou
```
cd backend
.venv/bin/python etude.py --temps 60 --seeds 42 43 44        # toutes les instances avec référence
.venv/bin/python etude.py homberger/C1_2_1 solomon/C101 --temps 30   # instances choisies
.venv/bin/python etude.py --jeux solomon --max-clients 100 --temps 10
```
`backend/etude.py` lance **les deux solveurs sur les mêmes instances, avec la même graine et le même budget de temps**, puis résume chaque solution avec le convertisseur (qui vérifie capacité et fenêtres horaires) : véhicules, distance, CO2, gap par rapport à la meilleure solution connue, temps, et **courbe de convergence** (meilleure distance en fonction du temps). Les résultats sont ajoutés à `resultats_solveur/etude.json` (export CSV à côté) ; un calcul déjà fait n'est pas refait, on peut donc interrompre puis relancer, ou ajouter des graines.

Précautions de lecture :
- l'ALNS tourne **sans arrêt anticipé** (pas de cible à 7 %) : on mesure sa vraie qualité ;
- l'ALNS utilise 4 chaînes en parallèle (4 coeurs), la recherche tabou une seule ;
- le temps de l'ALNS inclut la compilation de Julia (environ 7 s), ce qui le désavantage sur les petits budgets : en dessous de 30 s par solveur, la comparaison n'est pas représentative ;
- avec une seule graine il n'y a pas d'écart-type : utilisez `--seeds 42 43 44` pour le rapport.

La durée est d'environ `instances x graines x 2 x (temps + 5 s)` : 31 instances, 1 graine, 60 s = 1 h 10.

## Page « Analyses » : comparaison et benchmark
La page **Analyses** a deux onglets.

**Comparaison ALNS / tabou** (onglet par défaut) affiche `resultats_solveur/etude.json` :
- cartes : gap moyen des deux solveurs, victoires de l'ALNS, instances sous 7 %, CO2 évité ;
- **courbes de convergence** par instance (et par graine), avec la meilleure solution connue en pointillés ;
- gap par instance et par famille (C1, C2, R1, R2, RC1, RC2), CO2 par instance ;
- tableau détaillé (moyenne et écart-type sur les graines) et export CSV ;
- **comparaison en direct** : tabou puis ALNS sur une instance au choix (10, 30 ou 60 s par solveur), avec les courbes.

**Benchmark ALNS en direct** lance le solveur sur des instances de référence (CVRPLIB : `instances/solomon` et `instances/homberger`, 30 instances avec leur meilleure solution connue) et les compare à cette référence :
- sélection des instances (par taille, « Petites », « Moyennes », « Toutes »), calcul une instance après l'autre ;
- cartes (instances calculées, gap moyen, objectif 7 % atteint, temps total), trois graphes (gap, véhicules, temps) et un tableau avec le motif d'arrêt de chaque calcul (objectif atteint ou 60 s écoulées) ;
- le calcul continue si l'on change de page, et les résultats sont gardés dans le navigateur (bouton « Effacer les résultats »). Ce benchmark s'arrête à 7 % de gap : pour mesurer la vraie qualité, utilisez l'étude ci-dessus.

Côté API :
- `GET /etude` renvoie les résultats de l'étude (`resultats_solveur/etude.json`) ; `POST /comparer` (`instance`, `temps`, `seed`) puis `GET /comparer/{id}` lancent la comparaison en direct ;
- `GET /instances` renvoie aussi `clients`, `reference_cout` et `reference_vehicules` ;
- `POST /solve` puis `GET /solve/{id}` : le résultat contient `solveur.motif_arret` (`gap`, `temps` ou `iterations`), `temps_max` et `gap_cible_pourcent` ;
- les modes du tableau de bord (`france`, `petite`...) se lancent en tâche de fond : `POST /api/optimize/start?mode=...` renvoie `job_id`, puis `GET /api/optimize/status/{job_id}` donne l'état et, une fois `termine`, `resultats` (même format que `POST /api/optimize`, qui reste disponible). Le bouton du tableau de bord affiche le temps écoulé au lieu de bloquer la page.
