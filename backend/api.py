"""API FastAPI : lance le solveur Julia et renvoie les tournées en JSON.

Lancement (depuis le dossier backend/) :
    .venv/bin/uvicorn api:app --port 8000
Documentation interactive : http://localhost:8000/docs

Toute erreur est renvoyée sous la forme {"etape": ..., "message": ...} où
`etape` dit où ça a cassé : instance, lecture_instance, solveur,
lecture_solution, validation.
"""
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from delivery.main import app as front_app
from julia_runner import (GAP_CIBLE, ITER_SANS_LIMITE, TEMPS_MAX,
                          UN_SEUL_CALCUL, lancer_julia)
from sol_to_json import ErreurBackend, convert, read_instance, write_solomon

ROOT = Path(__file__).resolve().parent.parent
INSTANCES = ROOT / "instances"
JOBS = Path(__file__).resolve().parent / "jobs"
JOBS.mkdir(exist_ok=True)

app = FastAPI(title="Tournées de livraison", version="0.2")

# Sécurité minimale (usage local) :
# 1. CORS limité aux pages servies depuis cette machine ;
app.add_middleware(CORSMiddleware, allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
                   allow_methods=["*"], allow_headers=["*"])
# 2. un seul calcul Julia à la fois (voir julia_runner.UN_SEUL_CALCUL) ;
# 3. nom d'instance validé (voir resolve_instance) et paramètres bornés (SolveRequest).

# Routes du front-end (/api/...) : même application, même port 8000.
app.include_router(front_app.router)

jobs: dict[str, dict] = {}  # mémoire des calculs, perdue au redémarrage


class SolveRequest(BaseModel):
    instance: str = Field(description="Ex. 'homberger/C1_2_1'")
    iterations: int = Field(5000, ge=1, le=500_000, description="Itérations par chaîne")
    chains: int = Field(4, ge=1, le=16)
    seed: int = 42


def erreur(code, etape, message):
    """Réponse d'erreur HTTP uniforme."""
    return HTTPException(code, {"etape": etape, "message": message})


def resolve_instance(name):
    """Transforme 'homberger/C1_2_1' en chemin de fichier, après vérifications.

    Le motif interdit '..' et les chemins absolus : on ne peut pas sortir
    du dossier instances/.
    """
    if not re.fullmatch(r"[\w-]+/[\w.-]+", name) or ".." in name:
        raise erreur(400, "instance",
                     f"Nom invalide '{name}' (attendu : 'dossier/nom')")
    for ext in (".txt", ".vrp"):
        path = INSTANCES / f"{name}{ext}"
        if path.is_file():
            return path
    raise erreur(404, "instance", f"Instance inconnue : {name}")


def parse_resume(path):
    """Lit le fichier _resume.txt écrit par le Julia (lignes 'Clé: valeur')."""
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        k, _, v = line.partition(":")
        out[k.strip()] = v.strip()
    ref = out.get("Reference_distance", "")
    return {
        "temps_calcul": float(out.get("Elapsed_seconds", "nan")),
        "reference": float(ref) if re.fullmatch(r"[0-9.]+", ref) else None,
        "gap_pourcent": (float(out["Distance_gap_percent"])
                         if "Distance_gap_percent" in out else None),
    }


def motif_arret(log):
    """'gap', 'temps' ou 'iterations' d'après la ligne « Motif d'arrêt » du solveur."""
    try:
        texte = log.read_text(encoding="utf-8")
    except OSError:
        return None
    m = re.search(r"Motif d'arrêt : (.*)", texte)
    if not m:
        return None
    return ("gap" if "gap" in m.group(1) else
            "temps" if "temps" in m.group(1) else "iterations")


