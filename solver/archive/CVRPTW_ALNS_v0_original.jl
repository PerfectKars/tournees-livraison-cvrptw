using Random
using Printf
using Base.Threads

# ============================================================================
# Structures
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
    customers::Vector{Customer}
    travel::Matrix{Float64}
    neighbors::Vector{Vector{Int}}
end

mutable struct Route
    customers::Vector{Int}
    load::Int
    distance::Float64
    earliest::Vector{Float64}
    latest::Vector{Float64}
end

mutable struct Solution
    routes::Vector{Route}
    route_of::Vector{Int}
end

mutable struct SharedState
    mutex::ReentrantLock
    stop::Atomic{Bool}
    best::Union{Nothing,Solution}
    target_solution::Union{Nothing,Solution}
    started::Float64
end

const EPS = 1e-7

empty_route() = Route(Int[], 0, 0.0, Float64[], Float64[])

vehicles(s::Solution) = count(r -> !isempty(r.customers), s.routes)
distance(s::Solution) = sum(r.distance for r in s.routes)
objective(s::Solution) = (vehicles(s), distance(s))
better(a::Solution, b::Solution) = isless(objective(a), objective(b))

function copy_solution(s::Solution)
    routes = [
        Route(
            copy(r.customers),
            r.load,
            r.distance,
            copy(r.earliest),
            copy(r.latest)
        )
        for r in s.routes
    ]
    return Solution(routes, copy(s.route_of))
end

# ============================================================================
# Lecture de l'instance Solomon / Homberger
# ============================================================================

function read_solomon(path::String)
    lines = readlines(path)
    isempty(lines) && error("Fichier d'instance vide.")

    header = findfirst(
        line -> occursin("NUMBER", uppercase(line)) &&
                occursin("CAPACITY", uppercase(line)),
        lines
    )
    header === nothing && error("En-tête NUMBER / CAPACITY introuvable.")

    nv = 0
    capacity = 0

    for k in (header + 1):length(lines)
        parts = split(strip(lines[k]))
        length(parts) == 2 || continue
        a = tryparse(Int, parts[1])
        b = tryparse(Int, parts[2])
        if a !== nothing && b !== nothing
            nv = a
            capacity = b
            break
        end
    end

    nv > 0 && capacity > 0 ||
        error("Nombre de véhicules ou capacité invalide.")

    customers = Customer[]

    for line in lines
        parts = split(strip(line))
        length(parts) == 7 || continue
        values = tryparse.(Float64, parts)
        any(isnothing, values) && continue
        v = Float64[x for x in values]

        push!(customers, Customer(
            Int(v[1]), v[2], v[3], Int(v[4]), v[5], v[6], v[7]
        ))
    end

    sort!(customers, by = c -> c.id)
    length(customers) >= 2 || error("Aucun client trouvé.")

    for (i, c) in enumerate(customers)
        c.id == i - 1 ||
            error("Les identifiants doivent être consécutifs : 0, 1, ..., n.")
    end

    n = length(customers)
    travel = Matrix{Float64}(undef, n, n)

    for i in 1:n, j in 1:n
        travel[i, j] = hypot(
            customers[i].x - customers[j].x,
            customers[i].y - customers[j].y
        )
    end

    # Voisins clients uniquement : le dépôt n'est pas sélectionné.
    neighbors = Vector{Vector{Int}}(undef, n)

    for i in 1:n
        ids = [id for id in 1:(n - 1) if id != i - 1]
        sort!(ids, by = id -> travel[i, id + 1])
        neighbors[i] = ids[1:min(30, length(ids))]
    end

    inst = Instance(
        strip(lines[1]), nv, capacity, customers, travel, neighbors
    )

    println("Instance chargée : ", inst.name)
    println("Véhicules disponibles : ", nv)
    println("Capacité : ", capacity)
    println("Nombre de clients : ", n - 1)
    println()

    return inst
end

# ============================================================================
# Temps et distances des routes
# ============================================================================

function route_distance(ids::Vector{Int}, inst::Instance)
    total = 0.0
    previous = 0

    for id in ids
        total += inst.travel[previous + 1, id + 1]
        previous = id
    end

    return total + inst.travel[previous + 1, 1]
