// Fonctions et constantes partagées par la carte des tournées, la page Flotte
// et la page Clients.

export const COLORS = [
  "#C47759", "#648C78", "#7C78A8", "#D6A85F", "#578CA3",
  "#B16C85", "#8A9560", "#A17B56", "#6877A8", "#A56F48"
];

export const couleurCamion = (index) => COLORS[index % COLORS.length];

// Minutes depuis minuit -> « HH:MM ».
export const minutes = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const n = Math.max(0, Math.round(Number(value)));
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
};

// Durée totale d'une tournée (retour au dépôt ou fin du dernier service).
export function getRouteDuration(detail) {
  return Math.max(
    1,
    Number(detail?.return_time_min) || 0,
    ...(detail?.stops || []).map((stop) => Number(stop.service_end_min) || 0)
  );
}

// État d'un camion à une minute de simulation donnée.
export function getSimulationInfo(routeDetail, simulationMinute) {
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

  return { completed: completed.length, currentStop, nextStop, status, statusType };
}

// Un arrêt est en retard si l'arrivée dépasse l'heure limite du client.
export const estEnRetard = (stop) =>
  Number.isFinite(Number(stop?.due_min)) &&
  Number.isFinite(Number(stop?.arrival_min)) &&
  Number(stop.arrival_min) > Number(stop.due_min) + 1e-6;

// Table client -> { camion, rang, arrêt } d'après les tournées optimisées.
export function affectationClients(optimization) {
  const parClient = new Map();
  (optimization?.routes || []).forEach((route, camion) => {
    const stops = optimization.route_details?.[camion]?.stops || [];
    route.forEach((id, rang) => {
      const stop =
        stops.find((s) => Number(s.client_id) === Number(id)) || stops[rang] || {};
      parClient.set(Number(id), { camion, rang, stop });
    });
  });
  return parClient;
}
