/**
 * WISSENSDUELL PARTY – Server
 * ---------------------------------------------------------------------------
 * Kleiner Node.js-Server (http + ws), den der Host im eigenen WLAN startet.
 * Andere Geräte im selben Netzwerk verbinden sich per Browser mit der
 * angezeigten Adresse (z.B. http://192.168.1.23:3000).
 *
 * Verantwortlich für:
 *  - Räume (Lobby, Beitreten per Code)
 *  - Rundenkonfiguration (Anzahl, Zufallsrunde / Spiel erstellen)
 *  - Teams (Alle gegen alle, 2v2, 3v3, 2v2v2)
 *  - Punktesysteme (Runde / Steigend / Punkteabzug)
 *  - Die vier Spiel-Engines: knowledgeQuiz, orderingGame, chronologyGame, higherLowerGame
 *
 * Alle Inhalte (Fragen, Einordnen-/Mehr-oder-Weniger-Datensätze) liegen
 * getrennt in ./shared/*.json und werden hier nur eingelesen – neue
 * Kategorien lassen sich dort ergänzen, ohne den Server-Code anzufassen.
 * ---------------------------------------------------------------------------
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { WebSocketServer } = require("./lib/miniws");

const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------------ */
/* Datenbasis laden (zentral, getrennt vom Spielcode)                        */
/* ------------------------------------------------------------------------ */
const QUIZ_QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, "shared/quizQuestions.json"), "utf8"));
const DATASETS = JSON.parse(fs.readFileSync(path.join(__dirname, "shared/partyDatasets.json"), "utf8"));

// Konfigurierbarer Punktabzug für Punktesystem 3 ("Punkteabzug").
// Hier zentral anpassbar, ohne die restliche Logik zu berühren.
const MISTAKE_PENALTY = 1;

// Feste Zeitlimits im Party-Modus (Party-Runden sind session-basiert,
// unabhängig vom persönlichen Solo-/Multiplayer-Rang).
const QUIZ_TIME_LIMIT = 20; // Sekunden pro Frage

/* ------------------------------------------------------------------------ */
/* BOTS (ausschließlich im Party-Raum, sauber getrennt vom restlichen Spiel) */
/* ------------------------------------------------------------------------ */
// Zentrale Definition aller Bot-Schwierigkeitsstufen. Hier lassen sich später
// problemlos weitere Stufen, Werte oder ganze Bot-Persönlichkeiten ergänzen,
// ohne den Rest des Codes anzufassen.
const BOT_TIERS = {
  dumm:            { label: "Dumm",            prob: 0.40, quizMinPct: 0.55, quizMaxPct: 0.98, rankDelayMin: 2200, rankDelayMax: 4200 },
  einsteiger:      { label: "Einsteiger",       prob: 0.55, quizMinPct: 0.45, quizMaxPct: 0.9,  rankDelayMin: 1800, rankDelayMax: 3400 },
  schlau:          { label: "Schlau",           prob: 0.70, quizMinPct: 0.3,  quizMaxPct: 0.75, rankDelayMin: 1400, rankDelayMax: 2600 },
  doktor:          { label: "Doktor",           prob: 0.85, quizMinPct: 0.2,  quizMaxPct: 0.6,  rankDelayMin: 900,  rankDelayMax: 1900 },
  wissenschaftler: { label: "Wissenschaftler",  prob: 0.95, quizMinPct: 0.1,  quizMaxPct: 0.45, rankDelayMin: 600,  rankDelayMax: 1300 }
};
const BOT_TIER_ORDER = ["dumm", "einsteiger", "schlau", "doktor", "wissenschaftler"];
const BOT_NAME_POOL = ["Alex", "Max", "Lisa", "Tom", "Anna", "Chris", "Ben", "Leon", "Sophie", "Daniel"];
const DEFAULT_BOT_TIER = "schlau";
const MAX_PARTICIPANTS = 6;
const SUPPORTED_LANGS = ["de", "en", "ja", "zh", "fr", "it", "es"];

// Stadt-Land-Fluss-Konstanten (hier oben, da schon beim Aufbau des
// Rundenpools benötigt – siehe buildRoundDefPool()/slfBuildRoundDef()).
const SLF_DEFAULT_CATEGORIES = ["Stadt", "Land", "Fluss", "Name", "Tier", "Beruf", "Pflanze"];
const SLF_LETTERS = "ABCDEFGHIJKLMNOPRSTUVWZ".split(""); // Q, X, Y ausgelassen (zu schwer für flüssiges Spiel)
const SLF_ANSWER_MS = 80000;      // Zeit zum Schreiben
const SLF_CHALLENGE_MS = 30000;   // Zeit zum Anfechten nach der Auflösung
const SLF_VOTE_MS = 20000;        // Zeit zum Abstimmen über eine einzelne Anfechtung

function randRange(min, max) { return min + Math.random() * (max - min); }

function pickBotName(room) {
  const used = new Set(Array.from(room.players.values()).filter(p => p.isBot).map(p => p.name));
  const free = BOT_NAME_POOL.filter(n => !used.has(n));
  if (free.length > 0) return free[Math.floor(Math.random() * free.length)];
  // Falls alle Namen vergeben sind (mehr als 10 Bots wären ohnehin nie möglich, da max. 6 Teilnehmer)
  return "Bot" + Math.floor(Math.random() * 1000);
}

/* ------------------------------------------------------------------------ */
/* Verfügbare Rundentypen (modular, leicht erweiterbar – Punkt 15)           */
/* ------------------------------------------------------------------------ */
function buildRoundDefPool() {
  const pool = [{ id: "quiz", kind: "knowledgeQuiz", label: "Wissenstest", germanOnly: true }];
  pool.push(slfBuildRoundDef(null, false)); // "Stadt Land Fluss: Original"
  Object.entries(DATASETS.ordering).forEach(([key, ds]) => {
    pool.push({ id: "order_" + key, kind: "orderingGame", label: ds.label, datasetGroup: "ordering", datasetKey: key, germanOnly: !!ds.germanOnly });
  });
  Object.entries(DATASETS.chronology || {}).forEach(([key, ds]) => {
    pool.push({ id: "chrono_" + key, kind: "chronologyGame", label: ds.label, datasetGroup: "chronology", datasetKey: key, germanOnly: !!ds.germanOnly });
  });
  Object.entries(DATASETS.higherLower).forEach(([key, ds]) => {
    pool.push({ id: "hilo_" + key, kind: "higherLowerGame", label: ds.label, datasetGroup: "higherLower", datasetKey: key, germanOnly: !!ds.germanOnly });
  });
  Object.entries(DATASETS.guessPicture || {}).forEach(([key, ds]) => {
    pool.push({ id: "guess_" + key, kind: "guessPicture", label: ds.label, datasetGroup: "guessPicture", datasetKey: key, germanOnly: !!ds.germanOnly });
  });
  return pool;
}
const ROUND_DEF_POOL = buildRoundDefPool();
function findRoundDef(id) { return ROUND_DEF_POOL.find(r => r.id === id); }
function roundDefPoolForLanguage(language) {
  return language === "de" ? ROUND_DEF_POOL : ROUND_DEF_POOL.filter(r => !r.germanOnly);
}

/* ------------------------------------------------------------------------ */
/* Räume                                                                     */
/* ------------------------------------------------------------------------ */
const rooms = new Map(); // code -> room

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function createRoom(hostWs, hostName, language) {
  const code = makeRoomCode();
  const hostId = "pl_" + Math.random().toString(36).slice(2, 9);
  const room = {
    code,
    hostId,
    players: new Map(), // id -> {id,name,ws,teamId,connected}
    teamMode: "ffa",
    teams: new Map(), // teamId -> {id,name,memberIds:[],score:0}
    pointSystem: 1,
    roundCount: 5,
    roundMode: "random", // 'random' | 'custom'
    roundDefs: [],
    language: SUPPORTED_LANGS.includes(language) ? language : "de",
    currentRoundIndex: -1,
    phase: "lobby", // lobby | roundIntro | playing | roundResult | gameEnd
    runtime: null
  };
  rooms.set(code, room);
  addPlayer(room, hostWs, hostId, hostName);
  randomizeRoundDefs(room); // gleich passend zur Sprache vorbefüllen
  return room;
}

