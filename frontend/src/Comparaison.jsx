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

// Barres groupées : une ligne par élément, une barre par solveur.
function BarresDouble({ lignes, unite = "", seuil }) {
  const sommet = Math.max(1e-9, seuil ?? 0, ...lignes.flatMap((l) => [l.alns, l.tabou].map((v) => Math.abs(v ?? 0))));
  return (
    <div className="bench-bars">
      {lignes.map((l) => (
        <div className="bench-row cmp-row" key={l.cle}>
          <span className="bench-label" title={l.titre}>{l.etiquette}</span>
          <div className="bench-track">
            {["alns", "tabou"].map((s) => (
              <div
                key={s}
                className="bench-fill"
                style={{
                  width: `${Math.max(1, (100 * Math.abs(l[s] ?? 0)) / sommet)}%`,
                  background: COULEUR[s],
                }}
                title={`${LIBELLE[s]} : ${fmt(l[s])}${unite}`}
              />
            ))}
            {seuil !== undefined && (
              <i className="bench-seuil" style={{ left: `${(100 * seuil) / sommet}%` }} />
            )}
          </div>
          <span className="bench-value cmp-valeurs">
            <b style={{ color: COULEUR.alns }}>{fmt(l.alns)}</b>
            {" / "}
            <b style={{ color: COULEUR.tabou }}>{fmt(l.tabou)}</b>
          </span>
        </div>
      ))}
    </div>
  );
}

// Courbe de convergence : meilleure distance trouvée en fonction du temps.
export function Courbes({ ligne }) {
  const L = 680, H = 300, g = { h: 16, b: 38, l: 58, d: 14 };
  const w = L - g.l - g.d, h = H - g.h - g.b;

  const series = ["alns", "tabou"].map((s) => ({ s, trace: ligne[s].trace }));
  const tMax = Math.max(ligne.temps_budget, ...series.map((x) => x.trace.at(-1)[0]));
  const toutes = series.flatMap((x) => x.trace.map((p) => p[2]));
  const mini = Math.min(...toutes, ligne.reference ?? Infinity);
  // Le départ du tabou est très loin de l'optimum : on coupe en haut pour que la
  // partie utile (la fin de la descente) reste lisible.
  const maxi = Math.min(Math.max(...toutes), mini * 1.25);
  const bas = mini * 0.97, haut = maxi * 1.02;

  const x = (t) => g.l + (t / tMax) * w;
  const y = (d) => g.h + (1 - (d - bas) / (haut - bas)) * h;

  const chemin = (trace) => {
    const pts = [...trace];
    pts.push([tMax, 0, trace.at(-1)[2]]); // la meilleure solution reste valable jusqu'au bout
    let c = `M ${x(pts[0][0])} ${y(pts[0][2])}`;
    for (const p of pts.slice(1)) c += ` H ${x(p[0])} V ${y(p[2])}`;
    return c;
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
        {/* ALNS plus épais, tabou fin par-dessus : si les deux courbes se
            confondent (instance facile), les deux restent visibles. */}
        {series.map(({ s, trace }) => (
          <path key={s} d={chemin(trace)} fill="none" stroke={COULEUR[s]}
                strokeWidth={s === "alns" ? 4.5 : 1.8} strokeLinejoin="round" />
        ))}
      </g>
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
                  connue. La courbe est coupée en haut : le tabou démarre très loin de l'optimum.
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

          <section className="bench-grid cmp-grid">
            <article className="panel">
              <div className="panel-heading">
                <div>
                  <h3>Gap par instance (%)</h3>
                  <p>Trait : objectif de 7 %. Plus court = meilleur.</p>
                </div>
              </div>
              <Legende />
              <BarresDouble
                seuil={7}
                unite=" %"
                lignes={agreges.map((a) => ({
                  cle: a.nom, etiquette: a.court, titre: `${a.nom} (${a.clients} clients)`,
                  alns: Math.max(0, a.alns.gap ?? 0), tabou: Math.max(0, a.tabou.gap ?? 0),
                }))}
              />
            </article>

            <article className="panel">
              <div className="panel-heading">
                <div>
                  <h3>Gap moyen par famille (%)</h3>
                  <p>C = clients groupés, R = aléatoires, RC = mixte ; 1 = horizon court, 2 = long.</p>
                </div>
              </div>
              <Legende />
              <BarresDouble
                seuil={7}
                unite=" %"
                lignes={familles.map((f) => ({
                  cle: f.famille, etiquette: f.famille,
                  titre: `${f.instances} instance(s)`,
                  alns: Math.max(0, f.alns ?? 0), tabou: Math.max(0, f.tabou ?? 0),
                }))}
              />
              <div className="panel-heading" style={{ marginTop: 22 }}>
                <div>
                  <h3>CO₂ des tournées (kg)</h3>
                  <p>Émissions estimées de la solution de chaque solveur (hypothèse 0,2 kg/km).</p>
                </div>
              </div>
              <BarresDouble
                unite=" kg"
                lignes={agreges.map((a) => ({
                  cle: a.nom, etiquette: a.court, titre: `${a.nom}`,
                  alns: a.alns.co2_kg, tabou: a.tabou.co2_kg,
                }))}
              />
            </article>
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
