using Random
using Printf
using Base.Threads

# ============================================================================
# Solveur CVRPTW par ALNS (Adaptive Large Neighborhood Search)
#
# Principe : on part d'une solution construite par insertion gloutonne, puis,
# à chaque itération, on DÉTRUIT une partie de la solution (retrait de q
# clients) et on la RÉPARE (réinsertion). La nouvelle solution est acceptée
# selon un recuit simulé. Les opérateurs sont tirés selon des poids qui
# s'adaptent à leurs résultats.
#
# Objectif hiérarchique : d'abord moins de véhicules, ensuite moins de
# distance. Plusieurs chaînes indépendantes tournent en parallèle (multi-start)
# et partagent leur meilleure solution (voir run_chain et solve_parallel).
# ============================================================================

# ============================================================================
# Structures de données
# ============================================================================

struct Customer
    id::Int
    x::Float64
    y::Float64
    demand::Int
    ready::Float64
    due::Float64
    service::Float64
end

struct Instance
    name::String
    nb_vehicles::Int
    capacity::Int
    customers::Vector{Customer}   # indice 1 = dépôt (id 0)
    travel::Matrix{Float64}       # temps de trajet : fenêtres horaires
    neighbors::Vector{Vector{Int}}  # 30 plus proches clients de chaque point
    dist::Matrix{Float64}         # distance : coût à minimiser (= travel par défaut)
end

# Une route garde, pour chaque client, l'heure de service au plus tôt
# (earliest) et au plus tard (latest) : tester une insertion devient O(1).
mutable struct Route
    customers::Vector{Int}
    load::Int
    distance::Float64
    earliest::Vector{Float64}
    latest::Vector{Float64}
end

mutable struct Solution
    routes::Vector{Route}
    route_of::Vector{Int}   # route de chaque client (0 = non affecté)
end

# État commun aux chaînes parallèles, protégé par `mutex`.
mutable struct SharedState
    mutex::ReentrantLock
    stop::Atomic{Bool}
    best::Union{Nothing,Solution}
    target_solution::Union{Nothing,Solution}
    started::Float64
end

const EPS = 1e-7

# Nombre de véhicules de la solution de référence (0 = inconnu), renseigné par
# read_reference ; sert au critère d'arrêt sur le gap.
const REFERENCE_VEHICLES = Ref(0)

empty_route() = Route(Int[], 0, 0.0, Float64[], Float64[])

vehicles(s::Solution) = count(r -> !isempty(r.customers), s.routes)
distance(s::Solution) = sum(r.distance for r in s.routes)
objective(s::Solution) = (vehicles(s), distance(s))
better(a::Solution, b::Solution) = isless(objective(a), objective(b))

copy_route(r::Route) =
    Route(copy(r.customers), r.load, r.distance, copy(r.earliest), copy(r.latest))
copy_solution(s::Solution) = Solution(map(copy_route, s.routes), copy(s.route_of))

# ============================================================================
# Lecture de l'instance (format Solomon / Homberger)
# ============================================================================

# Matrice optionnelle n×n (dépôt d'abord), une ligne par point.
function read_travel_matrix(path::String, n::Int)
    rows = [split(strip(l)) for l in readlines(path) if !isempty(strip(l))]
    length(rows) == n ||
        error("Matrice : $(length(rows)) lignes, $n attendues.")

    m = Matrix{Float64}(undef, n, n)
    for i in 1:n
        length(rows[i]) == n ||
            error("Matrice : ligne $i a $(length(rows[i])) valeurs, $n attendues.")
        for j in 1:n
            v = tryparse(Float64, rows[i][j])
            (v !== nothing && isfinite(v) && v >= 0) ||
                error("Matrice : valeur invalide ligne $i, colonne $j.")
            m[i, j] = v
        end
        m[i, i] == 0 || error("Matrice : la diagonale doit valoir 0 (ligne $i).")
    end
    return m
end

# Lit <instance><extension> s'il existe, sinon renvoie `default`.
function optional_matrix(path::String, extension::String, n::Int, default, label)
    file = splitext(path)[1] * extension
    isfile(file) || return default
    println(label, " lue : ", basename(file))
    return read_travel_matrix(file, n)
end

function read_solomon(path::String)
    lines = readlines(path)
    isempty(lines) && error("Fichier d'instance vide.")

    header = findfirst(
        l -> occursin("NUMBER", uppercase(l)) && occursin("CAPACITY", uppercase(l)),
        lines
    )
    header === nothing && error("En-tête NUMBER / CAPACITY introuvable.")

    # Première ligne à deux entiers après l'en-tête : véhicules et capacité.
    nv = capacity = 0
    for k in (header + 1):length(lines)
        parts = split(strip(lines[k]))
        length(parts) == 2 || continue
        a, b = tryparse(Int, parts[1]), tryparse(Int, parts[2])
        if a !== nothing && b !== nothing
            nv, capacity = a, b
            break
        end
    end
    nv > 0 && capacity > 0 || error("Nombre de véhicules ou capacité invalide.")

    # Lignes clients : 7 valeurs numériques (id x y demande ready due service).
    customers = Customer[]
    for line in lines
        parts = split(strip(line))
        length(parts) == 7 || continue
        v = tryparse.(Float64, parts)
        any(isnothing, v) && continue
        push!(customers, Customer(Int(v[1]), v[2], v[3], Int(v[4]), v[5], v[6], v[7]))
    end

    sort!(customers, by = c -> c.id)
    length(customers) >= 2 || error("Aucun client trouvé.")
    all(((i, c),) -> c.id == i - 1, enumerate(customers)) ||
        error("Les identifiants doivent être consécutifs : 0, 1, ..., n.")

    n = length(customers)

    # Par défaut : distance à vol d'oiseau. Si <instance>.matrix existe, elle
    # donne les temps de trajet (fenêtres horaires) ; <instance>.dist, si elle
    # existe, donne le coût à minimiser (ex. km contre minutes par la route).
    travel = [hypot(customers[i].x - customers[j].x, customers[i].y - customers[j].y)
              for i in 1:n, j in 1:n]
    travel = optional_matrix(path, ".matrix", n, travel, "Matrice de trajet")
    dist = optional_matrix(path, ".dist", n, travel, "Matrice de distances")

    # 30 plus proches clients (le dépôt n'est jamais sélectionné).
    neighbors = map(1:n) do i
        ids = [id for id in 1:(n - 1) if id != i - 1]
        sort!(ids, by = id -> travel[i, id + 1])
        ids[1:min(30, length(ids))]
    end

    inst = Instance(strip(lines[1]), nv, capacity, customers, travel, neighbors, dist)
    println("Instance chargée : ", inst.name)
    println("Véhicules disponibles : ", nv, " | capacité : ", capacity,
            " | clients : ", n - 1)
    println()
    return inst
