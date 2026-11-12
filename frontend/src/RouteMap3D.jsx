import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./RouteMap3D.css";
import {
  couleurCamion,
  estEnRetard,
  getRouteDuration,
  getSimulationInfo,
  minutes
} from "./tournees";

setWorkerUrl(workerUrl);

const API = "http://127.0.0.1:8000";

const safe = (v) =>
  String(v ?? "—").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

// =========================================================
// GÉOMÉTRIE DES TRAJETS
// Le trajet est préparé une fois (longueurs cumulées) pour que la position
// du camion se calcule en O(log n) à chaque image de l'animation.
// =========================================================

function buildTrack(coords) {
  const cum = [0];

  for (let i = 1; i < coords.length; i++) {
    const dx = coords[i][0] - coords[i - 1][0];
    const dy = coords[i][1] - coords[i - 1][1];
    cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }

  return { coords, cum, total: cum[cum.length - 1] || 0 };
}

// Cap (degrés depuis le nord) du point a vers le point b.
function bearingBetween([lon1, lat1], [lon2, lat2]) {
  const toRad = (v) => v * Math.PI / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);

  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Position, cap et segment courant à une fraction (0..1) du trajet.
function locate(track, progress) {
  const { coords, cum, total } = track;

  if (!coords.length) return null;
  if (coords.length === 1 || !total) {
    return { pos: coords[0], bearing: 0, index: 0 };
  }

  const d = total * Math.max(0, Math.min(1, progress));

  let lo = 0;
  let hi = coords.length - 2;

  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid - 1;
  }

  const length = cum[lo + 1] - cum[lo];
  const ratio = length ? (d - cum[lo]) / length : 0;
  const a = coords[lo];
  const b = coords[lo + 1];
  const pos = [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];

  // Le cap regarde quelques points devant pour éviter les à-coups.
  const ahead = coords[Math.min(coords.length - 1, lo + 3)];

  return { pos, bearing: bearingBetween(a, ahead), index: lo };
}

// Écart d'angle le plus court (pour lisser la rotation de la caméra).
const lerpAngle = (from, to, t) => {
  const delta = ((to - from + 540) % 360) - 180;
  return (from + delta * t + 360) % 360;
};

// État d'un client à une minute donnée : pending, current ou done.
function etatClient(stop, minute) {
  if (Number(stop?.service_end_min) <= minute) return "done";
  if (Number(stop?.service_start_min) <= minute) return "current";
  return "pending";
}

// Le point visé par la caméra est à ~65 m devant le camion (en degrés), pas à
// un pourcentage du trajet : sur une longue tournée, un pourcentage donnerait
// des kilomètres et le camion sortirait de l'écran.
const DEVANT = 0.0006;

const pointDevant = (track, fraction) =>
  locate(track, Math.min(1, fraction + DEVANT / (track.total || 1)))?.pos;

const traceVide = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } };

