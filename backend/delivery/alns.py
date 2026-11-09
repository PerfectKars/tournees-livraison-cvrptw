
import math

import random
import math

from .operators.destroy import (
    random_removal,
    worst_removal,
    related_removal
)

from .utils.travel import leg_distance, leg_duration

from .operators.repair import (
    greedy_insertion,
    regret_2_insertion,
    regret_3_insertion
)


# =====================================================
# 1. OUTILS DE LECTURE DES DONNEES
# =====================================================

def get_value(obj, *names, default=None):
    """Permet de lire les données avec plusieurs noms possibles."""

    for name in names:
        if name in obj:
            return obj[name]

    return default


def normalize_customer(customer):
    """Uniformise les informations d'un client."""

    return {
        "id": int(get_value(customer, "id")),
        "x": float(get_value(customer, "x", default=0)),
        "y": float(get_value(customer, "y", default=0)),
        "lat": get_value(customer, "lat", "latitude"),
        "lon": get_value(customer, "lon", "longitude"),
        "demand": float(get_value(
            customer, "demand", "demande", default=0
        )),
        "ready": float(get_value(
            customer, "ready", "ready_time",
            "debut_fenetre", default=0
        )),
        "due": float(get_value(
            customer, "due", "due_time",
            "fin_fenetre", default=float("inf")
        )),
        "service": float(get_value(
            customer, "service", "service_time",
            "temps_service", default=0
        ))
    }


# =====================================================
# 2. CALCUL DES DISTANCES
# =====================================================

def distance(a, b, travel_data=None):
    """Distance routière si une matrice existe, sinon distance euclidienne."""
    return leg_distance(a, b, travel_data)


# =====================================================
# 3. EVALUATION D'UNE TOURNEE
# =====================================================

def evaluate_route(route, customers, depot, capacity, travel_data=None):

    if not route:
        return {
            "feasible": True,
            "distance": 0,
            "load": 0
        }

    load = 0
    total_distance = 0
    current_time = depot["ready"]

    current = depot

    for customer_id in route:

        customer = customers[customer_id]

        travel = distance(current, customer, travel_data)
        travel_time = leg_duration(current, customer, travel_data)
        arrival = current_time + travel_time

        # Attendre si le client n'est pas encore disponible
        service_start = max(arrival, customer["ready"])

        # Vérifier la fenêtre horaire
        if service_start > customer["due"]:
            return {"feasible": False}

        load += customer["demand"]

        # Vérifier la capacité du véhicule
        if load > capacity:
            return {"feasible": False}

        total_distance += travel

        current_time = service_start + customer["service"]
        current = customer

    # Retour au dépôt
    total_distance += distance(current, depot, travel_data)
    return_time = current_time + leg_duration(current, depot, travel_data)

    if return_time > depot["due"]:
        return {"feasible": False}

    return {
        "feasible": True,
        "distance": total_distance,
        "load": load
    }


# =====================================================
# 4. EVALUATION D'UNE SOLUTION
# =====================================================

def evaluate_solution(solution, customers, depot, capacity, travel_data=None):

    total_distance = 0

    for route in solution:

        result = evaluate_route(
            route, customers, depot, capacity, travel_data
        )

        if not result["feasible"]:
            return float("inf")

        total_distance += result["distance"]

    return total_distance


def summarize_route(route, customers, depot, travel_data=None):
    """Produit les horaires détaillés d'une tournée pour contrôler les fenêtres."""
    current = depot
    current_time = depot["ready"]
    total_distance = 0.0
    total_load = 0.0
    stops = []

    for customer_id in route:
        customer = customers[customer_id]
        distance_km = leg_distance(current, customer, travel_data)
        duration_min = leg_duration(current, customer, travel_data)
        arrival = current_time + duration_min
        service_start = max(arrival, customer["ready"])
        waiting = max(0.0, customer["ready"] - arrival)
        service_end = service_start + customer["service"]

        total_distance += distance_km
        total_load += customer["demand"]

        stops.append({
            "client_id": customer_id,
            "arrival_min": round(arrival, 2),
            "waiting_min": round(waiting, 2),
            "service_start_min": round(service_start, 2),
            "service_end_min": round(service_end, 2),
            "ready_min": round(customer["ready"], 2),
            "due_min": round(customer["due"], 2),
            "demand": customer["demand"],
            "within_time_window": service_start <= customer["due"]
        })

        current_time = service_end
        current = customer

    return_distance = leg_distance(current, depot, travel_data)
    return_duration = leg_duration(current, depot, travel_data)
    total_distance += return_distance
    return_time = current_time + return_duration

    return {
        "stops": stops,
        "distance_km": round(total_distance, 2),
        "load": round(total_load, 2),
        "capacity": None,
        "return_time_min": round(return_time, 2),
        "return_within_depot_window": return_time <= depot["due"]
    }


# =====================================================
# 5. CONSTRUCTION D'UNE SOLUTION INITIALE
# =====================================================