function addPlayer(room, ws, id, name) {
  room.players.set(id, { id, name: name.trim().slice(0, 20) || "Spieler", ws, teamId: null, connected: true, isBot: false, botTier: null });
  ws.playerId = id;
  ws.roomCode = room.code;
}

function addBot(room, tier) {
  const id = "bot_" + Math.random().toString(36).slice(2, 9);
  const name = pickBotName(room);
  const bot = { id, name, ws: null, teamId: null, connected: true, isBot: true, botTier: BOT_TIERS[tier] ? tier : DEFAULT_BOT_TIER };
  room.players.set(id, bot);
  assignNewParticipantToSmallestTeam(room, bot);
  return bot;
}

function removeBot(room, botId) {
  const bot = room.players.get(botId);
  if (!bot || !bot.isBot) return;
  room.players.delete(botId);
  room.teams.forEach(t => { t.memberIds = t.memberIds.filter(id => id !== botId); });
  if (room.teamMode === "ffa") rebuildFfaTeams(room);
}

function assignNewParticipantToSmallestTeam(room, participant) {
  if (room.teamMode === "ffa") { rebuildFfaTeams(room); return; }
  const teams = Array.from(room.teams.values());
  if (teams.length === 0) return;
  teams.sort((a, b) => a.memberIds.length - b.memberIds.length);
  const target = teams[0];
  target.memberIds.push(participant.id);
  participant.teamId = target.id;
}


function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch (e) { /* ignore */ }
  }
}
function broadcast(room, msg) {
  room.players.forEach(p => send(p.ws, msg));
}

/* ------------------------------------------------------------------------ */
/* Team-Hilfsfunktionen                                                      */
/* ------------------------------------------------------------------------ */
function rebuildFfaTeams(room) {
  room.teams.clear();
  room.players.forEach(p => {
    room.teams.set(p.id, { id: p.id, name: p.name, memberIds: [p.id], score: room.teams.get(p.id)?.score || 0 });
    p.teamId = p.id;
  });
}

function roomStateForClient(room) {
  return {
    type: "roomUpdate",
    code: room.code,
    hostId: room.hostId,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, teamId: p.teamId, connected: p.connected,
      isBot: !!p.isBot, botTier: p.botTier, botTierLabel: p.isBot ? (BOT_TIERS[p.botTier]?.label || p.botTier) : null
    })),
    teamMode: room.teamMode,
    teams: Array.from(room.teams.values()).map(t => ({ id: t.id, name: t.name, memberIds: t.memberIds, score: t.score })),
    pointSystem: room.pointSystem,
    roundCount: room.roundCount,
    roundMode: room.roundMode,
    roundDefs: room.roundDefs.map(r => r ? ({ id: r.id, kind: r.kind, label: r.label, categories: r.categories }) : null),
    availableRoundDefs: roundDefPoolForLanguage(room.language).map(r => ({ id: r.id, kind: r.kind, label: r.label })),
    language: room.language,
    botTierOptions: BOT_TIER_ORDER.map(key => ({ id: key, label: BOT_TIERS[key].label })),
    maxParticipants: MAX_PARTICIPANTS,
    phase: room.phase,
    currentRoundIndex: room.currentRoundIndex
  };
}
function pushRoomState(room) { broadcast(room, roomStateForClient(room)); }

/* ------------------------------------------------------------------------ */
/* Rundenauswahl                                                             */
/* ------------------------------------------------------------------------ */
function randomizeRoundDefs(room) {
  const availablePool = roundDefPoolForLanguage(room.language);
  const defs = [];
  for (let i = 0; i < room.roundCount; i++) {
    const def = availablePool[Math.floor(Math.random() * availablePool.length)];
    defs.push(def);
  }
  room.roundDefs = defs;
}

/* ------------------------------------------------------------------------ */
/* Punktesysteme                                                             */
/* ------------------------------------------------------------------------ */
function awardRoundPoints(room, roundNumber, winnerTeamIds) {
  const teams = Array.from(room.teams.values());
  if (room.pointSystem === 2) {
    winnerTeamIds.forEach(id => {
      const t = room.teams.get(id);
      if (t) t.score += roundNumber; // Steigend: Rundennummer = Punktwert
    });
  } else {
    // System 1 (Runde) und System 3 (Punkteabzug) vergeben Basis +1 je Sieg.
    winnerTeamIds.forEach(id => {
      const t = room.teams.get(id);
      if (t) t.score += 1;
    });
  }
  // Score darf nie unter 0 fallen (konsistent mit dem übrigen Spiel)
  teams.forEach(t => { t.score = Math.max(0, t.score); });
}
function applyMistakePenalty(room, teamId) {
  if (room.pointSystem !== 3) return;
  const t = room.teams.get(teamId);
  if (t) t.score = Math.max(0, t.score - MISTAKE_PENALTY);
}

/* ------------------------------------------------------------------------ */
/* RUNDE: knowledgeQuiz                                                      */
/* ------------------------------------------------------------------------ */
// Gewichtung der Schwierigkeitsgrade im Party-Wissenstest (1=leicht … 4=extrem
// schwer). Session-basiert, da der Party-Modus keinen persönlichen Rang je
// Spieler kennt. Hier zentral anpassbar.
const QUIZ_DIFFICULTY_WEIGHTS = [0.25, 0.35, 0.30, 0.10];

function weightedQuizDifficulty() {
  const r = Math.random();
  const w = QUIZ_DIFFICULTY_WEIGHTS;
  if (r < w[0]) return 1;
  if (r < w[0] + w[1]) return 2;
  if (r < w[0] + w[1] + w[2]) return 3;
  return 4;
}

function pickQuizQuestions(n) {
  const picks = [];
  const usedIdx = new Set();
  for (let i = 0; i < n; i++) {
    const diff = weightedQuizDifficulty();
    let pool = QUIZ_QUESTIONS.map((q, idx) => ({ ...q, idx })).filter(q => q.d === diff && !usedIdx.has(q.idx));
    if (pool.length === 0) pool = QUIZ_QUESTIONS.map((q, idx) => ({ ...q, idx })).filter(q => !usedIdx.has(q.idx));
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    usedIdx.add(chosen.idx);
    picks.push(chosen);
  }
  return picks;
}

function startQuizRound(room) {
  room.runtime = {
    kind: "knowledgeQuiz",
    questions: pickQuizQuestions(5),
    qIndex: 0,
    answers: new Map(), // playerId -> {selectedIndex, correct, delta}
    roundPointsByTeam: new Map(Array.from(room.teams.keys()).map(id => [id, 0])),
    timer: null
  };
  sendNextQuizQuestion(room);
}

function sendNextQuizQuestion(room) {
  const rt = room.runtime;
  const q = rt.questions[rt.qIndex];
  rt.answers.clear();
  rt.questionDeadline = Date.now() + QUIZ_TIME_LIMIT * 1000;
  broadcast(room, {
    type: "quizQuestion",
    index: rt.qIndex,
    total: rt.questions.length,
    q: q.q, a: q.a, cat: q.cat,
    timeLimit: QUIZ_TIME_LIMIT
  });
  clearTimeout(rt.timer);
  rt.timer = setTimeout(() => resolveQuizQuestion(room), QUIZ_TIME_LIMIT * 1000 + 200);
  scheduleBotQuizAnswers(room);
}

