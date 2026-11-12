import { Activity, Gauge, Play, Target, Timer } from "lucide-react";
import { GAP_CIBLE, TEMPS_MAX } from "./useBenchmark";

// Page « Analyses » : benchmark du solveur (état et calculs : useBenchmark).

const arrondi = (valeur, chiffres = 2) =>
  valeur === null || valeur === undefined ? "—" : Number(valeur).toFixed(chiffres);

// Résultat conforme à l'objectif : gap <= 7 % avec au plus autant de
// véhicules que la référence (si elle les indique).
const objectifAtteint = (r) =>
  r.gap !== null && r.gap !== undefined && r.gap <= GAP_CIBLE &&
  (r.vehicules_ref == null || r.vehicules <= r.vehicules_ref);

const LIBELLE_MOTIF = {
  gap: ["Objectif atteint", "available"],
  temps: [`${TEMPS_MAX} s écoulées`, "on-route"],
  iterations: ["Itérations épuisées", "on-route"],
};

function Barres({ lignes, max, seuil, unite }) {
  const sommet = Math.max(max, seuil ?? 0, 1e-9);
  return (
    <div className="bench-bars">
      {lignes.map((l) => (
        <div className="bench-row" key={l.cle}>
          <span className="bench-label">{l.etiquette}</span>
          <div className="bench-track">
            {l.valeurs.map((v, i) => (
              <div
                key={i}
                className={`bench-fill ${v.classe}`}
                style={{ width: `${Math.max(1, (100 * v.valeur) / sommet)}%` }}
                title={v.titre}
              />
            ))}
            {seuil !== undefined && (
              <i className="bench-seuil" style={{ left: `${(100 * seuil) / sommet}%` }} />
            )}
          </div>
          <span className="bench-value">{l.texte}{unite}</span>
        </div>
      ))}
    </div>
  );
}