end

function refresh!(r::Route, inst::Instance)
    n = length(r.customers)
    resize!(r.earliest, n)
    resize!(r.latest, n)

    r.load = 0
    r.distance = route_distance(r.customers, inst)

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
    feasible &= t + inst.travel[previous + 1, 1] <=
                inst.customers[1].due + EPS

    next_id = 0
    next_latest = inst.customers[1].due

    for i in n:-1:1
        id = r.customers[i]
        c = inst.customers[id + 1]

        r.latest[i] = min(
            c.due,
            next_latest - c.service -
            inst.travel[id + 1, next_id + 1]
        )

        next_latest = r.latest[i]
        next_id = id
    end

    return feasible
end

function can_insert(r::Route, pos::Int, id::Int, inst::Instance)
    c = inst.customers[id + 1]
    r.load + c.demand <= inst.capacity || return false

    n = length(r.customers)
    previous = pos == 1 ? 0 : r.customers[pos - 1]

    departure = if pos == 1
        inst.customers[1].ready
    else
        r.earliest[pos - 1] + inst.customers[previous + 1].service
    end

    start = max(
        departure + inst.travel[previous + 1, id + 1],
        c.ready
    )
    start <= c.due + EPS || return false

    if pos <= n
        next_id = r.customers[pos]
        arrival_next = start + c.service +
                       inst.travel[id + 1, next_id + 1]
        return arrival_next <= r.latest[pos] + EPS
    end

    return start + c.service + inst.travel[id + 1, 1] <=
           inst.customers[1].due + EPS
end

function insertion_delta(r::Route, pos::Int, id::Int, inst::Instance)
    previous = pos == 1 ? 0 : r.customers[pos - 1]
    next_id = pos > length(r.customers) ? 0 : r.customers[pos]

    return inst.travel[previous + 1, id + 1] +
           inst.travel[id + 1, next_id + 1] -
           inst.travel[previous + 1, next_id + 1]
end

function removal_gain(r::Route, pos::Int, inst::Instance)
    id = r.customers[pos]
    previous = pos == 1 ? 0 : r.customers[pos - 1]
    next_id = pos == length(r.customers) ? 0 : r.customers[pos + 1]

    return inst.travel[previous + 1, id + 1] +
           inst.travel[id + 1, next_id + 1] -
           inst.travel[previous + 1, next_id + 1]
end

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

function validate!(s::Solution, inst::Instance)
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

    return all(==(1), seen[2:end]) &&
           vehicles(s) <= inst.nb_vehicles
end

# ============================================================================
# Lecture du coût de référence
# ============================================================================

