# Tournées de livraison (CVRPTW) — projet CESI A3

Projet d'optimisation combinatoire : calcul de tournées de livraison avec capacité et fenêtres de temps.

```
livrables/           notebook de modélisation (livrable 1)
solver/              solveur ALNS en Julia + guide d'utilisation
backend/             API FastAPI : lance le solveur et renvoie les tournées en JSON
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