export function PageBenchmark({ bench, embarque = false }) {
  const {
    instances, erreur, selection, resultats, enCours, courante, ecoule,
    basculer, choisir, lancer, arreter, effacer,
  } = bench;

  // Résultats dans l'ordre de taille des instances.
  const calcules = instances
    .map((i) => resultats[i.nom])
    .filter((r) => r && !r.erreur);
  const enErreur = instances.map((i) => resultats[i.nom]).filter((r) => r && r.erreur);

  const avecGap = calcules.filter((r) => r.gap !== null && r.gap !== undefined);
  const gapMoyen = avecGap.length
    ? avecGap.reduce((s, r) => s + r.gap, 0) / avecGap.length
    : null;
  const atteints = calcules.filter(objectifAtteint).length;
  const tempsTotal = calcules.reduce((s, r) => s + (r.temps || 0), 0);

  const groupes = [100, 200, 400, 600, 800, 1000]
    .map((taille) => ({ taille, items: instances.filter((i) => i.clients === taille) }))
    .filter((g) => g.items.length > 0);

  const pireCas = selection.size * TEMPS_MAX;

  return (
    <>
      {!embarque && (
      <section className="welcome-section">
        <div>
          <div className="date-label">
            <Gauge size={15} />
            BENCHMARK DU SOLVEUR
          </div>
          <h1>Analyses des performances</h1>
          <p>
            Le solveur est lancé sur des instances de référence (CVRPLIB) et
            comparé à la meilleure solution connue. Il s'arrête dès que la
            distance est à {GAP_CIBLE} % ou moins de la référence avec au plus
            autant de véhicules, sinon après {TEMPS_MAX} s.
          </p>
        </div>
      </section>
      )}

      {erreur && <div className="error-message">Erreur : {erreur}</div>}

      <section className="panel bench-panel">
        <div className="panel-heading">
          <div>
            <h3>Instances à tester</h3>
            <p>
              {selection.size} sélectionnée(s) — durée maximale{" "}
              {pireCas >= 60 ? `${Math.round(pireCas / 60)} min` : `${pireCas} s`}
              {" "}(en général beaucoup moins)
            </p>
          </div>
          <div className="bench-presets">
            <button className="select-button" disabled={enCours}
              onClick={() => choisir((i) => i.clients <= 200)}>Petites (≤ 200)</button>
            <button className="select-button" disabled={enCours}
              onClick={() => choisir((i) => i.clients >= 400 && i.clients <= 600)}>Moyennes (400-600)</button>
            <button className="select-button" disabled={enCours}
              onClick={() => choisir(() => true)}>Toutes</button>
            <button className="select-button" disabled={enCours}
              onClick={() => choisir(() => false)}>Aucune</button>
          </div>
        </div>

        {groupes.map((g) => (
          <div className="bench-group" key={g.taille}>
            <strong>{g.taille} clients</strong>
            <div className="bench-chips">
              {g.items.map((i) => (
                <label
                  key={i.nom}
                  className={`bench-chip ${selection.has(i.nom) ? "on" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={selection.has(i.nom)}
                    disabled={enCours}
                    onChange={() => basculer(i.nom)}
                  />
                  {i.nom.split("/")[1]}
                </label>
              ))}
            </div>
          </div>
        ))}

        <div className="bench-actions">
          <button
            className="primary-button"
            onClick={lancer}
            disabled={enCours || selection.size === 0}
          >
            <Play size={18} />
            {enCours
              ? `Calcul de ${courante?.split("/")[1]}… (${ecoule} s)`
              : "Lancer le benchmark"}
          </button>
          {enCours && (
            <button className="text-button" onClick={arreter}>
              Arrêter après l'instance en cours
            </button>
          )}
          {!enCours && Object.keys(resultats).length > 0 && (
            <button className="text-button" onClick={effacer}>
              Effacer les résultats
            </button>
          )}
        </div>
      </section>

      {enErreur.length > 0 && (
        <div className="warning-message">
          <Activity size={16} />
          <span>
            {enErreur.length} calcul(s) en erreur :{" "}
            {enErreur.map((r) => `${r.nom.split("/")[1]} (${r.erreur})`).join(" ; ")}
          </span>
        </div>
      )}

      {calcules.length > 0 && (
        <>
          <section className="stats-grid bench-stats">
            <article className="stat-card">
              <div className="stat-top">
                <div className="stat-icon blue"><Activity size={21} /></div>
              </div>
              <p className="stat-title">Instances calculées</p>
              <h2>{calcules.length}</h2>
              <small>sur {instances.length} instances de référence</small>
            </article>
            <article className="stat-card">
              <div className="stat-top">
                <div className="stat-icon orange"><Gauge size={21} /></div>
              </div>
              <p className="stat-title">Gap moyen</p>
              <h2>{gapMoyen === null ? "--" : `${arrondi(gapMoyen)} %`}</h2>
              <small>par rapport à la meilleure solution connue</small>
            </article>
            <article className="stat-card">
              <div className="stat-top">
                <div className="stat-icon green"><Target size={21} /></div>
              </div>
              <p className="stat-title">Objectif {GAP_CIBLE} % atteint</p>
              <h2>{atteints} / {calcules.length}</h2>
              <small>gap ≤ {GAP_CIBLE} % et véhicules ≤ référence</small>
            </article>
            <article className="stat-card">
              <div className="stat-top">
                <div className="stat-icon purple"><Timer size={21} /></div>
              </div>
              <p className="stat-title">Temps de calcul total</p>
              <h2>{arrondi(tempsTotal, 1)} s</h2>
              <small>somme des temps du solveur</small>
            </article>
          </section>

          <section className="bench-grid">
            <article className="panel">
              <div className="panel-heading">
                <div>
                  <h3>Gap par rapport à la référence</h3>
                  <p>Trait : objectif de {GAP_CIBLE} %. Vert : objectif atteint.</p>
                </div>
              </div>
              <Barres
                lignes={calcules.map((r) => ({
                  cle: r.nom,
                  etiquette: r.nom.split("/")[1],
                  texte: r.gap === null ? "—" : arrondi(r.gap),
                  valeurs: [{
                    valeur: Math.max(0, r.gap ?? 0),
                    classe: objectifAtteint(r) ? "ok" : "ko",
                    titre: `${r.nom} : ${arrondi(r.gap)} %`,
                  }],
                }))}
                max={Math.max(...calcules.map((r) => r.gap ?? 0), GAP_CIBLE)}
                seuil={GAP_CIBLE}
                unite=" %"
              />
            </article>

            <article className="panel">
              <div className="panel-heading">
                <div>
                  <h3>Véhicules utilisés</h3>
                  <p>Solveur (vert) et solution de référence (clair).</p>
                </div>
              </div>
              <Barres
                lignes={calcules.map((r) => ({
                  cle: r.nom,
                  etiquette: r.nom.split("/")[1],
                  texte: `${r.vehicules} / ${r.vehicules_ref ?? "?"}`,
                  valeurs: [
                    { valeur: r.vehicules, classe: "ok", titre: `Solveur : ${r.vehicules}` },
                    ...(r.vehicules_ref != null
                      ? [{ valeur: r.vehicules_ref, classe: "ref", titre: `Référence : ${r.vehicules_ref}` }]
                      : []),
                  ],
                }))}
                max={Math.max(...calcules.flatMap((r) => [r.vehicules, r.vehicules_ref ?? 0]))}
                unite=""
              />
            </article>

            <article className="panel">
              <div className="panel-heading">
                <div>
                  <h3>Temps de calcul</h3>
                  <p>Trait : limite de {TEMPS_MAX} s.</p>
                </div>
              </div>
              <Barres
                lignes={calcules.map((r) => ({
                  cle: r.nom,
                  etiquette: r.nom.split("/")[1],
                  texte: arrondi(r.temps, 1),
                  valeurs: [{
                    valeur: r.temps ?? 0,
                    classe: r.motif === "gap" ? "ok" : "ko",
                    titre: `${r.nom} : ${arrondi(r.temps, 1)} s`,
                  }],
                }))}
                max={Math.max(...calcules.map((r) => r.temps ?? 0), TEMPS_MAX)}
                seuil={TEMPS_MAX}
                unite=" s"
              />
            </article>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <h3>Détail des calculs</h3>
                <p>Un calcul par instance, 4 chaînes, graine 42.</p>
              </div>
            </div>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>INSTANCE</th>
                    <th>CLIENTS</th>
                    <th>VÉHICULES (RÉF.)</th>
                    <th>DISTANCE</th>
                    <th>GAP</th>
                    <th>TEMPS</th>
                    <th>ARRÊT</th>
                  </tr>
                </thead>
                <tbody>
                  {calcules.map((r) => {
                    const [libelle, classe] = LIBELLE_MOTIF[r.motif] || ["—", "available"];
                    return (
                      <tr key={r.nom}>
                        <td><strong>{r.nom.split("/")[1]}</strong></td>
                        <td>{r.clients}</td>
                        <td>{r.vehicules} ({r.vehicules_ref ?? "?"})</td>
                        <td>{arrondi(r.distance)}</td>
                        <td>{r.gap === null ? "—" : `${arrondi(r.gap)} %`}</td>
                        <td>{arrondi(r.temps, 1)} s</td>
                        <td>
                          <span className={`status-badge ${classe}`}>{libelle}</span>
                          {!r.valide && " ⚠ invalide"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
