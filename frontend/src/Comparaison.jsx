import { useEffect, useMemo, useState } from "react";
import { Download, Gauge, Leaf, Play, Target, Trophy } from "lucide-react";
import {
  agreger, moyenne, nomCourt, parFamille, resume, versCsv,
} from "./etudeStats";

// Onglet « Comparaison ALNS / recherche tabou » de la page Analyses :
// résultats de l'étude expérimentale (python etude.py) + comparaison en direct.

const COULEUR = { alns: "var(--sage-dark)", tabou: "var(--terracotta)" };
const LIBELLE = { alns: "ALNS (Julia)", tabou: "Recherche tabou" };

const fmt = (v, chiffres = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(chiffres);

const attendre = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function Legende() {
  return (
    <div className="cmp-legende">
      {["alns", "tabou"].map((s) => (
        <span key={s}>
          <i style={{ background: COULEUR[s] }} /> {LIBELLE[s]}
        </span>
      ))}
    </div>
  );
}

// Meilleure distance connue à l'instant t (la trace ne change qu'aux améliorations).
const valeurA = (trace, t) => {
  let v = null;
  for (const p of trace) { if (p[0] <= t) v = p[2]; else break; }
  return v;
};

// Courbe de convergence : meilleure distance trouvée en fonction du temps.
// Les points de la trace sont reliés par des segments (courbe continue) ; la
// meilleure solution reste valable jusqu'à la fin du budget de temps.
export function Courbes({ ligne }) {
  const L = 680, H = 300, g = { h: 16, b: 38, l: 58, d: 14 };
  const w = L - g.l - g.d, h = H - g.h - g.b;

  const series = ["alns", "tabou"].map((s) => ({ s, trace: ligne[s].trace }));
  const tMax = Math.max(ligne.temps_budget, ...series.map((x) => x.trace.at(-1)[0]));
  // L'ALNS n'apparaît qu'après la compilation de Julia (quelques secondes). Le
  // haut du graphe est réglé sur les valeurs à partir de cet instant : les deux
  // solveurs restent visibles, même sur les grandes instances où le tabou est
  // très loin de la référence. Avant, seul le début du tabou est coupé en haut.
  const tDebut = Math.max(...series.map((x) => x.trace[0][0]));
  const apres = series.flatMap((x) => x.trace.filter((p) => p[0] >= tDebut).map((p) => p[2]));
  const departs = series.map((x) => valeurA(x.trace, tDebut)).filter((v) => v !== null);
  const toutes = series.flatMap((x) => x.trace.map((p) => p[2]));
  const mini = Math.min(...toutes, ligne.reference ?? Infinity);
  const maxi = Math.max(...apres, ...departs);
  const bas = mini - (maxi - mini) * 0.04, haut = maxi + (maxi - mini) * 0.04;

  const x = (t) => g.l + (t / tMax) * w;
  const y = (d) => g.h + (1 - (d - bas) / (haut - bas)) * h;

  const chemin = (trace) => {
    const pts = [...trace, [tMax, 0, trace.at(-1)[2]]];
    return pts.map((p, k) => `${k ? "L" : "M"} ${x(p[0]).toFixed(1)} ${y(p[2]).toFixed(1)}`).join(" ");
  };

  const ticksX = Array.from({ length: 6 }, (_, i) => (tMax * i) / 5);
  const ticksY = Array.from({ length: 5 }, (_, i) => bas + ((haut - bas) * i) / 4);

  return (
    <svg viewBox={`0 0 ${L} ${H}`} className="cmp-svg" role="img"
         aria-label={`Courbes de convergence, instance ${nomCourt(ligne.instance)}`}>
      <defs>
        <clipPath id="cmp-clip">
          <rect x={g.l} y={g.h} width={w} height={h} />
        </clipPath>
      </defs>
      {ticksY.map((d) => (
        <g key={d}>
          <line x1={g.l} x2={g.l + w} y1={y(d)} y2={y(d)} stroke="var(--line)" />
          <text x={g.l - 8} y={y(d) + 3} textAnchor="end" className="cmp-tick">{Math.round(d)}</text>
        </g>
      ))}
      {ticksX.map((t) => (
        <text key={t} x={x(t)} y={H - g.b + 16} textAnchor="middle" className="cmp-tick">
          {Math.round(t)}
        </text>
      ))}
      <text x={g.l + w / 2} y={H - 4} textAnchor="middle" className="cmp-tick">Temps (s)</text>
      <text transform={`translate(12 ${g.h + h / 2}) rotate(-90)`} textAnchor="middle"
            className="cmp-tick">Distance</text>
      {ligne.reference && (
        <g>
          <line x1={g.l} x2={g.l + w} y1={y(ligne.reference)} y2={y(ligne.reference)}
                stroke="var(--ink)" strokeDasharray="5 4" opacity=".6" />
          <text x={g.l + w - 4} y={y(ligne.reference) - 5} textAnchor="end" className="cmp-tick">
            meilleure solution connue : {ligne.reference}
          </text>
        </g>
      )}
      <g clipPath="url(#cmp-clip)">
        {series.map(({ s, trace }) => (
          <path key={s} d={chemin(trace)} fill="none" stroke={COULEUR[s]} strokeWidth="2.5"
                strokeLinejoin="round" strokeLinecap="round" />
        ))}
      </g>
    </svg>
  );
}

// Histogramme vertical groupé : une paire de barres (ALNS, tabou) par famille.
function BarresFamilles({ familles, seuil }) {
  const L = 1000, H = 340, g = { h: 24, b: 44, l: 56, d: 16 };
  const w = L - g.l - g.d, h = H - g.h - g.b;
  const max = Math.max(seuil, ...familles.flatMap((f) => [f.alns ?? 0, f.tabou ?? 0]));
  const haut = Math.ceil((max * 1.12) / 10) * 10;
  const y = (v) => g.h + (1 - v / haut) * h;
  const pas = w / familles.length;
  const lb = Math.min(60, pas * 0.32);
  const ticks = Array.from({ length: 5 }, (_, i) => (haut * i) / 4);
  return (
    <svg viewBox={`0 0 ${L} ${H}`} className="cmp-svg" role="img" aria-label="Écart moyen par famille d'instances">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={g.l} x2={g.l + w} y1={y(t)} y2={y(t)} stroke="var(--line)" />
          <text x={g.l - 8} y={y(t) + 4} textAnchor="end" className="cmp-tick-grand">{Math.round(t)} %</text>
        </g>
      ))}
      {familles.map((f, i) => {
        const cx = g.l + pas * (i + 0.5);
        return (
          <g key={f.famille}>
            {[["alns", -lb - 2], ["tabou", 2]].map(([s, dx]) => {
              const v = Math.max(0, f[s] ?? 0);
              return (
                <g key={s}>
                  <rect x={cx + dx} y={y(v)} width={lb} height={Math.max(1, h + g.h - y(v))} rx="4" fill={COULEUR[s]}>
                    <title>{`${LIBELLE[s]} : ${fmt(f[s])} % (${f.instances} instance(s))`}</title>
                  </rect>
                  <text x={cx + dx + lb / 2} y={y(v) - 6} textAnchor="middle" className="cmp-valeur">{fmt(f[s], 1)}</text>
                </g>
              );
            })}
            <text x={cx} y={H - 16} textAnchor="middle" className="cmp-tick-grand">{f.famille}</text>
          </g>
        );
      })}
      <line x1={g.l} x2={g.l + w} y1={y(seuil)} y2={y(seuil)} stroke="var(--ink)" strokeDasharray="5 4" opacity=".6" />
      <text x={g.l + w} y={y(seuil) - 6} textAnchor="end" className="cmp-tick">objectif : {seuil} %</text>
    </svg>
  );
}