function read_reference(instance_path::String, inst::Instance)
    dir = dirname(abspath(instance_path))
    base = splitext(basename(instance_path))[1]

    wanted = lowercase.([
        base * ".sol",
        base * "_ref.sol",
        base * "_reference.sol"
    ])

    candidates = String[]

    for folder in unique([dir, joinpath(dir, "reference"),
                          joinpath(dir, "bks")])
        isdir(folder) || continue

        for filename in readdir(folder)
            lowercase(filename) in wanted || continue
            push!(candidates, joinpath(folder, filename))
        end
    end

    # Formats : Cost: ..., Cost = ..., Distance: ..., Objective: ...
    pattern = r"(?i)^\s*(?:cost|distance|total\s+distance|objective|value)\s*[:=]?\s*([0-9]+(?:[.,][0-9]+)?(?:[eE][+-]?[0-9]+)?)\s*$"

    for path in unique(candidates)
        println("Référence trouvée : ", path)

        try
            lines = readlines(path)

            for raw in lines
                line = replace(raw, '\ufeff' => "")
                m = match(pattern, line)
                m === nothing && continue

                value = tryparse(
                    Float64, replace(m.captures[1], ',' => '.')
                )

                if value !== nothing && isfinite(value) && value > 0
                    println("Distance de référence : ", value)
                    println()
                    return value
                end
            end

            # Si aucun coût n'est indiqué, tente les lignes Route #k: ...
            routes = Vector{Vector{Int}}()

            for raw in lines
                m = match(r"(?i)^\s*route\s*#?\s*\d+\s*:\s*(.*)$", raw)
                m === nothing && continue

                tokens = split(strip(m.captures[1]))
                ids = tryparse.(Int, tokens)
                any(isnothing, ids) && continue

                route = Int[x for x in ids]

                # Accepte un dépôt explicitement indiqué aux extrémités.
                if !isempty(route) && first(route) == 0
                    popfirst!(route)
                end
                if !isempty(route) && last(route) == 0
                    pop!(route)
                end

                isempty(route) || push!(routes, route)
            end

            if !isempty(routes)
                rs = [empty_route() for _ in 1:inst.nb_vehicles]

                if length(routes) <= length(rs)
                    for (i, ids) in enumerate(routes)
                        rs[i].customers = ids
                    end

                    reference = Solution(rs, zeros(Int, length(inst.customers)))

                    if validate!(reference, inst)
                        value = distance(reference)
                        println(
                            "Coût recalculé depuis les routes : ",
                            @sprintf("%.6f", value)
                        )
                        println()
                        return value
                    end
                end
            end

            println("Référence illisible ou format non reconnu.")
        catch err
            println("Erreur de lecture : ", sprint(showerror, err))
        end
    end

    if isempty(candidates)
        println("Aucune référence trouvée pour ", base, ".")
        println("Chemin attendu : ", joinpath(dir, base * ".sol"))
    end

    println("Arrêt sur gap désactivé.")
    println("Toutes les itérations seront exécutées.")
    println("La meilleure solution sera enregistrée à la fin.")
    println()

    return nothing
end

# ============================================================================
# Insertions : routes candidates et regret-2
# ============================================================================

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

function route_option(r::Route, id::Int, inst::Instance)
    best_delta = Inf
    best_pos = 0

    for pos in 1:(length(r.customers) + 1)
        can_insert(r, pos, id, inst) || continue
        delta = insertion_delta(r, pos, id, inst)

        if delta < best_delta
            best_delta = delta
            best_pos = pos
        end
    end

    return best_pos, best_delta
end

function insertion_options(s::Solution, id::Int, inst::Instance;
                           full::Bool = false,
                           allow_empty::Bool = true,
                           opening_penalty::Float64 = 1000.0)
    indices = full ? collect(eachindex(s.routes)) :
                     candidate_routes(s, id, inst;
                                      allow_empty = allow_empty)

    options = Tuple{Float64,Int,Int}[]
    empty_tested = false

    for ri in indices
        r = s.routes[ri]

        if isempty(r.customers)
            allow_empty || continue
            empty_tested && continue
            empty_tested = true
        end

        pos, delta = route_option(r, id, inst)
        pos == 0 && continue

        score = delta + (isempty(r.customers) ? opening_penalty : 0.0)
        push!(options, (score, ri, pos))
    end

    sort!(options, by = first)

    if isempty(options) && !full
        return insertion_options(
            s, id, inst;
            full = true,
            allow_empty = allow_empty,
            opening_penalty = opening_penalty
        )
    end

    return options
end

function repair!(s::Solution, removed::Vector{Int}, inst::Instance,
                 rng::AbstractRNG, method::Int;
                 allow_empty::Bool = true)
    remaining = copy(removed)

    if method == 1
        shuffle!(rng, remaining)

        for id in remaining
            options = insertion_options(
                s, id, inst; allow_empty = allow_empty
            )
            isempty(options) && return false

            # Petite diversification parmi les insertions proches du meilleur.
            best_score = options[1][1]
            limit = best_score + max(1.0, abs(best_score) * 0.05)
            count_close = count(o -> o[1] <= limit, options)
            chosen = options[rand(rng, 1:max(1, count_close))]
            _, ri, pos = chosen

            insert_at!(s, ri, pos, id, inst)
        end
    else
        while !isempty(remaining)
            chosen_index = 0
            chosen_route = 0
            chosen_pos = 0
            max_regret = -Inf
            tie_cost = Inf

            for (i, id) in enumerate(remaining)
                options = insertion_options(
                    s, id, inst; allow_empty = allow_empty
                )
                isempty(options) && return false

                first_cost, ri, pos = options[1]
                regret = length(options) == 1 ?
                    1e12 : options[2][1] - first_cost

                if regret > max_regret ||
                   (regret == max_regret && first_cost < tie_cost)
                    max_regret = regret
                    tie_cost = first_cost
                    chosen_index = i
                    chosen_route = ri
                    chosen_pos = pos
                end
            end

            id = remaining[chosen_index]
            insert_at!(s, chosen_route, chosen_pos, id, inst)
            deleteat!(remaining, chosen_index)
        end
    end

    return true