// Lässt jeden Bot im Raum die aktuelle Frage nach einer schwierigkeitsabhängigen
// Verzögerung mit einer schwierigkeitsabhängigen Trefferquote beantworten.
function scheduleBotQuizAnswers(room) {
  const rt = room.runtime;
  const qIndexAtSchedule = rt.qIndex;
  room.players.forEach(p => {
    if (!p.isBot) return;
    const tier = BOT_TIERS[p.botTier] || BOT_TIERS[DEFAULT_BOT_TIER];
    const delayMs = Math.max(400, randRange(tier.quizMinPct, tier.quizMaxPct) * QUIZ_TIME_LIMIT * 1000);
    setTimeout(() => {
      if (!room.runtime || room.runtime !== rt || rt.qIndex !== qIndexAtSchedule) return;
      const q = rt.questions[rt.qIndex];
      const correct = Math.random() < tier.prob;
      let selectedIndex = q.c;
      if (!correct) {
        const wrongOptions = [0, 1, 2, 3].filter(i => i !== q.c);
        selectedIndex = wrongOptions[Math.floor(Math.random() * wrongOptions.length)];
      }
      handleQuizAnswer(room, p.id, selectedIndex);
    }, delayMs);
  });
}

function handleQuizAnswer(room, playerId, selectedIndex) {
  const rt = room.runtime;
  if (!rt || rt.kind !== "knowledgeQuiz") return;
  if (rt.answers.has(playerId)) return;
  const q = rt.questions[rt.qIndex];
  const correct = selectedIndex === q.c;
  const delta = correct ? 100 : -150;
  rt.answers.set(playerId, { selectedIndex, correct, delta });

  const player = room.players.get(playerId);
  if (player && player.teamId) {
    rt.roundPointsByTeam.set(player.teamId, (rt.roundPointsByTeam.get(player.teamId) || 0) + delta);
    if (!correct) applyMistakePenalty(room, player.teamId);
  }

  const allAnswered = Array.from(room.players.keys()).every(pid => rt.answers.has(pid));
  if (allAnswered) {
    clearTimeout(rt.timer);
    resolveQuizQuestion(room);
  }
}

function resolveQuizQuestion(room) {
  const rt = room.runtime;
  if (!rt || rt.resolved) return;
  const q = rt.questions[rt.qIndex];
  const results = Array.from(room.players.values()).map(p => {
    const ans = rt.answers.get(p.id);
    return { playerId: p.id, name: p.name, selectedIndex: ans ? ans.selectedIndex : null, correct: ans ? ans.correct : false, delta: ans ? ans.delta : -150 };
  });
  // Spieler, die nicht geantwortet haben, gelten als falsch (Zeit abgelaufen)
  results.forEach(r => {
    if (!rt.answers.has(r.playerId)) {
      const player = room.players.get(r.playerId);
      if (player && player.teamId) {
        rt.roundPointsByTeam.set(player.teamId, (rt.roundPointsByTeam.get(player.teamId) || 0) - 150);
        applyMistakePenalty(room, player.teamId);
      }
    }
  });

  broadcast(room, {
    type: "quizReveal",
    correctIndex: q.c,
    explanation: q.e || null,
    results
  });

  setTimeout(() => {
    rt.qIndex++;
    if (rt.qIndex >= rt.questions.length) {
      finishRoundEngine(room, rt.roundPointsByTeam);
    } else {
      sendNextQuizQuestion(room);
    }
  }, 3200);
}

/* ------------------------------------------------------------------------ */
/* RUNDE: orderingGame & higherLowerGame (gemeinsame Engine)                 */
/* Unterschied: higherLower startet mit einem bekannten Referenzelement und  */
/* deckt Werte direkt nach jedem Zug auf; ordering deckt Werte erst am Ende  */
/* der Runde auf (Auflösung). Siehe Punkt 4-12 der Anforderung.             */
/* ------------------------------------------------------------------------ */
function startRankingRound(room, def) {
  const group = def.datasetGroup;
  const dsRaw = DATASETS[group][def.datasetKey];
  const revealOnTurn = group === "higherLower";
  // Einordnen (orderingGame): alle Elemente liegen von Anfang an offen sichtbar
  // im Pool, das aktive Team wählt selbst, welches Element es als Nächstes
  // versucht. Mehr oder Weniger (higherLowerGame): weiterhin ein zufällig
  // gezogenes Element pro Zug, dafür wird der Wert direkt aufgedeckt.
  const freeChoice = !revealOnTurn;

  // Manche Kategorien enthalten deutlich mehr als MAX_ROUND_ITEMS Elemente
  // (größerer, "echter" Datenpool). Damit eine Runde nicht ewig dauert, wird
  // daraus jedes Mal eine zufällige Auswahl gezogen – bei "Mehr oder Weniger"
  // bleibt das Referenzelement (seedId) dabei garantiert immer Teil der
  // Auswahl, egal wie die Zufallsauswahl sonst ausfällt.
  // Ausnahme: "Chronologie" soll bewusst IMMER die vollständige Liste zeigen
  // (z. B. wirklich jeder MCU-Film), auch wenn das mehr als 10 Elemente sind –
  // dafür ist das Spielfenster clientseitig scrollbar.
  const MAX_ROUND_ITEMS = 10;
  const allItems = dsRaw.items.map(it => ({ ...it }));
  let selected;
  if (def.kind === "chronologyGame" || allItems.length <= MAX_ROUND_ITEMS) {
    selected = allItems.sort(() => Math.random() - 0.5); // nur die Anzeige-Reihenfolge mischen, nichts weglassen
  } else if (revealOnTurn && dsRaw.seedId) {
    const seedItem = allItems.find(it => it.id === dsRaw.seedId);
    const rest = allItems.filter(it => it.id !== dsRaw.seedId).sort(() => Math.random() - 0.5).slice(0, MAX_ROUND_ITEMS - 1);
    selected = seedItem ? [seedItem, ...rest] : allItems.sort(() => Math.random() - 0.5).slice(0, MAX_ROUND_ITEMS);
  } else {
    selected = allItems.sort(() => Math.random() - 0.5).slice(0, MAX_ROUND_ITEMS);
  }

  let pool = selected;
  let placed = []; // aufsteigend nach Spielreihenfolge, in "order" sortiert (true Reihenfolge)
  let seed = null;

  if (revealOnTurn && dsRaw.seedId) {
    seed = pool.find(it => it.id === dsRaw.seedId);
    pool = pool.filter(it => it.id !== dsRaw.seedId);
    placed = [{ ...seed, revealed: true }];
  }
  if (def.kind !== "chronologyGame") {
    pool = pool.slice(0, 10 - placed.length);
  }
  pool = pool.sort(() => Math.random() - 0.5);

  const teamIds = Array.from(room.teams.keys());
  room.runtime = {
    kind: def.kind,
    label: dsRaw.label,
    unit: dsRaw.unit,
    order: dsRaw.order, // 'desc' oder 'asc'
    revealOnTurn,
    freeChoice,
    pool,               // bei Einordnen: sichtbare, noch nicht platzierte Elemente
                        // bei Mehr-oder-Weniger: verdeckter Nachziehstapel
    placed,             // bestätigte Elemente in wahrer Reihenfolge
    currentItem: null,  // nur bei Mehr-oder-Weniger genutzt
    turnOrder: teamIds,
    turnPointer: 0,
    lives: new Map(teamIds.map(id => [id, 3])),
    mistakes: new Map(teamIds.map(id => [id, 0])),
    correctCount: new Map(teamIds.map(id => [id, 0])),
    eliminated: new Set(),
    roundPointsByTeam: new Map(teamIds.map(id => [id, 0]))
  };
  advanceRankingTurn(room, true);
}

function activeTeamsRemaining(room) {
  return room.runtime.turnOrder.filter(id => !room.runtime.eliminated.has(id));
}

function advanceRankingTurn(room, first) {
  const rt = room.runtime;
  const active = activeTeamsRemaining(room);

  if (active.length === 0 || rt.pool.length === 0) {
    return finishRankingRound(room);
  }

  if (!first) {
    do {
      rt.turnPointer = (rt.turnPointer + 1) % rt.turnOrder.length;
    } while (rt.eliminated.has(rt.turnOrder[rt.turnPointer]));
  } else {
    while (rt.eliminated.has(rt.turnOrder[rt.turnPointer])) {
      rt.turnPointer = (rt.turnPointer + 1) % rt.turnOrder.length;
    }
  }

  if (!rt.freeChoice) {
    rt.currentItem = rt.pool.shift(); // Mehr oder Weniger: nächstes verdecktes Element ziehen
  }
  broadcastRankState(room);
  scheduleBotRankMove(room);
}

