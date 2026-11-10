# Comparaison : ALNS classique, code d'origine, code actuel

Ce document répond à trois questions :
1. Qu'est-ce qu'un ALNS « de manuel » ?
2. En quoi notre code d'origine (`src/CVRPTW_ALNS_v0_original.jl`) s'en écarte ou le reprend ?
3. Qu'avons-nous modifié depuis, pourquoi, et avec quel effet mesuré ?

Instance cible : `RC2_10_10` (1000 clients). Référence : meilleure solution connue SINTEF
(21 834,94 ; 18 véhicules). Le gap est `(distance - référence) / référence`.

---

## 1. Un ALNS « de manuel »

L'ALNS (Adaptive Large Neighbourhood Search, Ropke & Pisinger 2006) améliore une solution en boucle :

1. **Détruire** : retirer `q` clients de la solution courante avec un opérateur de destruction.
2. **Réparer** : les réinsérer avec un opérateur de réparation.
3. **Accepter ou non** la nouvelle solution (en général un recuit simulé).
4. **Adapter** : chaque opérateur a un poids. Un opérateur qui produit de bonnes solutions est tiré plus souvent.

Les ingrédients standards :

| Ingrédient | Version classique |
|---|---|
| Destruction | aléatoire, « pire » (clients les plus coûteux), apparentée (Shaw), par route |
| Réparation | insertion gloutonne, insertion par regret-k |
| Choix des opérateurs | roulette selon des poids, mis à jour par segments |
| Acceptation | recuit simulé, température décroissante |
| Objectif | une seule valeur (distance) |

Le point faible connu de cette structure est le **coût de la réparation** : pour chaque client
à réinsérer, il faut tester toutes les positions de plusieurs routes. Le regret-2 refait ce calcul
à chaque tour de sa boucle, donc il domine le temps de calcul.

---

## 2. Notre code d'origine face à l'ALNS classique

Ce que l'on retrouve tel quel :

