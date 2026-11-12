"""Lancement du solveur Julia, partagé par l'API des tournées (api.py)
et par le pont du front-end (delivery/solver_bridge.py)."""
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path

from sol_to_json import ErreurBackend

ROOT = Path(__file__).resolve().parent.parent
SOLVER = ROOT / "solver" / "CVRPTW_ALNS.jl"
JULIA = os.environ.get("JULIA") or shutil.which("julia")
TIMEOUT_SOLVEUR = 900  # secondes : au-delà, on tue le calcul
TEMPS_MAX = 60         # secondes de calcul du solveur (hors démarrage de Julia)
GAP_CIBLE = 0.07       # arrêt anticipé à 7 % de la référence (si elle existe)
ITER_SANS_LIMITE = 1_000_000_000  # le temps décide, pas le nombre d'itérations

# Un seul calcul Julia à la fois : il utilise tous les coeurs.
UN_SEUL_CALCUL = threading.Semaphore(1)


def lancer_julia(work, inst_solomon, iterations, chains, seed,
                 gap=None, temps_max=None):
    """Exécute le solveur et renvoie le chemin du .sol produit.

    Lève ErreurBackend('solveur', ...) en cas de problème.
    """
    if not JULIA:
        raise ErreurBackend("solveur", "Julia introuvable : installez-le "
                            "ou définissez la variable d'environnement JULIA")
    cmd = [JULIA, f"--threads={chains}", "-O3", str(SOLVER), str(inst_solomon),
           str(iterations), str(chains),
           "Inf" if gap is None else str(gap), str(seed)]
    if temps_max:
        # "-" = valeur par défaut des 5 réglages avant le temps maximal
        cmd += ["-"] * 5 + [str(temps_max)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, cwd=work,
                              timeout=TIMEOUT_SOLVEUR)
    except subprocess.TimeoutExpired:
        raise ErreurBackend("solveur", f"Calcul arrêté après {TIMEOUT_SOLVEUR} s "
                            "(réduisez les itérations)")
    (Path(work) / "julia.log").write_text(proc.stdout + proc.stderr,
                                          encoding="utf-8")
    sol = Path(work) / f"{Path(inst_solomon).stem}_alns.sol"
    if proc.returncode != 0 or not sol.exists():
        fin = (proc.stderr or proc.stdout).strip()[-400:]
        raise ErreurBackend("solveur", f"Le Julia a échoué (code {proc.returncode}). "
                            f"Fin du journal : {fin}")
    return sol


# Ligne écrite par le solveur à chaque amélioration de la meilleure solution :
# "[12.3 s] chaîne 2, it. 450 | véhicules 11 | distance 1234.56 | gap ..."
_LIGNE_TRACE = re.compile(
    r"^\[(\d+(?:\.\d+)?) s\] chaîne \d+, it\. \d+ \| véhicules (\d+) \| "
    r"distance (\d+(?:\.\d+)?)", re.M)


def lire_trace(log, max_points=150):
    """Courbe de convergence du solveur, lue dans son journal (julia.log) :
    liste de [secondes, véhicules, distance], réduite à `max_points` points."""
    try:
        texte = Path(log).read_text(encoding="utf-8")
    except OSError:
        return []
    points = [[float(t), int(v), float(d)] for t, v, d in _LIGNE_TRACE.findall(texte)]
    return reduire_trace(points, max_points)


def reduire_trace(points, max_points=150):
    """Garde au plus `max_points` points, en conservant le premier et le dernier."""
    if len(points) <= max_points:
        return points
    pas = (len(points) - 1) / (max_points - 1)
    return [points[round(i * pas)] for i in range(max_points)]