end

# ============================================================================
# Routes : distances, horaires, faisabilité
# ============================================================================

function route_distance(ids::Vector{Int}, inst::Instance)
    total = 0.0
    previous = 0
    for id in ids
        total += inst.dist[previous + 1, id + 1]
        previous = id
    end
    return total + inst.dist[previous + 1, 1]
end

# Recalcule charge, distance et horaires au plus tôt / au plus tard.
# Renvoie true si la route respecte capacité et fenêtres horaires.
function refresh!(r::Route, inst::Instance)
    n = length(r.customers)
    resize!(r.earliest, n)
    resize!(r.latest, n)

    r.load = 0
    r.distance = route_distance(r.customers, inst)

    # Passe avant : heure de début de service au plus tôt.
    t = inst.customers[1].ready
    previous = 0
    feasible = true

    for i in 1:n
        id = r.customers[i]
        c = inst.customers[id + 1]

        t += inst.travel[previous + 1, id + 1]
        t = max(t, c.ready)
        r.earliest[i] = t
        r.load += c.demand

        feasible &= t <= c.due + EPS
        t += c.service
        previous = id
    end

    feasible &= r.load <= inst.capacity
    feasible &= t + inst.travel[previous + 1, 1] <= inst.customers[1].due + EPS

    # Passe arrière : heure de début de service au plus tard sans retard.
    next_id = 0
    next_latest = inst.customers[1].due

    for i in n:-1:1
        id = r.customers[i]
        c = inst.customers[id + 1]
        r.latest[i] = min(c.due, next_latest - c.service - inst.travel[id + 1, next_id + 1])
        next_latest = r.latest[i]
        next_id = id
    end

    return feasible
end

# Insérer `id` en position `pos` respecte-t-il capacité et fenêtres horaires ?
# Test en O(1) grâce à earliest/latest.
function can_insert(r::Route, pos::Int, id::Int, inst::Instance)
    c = inst.customers[id + 1]
    r.load + c.demand <= inst.capacity || return false

    n = length(r.customers)
    previous = pos == 1 ? 0 : r.customers[pos - 1]

    departure = pos == 1 ? inst.customers[1].ready :
                r.earliest[pos - 1] + inst.customers[previous + 1].service

    start = max(departure + inst.travel[previous + 1, id + 1], c.ready)
    start <= c.due + EPS || return false

    if pos <= n
        next_id = r.customers[pos]
        arrival_next = start + c.service + inst.travel[id + 1, next_id + 1]
        return arrival_next <= r.latest[pos] + EPS
    end

    return start + c.service + inst.travel[id + 1, 1] <= inst.customers[1].due + EPS
end

# Détour de distance pour passer par `id` entre `previous` et `next_id`.
# Sert au coût d'une insertion comme au gain d'un retrait.
detour(inst::Instance, previous::Int, id::Int, next_id::Int) =
    inst.dist[previous + 1, id + 1] + inst.dist[id + 1, next_id + 1] -
    inst.dist[previous + 1, next_id + 1]

insertion_delta(r::Route, pos::Int, id::Int, inst::Instance) =
    detour(inst, pos == 1 ? 0 : r.customers[pos - 1], id,
           pos > length(r.customers) ? 0 : r.customers[pos])

removal_gain(r::Route, pos::Int, inst::Instance) =
    detour(inst, pos == 1 ? 0 : r.customers[pos - 1], r.customers[pos],
           pos == length(r.customers) ? 0 : r.customers[pos + 1])

function insert_at!(s::Solution, ri::Int, pos::Int, id::Int, inst::Instance)
    insert!(s.routes[ri].customers, pos, id)
    s.route_of[id + 1] = ri
    refresh!(s.routes[ri], inst)
    return s
end

function remove_id!(s::Solution, id::Int, inst::Instance)
    ri = s.route_of[id + 1]
    ri == 0 && return false

    r = s.routes[ri]
    pos = findfirst(==(id), r.customers)
    pos === nothing && error("Incohérence route_of pour le client $id.")

    deleteat!(r.customers, pos)
    s.route_of[id + 1] = 0
    refresh!(r, inst)
    return true
end

# Contrôle complet d'une solution : chaque client exactement une fois, routes
# faisables, au plus `limit` véhicules. La construction et la recherche
# utilisent parfois plus de routes que la limite (voir initial_solution) ;
# seul le résultat final est contrôlé strictement.
function validate!(s::Solution, inst::Instance; limit::Int = inst.nb_vehicles)
    seen = zeros(Int, length(inst.customers))
    fill!(s.route_of, 0)

    for (ri, r) in enumerate(s.routes)
        for id in r.customers
            1 <= id < length(inst.customers) || return false
            seen[id + 1] += 1
            seen[id + 1] == 1 || return false
            s.route_of[id + 1] = ri
        end
        refresh!(r, inst) || return false
    end

    return all(==(1), seen[2:end]) && vehicles(s) <= limit
end

# ============================================================================
# Solution de référence (fichier .sol) : sert au calcul du gap
# ============================================================================

