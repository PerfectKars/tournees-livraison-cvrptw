import { useMemo, useState } from "react";
import { Clock, Package, Search, Users } from "lucide-react";
import { affectationClients, couleurCamion, estEnRetard, minutes } from "./tournees";

// Page « Clients » : liste des clients de l'instance, avec leur demande, leur
// fenêtre horaire et, après optimisation, le camion qui les livre.

const FILTRES = [
  ["tous", "Tous"],
  ["retard", "En retard"],
  ["attente", "Avec attente"],
];

export function PageClients({ instance, optimization, recherche, setRecherche }) {
  const [filtre, setFiltre] = useState("tous");
  const [tri, setTri] = useState("id");

  const clients = useMemo(() => instance?.clients || [], [instance]);
  const affectation = useMemo(() => affectationClients(optimization), [optimization]);
  const optimise = affectation.size > 0;

  const lignes = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    const liste = clients
      .map((c) => {
        const a = affectation.get(Number(c.id));
        return { c, a, retard: a ? estEnRetard(a.stop) : false,
                 attente: a ? Number(a.stop.waiting_min) > 0 : false };
      })
      .filter(({ c, a }) => {
        if (!q) return true;
        const texte = [c.id, c.name, c.city, c.address, c.category,
                       a ? `camion ${a.camion + 1}` : ""].join(" ").toLowerCase();
        return texte.includes(q);
      })
      .filter(({ retard, attente }) =>
        filtre === "retard" ? retard : filtre === "attente" ? attente : true);

    const cle = {
      id: ({ c }) => Number(c.id),
      demande: ({ c }) => -Number(c.demand || 0),
      camion: ({ a }) => (a ? a.camion * 1000 + a.rang : 1e9),
      arrivee: ({ a }) => (a ? Number(a.stop.arrival_min) : 1e9),
    }[tri];
    return liste.sort((x, y) => cle(x) - cle(y));
  }, [clients, affectation, recherche, filtre, tri]);

  if (!clients.length) {
    return (
      <div className="panel empty-state">
        <div className="empty-state-icon"><Users size={28} /></div>
        <strong>Aucun client chargé</strong>
        <p>Choisissez une instance dans le tableau de bord pour voir ses clients.</p>
      </div>
    );
  }

  const demandeTotale = clients.reduce((s, c) => s + (Number(c.demand) || 0), 0);
  const enRetard = [...affectation.values()].filter((a) => estEnRetard(a.stop)).length;

  return (
    <>
      <section className="welcome-section">
        <div>
          <div className="date-label"><Users size={15} /> CLIENTS</div>
          <h1>Clients à livrer</h1>
          <p>
            Demande, fenêtre horaire et camion affecté pour chaque client de
            l'instance {instance?.nom_instance}.
          </p>
        </div>
      </section>

      <section className="stats-grid">
        <article className="stat-card">
          <div className="stat-top"><div className="stat-icon blue"><Users size={21} /></div></div>
          <p className="stat-title">Clients</p>
          <h2>{clients.length}</h2>
          <small>dans l'instance</small>
        </article>
        <article className="stat-card">
          <div className="stat-top"><div className="stat-icon orange"><Package size={21} /></div></div>
          <p className="stat-title">Demande totale</p>
          <h2>{demandeTotale}</h2>
          <small>unités à livrer</small>
        </article>
        <article className="stat-card">
          <div className="stat-top"><div className="stat-icon green"><Search size={21} /></div></div>
          <p className="stat-title">Affichés</p>
          <h2>{lignes.length}</h2>
          <small>selon la recherche et le filtre</small>
        </article>
        <article className="stat-card">
          <div className="stat-top"><div className="stat-icon purple"><Clock size={21} /></div></div>
          <p className="stat-title">Livraisons en retard</p>
          <h2>{optimise ? enRetard : "—"}</h2>
          <small>{optimise ? "arrivée après l'heure limite" : "lancez une optimisation"}</small>
        </article>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h3>Liste des clients</h3>
            <p>
              {optimise
                ? "Camion, arrivée prévue et état issus de la dernière optimisation."
                : "Lancez une optimisation pour voir le camion affecté à chaque client."}
            </p>
          </div>
          <div className="clients-tools">
            <label className="clients-search">
              <Search size={15} />
              <input
                value={recherche}
                onChange={(e) => setRecherche(e.target.value)}
                placeholder="Nom, ville, n° de client, camion…"
              />
            </label>
            <select value={tri} onChange={(e) => setTri(e.target.value)} aria-label="Trier par">
              <option value="id">Tri : n° client</option>
              <option value="demande">Tri : demande</option>
              <option value="camion">Tri : camion</option>
              <option value="arrivee">Tri : arrivée</option>
            </select>
            <div className="bench-presets">
              {FILTRES.map(([valeur, libelle]) => (
                <button
                  key={valeur}
                  className={`select-button ${filtre === valeur ? "on" : ""}`}
                  onClick={() => setFiltre(valeur)}
                  disabled={valeur !== "tous" && !optimise}
                >
                  {libelle}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>#</th><th>CLIENT</th><th>DEMANDE</th><th>SERVICE</th>
                <th>FENÊTRE</th><th>CAMION</th><th>ARRIVÉE</th><th>ÉTAT</th>
              </tr>
            </thead>
            <tbody>
              {lignes.map(({ c, a, retard }) => (
                <tr key={c.id}>
                  <td>{c.id}</td>
                  <td>
                    <strong>{c.name || `Client ${c.id}`}</strong>
                    {c.city ? ` · ${c.city}` : ""}
                    {c.address && <small className="clients-adresse">{c.address}</small>}
                  </td>
                  <td>{c.demand ?? "—"}</td>
                  <td>{c.service ?? "—"} min</td>
                  <td>{minutes(c.ready)} – {minutes(c.due)}</td>
                  <td>
                    {a ? (
                      <span className="clients-camion" style={{ "--truck-color": couleurCamion(a.camion) }}>
                        Camion {a.camion + 1} · arrêt {a.rang + 1}
                      </span>
                    ) : "—"}
                  </td>
                  <td>{a ? minutes(a.stop.arrival_min) : "—"}</td>
                  <td>
                    {a ? (
                      <span className={`status-badge ${retard ? "on-route" : "available"}`}>
                        {retard ? "En retard" : "À l'heure"}
                      </span>
                    ) : "—"}
                  </td>
                </tr>
              ))}
              {!lignes.length && (
                <tr><td colSpan={8}>Aucun client ne correspond à la recherche.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
