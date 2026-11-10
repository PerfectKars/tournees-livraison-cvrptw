
import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./RouteMap3D.css";

setWorkerUrl(workerUrl);

const COLORS = [
  "#C47759", "#648C78", "#7C78A8", "#D6A85F", "#578CA3",
  "#B16C85", "#8A9560", "#A17B56", "#6877A8", "#A56F48"
];

const API = "http://127.0.0.1:8000";

const minutes = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const n = Math.max(0, Math.round(Number(value)));
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
};

const safe = (v) =>
  String(v ?? "—").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

function getPositionOnRoute(coords, progress) {
  if (!coords?.length) return null;
  if (coords.length === 1) return coords[0];

  const lengths = [];
  let total = 0;

  for (let i = 1; i < coords.length; i++) {
    const dx = coords[i][0] - coords[i - 1][0];
    const dy = coords[i][1] - coords[i - 1][1];
    const length = Math.sqrt(dx * dx + dy * dy);
    lengths.push(length);
    total += length;
  }

  if (!total) return coords[0];

  let remaining = total * Math.max(0, Math.min(1, progress));

  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i]) {
      const ratio = lengths[i] ? remaining / lengths[i] : 0;

      return [
        coords[i][0] + (coords[i + 1][0] - coords[i][0]) * ratio,
        coords[i][1] + (coords[i + 1][1] - coords[i][1]) * ratio
      ];
    }

    remaining -= lengths[i];
  }

  return coords[coords.length - 1];
}

// Calcule la direction réelle du camion sur le segment correspondant
// à sa position actuelle.
function getRouteBearing(coords, progress) {
  if (!coords || coords.length < 2) return 0;

  const lengths = [];
  let total = 0;

  for (let i = 1; i < coords.length; i++) {
    const dx = coords[i][0] - coords[i - 1][0];
    const dy = coords[i][1] - coords[i - 1][1];
    const length = Math.sqrt(dx * dx + dy * dy);
    lengths.push(length);
    total += length;
  }

  if (!total) return 0;

  let remaining = total * Math.max(0, Math.min(0.999999, progress));

  let segment = 0;

  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i]) {
      segment = i;
      break;
    }

    remaining -= lengths[i];
    segment = i;
  }

  const [lon1, lat1] = coords[segment];
  const [lon2, lat2] = coords[segment + 1];

  const toRad = (value) => value * Math.PI / 180;
  const toDeg = (value) => value * 180 / Math.PI;

  const latitude1 = toRad(lat1);
  const latitude2 = toRad(lat2);
  const deltaLongitude = toRad(lon2 - lon1);

  const y = Math.sin(deltaLongitude) * Math.cos(latitude2);

  const x =
    Math.cos(latitude1) * Math.sin(latitude2) -
    Math.sin(latitude1) * Math.cos(latitude2) *
    Math.cos(deltaLongitude);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function getRouteDuration(detail) {
  return Math.max(
    1,
    Number(detail?.return_time_min) || 0,
    ...(detail?.stops || []).map(
      (stop) => Number(stop.service_end_min) || 0
    )
  );
}

function getSimulationInfo(routeDetail, simulationMinute) {
  const stops = routeDetail?.stops || [];

  const completed = stops.filter(
    (stop) => Number(stop.service_end_min) <= simulationMinute
  );

  const currentStop = stops.find(
    (stop) =>
      Number(stop.service_start_min) <= simulationMinute &&
      Number(stop.service_end_min) > simulationMinute
  );

  const nextStop = stops.find(
    (stop) => Number(stop.arrival_min) > simulationMinute
  );

  let status = "En route";
  let statusType = "neutral";

  if (currentStop) {
    status = "En livraison";
    statusType = "info";
  } else if (nextStop) {
    const due = Number(nextStop.due_min);
    const arrival = Number(nextStop.arrival_min);

    if (Number.isFinite(due) && Number.isFinite(arrival) && arrival > due) {
      status = "Risque de retard";
      statusType = "warning";
    } else {
      status = "À l'heure";
      statusType = "success";
    }
  } else if (stops.length && completed.length === stops.length) {
    status = "Livraisons terminées";
    statusType = "success";
  }

  return {
    completed: completed.length,
    currentStop,
    nextStop,
    status,
    statusType
  };
}