# Routes lues dans les lignes « Route #k: id id id ».
function parse_reference_routes(lines)
    routes = Vector{Vector{Int}}()
    for raw in lines
        m = match(r"(?i)^\s*route\s*#?\s*\d+\s*:\s*(.*)$", raw)
        m === nothing && continue
        ids = tryparse.(Int, split(strip(m.captures[1])))
        any(isnothing, ids) && continue
        route = Int[x for x in ids]
        # Accepte un dépôt explicitement indiqué aux extrémités.
        !isempty(route) && first(route) == 0 && popfirst!(route)
        !isempty(route) && last(route) == 0 && pop!(route)
        isempty(route) || push!(routes, route)
    end
    return routes
end

# Renvoie le coût de référence, ou nothing si aucun .sol exploitable n'existe.
# Formats acceptés : ligne « Cost: x » (ou Distance, Objective...) ; à défaut,
# le coût est recalculé depuis les routes.
function read_reference(instance_path::String, inst::Instance)
    dir = dirname(abspath(instance_path))
    base = splitext(basename(instance_path))[1]
    wanted = lowercase.([base * ".sol", base * "_ref.sol", base * "_reference.sol"])

    candidates = String[]
    for folder in unique([dir, joinpath(dir, "reference"), joinpath(dir, "bks")])
        isdir(folder) || continue
        for filename in readdir(folder)
            lowercase(filename) in wanted && push!(candidates, joinpath(folder, filename))
        end
    end

    pattern = r"(?i)^\s*(?:cost|distance|total\s+distance|objective|value)\s*[:=]?\s*([0-9]+(?:[.,][0-9]+)?(?:[eE][+-]?[0-9]+)?)\s*$"

    for path in unique(candidates)
        println("Référence trouvée : ", path)

        try
            lines = readlines(path)
            routes = parse_reference_routes(lines)

            # 1) Coût écrit dans le fichier. Le nombre de routes donne les
            #    véhicules de la référence (0 si le fichier n'a que le coût).
            for raw in lines
                m = match(pattern, replace(raw, '﻿' => ""))
                m === nothing && continue
                value = tryparse(Float64, replace(m.captures[1], ',' => '.'))
                if value !== nothing && isfinite(value) && value > 0
                    println("Distance de référence : ", value)
                    REFERENCE_VEHICLES[] = count(
                        l -> occursin(r"(?i)^\s*route\s*#?\s*\d+\s*:", l), lines
                    )
                    REFERENCE_VEHICLES[] > 0 &&
                        println("Véhicules de la référence : ", REFERENCE_VEHICLES[])
                    println()
                    return value
                end
            end

            # 2) Sinon, coût recalculé depuis les routes (si elles sont valides).
            if !isempty(routes) && length(routes) <= inst.nb_vehicles
                rs = [empty_route() for _ in 1:inst.nb_vehicles]
                for (i, ids) in enumerate(routes)
                    rs[i].customers = ids
                end
                reference = Solution(rs, zeros(Int, length(inst.customers)))

                if validate!(reference, inst)
                    REFERENCE_VEHICLES[] = length(routes)
                    println("Coût recalculé depuis les routes : ",
                            @sprintf("%.6f", distance(reference)))
                    println()
                    return distance(reference)
                end
            end

            println("Référence illisible ou format non reconnu.")
        catch err
            println("Erreur de lecture : ", sprint(showerror, err))
        end
    end

    isempty(candidates) &&
        println("Aucune référence trouvée pour ", base, " (attendue : ",
                joinpath(dir, base * ".sol"), ").")
    println("Arrêt sur gap désactivé : toutes les itérations seront exécutées.")
    println()
    return nothing
end

# ============================================================================
# Réparation : insertion gloutonne et regret-2
# ============================================================================

# Routes où essayer d'insérer `id` : celles de ses plus proches voisins, plus
# une route vide (pour pouvoir ouvrir un véhicule).
function candidate_routes(s::Solution, id::Int, inst::Instance;
                          allow_empty::Bool = true)
    selected = falses(length(s.routes))

    for neighbor in inst.neighbors[id + 1]
        ri = s.route_of[neighbor + 1]
        ri > 0 && (selected[ri] = true)
    end

    if allow_empty
        ri = findfirst(r -> isempty(r.customers), s.routes)
        ri !== nothing && (selected[ri] = true)
    end

    return findall(selected)
end

# Meilleure position d'insertion de `id` dans la route r : (position, surcoût),
# ou (0, Inf) si aucune position n'est faisable.
function route_option(r::Route, id::Int, inst::Instance)
    best_delta = Inf
    best_pos = 0
    c = inst.customers[id + 1]
    n = length(r.customers)

    # Élagage exact (même résultat qu'un balayage complet) :
    # - latest est croissant : tant que latest[pos] < ready + service du
    #   client, l'insertion avant pos est impossible ;
    # - earliest + service est croissant : dès que le départ du
    #   prédécesseur dépasse l'échéance du client, tout le reste l'est aussi.
    first_pos = searchsortedfirst(r.latest, c.ready + c.service - 2EPS)

    for pos in first_pos:(n + 1)
        if pos > 1
            prev = r.customers[pos - 1]
            r.earliest[pos - 1] + inst.customers[prev + 1].service > c.due + EPS && break
        end

        can_insert(r, pos, id, inst) || continue
        delta = insertion_delta(r, pos, id, inst)

        if delta < best_delta
            best_delta = delta
            best_pos = pos
        end
    end

    return best_pos, best_delta
end