// Ermittelt die tatsächlich korrekte Einfügeposition für einen Wert
// (basierend auf den bereits bestätigten, wahr sortierten Elementen).
function correctInsertIndexFor(rt, value) {
  const desc = rt.order === "desc";
  let idx = 0;
  for (; idx < rt.placed.length; idx++) {
    const v = rt.placed[idx].value;
    if (desc ? value > v : value < v) break;
  }
  return idx;
}

// Lässt einen Bot automatisch ziehen, wenn das gerade aktive Team
// ausschließlich aus Bots besteht (ein menschliches Teammitglied zieht
// weiterhin immer selbst).
function scheduleBotRankMove(room) {
  const rt = room.runtime;
  if (!rt) return;
  const activeTeamId = rt.turnOrder[rt.turnPointer];
  const team = room.teams.get(activeTeamId);
  if (!team) return;
  const members = team.memberIds.map(id => room.players.get(id)).filter(Boolean);
  const allBots = members.length > 0 && members.every(p => p.isBot);
  if (!allBots) return;
  if (rt.freeChoice && rt.pool.length === 0) return;
  if (!rt.freeChoice && !rt.currentItem) return;

  const bot = members[0];
  const tier = BOT_TIERS[bot.botTier] || BOT_TIERS[DEFAULT_BOT_TIER];
  const turnSnapshot = rt.turnPointer;
  const delayMs = randRange(tier.rankDelayMin, tier.rankDelayMax);

  setTimeout(() => {
    if (!room.runtime || room.runtime !== rt) return; // Runde inzwischen beendet/gewechselt
    if (rt.turnPointer !== turnSnapshot || rt.turnOrder[rt.turnPointer] !== activeTeamId) return; // Zug hat sich geändert

    let targetItem;
    if (rt.freeChoice) {
      if (rt.pool.length === 0) return;
      targetItem = rt.pool[Math.floor(Math.random() * rt.pool.length)]; // Bot wählt ein beliebiges sichtbares Element
    } else {
      if (!rt.currentItem) return;
      targetItem = rt.currentItem;
    }

    const correct = Math.random() < tier.prob;
    const trueIndex = correctInsertIndexFor(rt, targetItem.value);
    let insertIndex = trueIndex;
    if (!correct) {
      const wrongOptions = [];
      for (let i = 0; i <= rt.placed.length; i++) if (i !== trueIndex) wrongOptions.push(i);
      insertIndex = wrongOptions.length ? wrongOptions[Math.floor(Math.random() * wrongOptions.length)] : trueIndex;
    }
    handleRankPlace(room, bot.id, targetItem.id, insertIndex);
  }, delayMs);
}

function broadcastRankState(room) {
  const rt = room.runtime;
  broadcast(room, {
    type: "rankState",
    kind: rt.kind,
    label: rt.label,
    unit: rt.unit,
    order: rt.order,
    freeChoice: rt.freeChoice,
    placed: rt.placed.map(it => ({ id: it.id, name: it.name, value: it.revealed ? it.value : undefined })),
    currentItem: (!rt.freeChoice && rt.currentItem) ? { id: rt.currentItem.id, name: rt.currentItem.name } : null,
    pool: rt.freeChoice ? rt.pool.map(it => ({ id: it.id, name: it.name })) : undefined,
    turnTeamId: rt.turnOrder[rt.turnPointer],
    lives: Object.fromEntries(rt.lives),
    mistakes: Object.fromEntries(rt.mistakes),
    eliminated: Array.from(rt.eliminated),
    remainingInPool: rt.pool.length
  });
}

// Prüft, ob das Einfügen an insertIndex (0..placed.length) korrekt ist.
// Gleiche Werte werden toleriert (z.B. reale Gleichstände bei Titeln).
function isPlacementCorrect(rt, value, insertIndex) {
  const before = rt.placed[insertIndex - 1];
  const after = rt.placed[insertIndex];
  const desc = rt.order === "desc";
  const okBefore = !before || (desc ? value <= before.value : value >= before.value);
  const okAfter = !after || (desc ? value >= after.value : value <= after.value);
  return okBefore && okAfter;
}

function handleRankPlace(room, playerId, itemId, insertIndex) {
  const rt = room.runtime;
  if (!rt) return;
  const player = room.players.get(playerId);
  if (!player || player.teamId !== rt.turnOrder[rt.turnPointer]) return; // nur das Team am Zug darf ziehen
  if (typeof insertIndex !== "number" || insertIndex < 0 || insertIndex > rt.placed.length) return;

  let item;
  if (rt.freeChoice) {
    // Einordnen: freie Auswahl aus dem sichtbaren Pool
    const idx = rt.pool.findIndex(p => p.id === itemId);
    if (idx === -1) return;
    item = rt.pool[idx];
    rt.pool.splice(idx, 1); // vorerst entfernen, kommt bei Fehlversuch zurück
  } else {
    // Mehr oder Weniger: muss das aktuell gezogene Element sein
    if (!rt.currentItem || rt.currentItem.id !== itemId) return;
    item = rt.currentItem;
  }

  const teamId = player.teamId;
  const correct = isPlacementCorrect(rt, item.value, insertIndex);

  if (correct) {
    rt.placed.splice(insertIndex, 0, { ...item, revealed: false });
    rt.correctCount.set(teamId, (rt.correctCount.get(teamId) || 0) + 1);
    rt.roundPointsByTeam.set(teamId, (rt.roundPointsByTeam.get(teamId) || 0) + 10);
  } else {
    rt.mistakes.set(teamId, (rt.mistakes.get(teamId) || 0) + 1);
    rt.lives.set(teamId, Math.max(0, (rt.lives.get(teamId) || 3) - 1));
    applyMistakePenalty(room, teamId);
    if (rt.lives.get(teamId) <= 0) rt.eliminated.add(teamId);

    if (rt.revealOnTurn) {
      // Mehr oder Weniger: Element sofort an seiner tatsächlich korrekten
      // Stelle einsortieren, damit künftige Vergleiche weiterhin stimmen –
      // der Wert selbst bleibt aber verborgen (erst die Auflösung am
      // Rundenende deckt alle Werte auf). Der nächste Zug zieht ein neues,
      // noch unbekanntes Element.
      const trueIndex = correctInsertIndexFor(rt, item.value);
      rt.placed.splice(trueIndex, 0, { ...item, revealed: false });
    } else {
      // Einordnen: Wert bleibt geheim -> Element zurück in den sichtbaren
      // Pool, der nächste Spieler/das nächste Team kann es (oder ein
      // anderes) versuchen.
      rt.pool.push(item);
    }
  }
  rt.currentItem = null;

  broadcast(room, {
    type: "rankAttempt",
    teamId,
    itemName: item.name,
    correct,
    livesLeft: rt.lives.get(teamId)
  });

  setTimeout(() => advanceRankingTurn(room, false), 1600);
}

function finishRankingRound(room) {
  const rt = room.runtime;
  // Endauflösung: alle Werte aufdecken (wichtig für orderingGame, wo Werte
  // bislang verborgen waren) und Restpunkte je Team ausweisen.
  const fullyRevealed = [...rt.placed, ...rt.pool].sort((a, b) => rt.order === "desc" ? b.value - a.value : a.value - b.value);

  broadcast(room, {
    type: "rankReveal",
    kind: rt.kind,
    label: rt.label,
    unit: rt.unit,
    fullOrder: fullyRevealed.map(it => ({ id: it.id, name: it.name, value: it.value })),
    correctCount: Object.fromEntries(rt.correctCount),
    mistakes: Object.fromEntries(rt.mistakes)
  });

  setTimeout(() => finishRoundEngine(room, rt.roundPointsByTeam), 2600);
}

