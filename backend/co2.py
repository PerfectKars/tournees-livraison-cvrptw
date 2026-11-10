"""Estimation des émissions de CO2 d'une tournée : distance x facteur d'émission.

ATTENTION : le facteur ci-dessous est une HYPOTHÈSE de travail, pas une valeur
officielle. Avant de présenter des résultats chiffrés, le remplacer par le
facteur de la Base Empreinte de l'ADEME (https://base-empreinte.ademe.fr)
pour le véhicule choisi, en notant l'identifiant de l'élément et la version.
On peut le surcharger sans toucher au code avec la variable d'environnement
CO2_FACTEUR_KG_KM.
"""
import os

FACTEUR_DEFAUT_KG_KM = 0.20  # kg de CO2e par km : hypothèse (utilitaire léger diesel)
SOURCE = ("hypothèse de travail, à remplacer par la valeur de la Base Empreinte "
          "ADEME")


def facteur():
    """Facteur utilisé (kg CO2e / km) : variable d'environnement, sinon défaut."""
    return float(os.environ.get("CO2_FACTEUR_KG_KM", FACTEUR_DEFAUT_KG_KM))


def co2_kg(distance_km, facteur_kg_km=None):
    """Émissions en kg de CO2e pour une distance en km."""
    f = facteur() if facteur_kg_km is None else facteur_kg_km
    return round(distance_km * f, 3)


def resume(tournees, facteur_kg_km=None):
    """Bloc à joindre aux résultats : total et rappel du facteur utilisé."""
    f = facteur() if facteur_kg_km is None else facteur_kg_km
    return {"total_kg": round(sum(t["co2_kg"] for t in tournees), 3),
            "facteur_kg_par_km": f, "source_facteur": SOURCE}
