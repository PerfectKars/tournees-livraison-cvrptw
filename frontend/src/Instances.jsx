import { useEffect, useMemo, useState } from "react";
import { Check, Search } from "lucide-react";

// Page « Instances » : choix de l'instance à optimiser, avec des filtres
// (jeu, famille, taille, recherche) plutôt qu'une longue liste déroulante.

const DEMOS = [
  { nom: "petite", titre: "Petite livraison", clients: 20, note: "Test, coordonnées euclidiennes" },
  { nom: "horaires", titre: "Fenêtres horaires", clients: 30, note: "Test des contraintes horaires" },
  { nom: "demande", titre: "Forte demande", clients: 50, note: "Test de la capacité" },
  { nom: "france", titre: "France — GPS + OSRM", clients: 100, note: "Distances routières réelles" },
  { nom: "grande", titre: "Grande capacité", clients: 200, note: "Test de grande capacité" },
];

const JEUX = [
  { cle: "solomon", libelle: "Solomon" },
  { cle: "homberger", libelle: "Homberger" },
  { cle: "xtw", libelle: "XTW" },
  { cle: "demo", libelle: "Démo" },
];

// Famille d'une instance : C1, C2, R1, R2, RC1, RC2 (Solomon : C101 -> C1 ;
// Homberger : C1_2_1 -> C1). Les XTW n'ont pas de famille.
function famille(nom) {
  const court = nom.split("/")[1] || nom;
  const m = court.match(/^(RC|R|C)(\d)/);
  return m ? m[1] + m[2] : "—";
}

const nomCourt = (nom) => nom.split("/")[1] || nom;

export default function PageInstances({ apiUrl, mode, onChoisir }) {
  const [catalogue, setCatalogue] = useState([]);
  const [erreur, setErreur] = useState(null);
  const [jeu, setJeu] = useState(() => (mode.includes("/") ? mode.split("/")[0] : "demo"));
  const [familles, setFamilles] = useState(new Set());
  const [taille, setTaille] = useState(null);
  const [recherche, setRecherche] = useState("");

  useEffect(() => {
    let annule = false;
    fetch(`${apiUrl}/instances`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Erreur serveur ${r.status}`))))
      .then((donnees) => !annule && setCatalogue(donnees))
      .catch((e) => !annule && setErreur(e.message));
    return () => {
      annule = true;
    };
  }, [apiUrl]);

  const parJeu = (cle) => catalogue.filter((i) => i.jeu === cle);
  const duJeu = useMemo(() => catalogue.filter((i) => i.jeu === jeu), [catalogue, jeu]);
  const famillesDispo = [...new Set(duJeu.map((i) => famille(i.nom)))].filter((f) => f !== "—").sort();
  const taillesDispo = [...new Set(duJeu.map((i) => i.clients))].sort((a, b) => a - b);

  const lignes = duJeu.filter(
    (i) =>
      (familles.size === 0 || familles.has(famille(i.nom))) &&
      (taille === null || i.clients === taille) &&
      nomCourt(i.nom).toLowerCase().includes(recherche.trim().toLowerCase())
  );

  const changerJeu = (cle) => {
    setJeu(cle);
    setFamilles(new Set());
    setTaille(null);
    setRecherche("");
  };

  const basculerFamille = (f) =>
    setFamilles((avant) => {
      const apres = new Set(avant);
      if (apres.has(f)) apres.delete(f);
      else apres.add(f);
      return apres;
    });

  const nombre = (cle) => (cle === "demo" ? DEMOS.length : parJeu(cle).length);

  return (
    <>
      <section className="welcome-section">
        <div>
          <div className="date-label">INSTANCES</div>
          <h1>Choisir une instance</h1>
          <p>
            Les instances de référence (Solomon, Homberger, XTW) viennent de CVRPLIB ; la
            solution de référence sert à calculer l'écart du solveur.
          </p>
        </div>
      </section>

      {erreur && <div className="error-message">Catalogue indisponible : {erreur}</div>}

      <section className="panel bench-panel">
        <div className="bench-presets" style={{ justifyContent: "flex-start" }}>
          {JEUX.map((j) => (
            <label
              key={j.cle}
              className={`bench-chip ${jeu === j.cle ? "on" : ""}`}
              onClick={() => changerJeu(j.cle)}
            >
              {j.libelle} ({nombre(j.cle)})
            </label>
          ))}
        </div>

        {jeu !== "demo" && (
          <>
            <div className="bench-group">
              <strong>Famille</strong>
              <div className="bench-chips">
                {famillesDispo.map((f) => (
                  <label key={f} className={`bench-chip ${familles.has(f) ? "on" : ""}`}
                         onClick={() => basculerFamille(f)}>
                    {f}
                  </label>
                ))}
                {famillesDispo.length === 0 && <span style={{ fontSize: 11 }}>Pas de famille pour ce jeu.</span>}
              </div>
            </div>
            <div className="bench-group">
              <strong>Clients</strong>
              <div className="bench-chips">
                {taillesDispo.map((t) => (
                  <label key={t} className={`bench-chip ${taille === t ? "on" : ""}`}
                         onClick={() => setTaille(taille === t ? null : t)}>
                    {t}
                  </label>
                ))}
              </div>
            </div>
            <div className="bench-group">
              <strong>Recherche</strong>
              <div className="bench-chips">
                <Search size={14} />
                <input
                  value={recherche}
                  onChange={(e) => setRecherche(e.target.value)}
                  placeholder="ex. RC2"
                  aria-label="Rechercher une instance"
                  style={{ border: "1px solid var(--line)", borderRadius: 999, padding: "6px 12px", fontSize: 11 }}
                />
              </div>
            </div>
          </>
        )}

        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Instance</th>
                <th>{jeu === "demo" ? "Description" : "Famille"}</th>
                <th>Clients</th>
                {jeu !== "demo" && <th>Véhicules réf.</th>}
                {jeu !== "demo" && <th>Coût réf.</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {jeu === "demo"
                ? DEMOS.map((d) => (
                    <tr key={d.nom}>
                      <td><strong>{d.titre}</strong></td>
                      <td>{d.note}</td>
                      <td>{d.clients}</td>
                      <td>
                        <BoutonChoix actif={mode === d.nom} onClick={() => onChoisir(d.nom)} />
                      </td>
                    </tr>
                  ))
                : lignes.map((i) => (
                    <tr key={i.nom}>
                      <td><strong>{nomCourt(i.nom)}</strong></td>
                      <td>{famille(i.nom)}</td>
                      <td>{i.clients}</td>
                      <td>{i.reference_vehicules ?? "—"}</td>
                      <td>{i.reference_cout ?? "—"}</td>
                      <td>
                        <BoutonChoix actif={mode === i.nom} onClick={() => onChoisir(i.nom)} />
                      </td>
                    </tr>
                  ))}
              {jeu !== "demo" && lignes.length === 0 && (
                <tr><td colSpan={6}>Aucune instance avec ces filtres.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function BoutonChoix({ actif, onClick }) {
  return (
    <button className={actif ? "select-button" : "primary-button"} onClick={onClick}
            style={{ padding: "6px 14px", fontSize: 11 }}>
      {actif ? <><Check size={13} /> Sélectionnée</> : "Choisir"}
    </button>
  );
}
