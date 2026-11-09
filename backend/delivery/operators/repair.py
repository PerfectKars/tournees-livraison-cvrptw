
from ..utils.travel import leg_distance, leg_duration


# =====================================================
# 1. CACHE DES DISTANCES ET DES DUREES
# =====================================================

def create_metrics(depot, customers, travel_data=None):
    """
    Mémorise les distances et durées déjà calculées.
    Compatible avec les matrices OSRM et les coordonnées.
    """

    distance_cache = {}
    duration_cache = {}

    def distance(a, b):
        key = (a["id"], b["id"])

        if key not in distance_cache:
            distance_cache[key] = leg_distance(a, b, travel_data)

        return distance_cache[key]

    def duration(a, b):
        key = (a["id"], b["id"])

        if key not in duration_cache:
            duration_cache[key] = leg_duration(a, b, travel_data)

        return duration_cache[key]

    return distance, duration


# =====================================================
# 2. OUTILS COMMUNS
# =====================================================

def calculate_distance(a, b, travel_data=None):
    return leg_distance(a, b, travel_data)


def route_cost(route, customers, depot, travel_data=None):
    if not route:
        return 0

    total = 0
    previous = depot

    for customer_id in route:
        customer = customers[customer_id]
        total += leg_distance(previous, customer, travel_data)
        previous = customer

    total += leg_distance(previous, depot, travel_data)

    return total


def _route_is_feasible(
    route,
    customers,
    depot,
    capacity,
    duration
):
    """Vérifie les fenêtres horaires et la capacité."""

    load = 0
    current_time = depot["ready"]
    previous = depot

    for customer_id in route:

        customer = customers[customer_id]

        arrival = current_time + duration(previous, customer)

        service_start = max(arrival, customer["ready"])

        if service_start > customer["due"]:
            return False

        load += customer["demand"]

        if load > capacity:
            return False

        current_time = service_start + customer["service"]
        previous = customer

    return_time = current_time + duration(previous, depot)

    return return_time <= depot["due"]


def is_feasible(route, customers, depot, capacity, travel_data=None):
    distance, duration = create_metrics(depot, customers, travel_data)

    return _route_is_feasible(
        route, customers, depot, capacity, duration
    )


# =====================================================
# 3. CALCUL RAPIDE DU COUT D'INSERTION
# =====================================================

def _insertion_delta(
    route,
    position,
    customer_id,
    customers,
    depot,
    distance
):
    """
    Calcule uniquement le coût supplémentaire lié
    à l'insertion d'un client entre deux arrêts.
    """

    customer = customers[customer_id]

    previous = (
        customers[route[position - 1]]
        if position > 0
        else depot
    )

    following = (
        customers[route[position]]
        if position < len(route)
        else depot
    )

    return (
        distance(previous, customer)
        + distance(customer, following)
        - distance(previous, following)
    )


def _insertion_options(
    solution,
    customer_id,
    customers,
    depot,
    capacity,
    vehicle_count,
    distance,
    duration
):
    """
    Renvoie les insertions faisables sous la forme :
    (coût supplémentaire, indice tournée, position).

    Aucun deepcopy de la solution complète.
    """

    options = []

    for route_index, route in enumerate(solution):

        for position in range(len(route) + 1):

            candidate_route = route.copy()
            candidate_route.insert(position, customer_id)

            if not _route_is_feasible(
                candidate_route,
                customers,
                depot,
                capacity,
                duration
            ):
                continue

            delta = _insertion_delta(
                route,
                position,
                customer_id,
                customers,
                depot,
                distance
            )

            options.append((delta, route_index, position))

    # Possibilité de créer une nouvelle tournée
    if len(solution) < vehicle_count:

        new_route = [customer_id]

        if _route_is_feasible(
            new_route,
            customers,
            depot,
            capacity,
            duration
        ):

            customer = customers[customer_id]

            new_route_cost = (
                distance(depot, customer)
                + distance(customer, depot)
            )

            options.append((
                new_route_cost,
                len(solution),
                0
            ))

    options.sort(key=lambda option: option[0])

    return options


def _apply_insertion(solution, customer_id, route_index, position):
    """Applique uniquement l'insertion sélectionnée."""

    if route_index == len(solution):
        solution.append([customer_id])
    else:
        solution[route_index].insert(position, customer_id)


