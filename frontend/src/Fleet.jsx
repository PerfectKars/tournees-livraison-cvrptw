import { useState } from "react";
import { Gauge, Leaf, Route, Truck } from "lucide-react";
import { couleurCamion, estEnRetard, minutes } from "./tournees";

// Page « Flotte » : détail de chaque camion (charge, distance, arrêts, horaires).

const arrondi = (v, d = 1) =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : Number(v).toFixed(d);

export function PageFlotte({ instance, optimization, boutonOptimisation }) {
  const [choisi, setChoisi] = useState(0);

  const routes = optimization?.routes || [];
  const details = optimization?.route_details || [];

  if (!routes.length) {
    return (
      <div className="panel empty-state">
        <div className="empty-state-icon"><Truck size={28} /></div>
        <strong>Aucune flotte à afficher</strong>
        <p>Lancez d'abord une optimisation ALNS pour voir le détail des camions.</p>
        {boutonOptimisation("Lancer ALNS")}
      </div>
    );
  }

  const capacite = (d) => d.capacity ?? instance?.capacite_vehicule ?? null;
  const taux = (d) => (capacite(d) ? (100 * (d.load ?? 0)) / capacite(d) : 0);

  const distanceTotale = details.reduce((s, d) => s + (Number(d.distance_km) || 0), 0);
  const co2Total = details.reduce((s, d) => s + (Number(d.co2_kg) || 0), 0);
  const chargeMoyenne = details.length
    ? details.reduce((s, d) => s + taux(d), 0) / details.length
    : 0;
  const disponibles = instance?.nombre_vehicules ?? optimization.vehicle_count ?? routes.length;

  const index = Math.min(choisi, routes.length - 1);
  const detail = details[index] || {};
  const arrets = detail.stops || [];
  const clients = new Map((instance?.clients || []).map((c) => [Number(c.id), c]));

  return (
    <>
      <section className="welcome-section">
        <div>
          <div className="date-label"><Truck size={15} /> FLOTTE</div>
          <h1>Détail des camions</h1>
          <p>Charge, distance, arrêts et horaires de chaque véhicule de la solution.</p>
        </div>
      </section>

      <section className="stats-grid">
        <article className="stat-card">
          <div className="stat-top"><div className="stat-icon blue"><Truck size={21} /></div></div>
          <p className="stat-title">Véhicules utilisés</p>
          <h2>{routes.length} / {disponibles}</h2>
          <small>sur la flotte disponible</small>
        </article>
        <article className="stat-card">
          <div className="stat-top"><div className="stat-icon orange"><Route size={21} /></div></div>
          <p className="stat-title">Distance totale</p>
          <h2>{arrondi(distanceTotale)} km</h2>
          <small>somme de toutes les tournées</small>
        </article>
        <article className="stat-card">
          <div className="stat-top"><div className="stat-icon green"><Gauge size={21} /></div></div>
          <p className="stat-title">Remplissage moyen</p>
          <h2>{arrondi(chargeMoyenne, 0)} %</h2>
          <small>charge sur capacité</small>
        </article>
        <article className="stat-card">
          <div className="stat-top"><div className="stat-icon purple"><Leaf size={21} /></div></div>
          <p className="stat-title">CO₂ estimé</p>
          <h2>{arrondi(co2Total)} kg</h2>
          <small>flotte entière</small>
        </article>
      </section>

      <section className="fleet-grid">
        {routes.map((route, i) => {
          const d = details[i] || {};
          return (
            <button
              key={i}
              type="button"
              className={`fleet-card ${i === index ? "active" : ""}`}
              style={{ "--truck-color": couleurCamion(i) }}
              onClick={() => setChoisi(i)}
            >
              <span className="fleet-card-head">
                <span className="fleet-dot" />
                <strong>Camion {i + 1}</strong>
                <small>{route.length} clients</small>
              </span>
              <span className="fleet-bar"><i style={{ width: `${Math.min(100, taux(d))}%` }} /></span>
              <span className="fleet-card-line">
                <span>Charge {d.load ?? "—"} / {capacite(d) ?? "—"}</span>
                <span>{arrondi(d.distance_km)} km</span>
              </span>
              <span className="fleet-card-line">
                <span>Retour {minutes(d.return_time_min)}</span>
                <span>{arrondi(d.co2_kg)} kg CO₂</span>
              </span>
            </button>
          );
        })}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h3>Camion {index + 1} — arrêts dans l'ordre</h3>
            <p>
              Retour au dépôt à {minutes(detail.return_time_min)}
              {detail.return_within_depot_window === false ? " (hors fenêtre du dépôt)" : ""}
            </p>
          </div>
        </div>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>#</th><th>CLIENT</th><th>DEMANDE</th><th>ARRIVÉE</th>
                <th>ATTENTE</th><th>SERVICE</th><th>FENÊTRE</th><th>ÉTAT</th>
              </tr>
            </thead>
            <tbody>
              {routes[index].map((id, rang) => {
                const c = clients.get(Number(id)) || {};
                const s = arrets.find((x) => Number(x.client_id) === Number(id)) || arrets[rang] || {};
                const retard = estEnRetard(s);
                return (
                  <tr key={`${id}-${rang}`}>
                    <td>{rang + 1}</td>
                    <td><strong>{c.name || `Client ${id}`}</strong>{c.city ? ` · ${c.city}` : ""}</td>
                    <td>{s.demand ?? c.demand ?? "—"}</td>
                    <td>{minutes(s.arrival_min)}</td>
                    <td>{s.waiting_min ?? 0} min</td>
                    <td>{minutes(s.service_start_min)} – {minutes(s.service_end_min)}</td>
                    <td>{minutes(s.ready_min)} – {minutes(s.due_min)}</td>
                    <td>
                      <span className={`status-badge ${retard ? "on-route" : "available"}`}>
                        {retard ? "En retard" : "À l'heure"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