# Toutes les insertions possibles de `id`, triées par score (surcoût, plus une
# pénalité si on ouvre un nouveau véhicule). `full` teste toutes les routes ;
# on y passe automatiquement si les routes voisines ne conviennent pas.
function insertion_options(s::Solution, id::Int, inst::Instance;
                           full::Bool = false,
                           allow_empty::Bool = true,
                           opening_penalty::Float64 = 1000.0)
    indices = full ? collect(eachindex(s.routes)) :
                     candidate_routes(s, id, inst; allow_empty = allow_empty)

    options = Tuple{Float64,Int,Int}[]
    empty_tested = false

    for ri in indices
        r = s.routes[ri]

        if isempty(r.customers)   # une seule route vide suffit à tester
            allow_empty || continue
            empty_tested && continue
            empty_tested = true
        end

        pos, delta = route_option(r, id, inst)
        pos == 0 && continue
        push!(options, (delta + (isempty(r.customers) ? opening_penalty : 0.0), ri, pos))
    end

    sort!(options, by = first)

    isempty(options) && !full &&
        return insertion_options(s, id, inst; full = true, allow_empty = allow_empty,
                                 opening_penalty = opening_penalty)
    return options
end

# Cache du regret-2 : le résultat de route_option est réutilisé tant que la
# route n'a pas changé. versions[ri] augmente à chaque insertion dans la route
# ri ; ver/pos/delta sont indexés par (emplacement du client, route).
struct RegretCache
    ver::Matrix{Int}
    pos::Matrix{Int}
    delta::Matrix{Float64}
    versions::Vector{Int}
    seen::Vector{Int}          # marque les routes déjà candidates (par `stamp`)
    cands::Vector{Int}
    stamp::Base.RefValue{Int}
end

# Même résultat que insertion_options (hors mode full), avec le cache, et sans
# allocation : renvoie (meilleur score, route, position, deuxième score).
function regret_options(s::Solution, id::Int, slot::Int, inst::Instance,
                        allow_empty::Bool, cache::RegretCache;
                        opening_penalty::Float64 = 1000.0)
    (; ver, pos, delta, versions, seen, cands) = cache
    ncols = size(ver, 2)
    stamp = (cache.stamp[] += 1)
    empty!(cands)

    for neighbor in inst.neighbors[id + 1]
        ri = s.route_of[neighbor + 1]
        if ri > 0 && seen[ri] != stamp
            seen[ri] = stamp
            push!(cands, ri)
        end
    end

    if allow_empty
        ri = findfirst(r -> isempty(r.customers), s.routes)
        if ri !== nothing && seen[ri] != stamp
            seen[ri] = stamp
            push!(cands, ri)
        end
    end

    # Deux meilleurs scores seulement (sans tri).
    c1 = Inf; ri1 = 0; pos1 = 0
    c2 = Inf
    empty_tested = false

    for ri in cands
        r = s.routes[ri]
        is_empty = isempty(r.customers)

        if is_empty
            allow_empty || continue
            empty_tested && continue
            empty_tested = true
        end

        if ri <= ncols
            if ver[slot, ri] != versions[ri]
                pos[slot, ri], delta[slot, ri] = route_option(r, id, inst)
                ver[slot, ri] = versions[ri]
            end
            p, d = pos[slot, ri], delta[slot, ri]
        else
            p, d = route_option(r, id, inst)
        end

        p == 0 && continue

        score = d + (is_empty ? opening_penalty : 0.0)
        if score < c1
            c2 = c1
            c1 = score; ri1 = ri; pos1 = p
        elseif score < c2
            c2 = score
        end
    end

    if ri1 == 0   # aucune route voisine ne convient : on teste toutes les routes
        options = insertion_options(s, id, inst; full = true, allow_empty = allow_empty,
                                    opening_penalty = opening_penalty)
        isempty(options) && return Inf, 0, 0, Inf
        length(options) == 1 && return options[1][1], options[1][2], options[1][3], Inf
        return options[1][1], options[1][2], options[1][3], options[2][1]
    end

    return c1, ri1, pos1, c2
end

# Réinsertion gloutonne : clients dans un ordre aléatoire, chacun à une des
# meilleures positions (au hasard parmi celles à moins de 5 % du meilleur score).
function repair_greedy!(s::Solution, removed::Vector{Int}, inst::Instance,
                        rng::AbstractRNG, allow_empty::Bool)
    remaining = shuffle!(rng, copy(removed))

    for id in remaining
        options = insertion_options(s, id, inst; allow_empty = allow_empty)
        isempty(options) && return false

        best_score = options[1][1]
        limit = best_score + max(1.0, abs(best_score) * 0.05)
        count_close = count(o -> o[1] <= limit, options)
        _, ri, pos = options[rand(rng, 1:max(1, count_close))]

        insert_at!(s, ri, pos, id, inst)
    end

    return true
end

# Réinsertion par regret-2 : à chaque étape on insère le client qui "perdrait
# le plus" s'il n'obtenait pas sa meilleure route (écart entre ses deux
# meilleures options). Évite de laisser les clients difficiles pour la fin.
function repair_regret!(s::Solution, removed::Vector{Int}, inst::Instance,
                        allow_empty::Bool)
    remaining = copy(removed)
    last_used = something(findlast(r -> !isempty(r.customers), s.routes), 0)
    ncols = min(length(s.routes), last_used + 2 + length(removed))
    cache = RegretCache(
        fill(-1, length(removed), ncols), zeros(Int, length(removed), ncols),
        zeros(Float64, length(removed), ncols), zeros(Int, length(s.routes)),
        zeros(Int, length(s.routes)), Int[], Ref(0)
    )
    slots = collect(1:length(removed))

    while !isempty(remaining)
        chosen_index = chosen_route = chosen_pos = 0
        max_regret = -Inf
        tie_cost = Inf

        for (i, id) in enumerate(remaining)
            first_cost, ri, pos, second_cost =
                regret_options(s, id, slots[i], inst, allow_empty, cache)
            ri == 0 && return false

            regret = second_cost == Inf ? 1e12 : second_cost - first_cost

            if regret > max_regret || (regret == max_regret && first_cost < tie_cost)
                max_regret = regret
                tie_cost = first_cost
                chosen_index, chosen_route, chosen_pos = i, ri, pos
            end
        end

        insert_at!(s, chosen_route, chosen_pos, remaining[chosen_index], inst)
        cache.versions[chosen_route] += 1
        deleteat!(remaining, chosen_index)
        deleteat!(slots, chosen_index)
    end

    return true