export default function RouteMap3D({ instance, optimization }) {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);

  const markersRef = useRef([]);
  const truckMarkerRefs = useRef([]);
  const routeCoordsRef = useRef([]);

  // Le suivi reste actif jusqu'à ce qu'un autre camion soit sélectionné.
  const followTruckRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState(0);
  const [followTruck, setFollowTruck] = useState(false);

  const [roadStatus, setRoadStatus] = useState(
    "Chargement des itinéraires routiers…"
  );

  const [roadFeatures, setRoadFeatures] = useState([]);

  const [simulationMinute, setSimulationMinute] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const details = useMemo(() => optimization?.route_details || [], [optimization]);
  const routes = useMemo(() => optimization?.routes || [], [optimization]);

  const detail = details[selected] || {};
  const route = routes[selected] || [];

  const clientById = new Map(
    (instance?.clients || []).map((c) => [Number(c.id), c])
  );

  const globalDuration = Math.max(
    1,
    ...details.map(getRouteDuration)
  );

  const simulation = getSimulationInfo(detail, simulationMinute);
  const duration = getRouteDuration(detail);

  const progress = Math.min(
    100,
    (simulationMinute / duration) * 100
  );

  const nextClient = simulation.nextStop
    ? clientById.get(Number(simulation.nextStop.client_id))
    : null;

  const currentClient = simulation.currentStop
    ? clientById.get(Number(simulation.currentStop.client_id))
    : null;

  // =========================================================
  // CAMÉRA EMBARQUÉE : SÉLECTION D'UN CAMION
  // =========================================================

  function focusTruck(idx) {
    const map = mapRef.current;
    const coords = routeCoordsRef.current[idx];
    const marker = truckMarkerRefs.current[idx];

    if (!map || !coords?.length || !marker) {
      console.warn("Impossible de trouver le camion ou son itinéraire :", idx);
      return;
    }

    setSelected(idx);
    setFollowTruck(true);
    followTruckRef.current = true;

    const truckDuration = getRouteDuration(details[idx]);

    const truckProgress = Math.min(
      1,
      simulationMinute / truckDuration
    );

    const position = marker.getLngLat();
    const bearing = getRouteBearing(coords, truckProgress);

    // Le point visé est légèrement devant le camion.
    // Le camion reste ainsi visible vers le bas de l'écran.
    const lookAhead = Math.min(1, truckProgress + 0.012);

    const target = getPositionOnRoute(coords, lookAhead);

    map.stop();
    map.resize();

    map.easeTo({
      center: target || [position.lng, position.lat],
      zoom: 18,
      pitch: 78,
      bearing,
      duration: 1400,
      essential: true
    });
  }

  // =========================================================
  // INITIALISATION DE LA CARTE
  // =========================================================

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [6.1844, 48.6921],
      zoom: 5,
      pitch: 35,
      bearing: -8,
      antialias: true
    });

    mapRef.current = map;

    map.addControl(
      new maplibregl.NavigationControl({
        visualizePitch: true
      }),
      "top-right"
    );

    map.on("load", () => {
      setReady(true);
    });

    return () => {
      markersRef.current.forEach((marker) => marker.remove());

      markersRef.current = [];
      truckMarkerRefs.current = [];
      routeCoordsRef.current = [];

      map.remove();
      mapRef.current = null;
    };
  }, []);

  // =========================================================
  // CHARGEMENT DES ITINÉRAIRES OSRM
  // =========================================================

  useEffect(() => {
    let cancelled = false;

    async function loadRoads() {
      if (!routes.length) {
        setRoadFeatures([]);
        return;
      }

      setRoadStatus("Calcul des tracés routiers OSRM…");

      try {
        const response = await fetch(`${API}/api/routes/geometry`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
  mode: instance?.mode || "france",
  routes
})
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.detail || `Erreur HTTP ${response.status}`
          );
        }

        if (!cancelled) {
          setRoadFeatures(data.features || []);
          setRoadStatus("Itinéraires routiers réels chargés");
        }
      } catch (error) {
        if (!cancelled) {
          setRoadFeatures([]);

          setRoadStatus(
            `Tracés routiers indisponibles : ${error.message}. Liaisons GPS simplifiées.`
          );
        }
      }
    }

    loadRoads();

    return () => {
      cancelled = true;
    };
  }, [instance, optimization, routes]);

  // =========================================================
  // NOUVELLE OPTIMISATION : RÉINITIALISATION
  // =========================================================

  useEffect(() => {
    setSelected(0);
    setSimulationMinute(0);
    setIsPlaying(false);
    setFollowTruck(false);
    followTruckRef.current = false;
  }, [instance, optimization]);

  // =========================================================
  // CRÉATION DES ROUTES, CLIENTS ET CAMIONS
  // =========================================================

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !ready || !instance?.depot || !optimization?.routes) {
      return;
    }

    markersRef.current.forEach((marker) => marker.remove());

    markersRef.current = [];
    truckMarkerRefs.current = [];
    routeCoordsRef.current = [];

    for (const layer of [...map.getStyle().layers.map((l) => l.id)]) {
      if (layer.startsWith("truck-route-")) {
        map.removeLayer(layer);
      }
    }

    for (let i = 0; i < 30; i++) {
      const sourceId = `truck-source-${i}`;

      if (map.getSource(sourceId)) {
        map.removeSource(sourceId);
      }
    }

    const depot = instance.depot;
    const clients = instance.clients || [];

    const byId = new Map(
      clients.map((c) => [Number(c.id), c])
    );

    const toLngLat = (p) =>
      instance.mode === "france"
        ? [Number(p.lon), Number(p.lat)]
        : [
            6.1844 + (p.x - depot.x) * 0.00025,
            48.6921 + (p.y - depot.y) * 0.00025
          ];

    const firstWaypoints =
  roadFeatures[0]?.properties?.waypoints || [];

