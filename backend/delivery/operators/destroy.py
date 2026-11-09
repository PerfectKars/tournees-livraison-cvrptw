
import random
import math
import copy
from ..utils.travel import leg_distance


# =====================================================
# 1. RANDOM REMOVAL
# =====================================================

def random_removal(solution, removal_count, rng=None):
    """
    Retire aléatoirement un certain nombre de clients.
    """

    rng = rng or random

    new_solution = copy.deepcopy(solution)

    all_customers = [
        customer_id
        for route in new_solution
        for customer_id in route
    ]

    removal_count = min(removal_count, len(all_customers))

    removed = rng.sample(all_customers, removal_count)

    for route in new_solution:
        route[:] = [
            customer_id
            for customer_id in route
            if customer_id not in removed
        ]

    # Supprimer les tournées devenues vides
    new_solution = [
        route for route in new_solution if route
    ]

    return new_solution, removed


# =====================================================
# 2. WORST REMOVAL
# =====================================================

def worst_removal(solution, customers, depot, removal_count, travel_data=None):
    """
    Retire les clients ayant la plus forte contribution
    au coût de leur tournée.
    """

    new_solution = copy.deepcopy(solution)
    removed = []

    for _ in range(removal_count):

        worst_customer = None
        worst_route_index = None
        worst_cost = -float("inf")

        for route_index, route in enumerate(new_solution):

            for position, customer_id in enumerate(route):

                customer = customers[customer_id]

                previous_customer = (
                    depot if position == 0
                    else customers[route[position - 1]]
                )

                next_customer = (
                    depot if position == len(route) - 1
                    else customers[route[position + 1]]
                )

                # Coût économisé si on retire ce client
                old_distance = (
                    leg_distance(previous_customer, customer, travel_data)
                    + leg_distance(customer, next_customer, travel_data)
                )

                new_distance = leg_distance(
                    previous_customer, next_customer, travel_data
                )

                saving = old_distance - new_distance

                if saving > worst_cost:
                    worst_cost = saving
                    worst_customer = customer_id
                    worst_route_index = route_index

        if worst_customer is None:
            break

        new_solution[worst_route_index].remove(worst_customer)
        removed.append(worst_customer)

        # Supprimer les tournées vides
        new_solution = [
            route for route in new_solution if route
        ]

    return new_solution, removed


# =====================================================
# 3. RELATED REMOVAL
# =====================================================

def related_removal(
    solution,
    customers,
    removal_count,
    rng=None,
    travel_data=None
):
    """
    Retire un groupe de clients similaires.

    Similarité basée sur :
    - Position géographique
    - Demande
    - Fenêtre horaire
    """

    rng = rng or random

    new_solution = copy.deepcopy(solution)

    all_customers = [
        customer_id
        for route in new_solution
        for customer_id in route
    ]

    if not all_customers:
        return new_solution, []

    removal_count = min(removal_count, len(all_customers))

    # Choisir un client de départ
    seed_id = rng.choice(all_customers)

    seed = customers[seed_id]

    remaining = [
        customer_id
        for customer_id in all_customers
        if customer_id != seed_id
    ]

    # Calculer les similarités
    relatedness = []

    for customer_id in remaining:

        customer = customers[customer_id]

        geographic_distance = leg_distance(
            seed, customer, travel_data
        )

        demand_difference = abs(
            seed["demand"] - customer["demand"]
        )

        time_difference = abs(
            seed["ready"] - customer["ready"]
        )

        # Plus le score est petit, plus les clients
        # sont considérés comme similaires.
        score = (
            geographic_distance
            + 0.5 * demand_difference
            + 0.5 * time_difference
        )

        relatedness.append((score, customer_id))

    # Trier par similarité croissante
    relatedness.sort(key=lambda item: item[0])

    removed = [seed_id]

    for _, customer_id in relatedness[:removal_count - 1]:
        removed.append(customer_id)

    # Retirer les clients des tournées
    for route in new_solution:
        route[:] = [
            customer_id
            for customer_id in route
            if customer_id not in removed
        ]

    new_solution = [
        route for route in new_solution if route
    ]

    return new_solution, removed