end

# method 1 = glouton, 2 = regret-2.
repair!(s::Solution, removed::Vector{Int}, inst::Instance, rng::AbstractRNG,
        method::Int; allow_empty::Bool = true) =
    method == 1 ? repair_greedy!(s, removed, inst, rng, allow_empty) :
                  repair_regret!(s, removed, inst, allow_empty)

# ============================================================================
# Solution initiale (point de départ de chaque chaîne)
# ============================================================================

# Insertion gloutonne dans l'ordre des échéances. `noise` > 0 perturbe cet
# ordre : chaque chaîne démarre alors d'une solution différente (multi-start).
function initial_solution(inst::Instance, rng::AbstractRNG; noise::Float64 = 0.0)
    n = length(inst.customers) - 1

    horizon = inst.customers[1].due
    ids = collect(1:n)
    key = [inst.customers[id + 1].due + noise * horizon * rand(rng) for id in ids]
    sort!(ids, by = id -> (key[id], inst.customers[id + 1].ready))

    # On essaie d'abord avec la limite de véhicules de l'instance. Si les
    # fenêtres horaires empêchent cette construction simple d'y arriver, on
    # donne temporairement des routes en plus : la recherche (objectif
    # véhicules d'abord) ramène ensuite le nombre de véhicules sous la limite.
    slots = inst.nb_vehicles

    while true
        s = Solution([empty_route() for _ in 1:slots], zeros(Int, length(inst.customers)))
        blocked = 0

        for id in ids
            options = insertion_options(s, id, inst; full = true)
            if isempty(options)
                blocked = id
                break
            end
            _, ri, pos = options[1]
            insert_at!(s, ri, pos, id, inst)
        end

        if blocked == 0
            validate!(s, inst; limit = slots) || error("Solution initiale non valide.")
            slots > inst.nb_vehicles &&
                println("Construction initiale : ", slots, " routes nécessaires (limite ",
                        inst.nb_vehicles, "), la recherche doit redescendre sous la limite.")
            return s
        end

        slots >= n && error("Construction initiale impossible pour le client $blocked.")
        slots = min(n, slots + max(1, inst.nb_vehicles ÷ 2))
    end
end

# ============================================================================
# Destruction : 1 aléatoire, 2 pire, 3 route, 4 Shaw (proches), 5 string
# ============================================================================

# Retire q clients de la solution et renvoie leurs identifiants.
function destroy!(s::Solution, inst::Instance, rng::AbstractRNG, method::Int, q::Int)
    ids = [id for id in 1:(length(inst.customers) - 1) if s.route_of[id + 1] > 0]
    isempty(ids) && return Int[]

    q = min(q, length(ids))
    chosen = Int[]

    if method == 1          # aléatoire : q clients au hasard
        shuffle!(rng, ids)
        chosen = ids[1:q]

    elseif method == 2      # pire : clients dont le retrait économise le plus
        shuffle!(rng, ids)
        resize!(ids, min(length(ids), max(100, 4q)))

        ranked = Tuple{Float64,Int}[]
        for id in ids
            r = s.routes[s.route_of[id + 1]]
            push!(ranked, (removal_gain(r, findfirst(==(id), r.customers), inst), id))
        end
        sort!(ranked, by = x -> -x[1])

        # Tirage biaisé vers le haut du classement (rand^3).
        while length(chosen) < q && !isempty(ranked)
            k = min(length(ranked), 1 + floor(Int, rand(rng)^3 * length(ranked)))
            push!(chosen, ranked[k][2])
            deleteat!(ranked, k)
        end

    elseif method == 3      # route : vide une des 8 plus petites routes
        nonempty = findall(r -> !isempty(r.customers), s.routes)
        sort!(nonempty, by = ri -> length(s.routes[ri].customers))
        pool = nonempty[1:min(8, length(nonempty))]
        chosen = copy(s.routes[rand(rng, pool)].customers)

    elseif method == 4      # Shaw : clients proches en distance et en horaire
        seed = rand(rng, ids)
        c = inst.customers[seed + 1]
        scale_distance = max(1.0, maximum(@view inst.travel[seed + 1, :]))
        scale_time = max(1.0, inst.customers[1].due - inst.customers[1].ready)

        # Clé calculée une seule fois par client (et non à chaque comparaison).
        key = Vector{Float64}(undef, length(inst.customers))
        for id in ids
            key[id + 1] = inst.travel[seed + 1, id + 1] / scale_distance +
                          abs(inst.customers[id + 1].ready - c.ready) / scale_time
        end

        partialsort!(ids, 1:q, by = id -> key[id + 1])
        chosen = ids[1:q]

    else                    # string : petites séquences consécutives autour d'un client
        seed = rand(rng, ids)
        pool = unique(vcat([seed], inst.neighbors[seed + 1], shuffle!(rng, ids)))
        selected = Set{Int}()

        for id in pool
            length(chosen) >= q && break
            ri = s.route_of[id + 1]
            ri == 0 && continue

            r = s.routes[ri]
            pos = findfirst(==(id), r.customers)
            len = min(rand(rng, 1:6), length(r.customers) - pos + 1)

            for j in pos:(pos + len - 1)
                cid = r.customers[j]
                cid in selected && continue
                push!(selected, cid)
                push!(chosen, cid)
                length(chosen) >= q && break
            end
        end
    end

    foreach(id -> remove_id!(s, id, inst), chosen)
    return chosen
end

# ============================================================================
# Recherche locale légère : déplace un client vers une meilleure position
# ============================================================================