# =====================================================
# 4. RECHERCHE DE LA MEILLEURE INSERTION
# =====================================================

def find_best_insertion(
    solution,
    customer_id,
    customers,
    depot,
    capacity,
    vehicle_count,
    travel_data=None
):

    distance, duration = create_metrics(
        depot, customers, travel_data
    )

    options = _insertion_options(
        solution,
        customer_id,
        customers,
        depot,
        capacity,
        vehicle_count,
        distance,
        duration
    )

    if not options:
        return None, float("inf")

    best_cost, route_index, position = options[0]

    candidate = [route.copy() for route in solution]

    _apply_insertion(
        candidate, customer_id, route_index, position
    )

    return candidate, best_cost


# =====================================================
# 5. GREEDY INSERTION
# =====================================================

def greedy_insertion(
    solution,
    removed,
    customers,
    depot,
    capacity,
    vehicle_count,
    travel_data=None
):

    current_solution = [route.copy() for route in solution]
    remaining = list(removed)

    distance, duration = create_metrics(
        depot, customers, travel_data
    )

    while remaining:

        best_customer = None
        best_option = None
        best_cost = float("inf")

        for customer_id in remaining:

            options = _insertion_options(
                current_solution,
                customer_id,
                customers,
                depot,
                capacity,
                vehicle_count,
                distance,
                duration
            )

            if options and options[0][0] < best_cost:

                best_cost, route_index, position = options[0]

                best_customer = customer_id
                best_option = (route_index, position)

        if best_customer is None:
            raise ValueError(
                "Impossible de réinsérer tous les clients."
            )

        _apply_insertion(
            current_solution,
            best_customer,
            best_option[0],
            best_option[1]
        )

        remaining.remove(best_customer)

    return current_solution


# =====================================================
# 6. REGRET-2 INSERTION
# =====================================================

def regret_2_insertion(
    solution,
    removed,
    customers,
    depot,
    capacity,
    vehicle_count,
    travel_data=None
):

    current_solution = [route.copy() for route in solution]
    remaining = list(removed)

    distance, duration = create_metrics(
        depot, customers, travel_data
    )

    while remaining:

        selected_customer = None
        selected_option = None
        max_regret = -float("inf")

        for customer_id in remaining:

            options = _insertion_options(
                current_solution,
                customer_id,
                customers,
                depot,
                capacity,
                vehicle_count,
                distance,
                duration
            )

            if not options:
                continue

            best = options[0]

            second_cost = (
                options[1][0]
                if len(options) >= 2
                else float("inf")
            )

            regret = second_cost - best[0]

            if regret > max_regret:

                max_regret = regret
                selected_customer = customer_id
                selected_option = (best[1], best[2])

        if selected_customer is None:
            raise ValueError(
                "Impossible de réinsérer tous les clients."
            )

        _apply_insertion(
            current_solution,
            selected_customer,
            selected_option[0],
            selected_option[1]
        )

        remaining.remove(selected_customer)

    return current_solution


# =====================================================
# 7. REGRET-3 INSERTION
# =====================================================

def regret_3_insertion(
    solution,
    removed,
    customers,
    depot,
    capacity,
    vehicle_count,
    travel_data=None
):

    current_solution = [route.copy() for route in solution]
    remaining = list(removed)

    distance, duration = create_metrics(
        depot, customers, travel_data
    )

    while remaining:

        selected_customer = None
        selected_option = None
        max_regret = -float("inf")

        for customer_id in remaining:

            options = _insertion_options(
                current_solution,
                customer_id,
                customers,
                depot,
                capacity,
                vehicle_count,
                distance,
                duration
            )

            if not options:
                continue

            best = options[0]

            third_cost = (
                options[2][0]
                if len(options) >= 3
                else float("inf")
            )

            regret = third_cost - best[0]

            if regret > max_regret:

                max_regret = regret
                selected_customer = customer_id
                selected_option = (best[1], best[2])

        if selected_customer is None:
            raise ValueError(
                "Impossible de réinsérer tous les clients."
            )

        _apply_insertion(
            current_solution,
            selected_customer,
            selected_option[0],
            selected_option[1]
        )

        remaining.remove(selected_customer)

    return current_solution
