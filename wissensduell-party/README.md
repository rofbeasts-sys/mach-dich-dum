# WISSENSDUELL PARTY

Erweiterung des bestehenden Wissensduell-Spiels um einen echten **WLAN-Mehrgeräte-Modus**
(„Party-Raum"), zusätzlich zu Solo und dem bisherigen lokalen Multiplayer (Pass & Play
auf einem Gerät), die unverändert erhalten bleiben.

## 1. Starten

Voraussetzung: [Node.js](https://nodejs.org) ist installiert (keine weiteren Pakete nötig –
der Server kommt komplett ohne externe Abhängigkeiten aus).

```bash
node server.js
```

Die Konsole zeigt danach zwei Adressen an, z. B.:

```
Auf diesem Gerät öffnen:   http://localhost:3000
Für andere Geräte im selben WLAN:
  http://192.168.1.23:3000
```

- **Host:** öffnet `http://localhost:3000` (oder die angezeigte WLAN-Adresse) im Browser.
- **Alle anderen Geräte** (Handys, Tablets, Laptops) müssen im **selben WLAN** sein und
  ebenfalls die angezeigte `http://192.168.x.x:3000`-Adresse öffnen.
- Solo und "Lokaler Multiplayer" funktionieren weiterhin genauso wie zuvor – dafür ist
  keine Verbindung zu anderen Geräten nötig, nur der Party-Modus nutzt den Server aktiv.

Einen anderen Port verwenden: `PORT=4000 node server.js`.

## 1b. Als echte Internetseite hosten (statt nur im WLAN)

Der Server läuft unverändert auch bei einem Hosting-Anbieter – der Code liest den Port
bereits aus der Umgebungsvariable `PORT` (die jeder Anbieter automatisch setzt), und die
Web-Oberfläche erkennt selbst, ob sie über `http://` oder `https://` aufgerufen wird und
wählt automatisch `ws://` bzw. `wss://`. Es sind also **keine Code-Änderungen** nötig, nur
ein paar Schritte beim Anbieter.

**Wichtig bei der Anbieterwahl:** Dieses Projekt braucht einen Anbieter mit einem
**dauerhaft laufenden Node-Prozess** (nicht "serverless"/"Functions"), der **WebSocket-
Verbindungen** unterstützt. Plattformen wie Vercel oder Netlify funktionieren dafür
**nicht**, weil sie Node-Code nur als kurzlebige Funktionen ausführen.

Empfehlung (Stand September 2026 – geprüft, weil sich diese Angebote erfahrungsgemäß
häufig ändern; vor der Anmeldung lohnt sich trotzdem ein kurzer Blick auf die aktuellen
Konditionen des Anbieters):