end

function initial_solution(inst::Instance, rng::AbstractRNG)
    s = Solution(
        [empty_route() for _ in 1:inst.nb_vehicles],
        zeros(Int, length(inst.customers))
    )

    ids = collect(1:(length(inst.customers) - 1))
    sort!(ids, by = id -> (
        inst.customers[id + 1].due,
        inst.customers[id + 1].ready,
        rand(rng)
    ))

    for id in ids
        options = insertion_options(s, id, inst; full = true)
        isempty(options) &&
            error("Construction initiale impossible pour le client $id.")

        _, ri, pos = options[1]
        insert_at!(s, ri, pos, id, inst)
    end

    validate!(s, inst) || error("Solution initiale non valide.")
    return s
end

# ============================================================================
# Destruction : random, worst, route, related, string
# ============================================================================

function destroy!(s::Solution, inst::Instance, rng::AbstractRNG,
                  method::Int, q::Int)
    ids = [id for id in 1:(length(inst.customers) - 1)
           if s.route_of[id + 1] > 0]
    isempty(ids) && return Int[]

    q = min(q, length(ids))
    chosen = Int[]

    if method == 1
        shuffle!(rng, ids)
        chosen = ids[1:q]

    elseif method == 2
        shuffle!(rng, ids)
        resize!(ids, min(length(ids), max(100, 4q)))

        ranked = Tuple{Float64,Int}[]
        for id in ids
            ri = s.route_of[id + 1]
            r = s.routes[ri]
            pos = findfirst(==(id), r.customers)
            push!(ranked, (removal_gain(r, pos, inst), id))
        end

        sort!(ranked, by = x -> -x[1])

        while length(chosen) < q && !isempty(ranked)
            k = min(length(ranked),
                    1 + floor(Int, rand(rng)^3 * length(ranked)))
            push!(chosen, ranked[k][2])
            deleteat!(ranked, k)
        end

    elseif method == 3
        nonempty = findall(r -> !isempty(r.customers), s.routes)
        sort!(nonempty, by = ri -> length(s.routes[ri].customers))
        pool = nonempty[1:min(8, length(nonempty))]
        ri = rand(rng, pool)
        chosen = copy(s.routes[ri].customers)

    elseif method == 4
        seed = rand(rng, ids)
        c = inst.customers[seed + 1]
        scale_distance = max(1.0, maximum(inst.travel[seed + 1, :]))
        scale_time = max(1.0, inst.customers[1].due -
                              inst.customers[1].ready)

        sort!(ids, by = id ->
            inst.travel[seed + 1, id + 1] / scale_distance +
            abs(inst.customers[id + 1].ready - c.ready) / scale_time
        )
        chosen = ids[1:q]

    else
        seed = rand(rng, ids)
        pool = unique(vcat([seed], inst.neighbors[seed + 1], ids))
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

    for id in chosen
        remove_id!(s, id, inst)
    end

    return chosen
end

# ============================================================================
# Recherche locale légère
# ============================================================================

function relocate!(s::Solution, inst::Instance, rng::AbstractRNG;
                   max_tests::Int = 100, max_moves::Int = 15)
    ids = collect(1:(length(inst.customers) - 1))
    shuffle!(rng, ids)
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

        best_change = (0, -EPS)
        target_route = 0
        target_pos = 0

        for target in indices
            tr = s.routes[target]
            p, delta = route_option(tr, id, inst)
            p == 0 && continue

            new_vehicle = isempty(tr.customers) ? 1 : 0
            change = (new_vehicle - old_vehicle, delta - gain)

            if isless(change, best_change)
                best_change = change
                target_route = target
                target_pos = p
            end
        end

        if target_route == 0
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
# Poids adaptatifs
# ============================================================================