/* ------------------------------------------------------------------------ */
/* RUNDE: guessPicture ("Bild erraten")                                      */
/* Ein Bild/Emoji wird zunehmend deutlicher; je früher richtig geraten wird  */
/* (Freitext, tippfehlertolerant), desto mehr Punkte gibt es. Alle Spieler   */
/* können jederzeit raten – wer zuerst richtig liegt, bekommt die Punkte.   */
/* ------------------------------------------------------------------------ */
const GUESS_TIER_MS = 3000;           // Dauer je Punktestufe
const GUESS_TIERS = [5, 3, 2, 1];     // Punkte je Stufe (zentral anpassbar)
const GUESS_TOTAL_MS = GUESS_TIER_MS * GUESS_TIERS.length;

function normalizeGuess(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Akzente entfernen
    .replace(/[^a-z0-9]/g, "") // Leerzeichen/Sonderzeichen entfernen
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function isGuessCorrect(guessText, item) {
  const norm = normalizeGuess(guessText);
  if (!norm) return false;
  const candidates = [item.answer, ...(item.alt || [])].map(normalizeGuess);
  return candidates.some(c => {
    if (norm === c) return true;
    const maxDist = c.length <= 4 ? 0 : (c.length <= 8 ? 1 : 2);
    return levenshtein(norm, c) <= maxDist;
  });
}

function currentGuessTierPoints(rt) {
  const elapsed = Date.now() - rt.currentStartedAt;
  const tierIdx = Math.min(Math.floor(elapsed / GUESS_TIER_MS), GUESS_TIERS.length - 1);
  return GUESS_TIERS[Math.max(0, tierIdx)];
}

function startGuessPictureRound(room, def) {
  const dsRaw = DATASETS.guessPicture[def.datasetKey];
  const items = [...dsRaw.items].sort(() => Math.random() - 0.5).slice(0, 10);
  const teamIds = Array.from(room.teams.keys());
  room.runtime = {
    kind: "guessPicture",
    label: dsRaw.label,
    items,
    index: -1,
    current: null,
    currentStartedAt: 0,
    currentResolved: false,
    timer: null,
    roundPointsByTeam: new Map(teamIds.map(id => [id, 0]))
  };
  nextGuessItem(room);
}

function nextGuessItem(room) {
  const rt = room.runtime;
  clearTimeout(rt.timer);
  rt.index++;
  if (rt.index >= rt.items.length) {
    return finishRoundEngine(room, rt.roundPointsByTeam);
  }
  rt.current = rt.items[rt.index];
  rt.currentStartedAt = Date.now();
  rt.currentResolved = false;

  broadcast(room, {
    type: "guessItem",
    index: rt.index,
    total: rt.items.length,
    label: rt.label,
    promptType: rt.current.promptType,
    promptValue: rt.current.promptValue,
    durationMs: GUESS_TOTAL_MS,
    tierMs: GUESS_TIER_MS,
    tiers: GUESS_TIERS,
    startedAt: rt.currentStartedAt
  });

  rt.timer = setTimeout(() => resolveGuessItem(room, null, 0), GUESS_TOTAL_MS + 300);
  scheduleBotGuesses(room);
}

function handleGuessSubmit(room, playerId, text) {
  const rt = room.runtime;
  if (!rt || rt.kind !== "guessPicture" || rt.currentResolved || !rt.current) return;
  const player = room.players.get(playerId);
  if (!player) return;
  const correct = isGuessCorrect(text, rt.current);
  broadcast(room, { type: "guessAttempt", teamId: player.teamId, playerName: player.name, text: (text || "").slice(0, 40), correct });
  if (correct) {
    const pts = currentGuessTierPoints(rt);
    resolveGuessItem(room, player.teamId, pts);
  }
}

function resolveGuessItem(room, winnerTeamId, points) {
  const rt = room.runtime;
  if (!rt || rt.currentResolved) return;
  rt.currentResolved = true;
  clearTimeout(rt.timer);
  if (winnerTeamId) {
    rt.roundPointsByTeam.set(winnerTeamId, (rt.roundPointsByTeam.get(winnerTeamId) || 0) + points);
  }
  broadcast(room, {
    type: "guessResolved",
    correctAnswer: rt.current.answer,
    winnerTeamId: winnerTeamId || null,
    points: points || 0
  });
  setTimeout(() => nextGuessItem(room), 2600);
}

// Bots raten mit schwierigkeitsabhängiger Verzögerung und Trefferquote –
// analog zu den Bots beim Wissenstest.
function scheduleBotGuesses(room) {
  const rt = room.runtime;
  const itemAtSchedule = rt.index;
  room.players.forEach(p => {
    if (!p.isBot) return;
    const tier = BOT_TIERS[p.botTier] || BOT_TIERS[DEFAULT_BOT_TIER];
    const delayMs = Math.max(400, randRange(tier.quizMinPct, tier.quizMaxPct) * GUESS_TOTAL_MS);
    setTimeout(() => {
      if (!room.runtime || room.runtime !== rt || rt.index !== itemAtSchedule || rt.currentResolved) return;
      if (Math.random() < tier.prob) {
        const pts = currentGuessTierPoints(rt);
        broadcast(room, { type: "guessAttempt", teamId: p.teamId, playerName: p.name, text: rt.current.answer, correct: true });
        resolveGuessItem(room, p.teamId, pts);
      }
    }, delayMs);
  });
}

/* ------------------------------------------------------------------------ */
/* ------------------------------------------------------------------------ */
/* RUNDE: stadtLandFluss                                                     */
/* Alle Spieler schreiben gleichzeitig zu einem zufälligen Buchstaben Wörter */
/* je Kategorie. Nach Ablauf der Zeit: Auflösung mit vorläufiger Wertung     */
/* (eindeutig=20, mehrfach=10, ungültig/leer=0), danach eine Anfechtungs-   */
/* /Abstimmungsphase, in der alle anderen Spieler über strittige Antworten  */
/* abstimmen können, bevor die Runde final gewertet wird.                   */
/* ------------------------------------------------------------------------ */
function slfBuildRoundDef(categories, isCustom) {
  const cats = (categories && categories.length ? categories : SLF_DEFAULT_CATEGORIES).slice(0, 8);
  return {
    id: isCustom ? "slf_custom" : "slf_original",
    kind: "stadtLandFluss",
    label: "Stadt Land Fluss: " + (isCustom ? "Eigene Kategorien (" + cats.join(", ") + ")" : "Original"),
    categories: cats
  };
}

function normalizeSlfWord(s) {
  return (s || "").toString().trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function startStadtLandFlussRound(room, def) {
  const categories = def.categories && def.categories.length ? def.categories : SLF_DEFAULT_CATEGORIES;
  const letter = SLF_LETTERS[Math.floor(Math.random() * SLF_LETTERS.length)];
  const teamIds = Array.from(room.teams.keys());
  room.runtime = {
    kind: "stadtLandFluss",
    label: def.label,
    categories,
    letter,
    phase: "answering",
    answers: new Map(),      // playerId -> { category: text }
    submitted: new Set(),
    challenges: new Map(),   // challengeId -> { playerId, category, votes: Map(playerId->bool), resolved, invalidated }
    challengeCounter: 0,
    timer: null,
    roundPointsByTeam: new Map(teamIds.map(id => [id, 0]))
  };
  broadcast(room, { type: "slfRoundStart", categories, letter, durationMs: SLF_ANSWER_MS });
  room.runtime.timer = setTimeout(() => slfFinishAnswering(room), SLF_ANSWER_MS + 400);
  // Hinweis: Bots beteiligen sich an Stadt-Land-Fluss bewusst nicht aktiv am
  // Schreiben (echte, sinnvolle Wörter je Buchstabe/Kategorie zu generieren
  // würde ein riesiges, fest hinterlegtes Wörterbuch erfordern) – sie liefern
  // hier keine Antworten ab und tragen für diese Runde 0 Punkte bei.
}

function handleSlfSubmit(room, playerId, answers) {
  const rt = room.runtime;
  if (!rt || rt.kind !== "stadtLandFluss" || rt.phase !== "answering") return;
  if (rt.submitted.has(playerId)) return;
  const clean = {};
  rt.categories.forEach(cat => { clean[cat] = (answers && typeof answers[cat] === "string") ? answers[cat].slice(0, 40) : ""; });
  rt.answers.set(playerId, clean);
  rt.submitted.add(playerId);
  const allSubmitted = Array.from(room.players.keys())
    .filter(pid => !room.players.get(pid).isBot)
    .every(pid => rt.submitted.has(pid));
  if (allSubmitted) { clearTimeout(rt.timer); slfFinishAnswering(room); }
}

function slfIsValidLetter(word, letter) {
  const n = normalizeSlfWord(word);
  return n.length > 0 && n[0].toUpperCase() === letter.toUpperCase();
}

// Berechnet die (vorläufige oder finale) Punkte je Spieler und Kategorie:
// eindeutige gültige Antwort = 20, mehrfach vorhandene gültige Antwort = 10,
// leer/ungültig (falscher Anfangsbuchstabe) = 0. `invalidPlayerCatPairs`
// enthält per Anfechtung für ungültig erklärte Antworten und wird wie eine
// leere Antwort behandelt.
function slfComputeScores(rt, invalidPlayerCatPairs) {
  const scores = new Map(); // playerId -> {category: points}
  const playerIds = Array.from(rt.answers.keys());
  playerIds.forEach(pid => scores.set(pid, {}));

  rt.categories.forEach(cat => {
    const wordCount = new Map(); // normalisiertes Wort -> Anzahl
    playerIds.forEach(pid => {
      const word = rt.answers.get(pid)[cat];
      const invalidated = invalidPlayerCatPairs && invalidPlayerCatPairs.has(pid + "|" + cat);
      if (invalidated || !slfIsValidLetter(word, rt.letter)) return;
      const norm = normalizeSlfWord(word);
      wordCount.set(norm, (wordCount.get(norm) || 0) + 1);
    });
    playerIds.forEach(pid => {
      const word = rt.answers.get(pid)[cat];
      const invalidated = invalidPlayerCatPairs && invalidPlayerCatPairs.has(pid + "|" + cat);
      if (invalidated || !slfIsValidLetter(word, rt.letter)) { scores.get(pid)[cat] = 0; return; }
      const norm = normalizeSlfWord(word);
      scores.get(pid)[cat] = wordCount.get(norm) === 1 ? 20 : 10;
    });
  });
  return scores;
}

function slfFinishAnswering(room) {
  const rt = room.runtime;
  if (!rt || rt.phase !== "answering") return;
  rt.phase = "reveal";
  // Wer nicht abgegeben hat, bekommt eine leere Antwort je Kategorie
  room.players.forEach(p => {
    if (!rt.answers.has(p.id)) {
      const empty = {};
      rt.categories.forEach(cat => { empty[cat] = ""; });
      rt.answers.set(p.id, empty);
    }
  });
  const scores = slfComputeScores(rt, null);
  broadcast(room, {
    type: "slfReveal",
    categories: rt.categories,
    letter: rt.letter,
    answers: Object.fromEntries(rt.answers),
    players: Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name, teamId: p.teamId })),
    scores: Object.fromEntries(scores),
    challengeWindowMs: SLF_CHALLENGE_MS
  });
  rt.phase = "challenge";
  rt.timer = setTimeout(() => slfFinalizeRound(room), SLF_CHALLENGE_MS + 400);
}

