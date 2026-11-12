// Calculs de la page « Analyses » (comparaison ALNS / recherche tabou) :
// regroupement des calculs par instance (moyenne sur les graines), familles,
// export CSV. Fonctions pures, sans React.

const SOLVEURS = ["alns", "tabou"];

export const moyenne = (valeurs) => {
  const v = valeurs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

export const ecartType = (valeurs) => {
  const v = valeurs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  if (v.length < 2) return null;
  const m = moyenne(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
};

export const nomCourt = (nom) => nom.split("/")[1] || nom;

// Un calcul par (instance, graine) -> une ligne par instance, moyennée sur les graines.
export function agreger(lignes) {
  const parInstance = new Map();
  for (const l of lignes) {
    if (!parInstance.has(l.instance)) parInstance.set(l.instance, []);
    parInstance.get(l.instance).push(l);
  }
  return [...parInstance.values()]
    .map((ls) => {
      const base = ls[0];
      const res = {
        nom: base.instance,
        court: nomCourt(base.instance),
        famille: base.famille,
        clients: base.clients,
        reference: base.reference,
        vehicules_ref: base.vehicules_ref,
        graines: ls.length,
        lignes: ls,
      };
      for (const s of SOLVEURS) {
        const f = (cle) => moyenne(ls.map((l) => l[s][cle]));
        res[s] = {
          vehicules: f("vehicules"),
          distance: f("distance"),
          gap: f("gap"),
          ecart_gap: ecartType(ls.map((l) => l[s].gap)),
          co2_kg: f("co2_kg"),
          secondes: f("secondes"),
          valide: ls.every((l) => l[s].valide),
        };
      }
      res.gagnant = gagnant(res.alns, res.tabou);
      res.co2_evite =
        res.tabou.co2_kg > 0 ? 100 * (1 - res.alns.co2_kg / res.tabou.co2_kg) : null;
      return res;
    })
    .sort((a, b) => a.clients - b.clients || a.nom.localeCompare(b.nom));
}

// Meilleur = moins de véhicules ; à égalité, distance plus courte
// (même ordre que le solveur Julia).
export function gagnant(alns, tabou) {
  if (Math.abs(alns.vehicules - tabou.vehicules) > 0.01) {
    return alns.vehicules < tabou.vehicules ? "alns" : "tabou";
  }
  if (Math.abs(alns.distance - tabou.distance) < 1e-6) return "egalite";
  return alns.distance < tabou.distance ? "alns" : "tabou";
}

const ORDRE_FAMILLES = ["C1", "C2", "R1", "R2", "RC1", "RC2", "XTW"];

// Gap moyen par famille d'instances, pour chaque solveur.
export function parFamille(agreges) {
  const groupes = new Map();
  for (const a of agreges) {
    if (!groupes.has(a.famille)) groupes.set(a.famille, []);
    groupes.get(a.famille).push(a);
  }
  return [...groupes.entries()]
    .map(([famille, items]) => ({
      famille,
      instances: items.length,
      alns: moyenne(items.map((i) => i.alns.gap)),
      tabou: moyenne(items.map((i) => i.tabou.gap)),
    }))
    .sort((a, b) => ORDRE_FAMILLES.indexOf(a.famille) - ORDRE_FAMILLES.indexOf(b.famille));
}

export function resume(agreges) {
  if (agreges.length === 0) return null;
  const gapsA = agreges.map((a) => a.alns.gap);
  const gapsT = agreges.map((a) => a.tabou.gap);
  return {
    instances: agreges.length,
    calculs: agreges.reduce((s, a) => s + a.graines, 0),
    gapAlns: moyenne(gapsA),
    gapTabou: moyenne(gapsT),
    victoiresAlns: agreges.filter((a) => a.gagnant === "alns").length,
    victoiresTabou: agreges.filter((a) => a.gagnant === "tabou").length,
    egalites: agreges.filter((a) => a.gagnant === "egalite").length,
    sous7Alns: agreges.filter((a) => a.alns.gap !== null && a.alns.gap <= 7).length,
    sous7Tabou: agreges.filter((a) => a.tabou.gap !== null && a.tabou.gap <= 7).length,
    co2Evite: moyenne(agreges.map((a) => a.co2_evite)),
    co2AlnsTotal: agreges.reduce((s, a) => s + a.alns.co2_kg, 0),
    co2TabouTotal: agreges.reduce((s, a) => s + a.tabou.co2_kg, 0),
  };
}

const guillemets = (v) => `"${String(v).replaceAll('"', '""')}"`;

// CSV : une ligne par (instance, graine, solveur), sans les courbes.
export function versCsv(lignes) {
  const entete = [
    "instance", "famille", "clients", "graine", "budget_s", "solveur", "vehicules",
    "vehicules_ref", "distance", "reference", "gap_pourcent", "co2_kg", "secondes", "valide",
  ];
  const corps = [];
  for (const l of lignes) {
    for (const [s, libelle] of [["alns", "ALNS"], ["tabou", "tabou"]]) {
      const x = l[s];
      corps.push([
        l.instance, l.famille, l.clients, l.seed, l.temps_budget, libelle, x.vehicules,
        l.vehicules_ref ?? "", x.distance, l.reference ?? "", x.gap ?? "", x.co2_kg,
        x.secondes, x.valide,
      ]);
    }
  }
  return [entete, ...corps].map((ligne) => ligne.map(guillemets).join(",")).join("\n");
}