- 5 destructions : aléatoire, pire, route entière, apparentée (Shaw), par chaîne de clients (string removal).
- 2 réparations : gloutonne (avec un peu d'aléatoire parmi les insertions proches du meilleur)
  et regret-2.
- Poids adaptatifs : mis à jour toutes les 100 itérations,
  `poids = max(0,1 ; 0,8 × ancien + 0,2 × score moyen)`.
- Recuit simulé : température de départ `max(2 ; distance × 0,003)`, refroidissement géométrique
  jusqu'à `0,02 ×` la température de départ à la dernière itération, réchauffage sur stagnation.

Ce qui est propre à ce code :

- **Objectif lexicographique** : d'abord le nombre de véhicules, ensuite la distance.
- **Fenêtres de temps** : chaque route garde pour chaque position l'heure d'arrivée au plus tôt
  (`earliest`) et la dernière heure d'arrivée permise (`latest`). Tester une insertion est donc
  rapide, sans reparcourir la route.
- **Routes candidates** : pour un client, on ne teste que les routes qui contiennent l'un de ses
  30 plus proches voisins, plus une route vide.
- **Plusieurs chaînes en parallèle** (`Threads.@spawn`) : chaque chaîne fait son propre ALNS,
  et une meilleure solution partagée (protégée par un verrou) permet les échanges.
- **Reprise sur stagnation** : après 1500 itérations sans amélioration, la chaîne repart d'une
  solution connue avec un réchauffage.

Dans la version d'origine, les chaînes échangeaient très souvent (tous les 200 itérations) et
repartaient toutes à la température maximale. Cela donnait des chaînes presque identiques.

---

## 2 bis. Le code expliqué simplement

### L'idée générale
Le problème : livrer 1000 clients avec le moins de camions possible, puis avec le moins de kilomètres.
Chaque client a une fenêtre horaire (il faut arriver entre `ready` et `due`) et une demande ; chaque
camion a une capacité de 1000.

Le programme part d'une solution correcte mais médiocre, puis la **casse et la reconstruit** des
dizaines de milliers de fois. Il garde ce qui est meilleur, et parfois ce qui est un peu pire, pour
ne pas rester bloqué. C'est l'ALNS.

### Comment une route est représentée
Une route est une liste de clients, par exemple `[12, 87, 5]` (le dépôt est le client 0, au début et
à la fin). Pour chaque position, on stocke deux heures :
- **`earliest`** : l'heure d'arrivée au plus tôt chez ce client (on attend si on arrive avant l'ouverture).
- **`latest`** : l'heure d'arrivée la plus tardive qui laisse encore la suite de la route faisable.

C'est l'astuce centrale. Pour savoir si on peut insérer le client X entre le 2ᵉ et le 3ᵉ client d'une
route, il suffit de :
1. calculer l'heure d'arrivée chez X à partir de `earliest` du 2ᵉ client ;
2. vérifier que X est ouvert à ce moment ;
3. vérifier que l'arrivée chez le 3ᵉ client reste inférieure à son `latest`.

Il n'y a pas besoin de reparcourir la route : c'est `can_insert`, en temps constant. Après chaque
modification, `refresh!` recalcule ces deux tableaux pour la route modifiée.

### Une itération, pas à pas
Prenons 1000 clients et `q` = 20.

1. **Copie** de la solution courante.
2. **Destruction** : on tire un opérateur, par exemple « Shaw ». On choisit un client germe au hasard
   et on retire les 20 clients les plus proches de lui (en distance et en heure d'ouverture). Ils sont
   maintenant hors de toute route.
3. **Réparation** : on tire un opérateur d'insertion.
   - *Glouton* : les 20 clients sont pris dans le désordre ; chacun va à sa meilleure position, avec un
     peu de hasard parmi les positions presque aussi bonnes.
   - *Regret-2* : pour chaque client retiré, on calcule le surcoût de sa meilleure insertion et celui
     de sa deuxième meilleure. La différence est le **regret**. On insère en premier le client qui a le
     plus grand regret (celui qui perdrait le plus à attendre), puis on recommence avec les clients
     restants. Exemple : un client dont la meilleure insertion coûte 3 et la deuxième 80 passe avant un
     client dont les deux meilleures coûtent 3 et 5.
4. **Décision** :
   - moins de véhicules : on accepte toujours ;
   - plus de véhicules : on refuse toujours ;
   - même nombre : si la distance baisse, on accepte ; sinon on accepte avec la probabilité
     `exp(-augmentation / température)`. C'est le **recuit simulé** : la température est élevée au
     début (on accepte des dégradations) puis descend jusqu'à presque zéro.
5. **Apprentissage** : l'opérateur reçoit une récompense (8 pour un nouveau meilleur de la chaîne,
   3 pour une amélioration de la solution courante, 0,5 pour une solution acceptée). Toutes les
   100 itérations les poids sont recalculés, et les opérateurs rentables sont tirés plus souvent.

Toutes les 25 itérations, `relocate!` essaie de déplacer 100 clients, un par un, vers une meilleure
position.

### Pourquoi plusieurs chaînes
Le programme lance 4 chaînes (4 threads) qui font chacune cette boucle sur leur propre solution. Elles
partagent seulement la meilleure solution trouvée, protégée par un verrou. Sur stagnation, une chaîne
repart de sa meilleure solution et réchauffe la température. Toutes les 10 000 itérations, si elle
stagne, elle peut adopter la meilleure solution globale.

### Pourquoi le regret-2 prend le plus de temps
Pour 20 clients à réinsérer, chaque tour de la boucle recalcule la meilleure position de chaque client
restant dans chaque route candidate : de l'ordre de 20 × 20 / 2 évaluations de route par réparation.
D'où les trois accélérations faites :
- l'élagage : on saute les positions manifestement impossibles (3.2) ;
- le cache : on ne recalcule que la route qui vient de changer (3.3) ;
- le calcul des deux meilleurs sans tableau ni tri (3.7).

---

## 2 ter. Le code, fonction par fonction

Tout est dans `src/CVRPTW_ALNS.jl`. Les numéros de ligne sont ceux de la version actuelle.

### Données (lignes 9-60)
- `Customer` : un client (position, demande, fenêtre `ready`/`due`, durée de service). Le dépôt est le client 0.
- `Instance` : capacité, matrice des temps/distances `travel`, et `neighbors` (les 30 plus proches voisins de chaque client).
- `Route` : liste de clients, charge, distance, et deux tableaux par position : `earliest` (heure d'arrivée au plus tôt) et `latest` (heure d'arrivée au plus tard pour que la suite reste faisable).
- `Solution` : la liste des routes et `route_of[id]` (route de chaque client, 0 s'il est retiré).
- `SharedState` : ce que les chaînes partagent (meilleure solution, verrou, drapeau d'arrêt).
- `objective(s) = (véhicules, distance)` et `better(a, b)` comparent dans l'ordre lexicographique.

### Évaluer une route (lignes 163-312)
- `refresh!` recalcule `earliest`, `latest`, la charge et la distance d'une route, et dit si elle est faisable. Elle est appelée après chaque insertion ou retrait.
- `can_insert` teste en temps constant si un client peut être inséré à une position : capacité, fenêtre du client, et arrivée au suivant avant son `latest`.
- `insertion_delta` donne le surcoût en distance ; `removal_gain` le gain d'un retrait.
- `insert_at!`, `remove_id!` modifient la solution. `validate!` revérifie tout (utilisée avant de publier une solution).

### Réparer (lignes 434-681)
- `candidate_routes` : routes qui contiennent un voisin du client, plus une route vide.
- `route_option` : meilleure position du client dans une route (avec l'élagage du 3.2).
- `insertion_options` : toutes les options triées, utilisée par le glouton et en secours.
- `regret_options` : version du regret-2 avec cache et sans allocation (3.3 et 3.7). Elle renvoie le meilleur coût, la route, la position et le deuxième meilleur coût.
- `repair!` :
  - `method == 1` (glouton) : les clients sont pris dans un ordre aléatoire, chacun va dans une insertion tirée parmi celles qui coûtent au plus 5 % (ou 1 unité) de plus que la meilleure.
  - sinon (regret-2) : à chaque tour, on insère le client dont le regret (deuxième meilleur coût moins meilleur coût) est le plus grand, puis on recommence avec les clients restants.
  - Ouvrir une route vide coûte une pénalité de 1000, pour éviter de créer des véhicules sans nécessité.
- `initial_solution` : insère les clients par échéance croissante (avec un bruit selon la chaîne).

### Détruire (lignes 714-803)
Cinq opérateurs, numérotés comme dans les diagnostics :
1. **aléatoire** : `q` clients au hasard.
2. **pire** : on tire un échantillon de clients, on les classe par `removal_gain` décroissant, puis on tire avec un biais fort (`rand^3`) vers les plus coûteux.
3. **route** : on prend l'une des 8 plus petites routes et on la vide entièrement.
4. **Shaw (apparenté)** : les `q` clients les plus proches d'un client germe, selon la distance et l'écart d'heure d'ouverture.
5. **string** : chaînes de 1 à 6 clients consécutifs autour d'un client germe et de ses voisins.

### Recherche locale légère (`relocate!`, lignes 809-858)
Toutes les 25 itérations, sur 100 clients tirés au hasard : on retire le client et on le réinsère à sa meilleure position si c'est mieux. Au plus 15 déplacements. Elle existait déjà dans la version d'origine.

### Adaptation (lignes 864-888)
`choose_operator` fait une roulette sur les poids. `update_weights!` les met à jour toutes les 100 itérations. Les récompenses sont : 8 pour un nouveau meilleur de la chaîne, 3 pour une amélioration de la solution courante, 0,5 pour une solution acceptée.

### Partage entre chaînes (lignes 922-980)
`publish!` valide une solution sur une copie privée, puis, sous verrou, la garde si elle est meilleure que la meilleure globale et arrête tout si le gap cible est atteint. `import_best` renvoie une copie de la meilleure globale.

### Une chaîne (`run_chain`, ligne 990)
À chaque itération :
1. (rarement) adopter la meilleure solution globale (`migration`) ;
2. choisir un opérateur de destruction et un de réparation ;
3. tirer `q` : de l'ordre de 10 à 40 clients normalement, de 20 à 60 en cas de stagnation prolongée (pour `n = 1000`), puis multiplié par `q_scale` ;
4. copier la solution, détruire, réparer ; une route vide n'est pas autorisée une fois sur deux après l'opérateur « route », pour tenter de supprimer un véhicule ;
5. accepter : toujours si le nombre de véhicules baisse, jamais s'il monte, sinon par recuit sur la distance ;
6. mettre à jour la meilleure solution, publier, adapter les poids, refroidir ;
7. après 1500 itérations sans nouveau meilleur : repartir de sa meilleure solution et réchauffer à 30 %.

### Lancement (`solve_parallel`, ligne 1210)
Lit l'instance et la référence, lance une chaîne par thread (`seed + 7919 × numéro`), attend la fin, écrit la solution et le résumé.

---

## 3. Les modifications, dans l'ordre

Chaque étape a une sauvegarde de l'état précédent dans `src/`.
« Exact » signifie que le résultat est identique à celui du balayage complet.

### 3.1 Départs différents et échanges rares (`_v0_original` → `_v1_avant_elagage`)

- **Départs diversifiés** : `initial_solution(...; noise)` perturbe l'ordre d'insertion initial.
  La chaîne 1 reste déterministe, les autres reçoivent un bruit de 0,1.
- **Échanges moins fréquents** : l'adoption de la meilleure solution globale se fait toutes les
  2000 itérations (au lieu de 200) et seulement si la chaîne stagne depuis 500 itérations.
- **Réchauffage partiel** : sur stagnation, la température remonte à 30 % de la température
  initiale (au lieu de 100 %) et la chaîne repart une fois sur deux de sa propre meilleure solution.
- **Petites accélérations de Shaw** : `partialsort!` au lieu d'un tri complet, vue sans copie de
  la matrice des distances.

*But : garder des chaînes différentes les unes des autres.*

### 3.2 Élagage exact de `route_option` (`_v1` → `_v2_avant_cache`)

La recherche de la meilleure position dans une route saute les positions impossibles :
- `latest` est croissant, donc on commence à la première position où le client peut arriver à temps ;
- on s'arrête dès que le départ du prédécesseur dépasse l'échéance du client.

*Exact : même résultat qu'un balayage complet, en moins de calculs.*

### 3.3 Cache du regret-2 (`_v2` → `_v3_avant_shaw`)

Le regret-2 calcule, à chaque tour, la meilleure position de chaque client restant dans chaque
route candidate. Or une seule route change entre deux tours. Le cache (`regret_options`) conserve
le résultat de `route_option` par couple (client, route) et ne le recalcule que si la route a été
modifiée (compteur `versions`).

*Exact : mêmes décisions que sans cache. C'est l'accélération principale du regret-2.*

### 3.4 Clés de Shaw calculées une fois (`_v3` → `_v4_avant_consolidation`)

La clé de proximité (distance + écart de fenêtre) est calculée une fois par client au lieu de
l'être à chaque comparaison du tri.

*Exact, petite accélération.*

### 3.5 Options de réglage ajoutées, laissées neutres par défaut

Elles sont disponibles en ligne de commande mais ne changent rien aux valeurs par défaut
(sauf `migration`, voir 3.6) :

| Argument | Rôle | Défaut |
|---|---|---|
| 6 `consolidation` | bonus à l'acceptation quand une route se vide | 0,0 (désactivé) |
| 7 `t0_factor` | température de départ en proportion de la distance | 0,003 |
| 8 `t_end` | température finale relative à la température de départ | 0,02 |
| 9 `migration` | période d'adoption de la meilleure solution globale (0 = jamais) | 10000 |
| 10 `q_scale` | multiplicateur de la taille de destruction | 1,0 |

Le mode diagnostic (`ALNS_DIAG=1`, statistiques par opérateur) a servi pendant la mise au
point puis a été retiré pour alléger le code ; il reste dans l'historique git.

### 3.6 `migration` à 10 000 (au lieu de 2000)

Le diagnostic a montré que les 4 chaînes finissaient sur la même solution : elles s'échangeaient
trop et faisaient le même travail. Avec une période de 10 000, elles restent plus indépendantes.

*Mesuré sur RC2_10_10 à 100 000 itérations, 3 graines : gap moyen 8,25 % → 7,43 %.
RC2_4_10 inchangé (3,8 %).*

### 3.7 Regret-2 sans allocation (`_v9_avant_top2` → version actuelle)

Dans la boucle du regret-2, chaque appel construisait un tableau de toutes les options, puis le
triait, alors que seuls les deux meilleurs scores servent. `regret_options` garde maintenant les
deux meilleurs en un seul passage et réutilise ses tampons (marqueur de routes déjà vues, liste de
candidates).

*Pas strictement identique : quand deux scores sont exactement égaux, l'ordre d'examen des routes
peut changer. Le résultat reste reproductible d'un run à l'autre.*

*Mesuré : environ 13 % plus rapide sur une seule chaîne (5,60 s → 4,89 s sur 15 000 itérations).
Avec 4 chaînes, RC2_10_10 à 100 000 itérations passe de ~38 s à ~24 s.*

Un premier essai avec une fonction interne était plus lent (6,33 s) : Julia mettait les variables
capturées en boîte. La boucle simple est la version retenue.

---

## 4. Essais abandonnés (mesurés, sans gain)

| Essai | Résultat | Sauvegarde |
|---|---|---|
| Consolidation (bonus de vidage de route) | pas de gain net ; RC2_10_7 reste à 19 véhicules | option laissée à 0 |
| Réglages de température (4 combinaisons) | dans le bruit | défauts inchangés |
| `q_scale` 0,75 / 1,5, 140 000 itérations | 1,0 reste le meilleur sur RC2_10_10 | option laissée à 1,0 |
| `q_scale` différent par chaîne (0,75 / 1 / 1,25 / 1) | gap moyen 8,16 % contre 7,78 %, et plus lent | `_v11_q_par_chaine.jl` |
| Reprise toujours sur la meilleure solution de la chaîne | identique (7,80 % contre 7,78 %) | `_v12_reprise_chaine.jl` |
| Regret-2 limité à 30 % des réparations | 10 à 15 % plus rapide mais moins bon sur RC2_10_10 (8,5 % contre 7,8 %) | `_v13_regret30.jl` |
| Réécriture de `candidate_routes` | 12 % plus lent, annulée | (non conservée) |

Le diagnostic donne aussi : le regret-2 prend environ 70 % du temps de réparation ; il réussit
~1,5 fois mieux par utilisation, mais le glouton est ~1,7 fois plus efficace par seconde. Les poids
adaptatifs répartissent déjà environ 70 % / 30 %.

---

## 5. Résultats

Gap sur RC2_10_10, 4 chaînes, plusieurs graines.

| Version | Itérations | Gap | Temps |
|---|---|---|---|
| Origine | 20 000 | 13,66 % (distance 24 818,25) | 19 s |
| Avec cache du regret, 200 000 it (1 graine) | 200 000 | 7,82 % | 89 s |
| Avec migration 2000, 100 000 it (3 graines) | 100 000 | 8,25 % (moyenne) | ~38 s |
| Avec migration 10 000, 100 000 it (3 graines) | 100 000 | 7,43 % (moyenne) | ~38 s |
| Version actuelle (regret-2 sans allocation), 100 000 it (2 graines) | 100 000 | 7,78 % (7,37 ; 8,19) | ~24 s |
| Version actuelle, 200 000 it (2 graines) | 200 000 | 7,43 % (8,66 ; 6,19) | ~49 s |

Sur RC2_4_10 (400 clients) la version actuelle donne 2,7 à 3,8 % en ~11 s.

Le bruit est important : avec 4 chaînes, une même graine peut donner 5,9 % ou 9,9 %, car la date
des échanges entre chaînes dépend de l'ordonnancement des threads. Il faut comparer des moyennes
sur plusieurs graines, et seuls les runs à une chaîne avec la même graine sont reproductibles.

**Objectifs :** temps < 40 s atteint (~24 s). Gap < 7 % non atteint de façon stable
(moyenne 7,4 à 7,8 %, un run sur deux passe sous 7,5 %).

---

## 6. Pistes restantes

- Bruit aléatoire dans les coûts d'insertion du regret-2 (Ropke) : peu de code, effet incertain.
- Phase finale sans dégradation (température coupée, `q` réduit) : gain probable de 0,1 à 0,3 point.
- Budget de temps (arrêt à 38 s) : garantit la contrainte de temps sur toute machine.
- Pour RC2_10_7 : ne descend pas toujours à 18 véhicules (remplissage de 99 %). Un « ejection pool »
  ou un opérateur qui vide la plus petite route demanderait un vrai nouveau morceau de code.
- Recherche locale plus forte (2-opt*, Or-opt) : il existe seulement un `relocate!` léger toutes les 25 itérations ; un vrai 2-opt*/Or-opt serait du code en plus pour un gain incertain.