function handleSlfChallenge(room, challengerId, targetPlayerId, category) {
  const rt = room.runtime;
  if (!rt || rt.phase !== "challenge") return;
  if (!rt.categories.includes(category)) return;
  if (targetPlayerId === challengerId) return; // eigene Antwort nicht anfechtbar
  const targetAnswers = rt.answers.get(targetPlayerId);
  if (!targetAnswers || !targetAnswers[category]) return;
  // Keine doppelte Anfechtung derselben Antwort
  const already = Array.from(rt.challenges.values()).some(c => c.playerId === targetPlayerId && c.category === category && !c.resolved);
  if (already) return;

  const challengeId = "c" + (++rt.challengeCounter);
  const votes = new Map();
  votes.set(challengerId, false); // Anfechter stimmt implizit "ungültig"
  const challenge = { id: challengeId, playerId: targetPlayerId, category, answerText: targetAnswers[category], votes, resolved: false, voteDeadline: Date.now() + SLF_VOTE_MS };
  rt.challenges.set(challengeId, challenge);
  broadcastSlfChallenges(room);
  setTimeout(() => slfResolveChallenge(room, challengeId), SLF_VOTE_MS + 300);
}

function handleSlfVote(room, voterId, challengeId, valid) {
  const rt = room.runtime;
  if (!rt || rt.phase !== "challenge") return;
  const challenge = rt.challenges.get(challengeId);
  if (!challenge || challenge.resolved || voterId === challenge.playerId) return;
  challenge.votes.set(voterId, !!valid);
  const eligibleVoters = Array.from(room.players.keys()).filter(pid => pid !== challenge.playerId && !room.players.get(pid).isBot);
  if (eligibleVoters.every(pid => challenge.votes.has(pid))) slfResolveChallenge(room, challengeId);
  else broadcastSlfChallenges(room);
}

function slfResolveChallenge(room, challengeId) {
  const rt = room.runtime;
  if (!rt) return;
  const challenge = rt.challenges.get(challengeId);
  if (!challenge || challenge.resolved) return;
  challenge.resolved = true;
  const votes = Array.from(challenge.votes.values());
  const invalidVotes = votes.filter(v => v === false).length;
  const validVotes = votes.filter(v => v === true).length;
  challenge.invalidated = invalidVotes > validVotes; // bei Gleichstand bleibt die Antwort gültig
  broadcastSlfChallenges(room);
}

function broadcastSlfChallenges(room) {
  const rt = room.runtime;
  broadcast(room, {
    type: "slfChallengeUpdate",
    challenges: Array.from(rt.challenges.values()).map(c => ({
      id: c.id, playerId: c.playerId, category: c.category, answerText: c.answerText,
      resolved: c.resolved, invalidated: c.invalidated, voteCount: c.votes.size
    }))
  });
}

function slfFinalizeRound(room) {
  const rt = room.runtime;
  if (!rt || rt.phase === "done") return;
  rt.phase = "done";
  const invalidPairs = new Set();
  rt.challenges.forEach(c => { if (c.resolved && c.invalidated) invalidPairs.add(c.playerId + "|" + c.category); });
  const finalScores = slfComputeScores(rt, invalidPairs);

  // Punkte je Spieler aufsummieren, dann auf dessen Team addieren
  finalScores.forEach((catScores, playerId) => {
    const player = room.players.get(playerId);
    if (!player || !player.teamId) return;
    const total = Object.values(catScores).reduce((a, b) => a + b, 0);
    rt.roundPointsByTeam.set(player.teamId, (rt.roundPointsByTeam.get(player.teamId) || 0) + total);
  });

  broadcast(room, {
    type: "slfFinalReveal",
    scores: Object.fromEntries(finalScores)
  });
  setTimeout(() => finishRoundEngine(room, rt.roundPointsByTeam), 2200);
}

/* ------------------------------------------------------------------------ */
/* Rundenabschluss (gemeinsam für alle Engines)                              */
/* ------------------------------------------------------------------------ */
function finishRoundEngine(room, roundPointsByTeam) {
  const maxPoints = Math.max(...Array.from(roundPointsByTeam.values()));
  const winnerTeamIds = Array.from(roundPointsByTeam.entries())
    .filter(([, pts]) => pts === maxPoints)
    .map(([id]) => id);

  const roundNumber = room.currentRoundIndex + 1;
  awardRoundPoints(room, roundNumber, winnerTeamIds);

  room.phase = "roundResult";
  broadcast(room, {
    type: "roundEnd",
    roundIndex: room.currentRoundIndex,
    roundNumber,
    totalRounds: room.roundCount,
    roundScores: Object.fromEntries(roundPointsByTeam),
    winnerTeamIds,
    totalScores: Object.fromEntries(Array.from(room.teams.values()).map(t => [t.id, t.score])),
    teams: Array.from(room.teams.values()).map(t => ({ id: t.id, name: t.name, score: t.score })),
    isLastRound: roundNumber >= room.roundCount
  });
}