function relocate!(s::Solution, inst::Instance, rng::AbstractRNG;
                   max_tests::Int = 100, max_moves::Int = 15)
    ids = shuffle!(rng, collect(1:(length(inst.customers) - 1)))
    moves = 0

    for id in ids[1:min(max_tests, length(ids))]
        ri = s.route_of[id + 1]
        ri == 0 && continue

        r = s.routes[ri]
        pos = findfirst(==(id), r.customers)

        gain = removal_gain(r, pos, inst)
        old_vehicle = length(r.customers) == 1 ? 1 : 0
        remove_id!(s, id, inst)

        indices = candidate_routes(s, id, inst)
        ri in indices || push!(indices, ri)

        # Meilleur changement : (véhicule ouvert moins véhicule fermé, distance).
        best_change = (0, -EPS)
        target_route = target_pos = 0

        for target in indices
            tr = s.routes[target]
            p, delta = route_option(tr, id, inst)
            p == 0 && continue

            change = ((isempty(tr.customers) ? 1 : 0) - old_vehicle, delta - gain)
            if isless(change, best_change)
                best_change = change
                target_route, target_pos = target, p
            end
        end

        if target_route == 0   # aucun gain : le client retourne à sa place
            insert_at!(s, ri, pos, id, inst)
        else
            insert_at!(s, target_route, target_pos, id, inst)
            moves += 1
            moves >= max_moves && break
        end
    end

    return s
end

# ============================================================================
# Poids adaptatifs : les opérateurs efficaces sont tirés plus souvent
# ============================================================================

# Tirage proportionnel aux poids (roulette).
function choose_operator(weights::Vector{Float64}, rng::AbstractRNG)
    x = rand(rng) * sum(weights)
    cumulative = 0.0

    for i in eachindex(weights)
        cumulative += weights[i]
        x <= cumulative && return i
    end

    return lastindex(weights)
end

# Tous les 100 tours : poids = 80 % ancien poids + 20 % score moyen obtenu.
function update_weights!(weights, scores, uses)
    for i in eachindex(weights)
        uses[i] > 0 &&
            (weights[i] = max(0.1, 0.8 * weights[i] + 0.2 * scores[i] / uses[i]))
    end

    fill!(scores, 0.0)
    fill!(uses, 0)
end

# ============================================================================
# Export de la solution (ne remplace jamais le fichier de référence)
# ============================================================================

function output_path(instance_path::String)
    dir = dirname(abspath(instance_path))
    return joinpath(dir, splitext(basename(instance_path))[1] * "_alns.sol")
end

function write_solution(path::String, s::Solution)
    temporary = path * ".tmp"

    open(temporary, "w") do io
        route_number = 0
        for r in s.routes
            isempty(r.customers) && continue
            route_number += 1
            println(io, "Route #", route_number, ": ", join(r.customers, " "))
        end
        @printf(io, "Cost: %.6f\n", distance(s))
    end

    mv(temporary, path; force = true)
end

# ============================================================================
# État partagé entre chaînes : publication de la meilleure solution et arrêt
# ============================================================================

function publish!(shared::SharedState, candidate::Solution,
                  inst::Instance, reference::Union{Nothing,Float64},
                  target_gap::Float64, path::String,
                  chain_id::Int, iteration::Int)
    # Validation sur une copie privée avant de prendre le verrou.
    checked = copy_solution(candidate)
    validate!(checked, inst; limit = length(checked.routes)) ||
        error("Solution invalide produite par la chaîne $chain_id.")

    lock(shared.mutex) do
        shared.stop[] && return nothing

        if shared.best === nothing || better(checked, shared.best)
            shared.best = copy_solution(checked)
            gap_text = reference === nothing ? "" :
                @sprintf(" | gap distance %.2f %%", 100 * (distance(checked) / reference - 1))
            @printf("[%.1f s] chaîne %d, it. %d | véhicules %d | distance %.2f%s\n",
                    time() - shared.started, chain_id, iteration,
                    vehicles(checked), distance(checked), gap_text)
        end

        # Arrêt sur gap uniquement si un seuil fini a été demandé.
        if reference !== nothing && isfinite(target_gap) &&
           vehicles(checked) <= inst.nb_vehicles
            gap = distance(checked) / reference - 1
            ref_veh = REFERENCE_VEHICLES[]

            # Cible atteinte : distance dans le gap cible avec au plus autant
            # de véhicules que la référence. Avec plus de véhicules la distance
            # est trompeuse ; avec moins, la distance n'est pas comparable à la
            # référence : on continue jusqu'à la limite de temps.
            if gap <= target_gap + 1e-12 && (ref_veh == 0 || vehicles(checked) <= ref_veh)
                # Enregistre exactement la solution qui atteint la cible.
                shared.target_solution = copy_solution(checked)
                write_solution(path, checked)
                shared.stop[] = true

                println("Gap cible atteint : arrêt global demandé.")
                println("Solution enregistrée dans : ", path)
            end
        end

        return nothing
    end
end

# Copie de la meilleure solution commune (migration entre chaînes).
function import_best(shared::SharedState)
    return lock(shared.mutex) do
        shared.best === nothing ? nothing : copy_solution(shared.best)
    end
end

# ============================================================================
# Une chaîne ALNS : destruction, réparation, acceptation par recuit simulé
# ============================================================================

# Somme des carrés du nombre de clients par route : plus elle est grande,
# plus les routes sont inégales (quelques routes pleines, une très petite).
sumsq(s::Solution) = sum(r -> abs2(length(r.customers)), s.routes)

# Taille de la destruction : petite en temps normal, grande après 500
# itérations sans amélioration (diversification).
function destruction_size(rng::AbstractRNG, n::Int, stagnation::Int, q_scale::Float64)
    small = max(3, min(20, n ÷ 40))
    large = max(small, min(60, n ÷ 10))

    q = stagnation > 500 ? rand(rng, small:large) :
                           rand(rng, max(2, small ÷ 2):max(3, 2small))
    return min(n, max(2, round(Int, q * q_scale)))
end