def run_job(job_id, req, source):
    job = jobs[job_id]
    with UN_SEUL_CALCUL:  # les autres calculs restent 'en_attente'
        work = JOBS / job_id
        try:
            work.mkdir()
            job["statut"] = "en_cours"
            t0 = time.time()
            instance = read_instance(source)         # lecture_instance
            inst_solomon = work / f"{source.stem}.txt"
            write_solomon(instance, inst_solomon)    # format lu par le Julia
            ref = source.with_suffix(".sol")         # solution de référence (gap)
            if ref.exists():
                shutil.copy(ref, work / ref.name)
            # Avec une solution de référence : le solveur s'arrête dès qu'il est
            # à GAP_CIBLE de la référence, sinon au bout de TEMPS_MAX secondes.
            # Sans référence : budget d'itérations demandé (et TEMPS_MAX).
            avec_ref = ref.exists()
            sol = lancer_julia(work, inst_solomon,
                               ITER_SANS_LIMITE if avec_ref else req.iterations,
                               req.chains, req.seed,
                               gap=GAP_CIBLE if avec_ref else None,
                               temps_max=TEMPS_MAX)          # solveur
            resultat = convert(str(source), str(sol))            # lecture_solution / validation
            resume = work / f"{source.stem}_alns_resume.txt"
            resultat["solveur"] = parse_resume(resume) if resume.exists() else {}
            resultat["solveur"]["duree_totale"] = round(time.time() - t0, 2)
            resultat["solveur"]["motif_arret"] = motif_arret(work / "julia.log")
            resultat["solveur"]["temps_max"] = TEMPS_MAX
            resultat["solveur"]["gap_cible_pourcent"] = (
                round(100 * GAP_CIBLE, 2) if avec_ref else None)
            # Gap comparable à la référence : même arrondi des distances qu'elle.
            ref_cout = resultat["solveur"].get("reference")
            if ref_cout:
                resultat["solveur"]["gap_benchmark_pourcent"] = round(
                    100 * (resultat["cout_convention_benchmark"] / ref_cout - 1), 3)
            job["resultat"] = resultat
            job["statut"] = "termine"
        except ErreurBackend as e:
            job["statut"] = "erreur"
            job["erreur"] = {"etape": e.etape, "message": e.message}
        except Exception as e:  # noqa: BLE001 — bug inattendu : on le rend visible
            job["statut"] = "erreur"
            job["erreur"] = {"etape": "interne",
                             "message": f"{type(e).__name__}: {e}"}


def lire_reference(sol):
    """(coût, nombre de routes) du .sol de référence ; None si absent du fichier."""
    cout, routes = None, 0
    for ligne in sol.read_text(encoding="utf-8").splitlines():
        if re.match(r"\s*Route\s*#", ligne, re.I):
            routes += 1
        m = re.match(r"\s*Cost\s*:?\s*([0-9.eE+-]+)", ligne, re.I)
        if m:
            cout = float(m.group(1))
    return cout, (routes or None)


_infos_instances = {}  # (chemin, date de modification) -> infos, calculées une fois


def infos_instance(p):
    cle = (str(p), p.stat().st_mtime)
    if cle not in _infos_instances:
        sol = p.with_suffix(".sol")
        cout, routes = lire_reference(sol) if sol.exists() else (None, None)
        try:
            clients = len(read_instance(p)["clients"]) - 1
        except ErreurBackend:
            clients = None
        _infos_instances[cle] = {"clients": clients, "reference_cout": cout,
                                 "reference_vehicules": routes}
    return _infos_instances[cle]


@app.get("/instances")
def list_instances():
    """Instances disponibles, rangées par jeu (solomon, homberger, xtw), avec
    le nombre de clients et la solution de référence (coût, véhicules)."""
    out = []
    for p in sorted(INSTANCES.glob("*/*")):
        if p.suffix in (".txt", ".vrp"):
            out.append({"nom": f"{p.parent.name}/{p.stem}", "jeu": p.parent.name,
                        "reference": p.with_suffix(".sol").exists(),
                        **infos_instance(p)})
    return out


@app.post("/solve", status_code=202)
def solve(req: SolveRequest):
    """Lance un calcul en tâche de fond. Renvoie son identifiant."""
    source = resolve_instance(req.instance)
    job_id = uuid.uuid4().hex[:8]
    jobs[job_id] = {"id": job_id, "statut": "en_attente", "instance": req.instance}
    threading.Thread(target=run_job, args=(job_id, req, source), daemon=True).start()
    return {"id": job_id, "statut": "en_attente"}


def get_job(job_id):
    if job_id not in jobs:
        raise erreur(404, "calcul", f"Calcul inconnu : {job_id}")
    return jobs[job_id]


def get_result(job_id):
    """Résultat d'un calcul terminé, sinon erreur HTTP explicite."""
    job = get_job(job_id)
    if job["statut"] == "erreur":
        raise erreur(409, job["erreur"]["etape"], job["erreur"]["message"])
    if job["statut"] != "termine":
        raise erreur(409, "calcul", f"Calcul pas fini (statut : {job['statut']})")
    return job["resultat"]


@app.get("/solve/{job_id}")
def solve_status(job_id: str):
    """Statut du calcul ; contient le résultat complet quand statut == 'termine'."""
    return get_job(job_id)


@app.get("/solve/{job_id}/livreurs")
def livreurs(job_id: str):
    """Résumé de chaque tournée (une tournée = un livreur)."""
    return [{"livreur": t["id"], "nb_arrets": len(t["arrets"]),
             "charge": t["charge"], "capacite": t["capacite"],
             "distance": t["distance"], "heure_retour": t["heure_retour"]}
            for t in get_result(job_id)["tournees"]]


@app.get("/solve/{job_id}/livreurs/{livreur}")
def tournee_livreur(job_id: str, livreur: int):
    """Tournée complète d'un livreur : arrêts ordonnés et horaires."""
    for t in get_result(job_id)["tournees"]:
        if t["id"] == livreur:
            return t
    raise erreur(404, "livreur", f"Pas de tournée n°{livreur}")
