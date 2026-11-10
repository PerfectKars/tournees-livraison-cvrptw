# CVRPTW – ALNS multi-start (Julia)

Instance cible : `RC2_10_10` (Gehring-Homberger, 1000 clients, 250 véhicules, capacité 1000).
Objectif : minimiser (véhicules, distance) le plus vite possible.

## Structure
- `src/CVRPTW_ALNS.jl` : solveur ALNS parallèle (chaînes + migration)
- `instances/` : instances Solomon / Homberger (`.txt`), et éventuelle référence `<nom>.sol`
- `results/` : un dossier par run (solution `.sol`, résumé, log)
- `logs/` : logs isolés
- `run.sh` : lance un run et range les sorties

## Lancer
    ./run.sh RC2_10_10.txt 100000 4

Arguments du solveur : `<instance.txt> <iterations> [chaines] [gap_cible] [seed] [consolidation] [t0_factor] [t_end] [migration] [q_scale]`
(défauts : 4 chaînes, pas de gap cible, graine 42, 0.0, 0.003, 0.02, 10000, 1.0). `ALNS_DIAG=1` affiche des statistiques par opérateur.

Explications détaillées des modifications : voir `COMPARAISON.txt`.

## Historique (RC2_10_10, 4 chaînes, gap par rapport à 21 834,94)
| Version | Itérations | Gap | Temps |
|---|---|---|---|
| Origine | 20 000 | 13,66 % (24 818,25) | 19 s |
| + élagage, cache du regret, départs diversifiés (1 graine) | 200 000 | 7,82 % | 89 s |
| + migration 2000 (3 graines, moyenne) | 100 000 | 8,25 % | ~38 s |
| + migration 10 000 (3 graines, moyenne) | 100 000 | 7,43 % | ~38 s |
| + regret-2 sans allocation (2 graines, moyenne) | 100 000 | 7,78 % | ~24 s |
| idem | 200 000 | 7,43 % | ~49 s |

RC2_4_10 (version actuelle, 100 000 it) : gap 2,7 à 3,8 % en ~11 s.
Objectif temps (< 40 s) atteint ; gap < 7 % non atteint de façon stable (le bruit entre graines est de plusieurs points).

## Essais sans gain (non retenus)
Consolidation, réglage de température, `q_scale` (global ou par chaîne), reprise sur la meilleure de la chaîne,
regret-2 limité à 30 %. Les versions testées sont dans `src/CVRPTW_ALNS_v*.jl`.

## Pistes restantes
1. Bruit dans les coûts d'insertion du regret-2
2. Phase finale sans dégradation (température coupée, q réduit)
3. Budget de temps (arrêt à ~38 s)
4. Phase de minimisation de flotte (ejection pool / SISR), utile pour RC2_10_7 (18 véhicules)
5. Recherche locale 2-opt*, Or-opt