**Render** (aktuell die zugänglichste kostenlose Option, keine Kreditkarte nötig):
1. Projekt auf GitHub hochladen (neues Repository erstellen, diese Dateien pushen).
2. Bei [render.com](https://render.com) registrieren, "New" → "Web Service" → GitHub-Repo auswählen.
3. Build/Run werden automatisch erkannt (Node.js, Build-Befehl `npm install`, Start-Befehl `npm start`).
4. Instanztyp "Free" wählen und deployen. Du bekommst eine feste Adresse wie
   `https://dein-app.onrender.com` – funktioniert von überall, nicht nur im eigenen WLAN.

Zwei bekannte Einschränkungen des Gratis-Tiers, die bei einer Party auffallen können:
Der Dienst legt sich nach 15 Minuten Inaktivität schlafen (der nächste Aufruf braucht dann
~30–60 Sekunden zum Aufwachen – am besten die Seite kurz vorher schon mal öffnen, bevor
alle mitspielen wollen), und WebSocket-Verbindungen können auf dem Gratis-Tier gelegentlich
vorzeitig getrennt werden. Für eine einzelne Spielrunde unter Freunden ist das meist kein
Problem; bricht die Verbindung doch ab, zeigt die Seite das jetzt klar an und man tritt dem
Raum einfach erneut bei.

~~Koyeb~~ ist seit der Übernahme durch Mistral AI (Februar 2026) für **neue** Nutzer keine
kostenlose Option mehr – neu registrierte Konten benötigen dort inzwischen einen
kostenpflichtigen Plan. Auch Glitch, früher eine beliebte Gratis-Option, hat sein
Projekt-Hosting im Juli 2025 komplett eingestellt. Diese Landschaft ändert sich häufig;
wenn Render zum Zeitpunkt deines Deploys nicht mehr passt, suche nach "kostenloser
Node.js-Hosting-Anbieter mit WebSocket-Unterstützung" und prüfe insbesondere, ob es sich
um einen dauerhaft laufenden Dienst (nicht "serverless"/"Functions") handelt.

Unabhängig vom Anbieter gilt: Der Raum-Zustand liegt nur im Arbeitsspeicher des
Node-Prozesses. Ein Neustart/Redeploy des Dienstes beendet alle laufenden Partys
(die Lobby lässt sich danach aber sofort neu erstellen).

## 2. Projektstruktur

```
server.js              Der Node-Server: Räume, Runden, Teams, Punktesysteme, Spiel-Engines
lib/miniws.js           Minimaler WebSocket-Server (nur Node-Bordmittel, kein npm-Paket nötig)
shared/quizQuestions.json   Zentrale Fragen-Datenbank (Wissenstest) – von Solo, lokalem MP und Party genutzt
shared/partyDatasets.json   Datensätze für "Einordnen" und "Mehr oder Weniger" (Werte anfangs verborgen)
public/index.html       Die komplette Client-Oberfläche (Solo, Lokaler Multiplayer, Party)
test/                   Ein automatisierter End-to-End-Test (optional, `npm test`)
```

## 3. Neue Fragen / Kategorien hinzufügen

- **Wissenstest-Fragen:** in `shared/quizQuestions.json` ein neues Objekt ergänzen
  (`q`, `a` [4 Antworten], `c` [Index der richtigen Antwort], `cat`, `d` [Schwierigkeit 1–3], optional `e` [Erklärung]).
- **Einordnen / Mehr oder Weniger:** in `shared/partyDatasets.json` unter `ordering` bzw.
  `higherLower` einen neuen Eintrag mit `label`, `unit`, `order` (`"desc"` oder `"asc"`) und
  `items` (`id`, `name`, `value`) anlegen. Bei "Mehr oder Weniger" zusätzlich `seedId` setzen
  (das bereits bekannte Startelement). Neue Kategorien erscheinen automatisch in der
  Zufallsrunde und in "Spiel erstellen" – dafür muss kein weiterer Code angepasst werden
  (siehe `buildRoundDefPool()` in `server.js`).

## 4. Punkte ändern

- Wissenstest: `handleQuizAnswer()` / `resolveQuizQuestion()` in `server.js` (`+100` / `-150`).
- Einordnen / Mehr oder Weniger: `handleRankPlace()` (`+10` je korrekt platziertem Element,
  1 Leben Abzug bei Fehlern).
- Rundenbonus / Punktesysteme: Funktion `awardRoundPoints()` – dort sind alle drei
  Punktesysteme (Runde / Steigend / Punkteabzug) zentral umgesetzt.
- Höhe des Punkteabzugs bei Punktesystem 3: Konstante `MISTAKE_PENALTY` ganz oben in `server.js`.

## 5. Ränge ändern

Weiterhin im Client in `public/index.html`, Array `RANKS` (gilt für Solo- und
lokale-Multiplayer-Profile; der Party-Modus verwendet eigene, sitzungsbasierte
Team-Punktestände ohne Rangsystem).

## 6. Bots im Party-Raum

Bots gibt es **ausschließlich im Party-Raum** – Solo und der bisherige lokale/Online-Multiplayer
bleiben komplett bot-frei und unverändert.

- Im Warteraum kann der Host über **„+ BOT HINZUFÜGEN"** beliebig viele Bots ergänzen
  (maximal so viele, bis die Teilnehmerzahl inkl. echter Spieler das Party-Limit von
  6 erreicht) und über **✕** wieder entfernen.
- Jeder Bot bekommt einen zufälligen, innerhalb der Party einmaligen Namen sowie das
  Symbol 🤖 und kann per Dropdown auf eine von fünf Schwierigkeitsstufen gestellt werden:
  **Dumm, Einsteiger, Schlau, Doktor, Wissenschaftler**.
- Auch mit nur einem echten Spieler lässt sich so eine vollständige Party mit bis zu
  5 Bots als Gegnern starten.
- Bots werden bei Teams (2v2, 3v3, 2v2v2) automatisch dem kleinsten Team zugeteilt;
  der Host kann sie in der Team-Übersicht jederzeit manuell umverteilen – genau wie
  echte Spieler.
- Bots spielen in **allen** Rundentypen mit: Beim Wissenstest antworten sie nach einer
  schwierigkeitsabhängigen Bedenkzeit mit einer schwierigkeitsabhängigen Trefferquote.
  Bei Einordnen/Mehr-oder-Weniger ziehen Bots automatisch, sobald ein komplett aus
  Bots bestehendes Team am Zug ist (ein Team mit mindestens einem echten Spieler zieht
  weiterhin selbst) – inklusive eigener 3 Leben und schwierigkeitsabhängiger Fehlerquote.

**Bot-Werte zentral anpassen:** Objekt `BOT_TIERS` ganz oben in `server.js` – dort lassen
sich für jede Stufe Trefferquote (`prob`), Bedenkzeit beim Wissenstest (`quizMinPct`/
`quizMaxPct`, als Anteil des Zeitlimits) und Bedenkzeit bei Einordnen/Mehr-oder-Weniger
(`rankDelayMin`/`rankDelayMax` in Millisekunden) einstellen. Neue Stufen einfach als
weiteren Eintrag ergänzen und in `BOT_TIER_ORDER` aufnehmen. Bot-Namen: Array
`BOT_NAME_POOL`. Das komplette Bot-System liegt in klar abgegrenzten Funktionen
(`addBot`, `removeBot`, `scheduleBotQuizAnswers`, `scheduleBotRankMove`, …) und lässt sich
unabhängig vom restlichen Code erweitern (weitere Stufen, eigene "Persönlichkeiten",
bessere KI, perspektivisch auch durch echte Online-Spieler ersetzen).

## 7. Wie der Party-Modus technisch funktioniert

- `server.js` hält pro Raum (`rooms`-Map) den kompletten Spielzustand serverseitig vor
  (Spieler, Teams, Rundenplan, Punktestände, aktueller Rundenzustand). Der Server ist die
  einzige Quelle der Wahrheit – Clients senden nur Aktionen (`quizAnswer`, `rankPlace`, …)
  und bekommen den neuen Zustand als Broadcast zurück.
- **Wissenstest:** Da im Party-Modus jeder Spieler ein eigenes Gerät hat, muss die Antwort
  niemand mehr verbergen – alle beantworten dieselbe Frage gleichzeitig auf ihrem eigenen
  Bildschirm; nach Ablauf der Zeit oder wenn alle geantwortet haben, wird ausgewertet.
- **Einordnen / Mehr oder Weniger:** Die Werte sind serverseitig bekannt, werden aber nie
  ungefragt an die Clients gesendet – bei "Einordnen" werden sie erst nach Rundenende
  aufgedeckt, bei "Mehr oder Weniger" direkt nach jedem einzelnen Zug (`rankAttempt`).
  Teams sind reihum an der Zug (`turnOrder`/`turnPointer`), jedes Team hat 3 Leben; bei 0
  Leben wird das Team für den Rest der Runde übersprungen. Endet die Runde, gewinnt das
  Team mit den meisten korrekt platzierten Elementen.
- Die drei Spielmodi teilen sich dieselbe Rundensteuerung (`startNextRound()` /
  `finishRoundEngine()`), sodass sich neue Modi später einfach ergänzen lassen, ohne die
  bestehende Logik zu verändern (siehe Punkt 15 der Anforderung: "knowledgeQuiz",
  "orderingGame", "higherLowerGame" sind bereits als klar getrennte, modulare Engines
  aufgebaut).

## 8. Bekannte Grenzen dieser ersten Version

- Verliert ein Gerät während einer laufenden Runde die Verbindung, wird es nicht automatisch
  wieder in die laufende Runde eingebunden (Reconnect erst wieder ab dem nächsten Raumzustand
  möglich). Für eine spätere Version ließe sich das ergänzen, ohne die Architektur zu ändern.
- Die Zahlenwerte in `partyDatasets.json` (Einwohner, Streams, Gehälter, Kaderwerte, …) sind
  ungefähre, zur Illustration gewählte Werte und können jederzeit angepasst werden.
