import { useState } from "react";
import { Gauge } from "lucide-react";
import Comparaison from "./Comparaison";
import { PageBenchmark } from "./Benchmark";

// Page « Analyses » : deux onglets. La comparaison ALNS / tabou (étude
// expérimentale) est l'onglet par défaut ; le benchmark en direct du solveur
// ALNS (écart à la référence, arrêt à 7 %) reste disponible.
const ONGLETS = [
  { cle: "comparaison", libelle: "Comparaison ALNS / tabou" },
  { cle: "benchmark", libelle: "Benchmark ALNS en direct" },
];

export function PageAnalyses({ apiUrl, bench }) {
  const [onglet, setOnglet] = useState("comparaison");

  return (
    <>
      <section className="welcome-section">
        <div>
          <div className="date-label">
            <Gauge size={15} />
            ANALYSES
          </div>
          <h1>Analyses des performances</h1>
          <p>
            {onglet === "comparaison"
              ? "Étude expérimentale : l'ALNS (Julia) et une recherche tabou simple sont lancés sur les mêmes instances de référence, avec le même budget de temps, et comparés (écart à la meilleure solution connue, véhicules, CO₂, convergence)."
              : "Le solveur ALNS est lancé sur des instances de référence et comparé à la meilleure solution connue."}
          </p>
        </div>
      </section>

      <div className="bench-presets" style={{ justifyContent: "flex-start", marginBottom: 18 }}>
        {ONGLETS.map((o) => (
          <label key={o.cle} className={`bench-chip ${onglet === o.cle ? "on" : ""}`}
                 onClick={() => setOnglet(o.cle)}>
            {o.libelle}
          </label>
        ))}
      </div>

      {onglet === "comparaison" ? <Comparaison apiUrl={apiUrl} /> : <PageBenchmark bench={bench} embarque />}
    </>
  );
}