function choose_operator(weights::Vector{Float64}, rng::AbstractRNG)
    x = rand(rng) * sum(weights)
    cumulative = 0.0

    for i in eachindex(weights)
        cumulative += weights[i]
        x <= cumulative && return i
    end

    return lastindex(weights)
end

function update_weights!(weights, scores, uses)
    for i in eachindex(weights)
        if uses[i] > 0
            weights[i] = max(
                0.1,
                0.8 * weights[i] + 0.2 * scores[i] / uses[i]
            )
        end
    end

    fill!(scores, 0.0)
    fill!(uses, 0)
end

# ============================================================================
# Export : ne remplace jamais le fichier de référence
# ============================================================================

function output_path(instance_path::String)
    dir = dirname(abspath(instance_path))
    base = splitext(basename(instance_path))[1]
    return joinpath(dir, base * "_alns.sol")
end

function write_solution(path::String, s::Solution)
    temporary = path * ".tmp"

    open(temporary, "w") do io
        route_number = 0
        for r in s.routes
            isempty(r.customers) && continue
            route_number += 1
            println(io, "Route #", route_number, ": ",
                    join(r.customers, " "))
        end

        @printf(io, "Cost: %.6f\n", distance(s))
    end

    mv(temporary, path; force = true)
end

# ============================================================================
# État partagé : publication, arrêt et migration
# ============================================================================

function publish!(shared::SharedState, candidate::Solution,
                  inst::Instance, reference::Union{Nothing,Float64},
                  target_gap::Float64, path::String,
                  chain_id::Int, iteration::Int)
    # Validation sur une copie privée avant de prendre le verrou.
    checked = copy_solution(candidate)
    validate!(checked, inst) ||
        error("Solution invalide produite par la chaîne $chain_id.")

    lock(shared.mutex) do
        shared.stop[] && return nothing

        improved = shared.best === nothing ||
                   better(checked, shared.best)

        if improved
            shared.best = copy_solution(checked)
            elapsed = time() - shared.started

            if reference === nothing
                @printf(
                    "[%.1f s] chaîne %d, it. %d | véhicules %d | distance %.2f\n",
                    elapsed, chain_id, iteration,
                    vehicles(checked), distance(checked)
                )
            else
                gap = 100 * (distance(checked) / reference - 1)
                @printf(
                    "[%.1f s] chaîne %d, it. %d | véhicules %d | distance %.2f | gap distance %.2f %%\n",
                    elapsed, chain_id, iteration,
                    vehicles(checked), distance(checked), gap
                )
            end
        end

        # Arrêt sur gap uniquement si un seuil fini a été demandé.
        if reference !== nothing && isfinite(target_gap)
            gap = distance(checked) / reference - 1

            if gap <= target_gap + 1e-12
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

function import_best(shared::SharedState)
    return lock(shared.mutex) do
        shared.best === nothing ? nothing : copy_solution(shared.best)
    end
end

# ============================================================================
# Une chaîne ALNS
# ============================================================================

