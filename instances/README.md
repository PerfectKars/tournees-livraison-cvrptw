# Instances ajoutées (CVRPLIB)

Source : <https://galgos.inf.puc-rio.br/cvrplib/en/vrptw/instances> (VRPTW, format Solomon / Homberger).
Chaque instance a son fichier `.txt` et la meilleure solution connue `.sol` (« BKS »), au même format que les autres.

- `solomon/` : 8 instances de 100 clients (6 ajoutées : C101, C201, R101, R201, RC101, RC201 ; C102 et RC208 étaient déjà présentes).
- `homberger/` : 22 instances de 200 à 1000 clients (14 ajoutées ; C1_2_1, RC2_4_10, RC2_6_10, RC2_8_10 et RC2_10_7 à RC2_10_10 étaient déjà présentes).

## Test rapide du solveur
Solveur Julia actuel (sans matrice : même résultat que celui de `fix/solver`), 20 000 itérations par chaîne, 4 chaînes, graine 42.

| Instance | Clients | Véhicules BKS | Véhicules solveur | Distance BKS | Distance solveur | Écart | Temps |
|---|---|---|---|---|---|---|---|
| C101 | 100 | 10 | 10 | 827.3 | 828.9 | 0.198 % | 1.41 s |
| C201 | 100 | 3 | 3 | 589.1 | 591.6 | 0.417 % | 1.49 s |
| R101 | 100 | 20 | 19 | 1637.7 | 1651.1 | 0.817 % | 1.51 s |
| R201 | 100 | 8 | 4 | 1143.2 | 1272.6 | 11.319 % | 1.57 s |
| RC101 | 100 | 15 | 16 | 1619.8 | 1652.2 | 2.001 % | 1.48 s |
| RC201 | 100 | 9 | 4 | 1261.8 | 1484.7 | 17.662 % | 1.56 s |
| R1_2_1 | 200 | 23 | 21 | 4667.2 | 4852.0 | 3.959 % | 1.84 s |
| R2_2_1 | 200 | 13 | 5 | 3468.0 | 4169.8 | 20.236 % | 1.95 s |
| RC1_2_1 | 200 | 20 | 19 | 3516.9 | 3651.0 | 3.812 % | 1.90 s |
| C2_2_1 | 200 | 7 | 6 | 1922.1 | 1931.4 | 0.486 % | 1.94 s |
| RC2_2_1 | 200 | 10 | 6 | 2797.4 | 3224.1 | 15.253 % | 1.91 s |
| C1_4_1 | 400 | 40 | 40 | 7138.8 | 7157.5 | 0.262 % | 2.90 s |
| R1_4_1 | 400 | 41 | 40 | 10305.8 | 10874.0 | 5.513 % | 2.89 s |
| RC1_4_1 | 400 | 37 | 38 | 8522.9 | 8760.0 | 2.782 % | 2.84 s |
| R2_6_1 | 600 | 27 | 12 | 15145.3 | 18474.6 | 21.982 % | 4.23 s |
| C1_6_1 | 600 | 60 | 60 | 14076.6 | 14113.7 | 0.264 % | 4.35 s |
| RC1_8_1 | 800 | 74 | 74 | 29946.1 | 31899.3 | 6.523 % | 5.24 s |
| R1_8_1 | 800 | 80 | 80 | 36345.0 | 39133.3 | 7.672 % | 5.29 s |
| C2_10_1 | 1000 | 30 | 31 | 16841.1 | 17036.0 | 1.157 % | 5.57 s |
| R1_10_1 | 1000 | 94 | 100 | 52982 | 57057.1 | 7.691 % | 6.27 s |

## Comment lire l'écart
- Le solveur minimise d'abord le **nombre de véhicules**, puis la distance. Les BKS de CVRPLIB minimisent la **distance** seule.
- Sur les instances à longues fenêtres (R2, RC2, C2), le solveur utilise donc beaucoup moins de véhicules que le BKS (par exemple R201 : 4 contre 8) avec une distance plus grande : l'écart de 11 à 22 % ne veut pas dire que la solution est mauvaise.
- Quand le solveur utilise plus de véhicules que le BKS (RC101, RC1_4_1, C2_10_1, R1_10_1), l'écart est à lire avec prudence.
- Résultats d'un seul essai à budget léger : ils sont indicatifs, pas des performances définitives.