// Courbe du CO2 par instance (instances rangées par taille). Le nom de
// l'instance et les valeurs apparaissent au survol des points.
function CourbesCO2({ agreges }) {
  const L = 1000, H = 320, g = { h: 16, b: 50, l: 70, d: 16 };
  const w = L - g.l - g.d, h = H - g.h - g.b;
  const n = agreges.length;
  const max = Math.max(...agreges.flatMap((a) => [a.alns.co2_kg, a.tabou.co2_kg]));
  const pasY = 10 ** Math.floor(Math.log10(max / 3));
  const haut = Math.ceil(max / pasY / 1) * pasY;
  const x = (i) => g.l + (n > 1 ? (i / (n - 1)) * w : w / 2);
  const y = (v) => g.h + (1 - v / haut) * h;
  const ticks = Array.from({ length: 5 }, (_, i) => (haut * i) / 4);
  // une étiquette à chaque changement de taille d'instance
  const groupes = [];
  agreges.forEach((a, i) => {
    if (i === 0 || a.clients !== agreges[i - 1].clients) {
      // pas d'étiquette si elle toucherait la précédente
      if (!groupes.length || x(i) - x(groupes.at(-1)[1]) > 95) groupes.push([a.clients, i]);
    }
  });
  const chemin = (s) => agreges.map((a, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(a[s].co2_kg).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${L} ${H}`} className="cmp-svg" role="img" aria-label="CO2 des tournées par instance">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={g.l} x2={g.l + w} y1={y(t)} y2={y(t)} stroke="var(--line)" />
          <text x={g.l - 8} y={y(t) + 4} textAnchor="end" className="cmp-tick-grand">{Math.round(t).toLocaleString("fr-FR")}</text>
        </g>
      ))}
      <text transform={`translate(14 ${g.h + h / 2}) rotate(-90)`} textAnchor="middle" className="cmp-tick">CO₂ (kg)</text>
      {groupes.map(([c, i]) => (
        <g key={`${c}-${i}`}>
          <line x1={x(i)} x2={x(i)} y1={g.h} y2={g.h + h} stroke="var(--line)" strokeDasharray="2 4" />
          <text x={x(i)} y={H - 22} textAnchor="start" className="cmp-tick-grand">{c} clients</text>
        </g>
      ))}
      {["alns", "tabou"].map((s) => (
        <g key={s}>
          <path d={chemin(s)} fill="none" stroke={COULEUR[s]} strokeWidth="2.5" strokeLinejoin="round" />
          {agreges.map((a, i) => (
            <circle key={a.nom} cx={x(i)} cy={y(a[s].co2_kg)} r="4" fill={COULEUR[s]}>
              <title>{`${a.court} (${a.clients} clients) — ${LIBELLE[s]} : ${fmt(a[s].co2_kg, 0)} kg`}</title>
            </circle>
          ))}
        </g>
      ))}
    </svg>
  );
}

function CartesResume({ r }) {
  return (
    <section className="stats-grid bench-stats">
      <article className="stat-card">
        <div className="stat-top"><div className="stat-icon blue"><Gauge size={21} /></div></div>
        <p className="stat-title">Gap moyen (distance)</p>
        <h2>
          <span style={{ color: COULEUR.alns }}>{fmt(r.gapAlns)} %</span>
          <small style={{ fontSize: 14 }}> vs </small>
          <span style={{ color: COULEUR.tabou }}>{fmt(r.gapTabou)} %</span>
        </h2>
        <small>ALNS contre tabou, par rapport à la meilleure solution connue</small>
      </article>
      <article className="stat-card">
        <div className="stat-top"><div className="stat-icon orange"><Trophy size={21} /></div></div>
        <p className="stat-title">Victoires de l'ALNS</p>
        <h2>{r.victoiresAlns} / {r.instances}</h2>
        <small>
          tabou : {r.victoiresTabou}{r.egalites ? `, égalités : ${r.egalites}` : ""}
          {" "}(véhicules, puis distance)
        </small>
      </article>
      <article className="stat-card">
        <div className="stat-top"><div className="stat-icon green"><Target size={21} /></div></div>
        <p className="stat-title">Sous 7 % de gap</p>
        <h2>
          <span style={{ color: COULEUR.alns }}>{r.sous7Alns}</span>
          <small style={{ fontSize: 14 }}> vs </small>
          <span style={{ color: COULEUR.tabou }}>{r.sous7Tabou}</span>
        </h2>
        <small>instances sur {r.instances} (ALNS contre tabou)</small>
      </article>
      <article className="stat-card">
        <div className="stat-top"><div className="stat-icon purple"><Leaf size={21} /></div></div>
        <p className="stat-title">CO₂ évité par l'ALNS</p>
        <h2>{fmt(r.co2Evite, 1)} %</h2>
        <small>
          en moyenne par instance ; total {fmt(r.co2AlnsTotal, 0)} kg contre {fmt(r.co2TabouTotal, 0)} kg
        </small>
      </article>
    </section>
  );
}

// Calcul en direct : tabou puis ALNS sur une instance, avec les courbes.
function Direct({ apiUrl, instances }) {
  const [nom, setNom] = useState("");
  const [temps, setTemps] = useState(30);
  const [enCours, setEnCours] = useState(false);
  const [ecoule, setEcoule] = useState(0);
  const [resultat, setResultat] = useState(null);
  const [erreur, setErreur] = useState(null);

  const choix = nom || instances[0]?.nom || "";

  const lancer = async () => {
    if (enCours || !choix) return;
    setEnCours(true);
    setErreur(null);
    setResultat(null);
    setEcoule(0);
    try {
      const r = await fetch(`${apiUrl}/comparer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance: choix, temps }),
      });
      const depart = await r.json();
      if (!r.ok) throw new Error(depart?.detail?.message || `Erreur serveur (${r.status}).`);
      const debut = Date.now();
      for (;;) {
        await attendre(1000);
        setEcoule(Math.round((Date.now() - debut) / 1000));
        const rep = await fetch(`${apiUrl}/comparer/${depart.id}`);
        const etat = await rep.json();
        if (etat.statut === "erreur") throw new Error(etat.erreur?.message || "Le calcul a échoué.");
        if (etat.statut === "termine") {
          setResultat(etat.resultat);
          break;
        }
        if (Date.now() - debut > 15 * 60 * 1000) throw new Error("Le calcul dépasse 15 minutes.");
      }
    } catch (e) {
      setErreur(e.message);
    } finally {
      setEnCours(false);
    }
  };

  return (
    <section className="panel bench-panel">
      <div className="panel-heading">
        <div>
          <h3>Comparaison en direct</h3>
          <p>
            Lance la recherche tabou puis l'ALNS sur une instance, avec le même budget de
            temps. Durée : environ {2 * temps + 15} s.
          </p>
        </div>
      </div>
      <div className="bench-actions">
        <select value={choix} onChange={(e) => setNom(e.target.value)} disabled={enCours}
                aria-label="Instance à comparer" className="cmp-select">
          {instances.map((i) => (
            <option key={i.nom} value={i.nom}>
              {nomCourt(i.nom)} — {i.clients} clients
            </option>
          ))}
        </select>
        <select value={temps} onChange={(e) => setTemps(Number(e.target.value))} disabled={enCours}
                aria-label="Budget de temps par solveur" className="cmp-select">
          {[10, 30, 60].map((t) => <option key={t} value={t}>{t} s par solveur</option>)}
        </select>
        <button className="primary-button" onClick={lancer} disabled={enCours || !choix}>
          <Play size={16} />
          {enCours ? `Calcul en cours… (${ecoule} s)` : "Lancer la comparaison"}
        </button>
      </div>
      {erreur && <div className="error-message" style={{ marginTop: 14 }}>Erreur : {erreur}</div>}
      {resultat && (
        <div style={{ marginTop: 18 }}>
          <Legende />
          <Courbes ligne={resultat} />
          <table style={{ marginTop: 10 }}>
            <thead>
              <tr><th>SOLVEUR</th><th>VÉHICULES</th><th>DISTANCE</th><th>GAP</th><th>CO₂ (kg)</th><th>TEMPS</th></tr>
            </thead>
            <tbody>
              {["alns", "tabou"].map((s) => (
                <tr key={s}>
                  <td><strong style={{ color: COULEUR[s] }}>{LIBELLE[s]}</strong></td>
                  <td>{resultat[s].vehicules} ({resultat.vehicules_ref ?? "?"})</td>
                  <td>{fmt(resultat[s].distance)}</td>
                  <td>{resultat[s].gap === null ? "—" : `${fmt(resultat[s].gap)} %`}</td>
                  <td>{fmt(resultat[s].co2_kg, 1)}</td>
                  <td>{fmt(resultat[s].secondes, 1)} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function Comparaison({ apiUrl }) {
  const [lignes, setLignes] = useState([]);
  const [instances, setInstances] = useState([]);
  const [erreur, setErreur] = useState(null);
  const [choisie, setChoisie] = useState("");
  const [graine, setGraine] = useState(null);

  useEffect(() => {
    let annule = false;
    Promise.all([
      fetch(`${apiUrl}/etude`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Étude indisponible (${r.status}).`)))),
      fetch(`${apiUrl}/instances`).then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([etude, liste]) => {
        if (annule) return;
        setLignes(etude);
        setInstances(
          liste.filter((i) => i.reference && i.clients)
               .sort((a, b) => a.clients - b.clients || a.nom.localeCompare(b.nom))
        );
      })
      .catch((e) => !annule && setErreur(e.message));
    return () => {
      annule = true;
    };
  }, [apiUrl]);

  const agreges = useMemo(() => agreger(lignes), [lignes]);
  const synthese = useMemo(() => resume(agreges), [agreges]);
  const familles = useMemo(() => parFamille(agreges), [agreges]);

  const courante = agreges.find((a) => a.nom === choisie) || agreges[0];
  const graines = courante ? courante.lignes.map((l) => l.seed) : [];
  const ligneCourbe = courante
    ? courante.lignes.find((l) => l.seed === graine) || courante.lignes[0]
    : null;

  const exporter = () => {
    const blob = new Blob([versCsv(lignes)], { type: "text/csv;charset=utf-8" });
    const lien = document.createElement("a");
    lien.href = URL.createObjectURL(blob);
    lien.download = "etude_alns_tabou.csv";
    lien.click();
    URL.revokeObjectURL(lien.href);
  };

  const budgets = [...new Set(lignes.map((l) => l.temps_budget))].join(", ");
  const nbGraines = Math.max(0, ...agreges.map((a) => a.graines));

  return (
    <>
      {erreur && <div className="error-message">Erreur : {erreur}</div>}

      {agreges.length === 0 ? (
        <section className="panel bench-panel">
          <div className="panel-heading">
            <div>
              <h3>Pas encore de résultats d'étude</h3>
              <p>
                Lancez l'étude depuis le dossier backend/ :{" "}
                <code>python etude.py --temps 60 --seeds 42 43 44</code>. Elle écrit
                resultats_solveur/etude.json, que cette page affiche. Vous pouvez déjà
                faire une comparaison en direct ci-dessous.
              </p>
            </div>
          </div>
        </section>
      ) : (
        <>
          <CartesResume r={synthese} />

          <section className="panel bench-panel">
            <div className="panel-heading">
              <div>
                <h3>Courbes de convergence</h3>
                <p>
                  Meilleure distance trouvée au fil du temps. Pointillés : meilleure solution
                  connue. Les courbes démarrent quand le solveur a trouvé sa première solution (l'ALNS après la compilation de Julia).
                </p>
              </div>
              <div className="bench-presets">
                <select value={courante.nom} onChange={(e) => { setChoisie(e.target.value); setGraine(null); }}
                        aria-label="Instance" className="cmp-select">
                  {agreges.map((a) => (
                    <option key={a.nom} value={a.nom}>{a.court} — {a.clients} clients</option>
                  ))}
                </select>
                {graines.length > 1 && (
                  <select value={ligneCourbe.seed} onChange={(e) => setGraine(Number(e.target.value))}
                          aria-label="Graine" className="cmp-select">
                    {graines.map((s) => <option key={s} value={s}>graine {s}</option>)}
                  </select>
                )}
              </div>
            </div>
            <Legende />
            <Courbes ligne={ligneCourbe} />
          </section>

          <section className="panel bench-panel">
            <div className="panel-heading">
              <div>
                <h3>Écart moyen à la meilleure solution connue, par famille</h3>
                <p>
                  C = clients groupés, R = répartis au hasard, RC = mélange ; 1 = horizon court,
                  2 = horizon long. Plus la barre est courte, mieux c'est. Trait : objectif de 7 %.
                </p>
              </div>
            </div>
            <Legende />
            <BarresFamilles familles={familles} seuil={7} />
          </section>

          <section className="panel bench-panel">
            <div className="panel-heading">
              <div>
                <h3>CO₂ des tournées (kg)</h3>
                <p>
                  Émissions estimées de la solution de chaque solveur, une valeur par instance
                  (rangées par taille ; survolez un point pour voir l'instance). Hypothèse : 0,2 kg/km.
                </p>
              </div>
            </div>
            <Legende />
            <CourbesCO2 agreges={agreges} />
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <h3>Détail de l'étude</h3>
                <p>
                  {agreges.length} instances, {nbGraines} graine(s), {budgets} s par solveur.
                  Moyenne sur les graines ; ± = écart-type du gap. L'ALNS utilise 4 chaînes en
                  parallèle, la recherche tabou une seule.
                </p>
              </div>
              <button className="select-button" onClick={exporter}>
                <Download size={14} /> Exporter en CSV
              </button>
            </div>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>INSTANCE</th><th>CLIENTS</th><th>VÉH. RÉF.</th>
                    <th style={{ color: COULEUR.alns }}>ALNS : VÉH.</th>
                    <th style={{ color: COULEUR.alns }}>GAP</th>
                    <th style={{ color: COULEUR.alns }}>CO₂</th>
                    <th style={{ color: COULEUR.tabou }}>TABOU : VÉH.</th>
                    <th style={{ color: COULEUR.tabou }}>GAP</th>
                    <th style={{ color: COULEUR.tabou }}>CO₂</th>
                    <th>MEILLEUR</th>
                  </tr>
                </thead>
                <tbody>
                  {agreges.map((a) => (
                    <tr key={a.nom}>
                      <td><strong>{a.court}</strong></td>
                      <td>{a.clients}</td>
                      <td>{a.vehicules_ref ?? "?"}</td>
                      <td>{fmt(a.alns.vehicules, a.graines > 1 ? 1 : 0)}</td>
                      <td>
                        {fmt(a.alns.gap)} %
                        {a.alns.ecart_gap !== null && <small> ±{fmt(a.alns.ecart_gap)}</small>}
                      </td>
                      <td>{fmt(a.alns.co2_kg, 1)}</td>
                      <td>{fmt(a.tabou.vehicules, a.graines > 1 ? 1 : 0)}</td>
                      <td>
                        {fmt(a.tabou.gap)} %
                        {a.tabou.ecart_gap !== null && <small> ±{fmt(a.tabou.ecart_gap)}</small>}
                      </td>
                      <td>{fmt(a.tabou.co2_kg, 1)}</td>
                      <td>
                        {a.gagnant === "egalite" ? "égalité" : (
                          <strong style={{ color: COULEUR[a.gagnant] }}>
                            {a.gagnant === "alns" ? "ALNS" : "tabou"}
                          </strong>
                        )}
                        {!(a.alns.valide && a.tabou.valide) && " ⚠ invalide"}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td><strong>Moyenne</strong></td><td /><td />
                    <td>{fmt(moyenne(agreges.map((a) => a.alns.vehicules)), 1)}</td>
                    <td>{fmt(synthese.gapAlns)} %</td>
                    <td>{fmt(moyenne(agreges.map((a) => a.alns.co2_kg)), 1)}</td>
                    <td>{fmt(moyenne(agreges.map((a) => a.tabou.vehicules)), 1)}</td>
                    <td>{fmt(synthese.gapTabou)} %</td>
                    <td>{fmt(moyenne(agreges.map((a) => a.tabou.co2_kg)), 1)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <Direct apiUrl={apiUrl} instances={instances} />
    </>
  );
}