def build_initial_solution(
    customers,
    depot,
    capacity,
    vehicle_count,
    travel_data=None
):

    # Les clients aux échéances les plus proches
    # sont traités en premier.

    ordered_customers = sorted(
        customers.values(),
        key=lambda c: (c["due"], c["ready"])
    )

    solution = []

    for customer in ordered_customers:

        best_route = None
        best_position = None
        best_cost = float("inf")

        # Essayer chaque position dans chaque tournée
        for route_index, route in enumerate(solution):

            for position in range(len(route) + 1):

                candidate = route.copy()
                candidate.insert(position, customer["id"])

                result = evaluate_route(
                    candidate, customers, depot, capacity, travel_data
                )

                if result["feasible"]:

                    if result["distance"] < best_cost:
                        best_cost = result["distance"]
                        best_route = route_index
                        best_position = position

        if best_route is not None:

            solution[best_route].insert(
                best_position, customer["id"]
            )

        else:

            # Créer une nouvelle tournée si nécessaire
            if len(solution) >= vehicle_count:
                raise ValueError(
                    f"Impossible d'affecter le client {customer['id']}"
                )

            result = evaluate_route(
                [customer["id"]],
                customers,
                depot,
                capacity,
                travel_data
            )

            if not result["feasible"]:
                raise ValueError(
                    f"Le client {customer['id']} est impossible à livrer"
                )

            solution.append([customer["id"]])

    return solution


# =====================================================
# 6. PREPARATION DE L'INSTANCE
# =====================================================


def prepare_instance(instance):

    # Récupération des clients
    raw_customers = instance.get("clients", [])

    if not raw_customers:
        raise ValueError("Aucun client trouvé")

    # Normalisation des clients
    normalized = [
        normalize_customer(c)
        for c in raw_customers
    ]

    # Récupération du dépôt
    depot_data = instance.get("depot")

    if depot_data is None:
        raise ValueError("Dépôt introuvable")

    depot = normalize_customer(depot_data)

    # Création du dictionnaire des clients
    customers = {
        c["id"]: c for c in normalized
    }

    # Paramètres des véhicules
    capacity = float(instance["capacite_vehicule"])

    vehicle_count = int(instance["nombre_vehicules"])

    travel_data = instance.get("travel_data")
    return customers, depot, capacity, vehicle_count, travel_data



# =====================================================
# 7. TEST DE LA SOLUTION INITIALE
# =====================================================

def create_initial_solution(instance):

    customers, depot, capacity, vehicle_count, travel_data = (
        prepare_instance(instance)
    )

    solution = build_initial_solution(
        customers,
        depot,
        capacity,
        vehicle_count,
        travel_data
    )

    cost = evaluate_solution(
        solution, customers, depot, capacity, travel_data
    )

    return {
        "routes": solution,
        "cost": round(cost, 2),
        "number_of_routes": len(solution),
        "number_of_customers": len(customers)
    }


# =====================================================
# 8. SELECTION ADAPTATIVE DES OPERATEURS
# =====================================================

def select_operator(operators, weights):
    """Sélection proportionnelle aux poids."""

    return random.choices(
        operators,
        weights=weights,
        k=1
    )[0]


# =====================================================
# 9. SIMULATED ANNEALING
# =====================================================

def accept_solution(
    current_cost,
    candidate_cost,
    temperature
):
    """
    Accepte systématiquement une amélioration.
    Accepte parfois une dégradation selon la température.
    """

    if candidate_cost < current_cost:
        return True

    if temperature <= 0:
        return False

    probability = math.exp(
        -(candidate_cost - current_cost) / temperature
    )

    return random.random() < probability


# =====================================================
# 10. MISE A JOUR DES POIDS
# =====================================================

def update_weights(
    weights,
    scores,
    uses,
    reaction_factor=0.2
):
    """
    Actualise les poids selon les performances
    des opérateurs pendant une période.
    """

    for i in range(len(weights)):

        if uses[i] > 0:

            average_score = scores[i] / uses[i]

            weights[i] = (
                (1 - reaction_factor) * weights[i]
                + reaction_factor * average_score
            )


# =====================================================
# 11. ALGORITHME PRINCIPAL
# =====================================================