export default function RouteMap3D({ instance, optimization }) {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);

  const markersRef = useRef([]);
  const truckMarkerRefs = useRef([]);
  const tracksRef = useRef([]);
  const clientMarkersRef = useRef([]);
  const locsRef = useRef([]);
  const boundsRef = useRef(null);

  // Valeurs lues à chaque image de l'animation (sans re-rendre React).
  const clockRef = useRef(0);
  const detailsRef = useRef([]);
  const selectedRef = useRef(0);
  const followTruckRef = useRef(false);
  const followSinceRef = useRef(0);
  const camBearingRef = useRef(0);

  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState(0);
  const [followTruck, setFollowTruck] = useState(false);

  const [roadStatus, setRoadStatus] = useState(
    "Chargement des itinéraires routiers…"
  );

  const [roadFeatures, setRoadFeatures] = useState([]);

  // Minute de simulation affichée dans le panneau (entier) ; l'horloge
  // précise, fractionnaire, est dans clockRef.
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

  const globalDuration = Math.max(1, ...details.map(getRouteDuration));

  const simulation = getSimulationInfo(detail, simulationMinute);
  const duration = getRouteDuration(detail);
  const progress = Math.min(100, (simulationMinute / duration) * 100);

  const nextClient = simulation.nextStop
    ? clientById.get(Number(simulation.nextStop.client_id))
    : null;

  const currentClient = simulation.currentStop
    ? clientById.get(Number(simulation.currentStop.client_id))
    : null;

  // =========================================================
  // RENDU D'UNE IMAGE : camions, traces, clients, caméra
  // =========================================================

  const updateArrows = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    truckMarkerRefs.current.forEach((marker, idx) => {
      const arrow = marker?.getElement().querySelector(".do-truck-arrow");
      const loc = locsRef.current[idx];
      if (arrow && loc) {
        arrow.style.transform = `rotate(${loc.bearing - map.getBearing()}deg)`;
      }
    });
  }, []);

  const renderFrame = useCallback((minute, { trails = true, follow = true } = {}) => {
    const map = mapRef.current;
    if (!map) return;

    tracksRef.current.forEach((track, idx) => {
      const marker = truckMarkerRefs.current[idx];
      if (!track || !marker) return;

      const fraction = Math.min(1, minute / getRouteDuration(detailsRef.current[idx]));
      const loc = locate(track, fraction);
      if (!loc) return;

      locsRef.current[idx] = loc;
      marker.setLngLat(loc.pos);

      // Trace déjà parcourue : du départ jusqu'à la position du camion.
      if (trails) {
        map.getSource(`truck-done-${idx}`)?.setData({
          ...traceVide,
          geometry: {
            type: "LineString",
            coordinates: [...track.coords.slice(0, loc.index + 1), loc.pos]
          }
        });
      }
    });

    updateArrows();

    // Clients : en attente, en cours de livraison, livrés.
    clientMarkersRef.current.forEach((m) => {
      const etat = etatClient(m.stop, minute);
      if (etat !== m.etat) {
        m.etat = etat;
        m.el.dataset.etat = etat;
        m.el.textContent = etat === "done" ? "✓" : String(m.id);
      }
    });

    // Caméra embarquée : suit le camion choisi, en lissant le cap.
    if (follow && followTruckRef.current && performance.now() >= followSinceRef.current) {
      const idx = selectedRef.current;
      const track = tracksRef.current[idx];
      const loc = locsRef.current[idx];

      if (track && loc) {
        const fraction = Math.min(1, minute / getRouteDuration(detailsRef.current[idx]));
        camBearingRef.current = lerpAngle(camBearingRef.current, loc.bearing, 0.08);

        map.jumpTo({
          center: pointDevant(track, fraction) || loc.pos,
          zoom: 18,
          pitch: 78,
          bearing: camBearingRef.current
        });
      }
    }
  }, [updateArrows]);

  const setClock = useCallback((minute) => {
    clockRef.current = minute;
    setSimulationMinute(Math.floor(minute));
    renderFrame(minute);
  }, [renderFrame]);

  // =========================================================
  // CAMÉRA : SÉLECTION D'UN CAMION ET VUE D'ENSEMBLE
  // =========================================================

  const focusTruck = useCallback((idx) => {
    const map = mapRef.current;
    const track = tracksRef.current[idx];

    if (!map || !track?.coords.length) return;

    setSelected(idx);
    selectedRef.current = idx;
    setFollowTruck(true);
    followTruckRef.current = true;

    const fraction = Math.min(
      1,
      clockRef.current / getRouteDuration(detailsRef.current[idx])
    );
    const loc = locate(track, fraction);

    camBearingRef.current = loc.bearing;
    // L'animation de caméra prend 1,4 s : le suivi image par image attend.
    followSinceRef.current = performance.now() + 1400;

    map.stop();
    map.resize();
    map.easeTo({
      center: pointDevant(track, fraction) || loc.pos,
      zoom: 18,
      pitch: 78,
      bearing: loc.bearing,
      duration: 1400,
      essential: true
    });
  }, []);

  const vueEnsemble = useCallback(() => {
    const map = mapRef.current;
    followTruckRef.current = false;
    setFollowTruck(false);

    if (map && boundsRef.current) {
      map.stop();
      map.fitBounds(boundsRef.current, {
        padding: { top: 65, bottom: 65, left: 65, right: 390 },
        maxZoom: 14,
        pitch: 35,
        bearing: -8,
        duration: 800
      });
    }
  }, []);

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
      new maplibregl.NavigationControl({ visualizePitch: true }),
      "top-right"
    );

    map.on("load", () => setReady(true));
    // Les flèches de cap restent justes quand l'utilisateur tourne la carte.
    map.on("rotate", updateArrows);

    return () => {
      markersRef.current.forEach((marker) => marker.remove());

      markersRef.current = [];
      truckMarkerRefs.current = [];
      clientMarkersRef.current = [];
      tracksRef.current = [];

      map.remove();
      mapRef.current = null;
    };
  }, [updateArrows]);

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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: instance?.mode || "france", routes })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.detail || `Erreur HTTP ${response.status}`);
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
    detailsRef.current = details;
    selectedRef.current = 0;
    followTruckRef.current = false;
    clockRef.current = 0;

    setSelected(0);
    setSimulationMinute(0);
    setIsPlaying(false);
    setFollowTruck(false);
  }, [instance, optimization, details]);

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
    clientMarkersRef.current = [];
    tracksRef.current = [];
    locsRef.current = [];

    // Supprime les couches et sources d'un calcul précédent.
    const style = map.getStyle();
    for (const layer of style.layers.map((l) => l.id)) {
      if (layer.startsWith("truck-route-") || layer.startsWith("truck-done-")) {
        map.removeLayer(layer);
      }
    }
    for (const source of Object.keys(style.sources)) {
      if (source.startsWith("truck-source-") || source.startsWith("truck-done-")) {
        map.removeSource(source);
      }
    }

    const depot = instance.depot;
    const clients = instance.clients || [];
    const byId = new Map(clients.map((c) => [Number(c.id), c]));

    const toLngLat = (p) =>
      instance.mode === "france"
        ? [Number(p.lon), Number(p.lat)]
        : [
            6.1844 + (p.x - depot.x) * 0.00025,
            48.6921 + (p.y - depot.y) * 0.00025
          ];

    const firstWaypoints = roadFeatures[0]?.properties?.waypoints || [];
    const depotPos = firstWaypoints[0] || toLngLat(depot);
    const bounds = new maplibregl.LngLatBounds();

    bounds.extend(depotPos);

    const depotEl = document.createElement("div");
    depotEl.className = "do-depot-marker";
    depotEl.textContent = "D";

    markersRef.current.push(
      new maplibregl.Marker({ element: depotEl })
        .setLngLat(depotPos)
        .setPopup(
          new maplibregl.Popup({ offset: 18 }).setText(
            instance.mode === "france"
              ? "Dépôt central — Nancy"
              : `Dépôt central — ${instance.nom_instance || instance.mode}`
          )
        )
        .addTo(map)
    );

    const routeDetails = optimization.route_details || [];

    optimization.routes.forEach((truckRoute, idx) => {
      const color = couleurCamion(idx);
      const feature = roadFeatures[idx];
      const waypoints = feature?.properties?.waypoints || [];

      const fallbackCoords = [
        depotPos,
        ...truckRoute
          .map((id) => byId.get(Number(id)))
          .filter(Boolean)
          .map(toLngLat),
        depotPos
      ];

      const coords = feature?.geometry?.coordinates || fallbackCoords;

      coords.forEach((point) => bounds.extend(point));

      // Tracé complet (partie restante, atténuée) puis trace déjà parcourue.
      map.addSource(`truck-source-${idx}`, {
        type: "geojson",
        data: { ...traceVide, geometry: { type: "LineString", coordinates: coords } }
      });

      map.addLayer({
        id: `truck-route-${idx}`,
        type: "line",
        source: `truck-source-${idx}`,
        paint: { "line-color": color, "line-width": 3.5, "line-opacity": 0.4 },
        layout: { "line-cap": "round", "line-join": "round" }
      });

      map.addSource(`truck-done-${idx}`, { type: "geojson", data: traceVide });

      map.addLayer({
        id: `truck-done-${idx}`,
        type: "line",
        source: `truck-done-${idx}`,
        paint: { "line-color": color, "line-width": 5, "line-opacity": 1 },
        layout: { "line-cap": "round", "line-join": "round" }
      });

      const stops = (routeDetails[idx] || {}).stops || [];

      // Marqueurs des clients : leur état change pendant la simulation.
      truckRoute.forEach((id, stopIndex) => {
        const client = byId.get(Number(id));

        if (!client) return;

        const stop =
          stops.find((s) => Number(s.client_id) === Number(id)) ||
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
        el.style.setProperty("--truck-color", color);
        el.dataset.etat = "pending";
        el.dataset.retard = String(estEnRetard(stop));
        el.textContent = String(id);

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat(waypoints[stopIndex + 1] || toLngLat(client))
          .setPopup(
            new maplibregl.Popup({ offset: 16, maxWidth: "280px" }).setHTML(popupHtml)
          )
          .addTo(map);

        markersRef.current.push(marker);
        clientMarkersRef.current.push({ el, id, stop, etat: "pending" });
      });

      // Camion cliquable : flèche de cap, icône et numéro.
      const truckEl = document.createElement("button");

      truckEl.type = "button";
      truckEl.className = "do-truck-marker";
      truckEl.style.borderColor = color;
      truckEl.style.setProperty("--truck-color", color);
      truckEl.setAttribute("aria-label", `Suivre le camion ${idx + 1}`);
      truckEl.innerHTML = `<span class="do-truck-arrow"></span>🚚<small>${idx + 1}</small>`;

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
      tracksRef.current[idx] = buildTrack(coords);
    });

    boundsRef.current = bounds;

    // Vue globale au chargement initial
    if (optimization.routes.length) {
      map.fitBounds(bounds, {
        padding: { top: 65, bottom: 65, left: 65, right: 390 },
        maxZoom: instance.mode === "petite" ? 14 : 11,
        pitch: 35,
        bearing: -8,
        duration: 800
      });
    }

    renderFrame(clockRef.current);
  }, [instance, optimization, ready, roadFeatures, focusTruck, renderFrame]);

  // =========================================================
  // MISE EN ÉVIDENCE DE LA ROUTE SÉLECTIONNÉE
  // =========================================================

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !ready) return;

    routes.forEach((_, idx) => {
      const base = `truck-route-${idx}`;
      const done = `truck-done-${idx}`;

      if (!map.getLayer(base)) return;

      const actif = idx === selected;

      map.setPaintProperty(base, "line-width", actif ? 6 : 3.5);
      map.setPaintProperty(base, "line-opacity", actif ? 0.6 : 0.3);
      map.setPaintProperty(done, "line-width", actif ? 8 : 5);
      map.setPaintProperty(done, "line-opacity", actif ? 1 : 0.7);
    });
  }, [selected, routes, ready, roadFeatures]);

  // =========================================================
  // HORLOGE UNIQUE : TOUS LES CAMIONS AVANCENT ENSEMBLE
  // Une image à chaque rafraîchissement de l'écran : le mouvement est continu.
  // =========================================================

  useEffect(() => {
    if (!isPlaying) return;

    let frame;
    let last = performance.now();
    let lastTrail = 0;

    const tick = (now) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;

      const next = Math.min(globalDuration, clockRef.current + speed * dt);
      const withTrail = now - lastTrail > 100;
      if (withTrail) lastTrail = now;

      clockRef.current = next;
      setSimulationMinute(Math.floor(next));
      renderFrame(next, { trails: withTrail });

      if (next >= globalDuration) {
        renderFrame(next);
        setIsPlaying(false);
        return;
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [isPlaying, globalDuration, speed, renderFrame]);

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

          <h2>Carte des tournées</h2>

          <p>
            Tous les camions avancent simultanément sur leurs propres tournées.
            Le détail des camions est dans « Flotte », celui des clients dans « Clients ».
          </p>
        </div>

        <span className="demo-label">
          {routes.length} camions
        </span>
      </div>

      <div className="do-map-layout">

        <div className="do-map-column">

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

          {followTruck && (
            <button
              type="button"
              className="do-map-overview"
              onClick={vueEnsemble}
            >
              Vue d'ensemble
            </button>
          )}

          <div className="map-legend">
            <span><i className="legend-depot" /> Dépôt</span>
            <span><i className="legend-wait" /> Client à livrer</span>
            <span><i className="legend-done" /> Livré</span>
            <span><i className="legend-late" /> Retard prévu</span>
            <span>🚚 Camion (flèche = direction)</span>
            <span>— Trajet parcouru / restant</span>
          </div>

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
                if (clockRef.current >= globalDuration) {
                  setClock(0);
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
                setClock(0);
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
                  style={{ "--truck-color": couleurCamion(i) }}
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

          <div className="do-route-detail">

            <div className="do-selected-title">

              <div>
                <span className="do-global-eyebrow">
                  SUIVI EN DIRECT
                </span>

                <h3>Camion {selected + 1}</h3>
              </div>

              <span
                className="do-selected-color"
                style={{ background: couleurCamion(selected) }}
              />

            </div>

            <div className="do-simulation">

              <div className="do-simulation-header">

                <strong>État du camion {selected + 1}</strong>

                <span className={`do-status ${simulation.statusType}`}>
                  {simulation.status}
                </span>

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

          </div>

        </aside>

      </div>

    </section>
  );
}
