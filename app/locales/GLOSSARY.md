# Gryffi glossary for the maker interface

One word per thing, in every language. Makers are often HR, L&D or inclusion staff, not technical people, and some have ADHD or dyslexia: a different word reads as a different thing. Use these words in `app/locales/*.json`, in `help-base/` and in the AI help prompt (`services/help.js`).

Decided by Erik on 24 November 2026 (see the report "Hulp in de Gryffi-app").

## Terms

| Concept | en | nl | de | fr | es |
|---|---|---|---|---|---|
| People who follow a journey | participants | deelnemers | Teilnehmer | participants | participantes |
| People who build journeys | makers | makers | Autoren | créateurs | creadores |
| A journey | journey | expeditie | Expedition | parcours | expedición |
| The editor where you build a journey | builder | bouwer | Editor | éditeur | editor |
| AI chatbot (menu and page title) | AI guides | AI-gidsen | KI-Begleiter | Guides IA | Guías de IA |
| AI chatbot (in running text) | guide | gids | Begleiter | guide | guía |
| Step type with a guide | AI guide | AI-gids | KI-Begleiter | Guide IA | Guía de IA |
| A guide added to any step (was "step assistant") | guide in this step | gids in deze stap | Begleiter in diesem Schritt | guide dans cette étape | guía en este paso |
| Piece of knowledge a guide learns from (was chunk, fragment, knowledge block) | piece of text, pieces | stukje tekst, stukjes | Textabschnitt, Textabschnitte | passage, passages | fragmento, fragmentos |
| Field "path label" on a connection | Button text | Tekst op de knop | Text auf dem Button | Texte du bouton | Texto del botón |
| Add a connection to another step | Add a choice | Nog een keuze toevoegen | Weitere Auswahl hinzufügen | Ajouter un choix | Añadir una opción |
| Connection between steps (noun) | link | koppeling | Verbindung | lien | enlace |
| Unpublish | Take offline | Offline halen | Offline nehmen | Mettre hors ligne | Dejar de publicar |
| Quiz step type (was Challenge in en/fr/es) | Quiz | Quiz | Quiz | Quiz | Cuestionario |
| Poll step type and results | poll, polls | peiling, peilingen | Umfrage, Umfragen | sondage, sondages | encuesta, encuestas |
| Personal settings page (menu and title) | My account | Mijn account | Mein Konto | Mon compte | Mi cuenta |
| Organization settings page (menu and title) | Organization | Organisatie | Organisation | Organisation | Organización |
| Extra instructions for a guide (was system prompt) | Extra instructions for the guide | Extra instructies voor de gids | Zusätzliche Anweisungen für den Begleiter | Instructions supplémentaires pour le guide | Instrucciones adicionales para la guía |
| Microsoft directory link | Microsoft 365 | Microsoft 365 | Microsoft 365 | Microsoft 365 | Microsoft 365 |
| Google directory link | Google Workspace | Google Workspace | Google Workspace | Google Workspace | Google Workspace |
| Step panel tab 1 (was Basic) | What they see | Wat ze zien | Was sie sehen | Ce qu'ils voient | Lo que ven |
| Step panel tab 2 (was Advanced) | How it works | Hoe het werkt | So funktioniert es | Fonctionnement | Cómo funciona |

## Rules

- Gryffi terms are not literal translations. A journey is an "expeditie", "Expedition", "parcours" or "expedición", never a trip, Reise, voyage or viaje. Keep the step type names and the other product words from the table and from the existing locale files; do not translate them back into everyday words.
- "users" (and gebruikers, Benutzer, Nutzer, utilisateurs, usuarios) only for accounts synced from Microsoft 365 or Google Workspace and in analytics. Whenever it means the people who follow a journey, write participants. Whenever it means makers, write makers.
- German: always "Sie".
- Avoid technical words when an everyday word exists: configure, synchronize (say "link" or "keep up to date"), session, system prompt, parameter, instance, override, token, chunk, API (only on the API page itself), JSON and CSV (say what the file is for; keep "CSV file" where a maker must pick a file type).
- Azure AD is now Microsoft Entra ID; write Microsoft 365 instead.
- One sentence per hint. Say what it does, not how it is built.
- No uppercase for emphasis, no emoji, no em dash or en dash as punctuation.
- Keep brand and product names as they are: Gryffi, Microsoft 365, Google Workspace, YouTube, PDF.
