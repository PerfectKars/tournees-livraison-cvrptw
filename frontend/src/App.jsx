
import { useState, useEffect } from "react";

import {
  LayoutDashboard,
  Truck,
  Users,
  Map,
  ChartNoAxesCombined,
  Settings,
  Search,
  ArrowUpRight,
  Clock,
  Route,
  Package,
  Activity,
  Plus,
  Menu,
  X,
  CalendarDays,
  ChevronRight,
  Leaf,
  ListFilter,
  TriangleAlert,
} from "lucide-react";

import "./App.css";
import RouteMap3D from "./RouteMap3D";
import { PageAnalyses } from "./Analyses";
import PageInstances from "./Instances";
import { PageFlotte } from "./Fleet";
import { PageClients } from "./Clients";
import { useBenchmark } from "./useBenchmark";

const API_URL = "http://127.0.0.1:8000";

const navigation = [
  { label: "Dashboard", icon: LayoutDashboard },
  { label: "Instances", icon: ListFilter },
  { label: "Optimisation", icon: Route },
  { label: "Clients", icon: Users },
  { label: "Flotte", icon: Truck },
  { label: "Carte des tournées", icon: Map },
  { label: "Analyses", icon: ChartNoAxesCombined },
];

function App() {
  const [activePage, setActivePage] = useState("Dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mode, setMode] = useState("petite");
  const [recherche, setRecherche] = useState("");

  // Données de l'instance
  const [instance, setInstance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Résultats ALNS
  const [optimization, setOptimization] = useState(null);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizationError, setOptimizationError] = useState(null);
  const [elapsed, setElapsed] = useState(0);

  // Benchmark du solveur (page Analyses) : l'état reste ici pour que le calcul
  // continue si l'on change de page.
  const benchmark = useBenchmark(API_URL);

  // Chargement de l'instance sélectionnée
  useEffect(() => {
    let cancelled = false;

    const chargerInstance = async () => {
      setLoading(true);
      setError(null);
      setInstance(null);
      setOptimization(null);
      setOptimizationError(null);

      try {
        const response = await fetch(
          `${API_URL}/api/instance?mode=${encodeURIComponent(mode)}`
        );

        if (!response.ok) {
          throw new Error(
            `Impossible de récupérer l'instance (${response.status}).`
          );
        }

        const data = await response.json();

        if (!cancelled) {
          setInstance(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    chargerInstance();

    return () => {
      cancelled = true;
    };
  }, [mode]);

  // Lancement de l'algorithme ALNS
  const lancerOptimisation = async () => {
    if (optimizing) return;

    console.log("Lancement ALNS - Instance :", mode);

    setOptimizing(true);
    setOptimizationError(null);
    setElapsed(0);

    try {
      const iterations =
        mode === "petite" ? 500 :
        mode === "france" ? 20 :
        mode === "demande" ? 20 :
        mode === "horaires" ? 20 :
        mode === "grande" ? 5 :
        5;

      // Le calcul tourne en arrière-plan (jusqu'à 60 s) : on le lance, puis on
      // interroge son état au lieu de laisser la page bloquée.
      const urlDepart =
        `${API_URL}/api/optimize/start?mode=${encodeURIComponent(mode)}` +
        `&iterations=${iterations}&removal_rate=0.15`;

      console.log("Requête envoyée :", urlDepart);

      const depart = await fetch(urlDepart, { method: "POST" });
      const departData = await depart.json();

      if (!depart.ok) {
        throw new Error(
          typeof departData.detail === "string"
            ? departData.detail
            : `Erreur serveur : ${depart.status}`
        );
      }

      const debutCalcul = Date.now();
      let data = null;

      while (!data) {
        await new Promise((resolve) => setTimeout(resolve, 700));

        const reponse = await fetch(
          `${API_URL}/api/optimize/status/${departData.job_id}`
        );
        const etat = await reponse.json();

        if (!reponse.ok) {
          throw new Error(
            typeof etat.detail === "string"
              ? etat.detail
              : `Erreur serveur : ${reponse.status}`
          );
        }

        setElapsed(Math.round((Date.now() - debutCalcul) / 1000));

        if (etat.status === "erreur") {
          throw new Error(etat.detail || "L'optimisation a échoué.");
        }

        if (etat.status === "termine") {
          data = etat;
        } else if (Date.now() - debutCalcul > 15 * 60 * 1000) {
          throw new Error("Le calcul dépasse 15 minutes : abandon.");
        }
      }

      if (!data.resultats) {
        throw new Error("Les résultats ALNS sont absents de la réponse.");
      }

      console.log("Résultats ALNS :", data.resultats);

      setOptimization(data.resultats);
      setActivePage("Optimisation");
    } catch (err) {
      console.error("Erreur pendant ALNS :", err);

      setOptimizationError(
        err.message || "Impossible de lancer l'optimisation."
      );
    } finally {
      setOptimizing(false);
    }
  };

  // Distance calculée
  const distanceOptimisee = optimization
    ? Number(optimization.cost).toFixed(2)
    : "--";

  // CO2 estimé par le back-end : distance de chaque tournée x facteur d'émission
  const co2Total = optimization?.co2
    ? Number(optimization.co2.total_kg).toFixed(1)
    : "--";
  const co2Facteur = optimization?.co2?.facteur_kg_par_km;

  // Composant de navigation
  const changerPage = (page) => {
    setActivePage(page);
    setSidebarOpen(false);
  };

  // Instance courante + accès à la page de choix (31 instances : une liste
  // déroulante serait trop longue, d'où une page avec filtres).
  const selecteurInstance = (
    <button
      className="select-button"
      onClick={() => changerPage("Instances")}
      aria-label="Changer d'instance"
    >
      Instance : <strong>{instance?.nom_instance || mode.split("/").pop()}</strong>
      {instance ? ` (${instance.nombre_clients} clients)` : ""} — Changer
    </button>
  );

  // Bouton de lancement réutilisable
  const boutonOptimisation = (label) => (
    <button
      className="primary-button"
      onClick={lancerOptimisation}
      disabled={optimizing || loading}
    >
      <Plus size={18} />
      {optimizing ? `Optimisation en cours... (${elapsed} s)` : label}
    </button>
  );

  // Affichage des erreurs ALNS
  const afficherErreurALNS = () =>
    optimizationError ? (
      <div className="error-message">
        Erreur ALNS : {optimizationError}
      </div>
    ) : null;

  // Contenu du Dashboard
  const afficherDashboard = () => (
    <>
      <section className="welcome-section">
        <div>
          <div className="date-label">
            <CalendarDays size={15} />
            VUE D'ENSEMBLE
          </div>

          <h1>
            Bonjour, bienvenue ! <span>👋</span>
          </h1>

          <p>
            Voici les informations de votre instance de livraison.
          </p>

          {loading && <p>Chargement des données...</p>}

          {error && (
            <p style={{ color: "red" }}>
              Erreur : {error}
            </p>
          )}

          {instance && (
            <p style={{ color: "green" }}>
              ● Instance {instance.nom_instance} chargée —{" "}
              {instance.nombre_clients} clients,{" "}
              {instance.nombre_vehicules} véhicules.
              {mode === "france"
                ? " Distances routières réelles calculées avec OSRM."
                : mode === "petite"
                ? " Petite instance de test : 20 clients et distances euclidiennes."
                : mode === "demande"
                ? " Instance avec forte demande."
                : mode === "horaires"
                ? " Instance avec fenêtres horaires."
                : mode === "grande"
                ? " Grande instance avec capacité élevée."
                : " Distances euclidiennes."}
            </p>
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            flexWrap: "wrap",
          }}
        >
          {selecteurInstance}
          {boutonOptimisation("Nouvelle optimisation")}
        </div>
      </section>

      {afficherErreurALNS()}

      <section className="stats-grid">
        <article className="stat-card">
          <div className="stat-top">
            <div className="stat-icon blue">
              <Users size={21} />
            </div>
          </div>

          <p className="stat-title">Clients de l'instance</p>

          <h2>
            {loading
              ? "..."
              : error
              ? "--"
              : instance?.nombre_clients ?? "--"}
          </h2>

          <small>Clients à desservir</small>
        </article>

        <article className="stat-card">
          <div className="stat-top">
            <div className="stat-icon purple">
              <Truck size={21} />
            </div>
          </div>

          <p className="stat-title">Nombre de véhicules</p>

          <h2>
            {loading
              ? "..."
              : error
              ? "--"
              : instance?.nombre_vehicules ?? "--"}
          </h2>

          <small>Flotte disponible</small>
        </article>

        <article className="stat-card">
          <div className="stat-top">
            <div className="stat-icon orange">
              <Package size={21} />
            </div>
          </div>

          <p className="stat-title">Capacité par véhicule</p>

          <h2>
            {loading
              ? "..."
              : error
              ? "--"
              : instance?.capacite_vehicule ?? "--"}
          </h2>

          <small>Capacité maximale autorisée</small>
        </article>
      </section>

      <section className="content-grid">
        <article className="panel route-panel">
          <div className="panel-heading">
            <div>
              <h3>Vue des opérations</h3>
              <p>Suivi des tournées de livraison</p>
            </div>

            <button
              className="select-button"
              onClick={() => changerPage("Optimisation")}
            >
              Résultats ALNS
              <ChevronRight size={15} />
            </button>
          </div>

          <div className="chart-summary">
            <div>
              <small>Distance totale optimisée</small>
              <h2>{distanceOptimisee}</h2>
            </div>
          </div>

          {optimizing ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Activity size={28} />
              </div>

              <strong>Optimisation en cours...</strong>
              <p>ALNS recherche les meilleures tournées.</p>
            </div>
          ) : optimization ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Route size={28} />
              </div>

              <strong>Optimisation terminée !</strong>

              <p>
                Nombre de clients : {optimization.number_of_customers}
              </p>

              <p>
                Véhicules utilisés : {optimization.number_of_routes}
              </p>

              <p>Distance totale : {distanceOptimisee}</p>

              <p>CO₂ estimé : {co2Total} kg</p>

              <p>Itérations : {optimization.iterations}</p>
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Route size={28} />
              </div>

              <strong>Aucune optimisation disponible</strong>

              <p>
                Lancez ALNS pour afficher les résultats.
              </p>
            </div>
          )}
        </article>

        <article className="panel performance-panel">
          <div className="panel-heading">
            <div>
              <h3>Performance globale</h3>
              <p>Résultats de l'optimisation</p>
            </div>

            <Activity size={19} className="muted-icon" />
          </div>

          <div className="performance-circle">
            <div className="circle-inner">
              <strong>
                {optimization ? optimization.number_of_routes : "--"}
              </strong>

              <small>
                {optimization ? "Véhicules" : "En attente"}
              </small>
            </div>
          </div>

          <div className="performance-footer">
            <span className="status-indicator" />

            <span>
              {optimization
                ? "Optimisation terminée"
                : optimizing
                ? "Calcul en cours"
                : "En attente de résultats"}
            </span>
          </div>

          <p className="performance-note">
            {optimization
              ? `${optimization.number_of_customers} clients traités en ${optimization.iterations} itérations.`
              : "Les indicateurs apparaîtront après l'optimisation."}
          </p>
        </article>
      </section>

      <section className="bottom-grid">
        <article className="panel fleet-panel">
          <div className="panel-heading">
            <div>
              <h3>État de la flotte</h3>
              <p>Informations sur les véhicules</p>
            </div>

            <button
              className="text-button"
              onClick={() => changerPage("Flotte")}
            >
              Voir tout
              <ArrowUpRight size={15} />
            </button>
          </div>

          <div className="empty-state">
            <div className="empty-state-icon">
              <Truck size={28} />
            </div>

            <strong>Détails de la flotte indisponibles</strong>

            <p>
              Les informations détaillées seront affichées ici
              dans une prochaine étape.
            </p>
          </div>
        </article>

        <article className="panel activity-panel">
          <div className="panel-heading">
            <div>
              <h3>Activité récente</h3>
              <p>Historique des optimisations</p>
            </div>

            <button className="more-button">•••</button>
          </div>

          {optimization ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Clock size={28} />
              </div>

              <strong>Dernière optimisation</strong>

              <p>Instance : {instance?.nom_instance}</p>
              <p>Coût : {distanceOptimisee}</p>
              <p>Itérations : {optimization.iterations}</p>
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Clock size={28} />
              </div>

              <strong>Aucune activité enregistrée</strong>

              <p>
                L'historique apparaîtra après les premières optimisations.
              </p>
            </div>
          )}
        </article>
      </section>
    </>
  );

  // Contenu de la page Optimisation
  const afficherOptimisation = () => (
    <>
      <section className="welcome-section">
        <div>
          <div className="date-label">
            <Route size={15} />
            OPTIMISATION ALNS
          </div>

          <h1>Optimisation des tournées</h1>

          <p>
            Analysez les résultats générés par votre algorithme.
          </p>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            flexWrap: "wrap",
          }}
        >
          {selecteurInstance}
          {boutonOptimisation("Lancer ALNS")}
        </div>
      </section>

      {afficherErreurALNS()}

      {optimizing && (
        <div className="panel empty-state">
          <Activity size={28} />
          <strong>Optimisation en cours...</strong>
          <p>Veuillez patienter pendant le calcul des tournées.</p>
        </div>
      )}

      {optimization && (
        <>
          {optimization.limite_depassee && (
            <div className="warning-message" role="alert">
              <TriangleAlert size={18} />
              <span>
                Flotte dépassée : {optimization.number_of_routes} camions
                utilisés pour {optimization.nombre_vehicules_disponibles}{" "}
                disponibles. Les tournées respectent capacités et horaires,
                mais pas le nombre de camions autorisé.
              </span>
            </div>
          )}

          <section className="stats-grid">
            <article className="stat-card">
              <div className="stat-top">
                <div className="stat-icon orange">
                  <Route size={21} />
                </div>
              </div>

              <p className="stat-title">Distance totale</p>
              <h2>{distanceOptimisee}</h2>
              <small>Coût de la solution ALNS</small>
            </article>

            <article className="stat-card">
              <div className="stat-top">
                <div className="stat-icon blue">
                  <Users size={21} />
                </div>
              </div>

              <p className="stat-title">Clients desservis</p>
              <h2>{optimization.number_of_customers}</h2>
              <small>Clients de l'instance</small>
            </article>

            <article className="stat-card">
              <div className="stat-top">
                <div className="stat-icon purple">
                  <Truck size={21} />
                </div>
              </div>

              <p className="stat-title">Véhicules utilisés</p>
              <h2>{optimization.number_of_routes}</h2>
              <small>Tournées générées</small>
            </article>

            <article className="stat-card">
              <div className="stat-top">
                <div className="stat-icon green">
                  <Leaf size={21} />
                </div>
              </div>

              <p className="stat-title">CO₂ estimé</p>
              <h2>{co2Total} kg</h2>
              <small>
                {co2Facteur !== undefined
                  ? `${co2Facteur} kg/km (hypothèse)`
                  : "Non calculé"}
              </small>
            </article>
          </section>

          <section
            className="panel"
            style={{ padding: "24px", marginTop: "22px" }}
          >
            <div className="panel-heading">
              <div>
                <h3>Résultat de l'algorithme</h3>
                <p>Résumé de la dernière optimisation</p>
              </div>
            </div>

            <p>
              <strong>Instance :</strong> {instance?.nom_instance}
            </p>

            <p>
              <strong>Nombre d'itérations :</strong> {optimization.iterations}
            </p>

            <p>
              <strong>Distance totale :</strong> {distanceOptimisee}
            </p>

            <p>
              <strong>CO₂ estimé :</strong> {co2Total} kg
            </p>

            <button
              className="text-button"
              onClick={() => changerPage("Carte des tournées")}
            >
              Visualiser les tournées
              <ArrowUpRight size={16} />
            </button>
          </section>
        </>
      )}

      {!optimization && !optimizing && (
        <div className="panel empty-state">
          <div className="empty-state-icon">
            <Route size={28} />
          </div>

          <strong>Aucun résultat disponible</strong>

          <p>
            Cliquez sur « Lancer ALNS » pour calculer vos tournées.
          </p>
        </div>
      )}
    </>
  );

  // Contenu de la page Carte
  const afficherCarte = () => (
    <>
      {optimization ? (
        <RouteMap3D
          instance={instance}
          optimization={optimization}
        />
      ) : (
        <div className="panel empty-state">
          <div className="empty-state-icon">
            <Map size={28} />
          </div>

          <strong>Aucune tournée à afficher</strong>

          <p>
            Lancez d'abord une optimisation ALNS pour afficher
            les tournées sur la carte.
          </p>

          {boutonOptimisation("Lancer ALNS")}
        </div>
      )}
    </>
  );

  // Pages en préparation
  return (
    <div className="app-shell">
      {/* SIDEBAR */}
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-icon">
            <Route size={25} />
          </div>

          <div>
            <h2>
              Delivery<span>Optimizer</span>
            </h2>
            <small>SMART LOGISTICS PLATFORM</small>
          </div>

          <button
            className="close-sidebar"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={20} />
          </button>
        </div>

        <div className="nav-section">
          <p className="nav-label">MENU PRINCIPAL</p>

          {navigation.map((item) => {
            const Icon = item.icon;

            return (
              <button
                key={item.label}
                className={`nav-item ${
                  activePage === item.label ? "active" : ""
                }`}
                onClick={() => changerPage(item.label)}
              >
                <Icon size={19} />
                <span>{item.label}</span>

                {item.label === "Optimisation" && (
                  <span className="nav-dot" />
                )}
              </button>
            );
          })}
        </div>

        <div className="sidebar-bottom">
          <div className="help-card">
            <div className="help-icon">
              <Activity size={20} />
            </div>

            <strong>Optimisez vos livraisons</strong>

            <p>
              Une logistique plus intelligente et plus efficace.
            </p>
          </div>

          <div className="profile">
            <div className="avatar">DO</div>

            <div>
              <strong>Administrateur</strong>
              <small>Gestionnaire de flotte</small>
            </div>

            <Settings size={17} className="profile-settings" />
          </div>
        </div>
      </aside>

      {/* OVERLAY MOBILE */}
      {sidebarOpen && (
        <div
          className="sidebar-overlay"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* CONTENU PRINCIPAL */}
      <main className="main-content">
        {/* BARRE SUPÉRIEURE */}
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="menu-button"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={22} />
            </button>

            <div className="breadcrumb">
              <span>Pages</span>
              <ChevronRight size={15} />
              <strong>{activePage}</strong>
            </div>
          </div>

          <div className="topbar-right">
            <div className="search-box">
              <Search size={17} />
              <input
                placeholder="Rechercher un client..."
                value={recherche}
                onChange={(e) => {
                  setRecherche(e.target.value);
                  if (activePage !== "Clients") changerPage("Clients");
                }}
              />
            </div>

            <div className="top-avatar">DO</div>
          </div>
        </header>

        {/* AFFICHAGE DES PAGES */}
        <div className="page-container">
          {activePage === "Dashboard" && afficherDashboard()}

          {activePage === "Instances" && (
            <PageInstances
              apiUrl={API_URL}
              mode={mode}
              onChoisir={(choix) => {
                setMode(choix);
                changerPage("Dashboard");
              }}
            />
          )}

          {activePage === "Optimisation" && afficherOptimisation()}

          {activePage === "Carte des tournées" && afficherCarte()}

          {activePage === "Analyses" && <PageAnalyses apiUrl={API_URL} bench={benchmark} />}

          {activePage === "Clients" && (
            <PageClients
              instance={instance}
              optimization={optimization}
              recherche={recherche}
              setRecherche={setRecherche}
            />
          )}

          {activePage === "Flotte" && (
            <PageFlotte
              instance={instance}
              optimization={optimization}
              boutonOptimisation={boutonOptimisation}
            />
          )}

          {error && (
            <div className="error-message">
              Erreur de chargement : {error}
            </div>
          )}

          <footer className="page-footer">
            <span>© 2026 DeliveryOptimizer</span>
            <span>Intelligent Logistics Management</span>
          </footer>
        </div>
      </main>
    </div>
  );
}

export default App;