/* ------------------------------------------------------------------------ */
/* Rundensteuerung                                                           */
/* ------------------------------------------------------------------------ */
function startNextRound(room) {
  room.currentRoundIndex++;
  if (room.currentRoundIndex >= room.roundDefs.length) {
    return endGame(room);
  }
  const def = room.roundDefs[room.currentRoundIndex];
  room.phase = "playing";
  broadcast(room, {
    type: "roundStart",
    roundIndex: room.currentRoundIndex,
    roundNumber: room.currentRoundIndex + 1,
    totalRounds: room.roundCount,
    kind: def.kind,
    label: def.label
  });

  setTimeout(() => {
    if (def.kind === "knowledgeQuiz") startQuizRound(room);
    else if (def.kind === "guessPicture") startGuessPictureRound(room, def);
    else if (def.kind === "stadtLandFluss") startStadtLandFlussRound(room, def);
    else startRankingRound(room, def);
  }, 1800);
}

function endGame(room) {
  room.phase = "gameEnd";
  const ranking = Array.from(room.teams.values()).sort((a, b) => b.score - a.score);
  broadcast(room, {
    type: "gameEnd",
    ranking: ranking.map(t => ({ id: t.id, name: t.name, score: t.score }))
  });
}

/* ------------------------------------------------------------------------ */
/* Benutzerkonten (Benutzername + Passwort, serverseitig gespeichert)        */
/* ------------------------------------------------------------------------ */
// Passwörter werden NIE im Klartext gespeichert, sondern mit scrypt (Node-
// Bordmittel, sicher, kein externes Paket) + zufälligem Salt pro Nutzer
// gehasht. Speicherung als einfache JSON-Datei – reicht für dieses Projekt,
// siehe README für Hinweise zur Persistenz bei manchen Hosting-Anbietern.
const USERS_FILE = path.join(__dirname, "data", "users.json");

let users = [];
function loadUsers() {
  try { users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); }
  catch (e) { users = []; }
}
function saveUsers() {
  try {
    fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 1), "utf8");
  } catch (e) {
    console.error("Konnte Nutzerdaten nicht speichern:", e.message);
  }
}
loadUsers();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function findUserByName(username) {
  const norm = (username || "").trim().toLowerCase();
  return users.find(u => u.username.toLowerCase() === norm);
}
function findUserByToken(token) {
  if (!token) return null;
  return users.find(u => (u.tokens || []).some(t => t.token === token));
}
function defaultStats() {
  return { score: 0, roundsPlayed: 0, wins: 0, losses: 0, correctAnswers: 0, wrongAnswers: 0, bestScore: 0 };
}
function publicProfile(user) {
  return { username: user.username, avatar: user.avatar || null, ...user.stats };
}

function registerUser(username, password) {
  username = (username || "").trim();
  if (username.length < 3 || username.length > 20 || !/^[a-zA-Z0-9_äöüÄÖÜß]+$/.test(username)) {
    return { ok: false, error: "Benutzername muss 3-20 Zeichen haben (Buchstaben, Zahlen, _)." };
  }
  if (!password || password.length < 6) {
    return { ok: false, error: "Passwort muss mindestens 6 Zeichen haben." };
  }
  if (findUserByName(username)) {
    return { ok: false, error: "Dieser Benutzername ist bereits vergeben." };
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);
  const token = crypto.randomBytes(24).toString("hex");
  const user = {
    username, salt, passwordHash,
    avatar: null,
    stats: defaultStats(),
    tokens: [{ token, createdAt: Date.now() }],
    createdAt: Date.now()
  };
  users.push(user);
  saveUsers();
  return { ok: true, token, profile: publicProfile(user) };
}

function loginUser(username, password) {
  const user = findUserByName(username);
  const genericError = { ok: false, error: "Benutzername oder Passwort ist falsch." };
  if (!user) return genericError;
  const hash = hashPassword(password || "", user.salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(user.passwordHash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return genericError;
  const token = crypto.randomBytes(24).toString("hex");
  user.tokens = user.tokens || [];
  user.tokens.push({ token, createdAt: Date.now() });
  saveUsers();
  return { ok: true, token, profile: publicProfile(user) };
}

function sessionUser(token) {
  const user = findUserByToken(token);
  if (!user) return { ok: false };
  return { ok: true, profile: publicProfile(user) };
}

function logoutUser(token) {
  const user = findUserByToken(token);
  if (user) {
    user.tokens = (user.tokens || []).filter(t => t.token !== token);
    saveUsers();
  }
  return { ok: true };
}

function saveUserStats(token, stats) {
  const user = findUserByToken(token);
  if (!user) return { ok: false, error: "Nicht angemeldet." };
  const allowedKeys = ["score", "roundsPlayed", "wins", "losses", "correctAnswers", "wrongAnswers", "bestScore"];
  allowedKeys.forEach(k => {
    if (typeof stats[k] === "number" && Number.isFinite(stats[k])) {
      user.stats[k] = Math.max(0, Math.round(stats[k]));
    }
  });
  saveUsers();
  return { ok: true, profile: publicProfile(user) };
}

/* ------------------------------------------------------------------------ */
/* HTTP: statische Dateien aus /public                                       */
/* ------------------------------------------------------------------------ */
const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url.startsWith("/api/")) {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let payload;
      try { payload = body ? JSON.parse(body) : {}; } catch (e) { payload = {}; }
      let result;
      if (req.url === "/api/register") result = registerUser(payload.username, payload.password);
      else if (req.url === "/api/login") result = loginUser(payload.username, payload.password);
      else if (req.url === "/api/session") result = sessionUser(payload.token);
      else if (req.url === "/api/logout") result = logoutUser(payload.token);
      else if (req.url === "/api/save-stats") result = saveUserStats(payload.token, payload.stats || {});
      else result = { ok: false, error: "Unbekannter Endpunkt." };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  let filePath = req.url.split("?")[0];
  if (filePath === "/") filePath = "/index.html";
  const fullPath = path.join(__dirname, "public", filePath);
  if (!fullPath.startsWith(path.join(__dirname, "public"))) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(fullPath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fullPath)] || "application/octet-stream" });
    res.end(data);
  });
});

