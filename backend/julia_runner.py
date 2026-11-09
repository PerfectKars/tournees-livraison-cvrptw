"""Lancement du solveur Julia, partagé par l'API des tournées (api.py)
et par le pont du front-end (delivery/solver_bridge.py)."""
import os
import shutil
import subprocess
import threading
from pathlib import Path

from sol_to_json import ErreurBackend

ROOT = Path(__file__).resolve().parent.parent
SOLVER = ROOT / "solver" / "CVRPTW_ALNS.jl"
JULIA = os.environ.get("JULIA") or shutil.which("julia")
TIMEOUT_SOLVEUR = 900  # secondes : au-delà, on tue le calcul

# Un seul calcul Julia à la fois : il utilise tous les coeurs.
UN_SEUL_CALCUL = threading.Semaphore(1)


def lancer_julia(work, inst_solomon, iterations, chains, seed):
    """Exécute le solveur et renvoie le chemin du .sol produit.

    Lève ErreurBackend('solveur', ...) en cas de problème.
    """
    if not JULIA:
        raise ErreurBackend("solveur", "Julia introuvable : installez-le "
                            "ou définissez la variable d'environnement JULIA")
    cmd = [JULIA, f"--threads={chains}", "-O3", str(SOLVER), str(inst_solomon),
           str(iterations), str(chains), "Inf", str(seed)]
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