function run_chain(inst::Instance, shared::SharedState,
                   reference::Union{Nothing,Float64},
                   target_gap::Float64, path::String,
                   max_iterations::Int, chain_id::Int, seed::Int;
                   consolidation::Float64 = 0.0,
                   t0_factor::Float64 = 0.003,
                   t_end::Float64 = 0.02,
                   migration::Int = 10000,
                   q_scale::Float64 = 1.0,
                   time_limit::Float64 = Inf)
    rng = MersenneTwister(seed)

    # Multi-start : la chaîne 1 part de la construction exacte, les autres d'une
    # construction perturbée (noise), donc de solutions différentes.
    current = initial_solution(inst, rng; noise = chain_id == 1 ? 0.0 : 0.1)
    best = copy_solution(current)
    publish!(shared, best, inst, reference, target_gap, path, chain_id, 0)

    # Poids et scores des 5 opérateurs de destruction et des 2 de réparation.
    dw, ds, du = ones(5), zeros(5), zeros(Int, 5)
    rw, rs, ru = ones(2), zeros(2), zeros(Int, 2)

    # Recuit simulé : température de départ proportionnelle à la distance.
    initial_temperature = max(2.0, distance(current) * t0_factor)
    temperature = initial_temperature
    cooling = exp(log(t_end) / max(1, max_iterations))
    last_progress = 0.0

    stagnation = 0   # itérations depuis la dernière amélioration de `best`
    completed = 0
    n = length(inst.customers) - 1

    for iteration in 1:max_iterations
        shared.stop[] && break
        isfinite(time_limit) && time() - shared.started >= time_limit && break
        completed = iteration

        # Migration : rare et seulement en cas de stagnation, pour garder des
        # chaînes différentes les unes des autres.
        if migration > 0 && iteration % migration == 0 && stagnation >= 500
            imported = import_best(shared)

            if imported !== nothing && better(imported, best)
                best = copy_solution(imported)
                current = copy_solution(imported)
                temperature = max(temperature, initial_temperature * 0.3)
            end
        end

        # Choix des opérateurs (roulette sur les poids) et de la taille q.
        di = choose_operator(dw, rng)
        rj = choose_operator(rw, rng)
        du[di] += 1
        ru[rj] += 1
        q = destruction_size(rng, n, stagnation, q_scale)

        # Destruction puis réparation sur une copie de la solution courante.
        # L'opérateur « route » essaie réellement de supprimer un véhicule en
        # interdisant parfois l'ouverture d'une route vide.
        trial = copy_solution(current)
        removed = destroy!(trial, inst, rng, di, q)
        allow_empty = !(di == 3 && rand(rng) < 0.5)
        success = !isempty(removed) &&
                  repair!(trial, removed, inst, rng, rj; allow_empty = allow_empty)

        reward = 0.0
        stagnation += 1

        if success
            iteration % 25 == 0 && relocate!(trial, inst, rng)

            # Acceptation : moins de véhicules toujours, plus jamais ; à nombre
            # égal, recuit simulé sur la distance (+ bonus de consolidation).
            old_k = vehicles(current)
            new_k = vehicles(trial)

            accepted = if new_k != old_k
                new_k < old_k
            else
                delta = distance(trial) - distance(current)
                consolidation > 0 && (delta -= consolidation * temperature *
                                      (sumsq(trial) - sumsq(current)) /
                                      (2 * (n / max(1, old_k))))
                delta <= 0 || rand(rng) < exp(-delta / max(temperature, 1e-9))
            end

            if accepted
                reward = better(trial, current) ? 3.0 : 0.5
                current = trial

                if better(current, best)
                    best = copy_solution(current)
                    reward = 8.0
                    stagnation = 0
                    publish!(shared, best, inst, reference, target_gap, path,
                             chain_id, iteration)
                elseif reference !== nothing &&
                       distance(current) <= reference * (1 + target_gap)
                    # Une solution peut atteindre la cible distance sans
                    # améliorer l'objectif lexicographique de la chaîne.
                    publish!(shared, current, inst, reference, target_gap, path,
                             chain_id, iteration)
                end
            end
        end

        ds[di] += reward
        rs[rj] += reward

        # Refroidissement. Avec une limite de temps, le recuit suit le temps :
        # il finit de refroidir à la limite (ou au dernier tour, si les
        # itérations s'épuisent avant).
        if isfinite(time_limit)
            progress = max(iteration / max_iterations,
                           (time() - shared.started) / time_limit)
            temperature *= t_end^max(0.0, progress - last_progress)
            last_progress = max(last_progress, progress)
        else
            temperature *= cooling
        end

        # Mise à jour des poids (même après une réparation échouée).
        if iteration % 100 == 0
            update_weights!(dw, ds, du)
            update_weights!(rw, rs, ru)
        end

        # Reprise après 1500 itérations sans amélioration : sur son propre
        # meilleur (1 fois sur 2) ou sur le meilleur global, avec un
        # réchauffage partiel seulement.
        if stagnation >= 1500
            imported = migration > 0 && rand(rng) < 0.5 ? import_best(shared) : nothing
            current = imported === nothing ? copy_solution(best) : imported
            temperature = max(temperature, initial_temperature * 0.3)
            stagnation = 0
        end
    end

    return best, completed
end

# ============================================================================
# Exécution parallèle : lance les chaînes, retient le meilleur, écrit les sorties
# ============================================================================

# Résumé lu par le backend (clés « Nom: valeur »).
function write_summary(path::String, inst::Instance, final::Solution,
                       reference, elapsed, n_chains, max_iterations,
                       shared::SharedState, results)
    open(path, "w") do io
        println(io, "Instance: ", inst.name)
        println(io, "Vehicles: ", vehicles(final))
        @printf(io, "Distance: %.6f\n", distance(final))
        @printf(io, "Elapsed_seconds: %.3f\n", elapsed)
        println(io, "Chains: ", n_chains)
        println(io, "Max_iterations_per_chain: ", max_iterations)
        println(io, "Target_reached: ", shared.stop[])

        if reference !== nothing
            println(io, "Reference_distance: ", reference)
            @printf(io, "Distance_gap_percent: %.6f\n",
                    100 * (distance(final) / reference - 1))
        else
            println(io, "Reference_distance: unavailable")
        end

        for cid in 1:n_chains
            println(io, "Chain_", cid, "_iterations: ", results[cid][2])
        end
    end