/* ------------------------------------------------------------------------ */
/* WebSocket-Handling                                                        */
/* ------------------------------------------------------------------------ */
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  // Regelmäßiger Ping hält die Verbindung durch Proxys/Idle-Timeouts mancher
  // Hosting-Anbieter am Leben (Browser beantworten Ping-Frames automatisch
  // mit Pong, ganz ohne zusätzlichen Client-Code).
  const keepAlive = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
    else clearInterval(keepAlive);
  }, 25000);
  ws.on("close", () => clearInterval(keepAlive));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.action === "createRoom") {
      const room = createRoom(ws, msg.name || "Host", msg.language);
      send(ws, { type: "joined", roomCode: room.code, playerId: ws.playerId, isHost: true });
      pushRoomState(room);
      return;
    }

    if (msg.action === "joinRoom") {
      const room = rooms.get((msg.code || "").toUpperCase());
      if (!room) return send(ws, { type: "error", message: "Raum nicht gefunden." });
      if (room.phase !== "lobby") return send(ws, { type: "error", message: "Diese Runde läuft bereits." });
      if (room.players.size >= MAX_PARTICIPANTS) return send(ws, { type: "error", message: "Der Raum ist voll (max. " + MAX_PARTICIPANTS + " Teilnehmer)." });
      const id = "pl_" + Math.random().toString(36).slice(2, 9);
      addPlayer(room, ws, id, msg.name || "Spieler");
      send(ws, { type: "joined", roomCode: room.code, playerId: id, isHost: false });
      rebuildFfaTeams(room);
      pushRoomState(room);
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const isHost = ws.playerId === room.hostId;

    switch (msg.action) {
      case "setRoundCount":
        if (isHost && room.phase === "lobby") {
          const n = parseInt(msg.count, 10);
          const allowed = [5, 10, 15, 20];
          room.roundCount = allowed.includes(n) ? n : 5;
          if (room.roundMode === "custom") {
            // Bereits getroffene Auswahl beibehalten, nur auf neue Länge anpassen
            const defs = room.roundDefs.slice(0, room.roundCount);
            while (defs.length < room.roundCount) defs.push(null);
            room.roundDefs = defs;
          } else {
            randomizeRoundDefs(room);
          }
          pushRoomState(room);
        }
        break;
      case "setRoundMode":
        if (isHost && room.phase === "lobby") {
          room.roundMode = msg.mode === "custom" ? "custom" : "random";
          if (room.roundMode === "random") randomizeRoundDefs(room);
          else room.roundDefs = Array.from({ length: room.roundCount }, () => null); // "Noch nicht gewählt"
          pushRoomState(room);
        }
        break;
      case "randomizeRounds":
        if (isHost && room.phase === "lobby") { randomizeRoundDefs(room); pushRoomState(room); }
        break;
      case "setRoundDef":
        if (isHost && room.phase === "lobby" && room.roundMode === "custom") {
          const def = findRoundDef(msg.defId);
          if (def && msg.index >= 0 && msg.index < room.roundCount) {
            room.roundDefs[msg.index] = def;
            pushRoomState(room);
          }
        }
        break;
      case "setSlfCustomRoundDef":
        if (isHost && room.phase === "lobby" && room.roundMode === "custom") {
          if (msg.index >= 0 && msg.index < room.roundCount && Array.isArray(msg.categories) && msg.categories.length > 0) {
            const cleanCats = msg.categories.map(c => (c || "").toString().trim().slice(0, 20)).filter(Boolean).slice(0, 8);
            if (cleanCats.length > 0) {
              room.roundDefs[msg.index] = slfBuildRoundDef(cleanCats, true);
              pushRoomState(room);
            }
          }
        }
        break;
      case "setTeamMode":
        if (isHost && room.phase === "lobby") {
          room.teamMode = msg.teamMode;
          if (room.teamMode === "ffa") {
            rebuildFfaTeams(room);
          } else {
            room.teams.clear();
            const n = room.teamMode === "2v2v2" ? 3 : 2;
            const letters = ["A", "B", "C"];
            for (let i = 0; i < n; i++) room.teams.set(letters[i], { id: letters[i], name: "Team " + letters[i], memberIds: [], score: 0 });
            room.players.forEach(p => (p.teamId = null));
          }
          pushRoomState(room);
        }
        break;
      case "assignTeam":
        if (isHost && room.phase === "lobby" && room.teamMode !== "ffa") {
          const player = room.players.get(msg.playerId);
          const team = room.teams.get(msg.teamId);
          if (player && team) {
            room.teams.forEach(t => { t.memberIds = t.memberIds.filter(id => id !== msg.playerId); });
            team.memberIds.push(msg.playerId);
            player.teamId = team.id;
          }
          pushRoomState(room);
        }
        break;
      case "setPointSystem":
        if (isHost && room.phase === "lobby") { room.pointSystem = [1, 2, 3].includes(msg.system) ? msg.system : 1; pushRoomState(room); }
        break;
      case "setLanguage":
        if (isHost && room.phase === "lobby") {
          room.language = SUPPORTED_LANGS.includes(msg.language) ? msg.language : "de";
          if (room.roundMode === "random") {
            randomizeRoundDefs(room);
          } else {
            // Bereits gewählte Runden, die mit der neuen Sprache nicht mehr
            // verfügbar sind (germanOnly), zurück auf "nicht gewählt" setzen.
            const availableIds = new Set(roundDefPoolForLanguage(room.language).map(d => d.id));
            room.roundDefs = room.roundDefs.map(r => (r && availableIds.has(r.id)) ? r : null);
          }
          pushRoomState(room);
        }
        break;
      case "addBot":
        if (isHost && room.phase === "lobby") {
          if (room.players.size < MAX_PARTICIPANTS) {
            addBot(room, msg.tier || DEFAULT_BOT_TIER);
            pushRoomState(room);
          }
        }
        break;
      case "removeBot":
        if (isHost && room.phase === "lobby") {
          removeBot(room, msg.botId);
          pushRoomState(room);
        }
        break;
      case "setBotTier":
        if (isHost && room.phase === "lobby") {
          const bot = room.players.get(msg.botId);
          if (bot && bot.isBot && BOT_TIERS[msg.tier]) { bot.botTier = msg.tier; pushRoomState(room); }
        }
        break;
      case "startGame":
        if (isHost && room.phase === "lobby") {
          if (room.roundDefs.length !== room.roundCount || room.roundDefs.some(r => !r)) randomizeRoundDefs(room);
          if (room.teams.size === 0) rebuildFfaTeams(room);
          // Wichtig: Teams (insb. bei "Alle gegen alle") werden erst hier final
          // zugewiesen. Ohne diesen roomUpdate hätte der Client noch die alte
          // (leere) teamId je Spieler zwischengespeichert und würde fälschlich
          // glauben, niemand sei je am Zug – alle Klick-Buttons blieben dann
          // unsichtbar. phase wird deshalb VOR dem Broadcast schon auf
          // "playing" gesetzt, damit der Client dabei nicht kurz zurück in
          // den Warteraum/die Solo-Konfiguration zurückspringt.
          room.phase = "playing";
          pushRoomState(room);
          room.currentRoundIndex = -1;
          startNextRound(room);
        }
        break;
      case "continue":
        if (isHost && room.phase === "roundResult") startNextRound(room);
        break;
      case "quizAnswer":
        handleQuizAnswer(room, ws.playerId, msg.selectedIndex);
        break;
      case "rankPlace":
        handleRankPlace(room, ws.playerId, msg.itemId, msg.insertIndex);
        break;
      case "guessSubmit":
        handleGuessSubmit(room, ws.playerId, msg.text);
        break;
      case "slfSubmit":
        handleSlfSubmit(room, ws.playerId, msg.answers);
        break;
      case "slfChallenge":
        handleSlfChallenge(room, ws.playerId, msg.targetPlayerId, msg.category);
        break;
      case "slfVote":
        handleSlfVote(room, ws.playerId, msg.challengeId, msg.valid);
        break;
      case "restartLobby":
        if (isHost && room.phase === "gameEnd") {
          room.phase = "lobby";
          room.currentRoundIndex = -1;
          room.roundDefs = [];
          room.teams.forEach(t => (t.score = 0));
          pushRoomState(room);
        }
        break;
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const player = room.players.get(ws.playerId);
    if (player) player.connected = false;
    pushRoomState(room);
    // Raum aufräumen, wenn niemand mehr verbunden ist
    const anyConnected = Array.from(room.players.values()).some(p => p.connected);
    if (!anyConnected) setTimeout(() => { if (!Array.from(room.players.values()).some(p => p.connected)) rooms.delete(room.code); }, 60000);
  });
});

/* ------------------------------------------------------------------------ */
/* Start                                                                     */
/* ------------------------------------------------------------------------ */
server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const addresses = [];
  Object.values(nets).forEach(ifaces => (ifaces || []).forEach(iface => {
    if (iface.family === "IPv4" && !iface.internal) addresses.push(iface.address);
  }));
  console.log("");
  console.log("WISSENSDUELL PARTY läuft.");
  console.log("Auf diesem Gerät öffnen:   http://localhost:" + PORT);
  if (addresses.length) {
    console.log("Für andere Geräte im selben WLAN:");
    addresses.forEach(a => console.log("  http://" + a + ":" + PORT));
  } else {
    console.log("Keine WLAN-Adresse gefunden – stelle sicher, dass dieses Gerät im WLAN ist.");
  }
  console.log("(Läuft dieser Server bei einem Hosting-Anbieter, nutze stattdessen die von");
  console.log(" dort angezeigte öffentliche Adresse, z.B. https://dein-app-name.<anbieter>.app)");
  console.log("");
});
