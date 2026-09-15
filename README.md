# WISSENSDUELL PARTY

Erweiterung des bestehenden Wissensduell-Spiels um einen echten **WLAN-/Internet-
Mehrgeräte-Modus** ("Party-Raum") sowie einen Solo-Modus.

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
- Der Solo-Wissenstest funktioniert weiterhin ganz ohne Verbindung zu anderen Geräten;
  Solo-Party und der Party-Raum nutzen den Server aktiv.

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
public/index.html       Die komplette Client-Oberfläche (Solo, Solo-Party, Party)
test/                   Ein automatisierter End-to-End-Test (optional, `npm test`)
```

## 3. Neue Fragen / Kategorien hinzufügen

- **Wissenstest-Fragen:** in `shared/quizQuestions.json` ein neues Objekt ergänzen
  (`q`, `a` [4 Antworten], `c` [Index der richtigen Antwort], `cat`, `d` [Schwierigkeit 1=leicht, 2=normal, 3=schwer, 4=extrem schwer], optional `e` [Erklärung]).
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
- Solo-Wissenstest (klassischer, eigenständiger Modus – `public/index.html`,
  nicht Party): Rundenbonus (+150) gibt es seit dieser Version nur noch bei
  einer perfekten Runde (alle Fragen richtig), siehe `endSoloRound()`. Nach
  jeder Frage bleibt die "Wusstest du...?"-Erklärung außerdem so lange offen
  stehen, bis man selbst auf "WEITER" tippt – kein automatisches
  Weiterspringen mehr, siehe `handleSoloAnswer()`/`soloNextQuestion()`.

## 5. Ränge ändern

Weiterhin im Client in `public/index.html`, Array `RANKS` (gilt für Solo-
Profile; der Party-Modus verwendet eigene, sitzungsbasierte
Team-Punktestände ohne Rangsystem).

## 6. Bots im Party-Raum

### Solo-Party

Im Hauptmenü unter „SOLO" gibt es neben dem klassischen Wissenstest jetzt auch
„PARTY-MODUS": eine Party-Runde ganz allein, ohne Mitspieler und ohne Bots.
Technisch ist das schlicht eine Party mit genau einem Teilnehmer – die Person
konfiguriert Rundenanzahl und Zufallsrunde/Spiel erstellen wie ein Host, der
Lobby-Wartebildschirm mit Raum-Code entfällt aber, da niemand beitreten muss.
Es kommt dieselbe Server-Logik zum Einsatz wie im WLAN-Party-Modus (Wissenstest,
Einordnen, Mehr oder Weniger) – Punktestände sind auch hier sitzungsbasiert und
nicht mit dem persönlichen Solo-Rang verknüpft. Die Anzeige ist bewusst frei von
jeglicher Gegner-/Bot-Sprache gehalten (kein "Team", keine Medaillen-Rangliste) –
Rundenauswertung und Spielende zeigen stattdessen nur den eigenen Punktestand,
im Sinne von "wie weit schaffst du es".

Der frühere Menüpunkt "Lokaler Multiplayer" (Pass & Play auf einem gemeinsamen
Gerät) wurde aus dem Hauptmenü entfernt, da der Party-Raum diese Funktion nun
auch online/im selben WLAN abdeckt. Der zugehörige Code ist weiterhin in
`public/index.html` vorhanden, aber über die Oberfläche nicht mehr erreichbar.

### Eigene Spielrunde zusammenstellen ("Spiel erstellen")

Bei "Spiel erstellen" (Party-Host wie auch Solo-Party) gibt es jetzt einen
übersichtlichen Baukasten statt einer langen Dropdown-Liste: Rundenanzahl frei
zwischen 5, 10, 15 oder 20 wählbar, danach pro Runde per Suche zuerst den Spielmodus
(Wissenstest/Einordnen/Mehr oder Weniger) und – außer bei Wissenstest – die
passende Kategorie auswählen, zur Liste "MEINE SPIELRUNDE" hinzufügen, bei
Bedarf über ✏️/🗑️ bearbeiten oder entfernen. Erst wenn genau so viele Runden
zusammengestellt sind wie die gewählte Rundenanzahl, lässt sich die
Zusammenstellung mit "EIGENE SPIELRUNDE ÜBERNEHMEN" bestätigen. Die
Kategorien selbst kommen unverändert aus `shared/partyDatasets.json` und
`shared/quizQuestions.json` – für diesen Baukasten wurden keine neuen
Kategorien erfunden, nur eine neue Auswahloberfläche dafür gebaut
(`openRoundBuilder()`/`renderRoundBuilder()` in `public/index.html`).

### Kategorien je Runde und Feingliederung nach Liga/Genre

Jede Runde bei Einordnen/Mehr oder Weniger umfasst bewusst weiterhin nur rund
8 Elemente (bei "Einwohner" 10) – das hält eine Runde überschaubar lang. Statt
eine Kategorie größer zu machen, gibt es stattdessen inzwischen mehrere
eigenständige Kategorien zum selben Thema, die im Round-Builder einzeln
auswählbar sind, z. B.:

- **Fußball (Kaderwert):** allgemein gemischt, plus getrennt nach Bundesliga,
  2. Bundesliga, La Liga und Premier League
- **Musik (Streams):** allgemein gemischt, plus getrennt nach Rock, HipHop
  und Klassik
- **Serien/Filme:** zusätzlich zur allgemeinen Serien- und Filme-Kategorie
  gibt es jetzt auch Anime (Episodenanzahl), Manga (verkaufte Bände) und
  Animationsfilme (Einspielergebnis)

Aktuell (Stand dieser Version): 19 Einordnen-, 15 Chronologie- und 21
Mehr-oder-Weniger-
Kategorien, darunter auch "Trash-TV Deutschland" (Anzahl der Staffeln von
Dschungelcamp, Bachelor, Big Brother, Bauer sucht Frau & Co. – Stand 2026, da
sich Staffelzahlen bei jährlich laufenden Formaten schnell ändern). Zusätzlich
gibt es je eine eigene "Sieger nach Staffel"-Kategorie für Kampf der
Realitystars, Das Sommerhaus der Stars, LOL – Last One Laughing und Ich bin
ein Star (Dschungelcamp): Dort wird nicht die Staffelanzahl, sondern die
tatsächlichen Sieger:innen chronologisch (niedrigste Staffelnummer zuerst)
einsortiert. Bei Formaten mit bis zu 10 Staffeln (KDRS, Sommerhaus, LOL) sind
das alle Staffeln von Anfang an; bei längeren Formaten wie Dschungelcamp (19
Staffeln) die letzten 10 bis zur aktuellsten Staffel, im Kategorienamen als
Spanne ausgewiesen (z. B. "Staffel 10-19") – so kommt der Pool je Runde
(max. 10 Elemente) nie an seine Grenze, und es bleiben die aktuellsten,
bekanntesten Staffeln erhalten. Für "Der Bachelor" gibt es bewusst noch keine
solche Kategorie: Eine Staffel hatte gar keine Siegerin, zwei weitere hatten
gleich zwei Bachelors mit je zwei Gewinnerinnen gleichzeitig – das lässt sich
nicht sauber in "ein Sieger pro Staffel" packen.

Außerdem gibt es einen fünften, eigenständigen Spielmodus **"Chronologie"**
(eigenes `kind: "chronologyGame"`, technisch dieselbe Engine wie Einordnen,
aber im Round-Builder als klar getrennter Modus mit eigenen 15 Kategorien
auswählbar) für bekannte Film-/
Serien-/Spiele-Universen (Marvel Cinematic Universe, X-Men, Star Wars, Star
Trek, The Walking Dead Universe, Mittelerde/Der Herr der Ringe, Harry Potter,
The Conjuring Universe, Assassin's Creed, Uncharted, Pokémon-Anime,
Pokémon-Hauptspiele, Resident Evil sowie Call of Duty gleich zweimal – einmal
nach Erscheinungsjahr, einmal nach Handlungsjahr, da beides bei dieser Reihe
bewusst stark auseinanderfällt). Sortiert wird nach dem Jahr, in dem die
Handlung spielt (nicht nach Erscheinungsjahr) – bei Reihen mit klarem
Zeitsprung wie Star Wars oder Assassin's Creed ist das die eigentlich
interessante Trivia-Frage. Bei Titeln, die am selben Tag/Jahr spielen (z. B.
die ersten vier Resident-Evil-Spiele, alle 1998), wurden minimal
unterschiedliche Dezimalwerte vergeben, um die tatsächliche Reihenfolge
weiterhin eindeutig abzufragen. Bei The Walking Dead Universe ist die reale
Chronologie durch ständige staffelweise Überschneidungen zwischen den
Serien so verschachtelt, dass keine seriöse Jahresangabe je Serie möglich
ist – dort wird stattdessen eine vereinfachte, in Fan-Guides gängige
empfohlene Reihenfolge verwendet (Positionsnummer statt Jahr).

Außerdem drei reine Größenvergleich-Kategorien bei Einordnen: Häuser (nach
Wohnfläche, von Antilia bis zum Sultanspalast von Brunei), Dinosaurier (nach
Länge) und ein bunter "Größenvergleich" quer durch komplett unterschiedliche
Objekte – von der Kakerlake (5 cm) über Pikachu, SpongeBob und Yoda bis zum
fiktiven Todesstern aus Star Wars (120 km Durchmesser).

### Größere Datenpools mit echter Zufallsauswahl je Runde

Kategorien können jetzt deutlich mehr Elemente enthalten, als tatsächlich in
einer einzelnen Runde vorkommen (weiterhin max. 10 je Runde, wie bisher).
`startRankingRound()` in `server.js` zieht bei mehr als 10 Elementen jedes
Mal eine neue Zufallsauswahl aus dem vollen Pool – bei "Mehr oder Weniger"
bleibt dabei das Referenzelement (`seedId`) garantiert immer Teil der
Auswahl. Bislang nutzen "Häuser" (16 Elemente), "Dinosaurier" (16) und
"Größenvergleich" (13) diesen größeren Pool; alle anderen, bereits
bestehenden Kategorien haben weiterhin ihre ursprüngliche Elementanzahl
(meist genau 8–10) und zeigen daher bei jeder Runde dieselben Elemente wie
bisher – ließe sich aber genauso leicht um weitere Elemente ergänzen.

### Chronologie zeigt jetzt bewusst ALLE Einträge, kein Zehner-Limit

Bei "Chronologie" wird nie mehr zufällig gekürzt – jede Runde zeigt wirklich
jedes Element der Kategorie (Ausnahme von der sonst geltenden 10er-Grenze
bei Einordnen/Mehr-oder-Weniger, siehe oben). Bei mehr als 10 Elementen
scrollt der Spielbereich einfach länger, das Layout hat dafür keine feste
Höhenbegrenzung. "Harry-Potter-Universum" ist jetzt mit allen 11 Filmen
vollständig (die bisher fehlenden "Kammer des Schreckens" und "Heiligtümer
des Todes 1" wurden ergänzt).

Die übrigen 14 Chronologie-Kategorien haben weiterhin ihre ursprüngliche,
kuratierte Auswahl (meist 6-10 Einträge) – sie zeigen also bereits alles,
was aktuell hinterlegt ist, das ist nur (noch) nicht die vollständige Liste
jedes Films/Spiels der jeweiligen Reihe bis Stand Juni 2026. Eine wirklich
vollständige, verifizierte Liste je Reihe (z. B. MCU: über 35 Filme mit
teils umstrittener interner Chronologie) ist ein größeres Rechercheprojekt
für sich und wurde hier bewusst noch nicht in einem Rutsch für alle 14
gemacht, um keine falschen Daten unter Zeitdruck einzubauen.

Weitere Sieger-/Chronologie-Kategorien lassen sich genauso leicht ergänzen –
einfach einen neuen Eintrag in `shared/partyDatasets.json` anlegen, der
Round-Builder und die Zufallsrunde nehmen ihn automatisch auf.

Bots gibt es **ausschließlich im normalen Party-Raum** – der Solo-Modus (Wissenstest wie
Solo-Party) bleibt komplett bot-frei und unverändert.

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

### Neuer Spielmodus: „Stadt Land Fluss"

Ein sechster, eigenständiger Spielmodus (`kind: "stadtLandFluss"`) – klassisches
Papier-Stift-Prinzip, nur digital: Ein zufälliger Buchstabe wird gezogen
(Q, X, Y bewusst ausgelassen, da zu schwer für ein flüssiges Spiel), alle
Spieler schreiben gleichzeitig 80 Sekunden lang Wörter zu den gewählten
Kategorien, die mit diesem Buchstaben beginnen.

**Original**: die sieben klassischen Kategorien (Stadt, Land, Fluss, Name,
Tier, Beruf, Pflanze) – direkt im Round-Builder auswählbar wie jede andere
Kategorie auch.

**Eigene Kategorien**: Im Round-Builder gibt es bei „Stadt Land Fluss" statt
der normalen Kategorie-Suche einen eigenen Baukasten – 13 vorgeschlagene
Kategorien zum Anklicken (u. a. Farbe, Automarke, Filmtitel, Promi) plus ein
Textfeld, um beliebige eigene Kategorien einzutippen (bis zu 8 insgesamt).
Diese individuelle Auswahl wird direkt als eigene Rundendefinition zum Server
geschickt (`setSlfCustomRoundDef`) und muss nicht erst in
`shared/partyDatasets.json` vordefiniert sein.

**Wertung**: Nach Ablauf der Schreibzeit werden alle Antworten aller Spieler
offengelegt – eindeutige gültige Antwort (richtiger Anfangsbuchstabe) = 20
Punkte, mehrfach vorhandene = 10 Punkte, leer/falscher Buchstabe = 0 Punkte.
Punkte werden pro Spieler vergeben (nicht pro Team), auch bei größeren
Teams – die Teampunkte am Rundenende sind die Summe der Mitgliederpunkte.

**Anfechten**: 30 Sekunden lang kann jede Antwort außer der eigenen von
anderen Spielern angefochten werden (⚑-Button). Danach stimmen alle übrigen
Spieler außer dem/der Angefochtenen "Gültig"/"Ungültig" ab; bei Mehrheit für
"Ungültig" fällt die Antwort auf 0 Punkte, bei Gleichstand bleibt sie gültig.
Erst danach wird final gewertet.

**Bots**: Beteiligen sich an Stadt-Land-Fluss bewusst **nicht aktiv** am
Schreiben – ein verlässliches Wörterbuch für alle Buchstaben-Kategorie-
Kombinationen wäre ein eigenes, sehr großes Projekt für sich. Mit Bots im
Raum tragen diese für Stadt-Land-Fluss-Runden schlicht 0 Punkte bei.

**Zentral anpassbar** in `server.js`: `SLF_DEFAULT_CATEGORIES`, `SLF_LETTERS`,
`SLF_ANSWER_MS`, `SLF_CHALLENGE_MS`, `SLF_VOTE_MS`.

### Sprachen

Sprachumschalter (7 Sprachen: Deutsch, Englisch, Japanisch, Chinesisch,
Französisch, Italienisch, Spanisch) oben im Hauptmenü, per `localStorage`
gemerkt. Übersetzt sind Menüs, Buttons und die zentralen Bildschirme
(Hauptmenü, Solo-Auswahl, Party-Einstieg, Warteraum, Rundenübersicht,
Rundenauswertung, Spielende). Übersetzungen liegen im `I18N`-Objekt in
`public/index.html`, abgerufen über `t('schlüssel')`.

Da die eigentlichen **Inhalte** (545 Wissensfragen, Trash-TV-/Bundesliga-
Kategorien) sehr Deutschland-spezifisch sind, werden diese bei anderen
Sprachen nicht übersetzt, sondern schlicht ausgeblendet: Der Wissenstest ist
im Solo-Menü gesperrt, solange keine deutsche Sprache gewählt ist; im
Party-Raum verschwinden Wissenstest sowie die Kategorien "Trash-TV
Deutschland", "Kampf der Realitystars", "Sommerhaus der Stars", "LOL",
"Dschungelcamp", "Bundesliga" und "2. Bundesliga" automatisch aus Zufallsrunde
und Round-Builder, sobald der Host eine andere Sprache als Deutsch wählt
(steuerbar über `germanOnly: true` je Kategorie in `shared/partyDatasets.json`
bzw. für den Wissenstest fest in `server.js`). International verständliche
Kategorien (Flaggen, Tiere, Länder, Berge, Fußball-Weltmeister, La Liga,
Premier League, Musik, Filme, Olympia usw.) bleiben in jeder Sprache
verfügbar – ihre Inhalte (Ländernamen, Titel) stehen aktuell aber weiterhin
auf Deutsch, da eine vollständige Übersetzung aller Kategorie-Inhalte ein
deutlich größerer, separater Schritt wäre.

Die Sprache ist eine **Raum-Einstellung** (vom Host beim Erstellen gewählt,
im Warteraum änderbar), nicht pro Spieler – alle Teilnehmer eines Raums
sehen dieselben verfügbaren Kategorien. Bereits ausgewählte "Spiel
erstellen"-Runden, die durch einen Sprachwechsel ungültig werden, werden
automatisch auf "noch nicht gewählt" zurückgesetzt statt zu crashen.

### Neuer Spielmodus: „Bild erraten"

Ein viertes Rundenformat (`kind: "guessPicture"`) neben Wissenstest, Einordnen
und Mehr oder Weniger: Ein Bild bzw. Emoji wird über 12 Sekunden hinweg in
4 Stufen (3 Sekunden je Stufe) zunehmend schärfer/deutlicher. Punktestufen
`[5, 3, 2, 1]` – je früher richtig geraten wird, desto mehr Punkte. Alle
Spieler können jederzeit per Freitext raten; wer zuerst richtig liegt,
bekommt die Punkte für dieses Bild, danach geht's zum nächsten. Tippfehler
werden toleriert (kleine Levenshtein-Distanz je nach Wortlänge, sowie
alternative Schreibweisen über das Feld `alt` je Element).

**Bilder:** Aktuell mit zwei Kategorien befüllt, die ohne echte Fotos
auskommen (Flaggen: 28 Länder, Tiere: 27 – jeweils per Emoji, keine
Bildrechte nötig; ein Spielpool je Runde zieht daraus zufällig 10).
Zwei Kategorien mit echten Fotos sind als Nächstes geplant, aber noch nicht
befüllt – "Promis/Trash-TV-Stars" und "Autos" (konkrete Marken/Modelle,
dafür reichen Emoji nicht, da es keine markenspezifischen Auto-Emoji gibt
und Logos ohnehin geschützt sind). Für beide werden reale Bilddateien mit
Nutzungsrecht benötigt (Foto + der Name/das Modell, der/das als Lösung
gelten soll, für jedes Bild).
Neue Kategorien einfach in `shared/partyDatasets.json` unter
`"guessPicture"` ergänzen; für Foto-Kategorien `promptType: "image"` und
`promptValue` als Bildpfad (z. B. `/images/dateiname.jpg`, Datei dann unter
`public/images/` ablegen) statt eines Emoji verwenden.

**Zentral anpassbar** in `server.js`: `GUESS_TIER_MS` (Dauer je Stufe) und
`GUESS_TIERS` (Punktewerte je Stufe).

- `server.js` hält pro Raum (`rooms`-Map) den kompletten Spielzustand serverseitig vor
  (Spieler, Teams, Rundenplan, Punktestände, aktueller Rundenzustand). Der Server ist die
  einzige Quelle der Wahrheit – Clients senden nur Aktionen (`quizAnswer`, `rankPlace`, …)
  und bekommen den neuen Zustand als Broadcast zurück.
- **Wissenstest:** Da im Party-Modus jeder Spieler ein eigenes Gerät hat, muss die Antwort
  niemand mehr verbergen – alle beantworten dieselbe Frage gleichzeitig auf ihrem eigenen
  Bildschirm; nach Ablauf der Zeit oder wenn alle geantwortet haben, wird ausgewertet.
- **Einordnen:** Alle Elemente liegen von Anfang an offen sichtbar im Pool (nur ihr
  Wert bleibt verborgen). Das Team am Zug wählt frei, welches Element es versucht,
  und an welcher Position. Bei einem Fehlversuch bleibt das Element weiterhin sichtbar
  im Pool – das nächste Team kann es (oder ein anderes) probieren. Aufgedeckt werden
  die Werte erst in der Auflösung am Rundenende.
- **Mehr oder Weniger:** Weiterhin wird pro Zug ein verdecktes Element gezogen, dessen
  Wert direkt nach der Entscheidung aufgedeckt wird (`rankAttempt`). Bei einem
  Fehlversuch wird das Element sofort an seiner nun bekannten, korrekten Stelle
  einsortiert (damit niemand von einem bereits verratenen Wert profitiert) – das
  nächste Team zieht dafür ein neues, noch unbekanntes Element.
  Teams sind reihum an der Zug (`turnOrder`/`turnPointer`), jedes Team hat 3 Leben; bei 0
  Leben wird das Team für den Rest der Runde übersprungen. Endet die Runde, gewinnt das
  Team mit den meisten korrekt platzierten Elementen.
- Die drei Spielmodi teilen sich dieselbe Rundensteuerung (`startNextRound()` /
  `finishRoundEngine()`), sodass sich neue Modi später einfach ergänzen lassen, ohne die
  bestehende Logik zu verändern (siehe Punkt 15 der Anforderung: "knowledgeQuiz",
  "orderingGame", "higherLowerGame" sind bereits als klar getrennte, modulare Engines
  aufgebaut).

## 7b. Benutzerkonten (Online-Profile)

Im Hauptmenü gibt es jetzt "Anmelden" (Benutzername + Passwort). Wer sich
registriert/anmeldet, spielt den **Solo-Wissenstest** automatisch mit einem
serverseitig gespeicherten Konto statt mit einem lokalen Browser-Profil –
Punktestand/Rang folgen damit über Geräte und Browser hinweg dem Account.
Ohne Anmeldung funktioniert Solo weiterhin exakt wie bisher, komplett lokal.

**Sicherheit:** Passwörter werden nie im Klartext gespeichert, sondern mit
`crypto.scrypt` (Node-Bordmittel) + zufälligem Salt pro Nutzer gehasht;
Logins verwenden einen zeitkonstanten Vergleich (`crypto.timingSafeEqual`)
gegen Timing-Angriffe. Falsche Logins zeigen bewusst dieselbe Fehlermeldung,
egal ob der Nutzername existiert oder das Passwort falsch war (kein
Ausspähen registrierter Namen).

**Speicherung:** Als JSON-Datei unter `data/` (wird von Git ignoriert, landet
also nie im Repository). Wichtiger Hinweis wie schon beim Hosting erwähnt:
Auf Render-Gratis-Tier ist die Festplatte nicht garantiert dauerhaft – bei
einem Neustart des Dienstes können gespeicherte Konten verloren gehen. Für
echte Dauerhaftigkeit bräuchte es einen Plan mit persistenter Festplatte
oder eine externe Datenbank.

**Technisch:** Vier schlanke HTTP-Endpunkte neben dem WebSocket-Server:
`POST /api/register`, `/api/login`, `/api/session` (Auto-Login beim erneuten
Öffnen der Seite über einen in `localStorage` gemerkten Token), `/api/logout`
und `/api/save-stats` (Punktestand wird am Rundenende synchronisiert, nicht
nach jeder einzelnen Frage). Die komplette Logik liegt in `server.js` im
Abschnitt "Benutzerkonten".

**Noch offen:** Profilbilder – vorbereitet (`avatar`-Feld existiert bereits
in jedem Konto), aber noch nicht mit Auswahloberfläche, da erst die
Charakter-Bilder benötigt werden.

### Bugfix: Platzieren-Buttons blieben bei "Alle gegen alle" unsichtbar

Wenn der Host nie manuell Teams einstellte (Standardfall bei "Alle gegen
alle", also praktisch immer bei Solo-Party und oft auch im normalen
Party-Raum), bekam der Client nach dem Start nie ein Update mit der
tatsächlich zugewiesenen Team-ID je Spieler. Die Oberfläche dachte deshalb
fälschlich, man sei nie am Zug, und zeigte in Einordnen, Chronologie und
Mehr-oder-Weniger keinerlei "Hier einordnen"-Buttons an – das Spiel wirkte
komplett eingefroren, obwohl serverseitig alles korrekt funktionierte.
Behoben durch einen zusätzlichen `roomUpdate`-Broadcast direkt nach der
Team-Zuweisung in `startGame`, noch bevor die erste Runde beginnt.

## 8. Bekannte Grenzen dieser ersten Version

- Verliert ein Gerät während einer laufenden Runde die Verbindung, wird es nicht automatisch
  wieder in die laufende Runde eingebunden (Reconnect erst wieder ab dem nächsten Raumzustand
  möglich). Für eine spätere Version ließe sich das ergänzen, ohne die Architektur zu ändern.
- Die Zahlenwerte in `partyDatasets.json` (Einwohner, Streams, Gehälter, Kaderwerte, …) sind
  ungefähre, zur Illustration gewählte Werte und können jederzeit angepasst werden.