function run_chain(inst::Instance, shared::SharedState,
                   reference::Union{Nothing,Float64},
                   target_gap::Float64, path::String,
                   max_iterations::Int, chain_id::Int, seed::Int)
    rng = MersenneTwister(seed)
    current = initial_solution(inst, rng)
    best = copy_solution(current)

    publish!(
        shared, best, inst, reference, target_gap, path, chain_id, 0
    )

    dw = ones(5)
    ds = zeros(5)
    du = zeros(Int, 5)

    rw = ones(2)
    rs = zeros(2)
    ru = zeros(Int, 2)

    initial_temperature = max(2.0, distance(current) * 0.003)
    temperature = initial_temperature
    cooling = exp(log(0.02) / max(1, max_iterations))

    stagnation = 0
    completed = 0
    n = length(inst.customers) - 1

    for iteration in 1:max_iterations
        shared.stop[] && break
        completed = iteration

        # Migration : conserve une exploration locale entre deux échanges.
        if iteration % 200 == 0
            imported = import_best(shared)

            if imported !== nothing && better(imported, best)
                best = copy_solution(imported)

                if stagnation >= 100 || rand(rng) < 0.5
                    current = copy_solution(imported)
                    temperature = max(
                        temperature, initial_temperature * 0.3
                    )
                end
            end
        end

        di = choose_operator(dw, rng)
        rj = choose_operator(rw, rng)
        du[di] += 1
        ru[rj] += 1

        small = max(3, min(20, n ÷ 40))
        large = max(small, min(60, n ÷ 10))

        q = stagnation > 500 ?
            rand(rng, small:large) :
            rand(rng, max(2, small ÷ 2):max(3, 2small))

        q = min(n, q)
        trial = copy_solution(current)
        removed = destroy!(trial, inst, rng, di, q)

        # Certaines destructions de route essaient réellement de supprimer
        # un véhicule en interdisant l'ouverture d'une route vide.
        allow_empty = !(di == 3 && rand(rng) < 0.5)

        success = !isempty(removed) &&
                  repair!(
                      trial, removed, inst, rng, rj;
                      allow_empty = allow_empty
                  )

        reward = 0.0
        stagnation += 1

        if success
            if iteration % 25 == 0
                relocate!(trial, inst, rng)
            end

            old_k = vehicles(current)
            new_k = vehicles(trial)
            delta_distance = distance(trial) - distance(current)

            accepted = if new_k < old_k
                true
            elseif new_k > old_k
                false
            else
                delta_distance <= 0 ||
                rand(rng) < exp(
                    -delta_distance / max(temperature, 1e-9)
                )
            end

            if accepted
                improved_current = better(trial, current)
                current = trial
                reward = improved_current ? 3.0 : 0.5

                if better(current, best)
                    best = copy_solution(current)
                    reward = 8.0
                    stagnation = 0

                    publish!(
                        shared, best, inst, reference,
                        target_gap, path, chain_id, iteration
                    )
                elseif reference !== nothing &&
                       distance(current) <= reference * (1 + target_gap)
                    # Une solution peut atteindre la cible distance sans
                    # améliorer l'objectif lexicographique de la chaîne.
                    publish!(
                        shared, current, inst, reference,
                        target_gap, path, chain_id, iteration
                    )
                end
            end
        end

        ds[di] += reward
        rs[rj] += reward
        temperature *= cooling

        # Toujours effectué, même après une réparation échouée.
        if iteration % 100 == 0
            update_weights!(dw, ds, du)
            update_weights!(rw, rs, ru)
        end

        if stagnation >= 1500
            imported = import_best(shared)
            current = imported === nothing ?
                copy_solution(best) : imported
            temperature = initial_temperature
            stagnation = 0
        end
    end

    return best, completed
end

# ============================================================================
# Résumé et exécution parallèle
# ============================================================================

