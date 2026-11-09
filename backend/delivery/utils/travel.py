"""Calcul des distances et durées entre deux points.

Sans matrice routière, le module conserve le calcul euclidien de Solomon.
Avec une matrice routière, toute paire manquante déclenche une erreur :
on évite ainsi de remplacer silencieusement une distance GPS par une
distance euclidienne calculée sur des coordonnées absentes.
"""
import math


def _matrix_value(matrix, origin_id, destination_id):
    if matrix is None:
        return None

    row = matrix.get(str(origin_id), matrix.get(origin_id))
    if row is None:
        return None

    return row.get(str(destination_id), row.get(destination_id))


def _get_leg_value(a, b, travel_data, matrix_name):
    matrix = (travel_data or {}).get(matrix_name)

    if travel_data is None or matrix is None:
        return None

    value = _matrix_value(matrix, a.get("id"), b.get("id"))
    if value is None:
        raise ValueError(
            f"Trajet absent de la matrice {matrix_name} : "
            f"{a.get('id')} -> {b.get('id')}. "
            "Vérifie/regénère la matrice OSRM."
        )

    return float(value)


def leg_distance(a, b, travel_data=None):
    """Distance en km avec OSRM, sinon distance euclidienne Solomon."""
    value = _get_leg_value(a, b, travel_data, "distance_km")
    if value is not None:
        return value

    if "x" not in a or "y" not in a or "x" not in b or "y" not in b:
        raise ValueError("Coordonnées x/y absentes pour le calcul euclidien.")

    return math.dist(
        (float(a["x"]), float(a["y"])),
        (float(b["x"]), float(b["y"]))
    )


def leg_duration(a, b, travel_data=None):
    """Durée en minutes avec OSRM, sinon distance euclidienne Solomon."""
    value = _get_leg_value(a, b, travel_data, "duration_min")
    if value is not None:
        return value

    if "x" not in a or "y" not in a or "x" not in b or "y" not in b:
        raise ValueError("Coordonnées x/y absentes pour le calcul de durée.")

    return math.dist(
        (float(a["x"]), float(a["y"])),
        (float(b["x"]), float(b["y"]))
    )