def run_alns(
    instance,
    iterations=500,
    removal_rate=0.15,
    segment_length=50,
    reaction_factor=0.2,
    seed=None
):

    if seed is not None:
        random.seed(seed)

    # Préparer les données
    customers, depot, capacity, vehicle_count, travel_data = (
        prepare_instance(instance)
    )

    # Construire la solution initiale
    current_solution = build_initial_solution(
        customers,
        depot,
        capacity,
        vehicle_count,
        travel_data
    )

    current_cost = evaluate_solution(
        current_solution,
        customers,
        depot,
        capacity,
        travel_data
    )

    best_solution = [
        route.copy() for route in current_solution
    ]

    best_cost = current_cost

    # Opérateurs de destruction
    destroy_operators = [
        random_removal,
        worst_removal,
        related_removal
    ]

    # Opérateurs de reconstruction
    repair_operators = [
        greedy_insertion,
        regret_2_insertion,
        regret_3_insertion
    ]

    # Poids initiaux identiques
    destroy_weights = [1.0] * len(destroy_operators)
    repair_weights = [1.0] * len(repair_operators)

    # Scores et utilisations
    destroy_scores = [0.0] * len(destroy_operators)
    repair_scores = [0.0] * len(repair_operators)

    destroy_uses = [0] * len(destroy_operators)
    repair_uses = [0] * len(repair_operators)

    # Température initiale
    temperature = max(1.0, current_cost * 0.05)

    cooling_rate = 0.995

    # Historique des résultats
    history = []

    for iteration in range(iterations):

        # ---------------------------------------------
        # A. SELECTION DES OPERATEURS
        # ---------------------------------------------

        destroy_index = select_operator(
            list(range(len(destroy_operators))),
            destroy_weights
        )

        repair_index = select_operator(
            list(range(len(repair_operators))),
            repair_weights
        )

        destroy = destroy_operators[destroy_index]
        repair = repair_operators[repair_index]

        destroy_uses[destroy_index] += 1
        repair_uses[repair_index] += 1

        # ---------------------------------------------
        # B. DESTRUCTION
        # ---------------------------------------------

        customer_count = sum(
            len(route) for route in current_solution
        )

        removal_count = max(
            1,
            int(customer_count * removal_rate)
        )

        if destroy == random_removal:

            partial_solution, removed = destroy(
                current_solution,
                removal_count
            )

        elif destroy == worst_removal:

            partial_solution, removed = destroy(
                current_solution,
                customers,
                depot,
                removal_count,
                travel_data=travel_data
            )

        else:

            partial_solution, removed = destroy(
                current_solution,
                customers,
                removal_count,
                travel_data=travel_data
            )

        # ---------------------------------------------
        # C. RECONSTRUCTION
        # ---------------------------------------------

        try:

            candidate_solution = repair(
                partial_solution,
                removed,
                customers,
                depot,
                capacity,
                vehicle_count,
                travel_data=travel_data
            )

            candidate_cost = evaluate_solution(
                candidate_solution,
                customers,
                depot,
                capacity,
                travel_data
            )

        except (ValueError, KeyError):
            candidate_cost = float("inf")
            candidate_solution = None

        # ---------------------------------------------
        # D. ACCEPTATION
        # ---------------------------------------------

        reward = 0

        if candidate_solution is not None:

            if candidate_cost < best_cost:

                # Nouvelle meilleure solution globale
                best_solution = [
                    route.copy()
                    for route in candidate_solution
                ]

                best_cost = candidate_cost

                current_solution = candidate_solution
                current_cost = candidate_cost

                reward = 33

            elif candidate_cost < current_cost:

                # Amélioration de la solution courante
                current_solution = candidate_solution
                current_cost = candidate_cost

                reward = 13

            elif accept_solution(
                current_cost,
                candidate_cost,
                temperature
            ):

                # Solution moins bonne mais acceptée
                current_solution = candidate_solution
                current_cost = candidate_cost

                reward = 5

        # ---------------------------------------------
        # E. RECOMPENSE DES OPERATEURS
        # ---------------------------------------------

        destroy_scores[destroy_index] += reward
        repair_scores[repair_index] += reward

        # ---------------------------------------------
        # F. REFROIDISSEMENT
        # ---------------------------------------------

        temperature *= cooling_rate

        # ---------------------------------------------
        # G. ADAPTATION DES POIDS
        # ---------------------------------------------

        if (iteration + 1) % segment_length == 0:

            update_weights(
                destroy_weights,
                destroy_scores,
                destroy_uses,
                reaction_factor
            )

            update_weights(
                repair_weights,
                repair_scores,
                repair_uses,
                reaction_factor
            )

            destroy_scores = [0.0] * len(destroy_operators)
            repair_scores = [0.0] * len(repair_operators)

            destroy_uses = [0] * len(destroy_operators)
            repair_uses = [0] * len(repair_operators)

        # ---------------------------------------------
        # H. HISTORIQUE
        # ---------------------------------------------

        history.append({
            "iteration": iteration + 1,
            "current_cost": round(current_cost, 2),
            "best_cost": round(best_cost, 2),
            "temperature": round(temperature, 4)
        })

    # Résultat final : détail des horaires pour chaque tournée
    route_details = []
    for route in best_solution:
        details = summarize_route(
            route, customers, depot, travel_data
        )
        details["capacity"] = capacity
        route_details.append(details)

    return {
        "routes": best_solution,
        "route_details": route_details,
        "cost": round(best_cost, 2),
        "number_of_routes": len(best_solution),
        "number_of_customers": len(customers),
        "iterations": iterations,
        "history": history,
        "destroy_weights": destroy_weights,
        "repair_weights": repair_weights
    }