end

function solve_parallel(instance_path::String;
                        max_iterations::Int = 50_000,
                        n_chains::Int = 4,
                        target_gap::Float64 = Inf,
                        seed::Int = 42,
                        consolidation::Float64 = 0.0,
                        t0_factor::Float64 = 0.003,
                        t_end::Float64 = 0.02,
                        migration::Int = 10000,
                        q_scale::Float64 = 1.0,
                        time_limit::Float64 = Inf)
    max_iterations > 0 || error("max_iterations doit être positif.")
    n_chains > 0 || error("n_chaines doit être positif.")
    !isnan(target_gap) && target_gap >= 0 ||
        error("Le gap cible doit être positif ou nul.")

    started = time()
    inst = read_solomon(instance_path)
    reference = read_reference(instance_path, inst)
    path = output_path(instance_path)

    println("Threads Julia : ", Threads.nthreads(), " | chaînes : ", n_chains,
            " | itérations max par chaîne : ", max_iterations)
    isfinite(time_limit) && @printf("Temps maximal : %.0f s\n", time_limit)
    Threads.nthreads() < n_chains &&
        println("Attention : moins de threads que de chaînes. ",
                "Commande conseillée : julia --threads ", n_chains, " ...")

    if isfinite(target_gap) && reference !== nothing
        @printf("Gap distance cible : %.2f %% (distance %.6f)\n",
                100 * target_gap, reference * (1 + target_gap))
        println("Arrêt dès que la distance est dans le gap cible avec au plus ",
                "autant de véhicules que la référence.")
    else
        println("Pas de gap cible exploitable : toutes les itérations seront exécutées.")
    end
    println("Sortie : ", path)
    println()

    shared = SharedState(ReentrantLock(), Atomic{Bool}(false), nothing, nothing, started)
    results = Vector{Tuple{Solution,Int}}(undef, n_chains)

    # Multi-start parallèle : une chaîne par thread, graines différentes.
    @sync for chain_id in 1:n_chains
        let cid = chain_id
            Threads.@spawn results[cid] = run_chain(
                inst, shared, reference, target_gap, path, max_iterations,
                cid, seed + 7919cid;
                consolidation = consolidation, t0_factor = t0_factor,
                t_end = t_end, migration = migration, q_scale = q_scale,
                time_limit = time_limit
            )
        end
    end

    # Si le seuil a été atteint, conserve la solution déjà sauvegardée.
    # Sinon, retient le meilleur objectif (véhicules puis distance).
    final = if shared.target_solution !== nothing
        shared.target_solution
    else
        pool = [first.(results); shared.best === nothing ? Solution[] : [shared.best]]
        foldl((a, b) -> better(b, a) ? b : a, pool)
    end
    final = copy_solution(final)

    # La limite de véhicules n'empêche pas d'obtenir un résultat : si le
    # meilleur trouvé la dépasse, on le rend quand même avec un avertissement
    # pour éviter de relancer le calcul.
    vehicles(final) > inst.nb_vehicles &&
        println("AVERTISSEMENT limite de véhicules dépassée : ", vehicles(final),
                " utilisés pour ", inst.nb_vehicles, " autorisés.")
    validate!(final, inst; limit = length(final.routes)) ||
        error("La solution finale est invalide.")
    write_solution(path, final)

    elapsed = time() - started

    println()
    println("========================================")
    println("Résultat final")
    println("========================================")
    println("Instance : ", inst.name)
    println("Véhicules utilisés : ", vehicles(final))
    @printf("Distance totale : %.6f\n", distance(final))
    @printf("Temps total : %.2f secondes\n", elapsed)

    reference === nothing ?
        println("Gap : indisponible, référence absente ou illisible.") :
        @printf("Gap distance atteint : %.3f %%\n", 100 * (distance(final) / reference - 1))

    println(
        "Motif d'arrêt : ",
        shared.stop[] ? "gap distance cible atteint." :
        isfinite(time_limit) && elapsed >= time_limit ? "temps maximal atteint." :
        "toutes les itérations terminées."
    )

    for cid in 1:n_chains
        println("Chaîne ", cid, " : ", results[cid][2], " itérations exécutées.")
    end

    summary_path = splitext(path)[1] * "_resume.txt"
    write_summary(summary_path, inst, final, reference, elapsed, n_chains,
                  max_iterations, shared, results)
    println("Solution enregistrée dans : ", path)
    println("Résumé enregistré dans : ", summary_path)
    return final
end

# ============================================================================
# Lancement en ligne de commande
# ============================================================================

if abspath(PROGRAM_FILE) == abspath(@__FILE__)
    if length(ARGS) < 2
        println("Usage : julia --threads 4 --project=. -O3 CVRPTW_ALNS.jl ",
                "<instance.txt> <max_iterations> [n_chaines] [gap_cible] [seed] ",
                "[consolidation] [t0_factor] [t_end] [migration] [q_scale] ",
                "[temps_max_secondes]")
        println("Exemple : julia --threads 4 --project=. -O3 CVRPTW_ALNS.jl ",
                "RC1_6_2.txt 50000 4 0.06")
        exit(1)
    end

    # Un argument "-" laisse la valeur par défaut (permet de n'en fixer qu'un).
    arg(k, T, default) =
        length(ARGS) >= k && ARGS[k] != "-" ? parse(T, ARGS[k]) : default

    solve_parallel(
        ARGS[1];
        max_iterations = parse(Int, ARGS[2]),
        n_chains = arg(3, Int, 4),
        target_gap = arg(4, Float64, Inf),
        seed = arg(5, Int, 42),
        consolidation = arg(6, Float64, 0.0),
        t0_factor = arg(7, Float64, 0.003),
        t_end = arg(8, Float64, 0.02),
        migration = arg(9, Int, 10000),
        q_scale = arg(10, Float64, 1.0),
        time_limit = arg(11, Float64, Inf)
    )
end