function solve_parallel(instance_path::String;
                        max_iterations::Int = 50_000,
                        n_chains::Int = 4,
                        target_gap::Float64 = Inf,
                        seed::Int = 42)
    max_iterations > 0 || error("max_iterations doit être positif.")
    n_chains > 0 || error("n_chaines doit être positif.")
    !isnan(target_gap) && target_gap >= 0 ||
        error("Le gap cible doit être positif ou nul.")

    started = time()
    inst = read_solomon(instance_path)
    reference = read_reference(instance_path, inst)
    path = output_path(instance_path)

    println("Threads Julia disponibles : ", Threads.nthreads())
    println("Nombre de chaînes : ", n_chains)
    println("Itérations maximales par chaîne : ", max_iterations)

    if Threads.nthreads() < n_chains
        println(
            "Attention : moins de threads que de chaînes. ",
            "Commande conseillée : julia --threads ", n_chains, " ..."
        )
    end

    if !isfinite(target_gap)
        println("Aucun gap cible demandé.")
        println("Toutes les itérations seront exécutées.")
    elseif reference === nothing
        println("Gap cible demandé, mais référence indisponible.")
        println("Toutes les itérations seront exécutées.")
    else
        @printf("Gap distance cible : %.2f %%\n", 100 * target_gap)
        @printf(
            "Distance cible : %.6f\n",
            reference * (1 + target_gap)
        )
        println("Ce critère ne contraint pas le nombre de véhicules.")
    end

    println("Sortie : ", path)
    println()

    shared = SharedState(
        ReentrantLock(), Atomic{Bool}(false),
        nothing, nothing, started
    )

    results = Vector{Tuple{Solution,Int}}(undef, n_chains)

    @sync begin
        for chain_id in 1:n_chains
            let cid = chain_id
                Threads.@spawn begin
                    results[cid] = run_chain(
                        inst, shared, reference, target_gap,
                        path, max_iterations,
                        cid, seed + 7919cid
                    )
                end
            end
        end
    end

    # Si le seuil a été atteint, conserve la solution déjà sauvegardée.
    # Sinon, retient le meilleur objectif véhicules puis distance.
    final = if shared.target_solution !== nothing
        copy_solution(shared.target_solution)
    else
        candidate = copy_solution(results[1][1])

        for (solution, _) in results
            if better(solution, candidate)
                candidate = copy_solution(solution)
            end
        end

        if shared.best !== nothing && better(shared.best, candidate)
            candidate = copy_solution(shared.best)
        end

        candidate
    end

    validate!(final, inst) || error("La solution finale est invalide.")
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

    if reference !== nothing
        @printf(
            "Gap distance atteint : %.3f %%\n",
            100 * (distance(final) / reference - 1)
        )
    else
        println("Gap : indisponible, référence absente ou illisible.")
    end

    if shared.stop[]
        println("Motif d'arrêt : gap distance cible atteint.")
    else
        println("Motif d'arrêt : toutes les itérations terminées.")
    end

    for cid in 1:n_chains
        println(
            "Chaîne ", cid, " : ",
            results[cid][2], " itérations exécutées."
        )
    end

    println("Solution enregistrée dans : ", path)

    summary_path = splitext(path)[1] * "_resume.txt"
    open(summary_path, "w") do io
        println(io, "Instance: ", inst.name)
        println(io, "Vehicles: ", vehicles(final))
        @printf(io, "Distance: %.6f\n", distance(final))
        @printf(io, "Elapsed_seconds: %.3f\n", elapsed)
        println(io, "Chains: ", n_chains)
        println(io, "Max_iterations_per_chain: ", max_iterations)
        println(io, "Target_reached: ", shared.stop[])

        if reference !== nothing
            println(io, "Reference_distance: ", reference)
            @printf(
                io, "Distance_gap_percent: %.6f\n",
                100 * (distance(final) / reference - 1)
            )
        else
            println(io, "Reference_distance: unavailable")
        end

        for cid in 1:n_chains
            println(io, "Chain_", cid, "_iterations: ", results[cid][2])
        end
    end

    println("Résumé enregistré dans : ", summary_path)
    return final
end

# ============================================================================
# Lancement
# ============================================================================

if abspath(PROGRAM_FILE) == abspath(@__FILE__)
    if length(ARGS) < 2
        println("Usage :")
        println(
            "julia --threads 4 --project=. -O3 CVRPTW_ALNS.jl ",
            "<instance.txt> <max_iterations> [n_chaines] [gap_cible] [seed]"
        )
        println()
        println("Exemple :")
        println(
            "julia --threads 4 --project=. -O3 CVRPTW_ALNS.jl ",
            "RC1_6_2.txt 50000 4 0.06"
        )
        exit(1)
    end

    instance_path = ARGS[1]
    iterations = parse(Int, ARGS[2])
    chains = length(ARGS) >= 3 ? parse(Int, ARGS[3]) : 4
    gap = length(ARGS) >= 4 ? parse(Float64, ARGS[4]) : Inf
    seed = length(ARGS) >= 5 ? parse(Int, ARGS[5]) : 42

    solve_parallel(
        instance_path;
        max_iterations = iterations,
        n_chains = chains,
        target_gap = gap,
        seed = seed
    )
end