const depotPos = firstWaypoints[0] || toLngLat(depot);
    const bounds = new maplibregl.LngLatBounds();

    bounds.extend(depotPos);

    const depotEl = document.createElement("div");
    depotEl.className = "do-depot-marker";
    depotEl.textContent = "D";

    const depotMarker = new maplibregl.Marker({
      element: depotEl
    })
      .setLngLat(depotPos)
      .setPopup(
        new maplibregl.Popup({ offset: 18 }).setText(
          instance.mode === "france"
            ? "Dépôt central — Nancy"
            : `Dépôt central — ${instance.nom_instance || instance.mode}`
        )
      )
      .addTo(map);

    markersRef.current.push(depotMarker);

    const routeDetails = optimization.route_details || [];

    optimization.routes.forEach((truckRoute, idx) => {
      const color = COLORS[idx % COLORS.length];
const feature = roadFeatures[idx];

const waypoints =
  feature?.properties?.waypoints || [];

      const fallbackCoords = [
        depotPos,
        ...truckRoute
          .map((id) => byId.get(Number(id)))
          .filter(Boolean)
          .map(toLngLat),
        depotPos
      ];

      const coords =
        feature?.geometry?.coordinates || fallbackCoords;

      coords.forEach((point) => bounds.extend(point));

      const sourceId = `truck-source-${idx}`;
      const layerId = `truck-route-${idx}`;

      map.addSource(sourceId, {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: coords
          }
        }
      });

      map.addLayer({
        id: layerId,
        type: "line",
        source: sourceId,
        paint: {
          "line-color": color,
          "line-width": 3.5,
          "line-opacity": 0.75
        },
        layout: {
          "line-cap": "round",
          "line-join": "round"
        }
      });

      const routeDetail = routeDetails[idx] || {};
      const stops = routeDetail.stops || [];

      // Marqueurs des clients
      truckRoute.forEach((id, stopIndex) => {
        const client = byId.get(Number(id));

        if (!client) return;

        const stop =
          stops.find(
            (s) => Number(s.client_id) === Number(id)
          ) ||
          stops[stopIndex] ||
          {};

        const popupHtml = `
          <div class="do-popup">
            <strong>${safe(client.name || `Client ${id}`)}</strong>
            <div>${safe(client.city || "")}</div>
            <hr/>
            <div>Camion : ${idx + 1} · Arrêt : ${stopIndex + 1}</div>
            <div>Demande : ${safe(stop.demand ?? client.demand)} unités</div>
            <div>Arrivée : ${minutes(stop.arrival_min)}</div>
            <div>Attente : ${safe(stop.waiting_min ?? 0)} min</div>
            <div>Début service : ${minutes(stop.service_start_min)}</div>
            <div>Fin service : ${minutes(stop.service_end_min)}</div>
            <div>Fenêtre : ${minutes(stop.ready_min)} – ${minutes(stop.due_min)}</div>
            <div>Service : ${safe(client.service ?? "—")} min</div>
          </div>
        `;

        const el = document.createElement("div");
        el.className = "do-client-marker";
        el.style.background = color;
        el.textContent = String(id);

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat(
  waypoints[stopIndex + 1] || toLngLat(client)
)
          .setPopup(
            new maplibregl.Popup({
              offset: 16,
              maxWidth: "280px"
            }).setHTML(popupHtml)
          )
          .addTo(map);

        markersRef.current.push(marker);
      });

      // CAMION CLIQUABLE
      const truckEl = document.createElement("button");

      truckEl.type = "button";
      truckEl.className = "do-truck-marker";
      truckEl.style.borderColor = color;
      truckEl.setAttribute("aria-label", `Suivre le camion ${idx + 1}`);
      truckEl.innerHTML = `🚚<small>${idx + 1}</small>`;

      truckEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        focusTruck(idx);
      });

      const truckMarker = new maplibregl.Marker({
        element: truckEl,
        anchor: "center"
      })
        .setLngLat(coords[0] || depotPos)
        .addTo(map);

      truckMarker.getElement().style.zIndex = "1000";
      truckMarker.getElement().style.pointerEvents = "auto";

      markersRef.current.push(truckMarker);

      truckMarkerRefs.current[idx] = truckMarker;
      routeCoordsRef.current[idx] = coords;
    });

    // Vue globale au chargement initial
    if (optimization.routes.length) {
      map.fitBounds(bounds, {
        padding: {
          top: 65,
          bottom: 65,
          left: 65,
          right: 390
        },
        maxZoom: instance.mode === "petite" ? 14 : 11,
        pitch: 35,
        bearing: -8,
        duration: 800
      });
    }
  }, [instance, optimization, ready, roadFeatures]);

  // =========================================================
  // MISE EN ÉVIDENCE DE LA ROUTE SÉLECTIONNÉE
  // =========================================================

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !ready) return;

    routes.forEach((_, idx) => {
      const layerId = `truck-route-${idx}`;

      if (!map.getLayer(layerId)) return;

      map.setPaintProperty(
        layerId,
        "line-width",
        idx === selected ? 7 : 3.5
      );

      map.setPaintProperty(
        layerId,
        "line-opacity",
        idx === selected ? 1 : 0.45
      );
    });
  }, [selected, routes, ready]);

  // =========================================================
  // HORLOGE UNIQUE : TOUS LES CAMIONS AVANCENT ENSEMBLE
  // =========================================================

  useEffect(() => {
    if (!isPlaying) return;

    const timer = setInterval(() => {
      setSimulationMinute((previous) =>
        Math.min(globalDuration, previous + speed)
      );
    }, 1000);

    return () => clearInterval(timer);
  }, [isPlaying, globalDuration, speed]);

  useEffect(() => {
    if (isPlaying && simulationMinute >= globalDuration) {
      setIsPlaying(false);
    }
  }, [simulationMinute, globalDuration, isPlaying]);

  // =========================================================
  // DÉPLACEMENT DE TOUS LES CAMIONS
  // =========================================================

  useEffect(() => {
    routes.forEach((_, idx) => {
      const coords = routeCoordsRef.current[idx];
      const marker = truckMarkerRefs.current[idx];
      const truckDetail = details[idx];

      if (!coords || !marker) return;

      const truckDuration = getRouteDuration(truckDetail);

      const truckProgress = Math.min(
        1,
        simulationMinute / truckDuration
      );

      const position = getPositionOnRoute(
        coords,
        truckProgress
      );

      if (position) {
        marker.setLngLat(position);
      }
    });
  }, [simulationMinute, routes, details, roadFeatures]);

  // =========================================================
  // CAMÉRA : SUIVI CONTINU DU CAMION SÉLECTIONNÉ
  // =========================================================

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !ready || !followTruckRef.current) return;

    const coords = routeCoordsRef.current[selected];
    const marker = truckMarkerRefs.current[selected];

    if (!coords?.length || !marker) return;

    const truckPosition = marker.getLngLat();

    const truckDuration = getRouteDuration(details[selected]);

    const truckProgress = Math.min(
      1,
      simulationMinute / truckDuration
    );

    const bearing = getRouteBearing(coords, truckProgress);

    const lookAhead = Math.min(1, truckProgress + 0.012);
    const target = getPositionOnRoute(coords, lookAhead);

    map.easeTo({
      center: target || [
        truckPosition.lng,
        truckPosition.lat
      ],
      zoom: 18,
      pitch: 78,
      bearing,
      duration: isPlaying ? 850 : 500,
      essential: true
    });
  }, [simulationMinute, selected, ready, isPlaying, details]);

  // =========================================================
  // INFORMATIONS DE CHAQUE CAMION
  // =========================================================

  const getTruckInfo = (idx) =>
    getSimulationInfo(details[idx], simulationMinute);

  // =========================================================
  // AFFICHAGE
  // =========================================================

  return (
    <section className="map-section do-dashboard">

      <div className="map-heading">
        <div>
          <span className="eyebrow">SUIVI DES LIVRAISONS</span>

          <h2>Flotte et tournées optimisées</h2>

          <p>
            Tous les camions avancent simultanément sur leurs propres tournées.
          </p>
        </div>

        <span className="demo-label">
          {routes.length} camions
        </span>
      </div>

      <div className="do-map-layout">

        <div className="map-card do-map-card">

          <div
            ref={mapContainer}
            className="map-container"
          />

          <div className="do-map-status">
            ● {roadStatus}
          </div>

          <div className="do-map-view-label">
            {followTruck
              ? `Caméra embarquée — Camion ${selected + 1}`
              : "Vue globale — Cliquez sur un camion pour le suivre"}
          </div>

          <div className="map-legend">
            <span><i className="legend-depot" /> Dépôt</span>
            <span><i className="legend-client" /> Clients</span>
            <span>🚚 Camions</span>
            <span>— Tournées</span>
          </div>

        </div>

        <aside className="do-route-panel">

          <h3>Flotte de livraison</h3>

          <p className="do-muted">
            Clique sur un camion pour activer la caméra de suivi.
            Les autres camions continuent leur déplacement.
          </p>

          <div className="do-truck-list">

            {routes.map((r, i) => {
              const d = details[i] || {};
              const truckSimulation = getTruckInfo(i);

              return (
                <button
                  key={i}
                  type="button"
                  className={`do-truck-card ${selected === i ? "active" : ""}`}
                  onClick={() => focusTruck(i)}
                  style={{
                    "--truck-color": COLORS[i % COLORS.length]
                  }}
                >

                  <span className="do-truck-icon">🚚</span>

                  <span className="do-truck-info">

                    <strong>Camion {i + 1}</strong>

                    <small>
                      {r.length} clients · {d.distance_km ?? "—"} km · {d.co2_kg ?? "—"} kg CO₂
                    </small>

                    <small className={`do-mini-status ${truckSimulation.statusType}`}>
                      {truckSimulation.status}
                    </small>

                  </span>

                  <span className="do-truck-load">
                    {d.load ?? "—"}/
                    {d.capacity ?? instance?.capacite_vehicule ?? "—"}
                  </span>

                </button>
              );
            })}

          </div>

          <div className="do-global-simulation">

            <div className="do-global-header">

              <div>
                <span className="do-global-eyebrow">
                  SIMULATION GLOBALE
                </span>

                <h3>Départ de la flotte</h3>
              </div>

              <span className={`do-status ${isPlaying ? "success" : "neutral"}`}>
                {isPlaying
                  ? "En cours"
                  : simulationMinute >= globalDuration
                    ? "Terminée"
                    : "En pause"}
              </span>

            </div>

            <div className="do-simulation-clock">
              Temps commun :
              <strong> {minutes(simulationMinute)}</strong>
            </div>

            <div className="do-simulation-progress">
              <div
                style={{
                  width: `${Math.min(
                    100,
                    (simulationMinute / globalDuration) * 100
                  )}%`
                }}
              />
            </div>

            <div className="do-progress-label">
              Temps de simulation global · {minutes(globalDuration)} maximum
            </div>

            <div className="do-simulation-buttons">

              <button
                className="do-start-button"
                onClick={() => {
                  if (simulationMinute >= globalDuration) {
                    setSimulationMinute(0);
                  }

                  setIsPlaying(true);
                }}
                disabled={isPlaying || !routes.length}
              >
                ▶ Démarrer toute la flotte
              </button>

              <button
                onClick={() => setIsPlaying(false)}
                disabled={!isPlaying}
              >
                ⏸ Pause
              </button>

              <button
                onClick={() => {
                  setSimulationMinute(0);
                  setIsPlaying(false);
                }}
              >
                ↻ Recommencer
              </button>

            </div>

            <div className="do-speed-control">

              <label htmlFor="simulation-speed">
                Vitesse commune de simulation
              </label>

              <select
                id="simulation-speed"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                <option value={1}>×1 — 1 min / seconde</option>
                <option value={5}>×5 — 5 min / seconde</option>
                <option value={10}>×10 — 10 min / seconde</option>
                <option value={30}>×30 — 30 min / seconde</option>
              </select>

            </div>

          </div>

          <div className="do-route-detail">

            <div className="do-selected-title">

              <div>
                <span className="do-global-eyebrow">
                  TOURNÉE SÉLECTIONNÉE
                </span>

                <h3>Camion {selected + 1}</h3>
              </div>

              <span
                className="do-selected-color"
                style={{
                  background: COLORS[selected % COLORS.length]
                }}
              />

            </div>

            <div className="do-kpis">

              <div>
                <small>Distance</small>
                <strong>{detail.distance_km ?? "—"} km</strong>
              </div>

              <div>
                <small>Charge</small>
                <strong>
                  {detail.load ?? "—"}/
                  {detail.capacity ?? instance?.capacite_vehicule ?? "—"}
                </strong>
              </div>

              <div>
                <small>Retour dépôt</small>
                <strong>{minutes(detail.return_time_min)}</strong>
              </div>

              <div>
                <small>Clients</small>
                <strong>{route.length}</strong>
              </div>

              <div style={{ gridColumn: "1 / -1" }}>
                <small>CO₂ estimé</small>
                <strong>{detail.co2_kg ?? "—"} kg</strong>
              </div>

            </div>

            <div className="do-simulation">

              <div className="do-simulation-header">

                <strong>Suivi du camion {selected + 1}</strong>

                <span className={`do-status ${simulation.statusType}`}>
                  {simulation.status}
                </span>

              </div>

              <div className="do-simulation-clock">
                Temps commun :
                <strong> {minutes(simulationMinute)}</strong>
              </div>

              <div className="do-simulation-progress">
                <div style={{ width: `${progress}%` }} />
              </div>

              <div className="do-progress-label">
                {simulation.completed} / {route.length} livraisons terminées
              </div>

              <div className="do-live-info">

                <div>
                  <small>Client en cours</small>
                  <strong>{currentClient?.name || "Aucun"}</strong>
                </div>

                <div>
                  <small>Prochain client</small>
                  <strong>{nextClient?.name || "Aucun"}</strong>
                </div>

                <div>
                  <small>Arrivée prévue</small>
                  <strong>
                    {simulation.nextStop
                      ? minutes(simulation.nextStop.arrival_min)
                      : "—"}
                  </strong>
                </div>

                <div>
                  <small>Heure limite</small>
                  <strong>
                    {simulation.nextStop
                      ? minutes(simulation.nextStop.due_min)
                      : "—"}
                  </strong>
                </div>

              </div>

            </div>

            <h4 className="do-stops-title">
              Planning des livraisons
            </h4>

            <ol className="do-stop-list">

              {route.map((id, i) => {
                const c = clientById.get(Number(id)) || {};

                const s =
                  detail.stops?.find(
                    (x) => Number(x.client_id) === Number(id)
                  ) ||
                  detail.stops?.[i] ||
                  {};

                const isDone =
                  Number(s.service_end_min) <= simulationMinute;

                const isCurrent =
                  Number(s.service_start_min) <= simulationMinute &&
                  Number(s.service_end_min) > simulationMinute;

                return (
                  <li
                    key={`${id}-${i}`}
                    className={isDone ? "do-stop-done" : ""}
                  >

                    <span className="do-stop-number">
                      {isDone ? "✓" : i + 1}
                    </span>

                    <div>

                      <strong>
                        {c.name || `Client ${id}`}
                      </strong>

                      <small>
                        {c.city || ""} · {s.demand ?? c.demand ?? "—"} unités
                      </small>

                      {isCurrent && (
                        <span className="do-stop-current">
                          Livraison en cours
                        </span>
                      )}

                      {isDone && (
                        <span className="do-stop-completed">
                          Livraison terminée
                        </span>
                      )}

                      <div className="do-time-grid">

                        <span>
                          Arrivée <b>{minutes(s.arrival_min)}</b>
                        </span>

                        <span>
                          Attente <b>{s.waiting_min ?? 0} min</b>
                        </span>

                        <span>
                          Début <b>{minutes(s.service_start_min)}</b>
                        </span>

                        <span>
                          Fin <b>{minutes(s.service_end_min)}</b>
                        </span>

                        <span>
                          Fenêtre <b>{minutes(s.ready_min)}–{minutes(s.due_min)}</b>
                        </span>

                      </div>

                    </div>

                  </li>
                );
              })}

            </ol>

            <div
              className={`do-return ${
                detail.return_within_depot_window === false
                  ? "warning"
                  : ""
              }`}
            >
              Retour au dépôt :

              <strong>
                {" "}{minutes(detail.return_time_min)}
              </strong>

              {" · "}

              {detail.return_within_depot_window === false
                ? "Hors fenêtre"
                : "Dans la fenêtre"}
            </div>

          </div>

        </aside>

      </div>

    </section>
  );
}
