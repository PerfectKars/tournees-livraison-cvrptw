import { useCallback, useEffect, useRef, useState } from "react";

// Benchmark du solveur (page « Analyses ») : lance le solveur sur des
// instances de référence (CVRPLIB) via /solve, une par une, et compare à la
// meilleure solution connue. L'état est gardé dans App (hook) pour que le
// calcul continue si l'on change de page.

const CLE_STOCKAGE = "benchmark_resultats_v1";
export const GAP_CIBLE = 7; // % : objectif du solveur (arrêt anticipé)
export const TEMPS_MAX = 60; // s : limite de calcul du solveur

const lireStockage = () => {
  try {
    return JSON.parse(localStorage.getItem(CLE_STOCKAGE)) || {};
  } catch {
    return {};
  }
};

const ecrireStockage = (resultats) => {
  try {
    localStorage.setItem(CLE_STOCKAGE, JSON.stringify(resultats));
  } catch {
    // stockage indisponible : les résultats restent en mémoire
  }
};

const attendre = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function useBenchmark(apiUrl) {
  const [instances, setInstances] = useState([]);
  const [erreur, setErreur] = useState(null);
  const [selection, setSelection] = useState(new Set());
  const [resultats, setResultats] = useState(lireStockage);
  const [enCours, setEnCours] = useState(false);
  const [courante, setCourante] = useState(null);
  const [ecoule, setEcoule] = useState(0);
  const arret = useRef(false);

  // Liste des instances de référence (jeux Solomon et Homberger).
  useEffect(() => {
    let annule = false;
    fetch(`${apiUrl}/instances`)
      .then((r) => {
        if (!r.ok) throw new Error(`Liste des instances indisponible (${r.status}).`);
        return r.json();
      })
      .then((liste) => {
        if (annule) return;
        setInstances(
          liste
            .filter((i) => i.reference && i.clients && i.jeu !== "xtw")
            .sort((a, b) => a.clients - b.clients || a.nom.localeCompare(b.nom))
        );
      })
      .catch((e) => !annule && setErreur(e.message));
    return () => {
      annule = true;
    };
  }, [apiUrl]);

  const basculer = useCallback((nom) => {
    setSelection((avant) => {
      const apres = new Set(avant);
      if (apres.has(nom)) apres.delete(nom);
      else apres.add(nom);
      return apres;
    });
  }, []);

  const choisir = useCallback(
    (filtre) => setSelection(new Set(instances.filter(filtre).map((i) => i.nom))),
    [instances]
  );

  // Calcul d'une instance : lance /solve puis interroge son état.
  const calculer = useCallback(
    async (inst) => {
      const r = await fetch(`${apiUrl}/solve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance: inst.nom }),
      });
      const depart = await r.json();
      if (!r.ok) {
        throw new Error(depart?.detail?.message || `Erreur serveur (${r.status}).`);
      }

      const debut = Date.now();
      for (;;) {
        await attendre(1000);
        setEcoule(Math.round((Date.now() - debut) / 1000));
        const rep = await fetch(`${apiUrl}/solve/${depart.id}`);
        const etat = await rep.json();
        if (etat.statut === "erreur") {
          throw new Error(etat.erreur?.message || "Le calcul a échoué.");
        }
        if (etat.statut === "termine") {
          const res = etat.resultat;
          return {
            nom: inst.nom,
            clients: inst.clients,
            vehicules: res.nb_vehicules_utilises,
            vehicules_ref: inst.reference_vehicules,
            limite: res.nb_vehicules_disponibles,
            distance: res.distance_totale,
            gap: res.solveur?.gap_benchmark_pourcent ?? null,
            temps: res.solveur?.temps_calcul ?? null,
            motif: res.solveur?.motif_arret ?? null,
            valide: res.valide,
          };
        }
        if (Date.now() - debut > 15 * 60 * 1000) {
          throw new Error("Le calcul dépasse 15 minutes : abandon.");
        }
      }
    },
    [apiUrl]
  );

  const lancer = useCallback(async () => {
    if (enCours || selection.size === 0) return;
    arret.current = false;
    setEnCours(true);
    const aCalculer = instances.filter((i) => selection.has(i.nom));

    for (const inst of aCalculer) {
      if (arret.current) break;
      setCourante(inst.nom);
      setEcoule(0);
      try {
        const res = await calculer(inst);
        setResultats((avant) => {
          const apres = { ...avant, [inst.nom]: res };
          ecrireStockage(apres);
          return apres;
        });
      } catch (e) {
        setResultats((avant) => {
          const apres = {
            ...avant,
            [inst.nom]: { nom: inst.nom, clients: inst.clients, erreur: e.message },
          };
          ecrireStockage(apres);
          return apres;
        });
      }
    }

    setCourante(null);
    setEnCours(false);
  }, [enCours, selection, instances, calculer]);

  const arreter = useCallback(() => {
    arret.current = true;
  }, []);

  const effacer = useCallback(() => {
    setResultats({});
    ecrireStockage({});
  }, []);

  return {
    instances, erreur, selection, resultats, enCours, courante, ecoule,
    basculer, choisir, lancer, arreter, effacer,
  };
}
