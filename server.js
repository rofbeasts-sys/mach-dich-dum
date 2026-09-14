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
 *  - Die drei Spiel-Engines: knowledgeQuiz, orderingGame, higherLowerGame
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
  const pool = [{ id: "quiz", kind: "knowledgeQuiz", label: "Wissenstest" }];
  Object.entries(DATASETS.ordering).forEach(([key, ds]) => {
    pool.push({ id: "order_" + key, kind: "orderingGame", label: ds.label, datasetGroup: "ordering", datasetKey: key });
  });
  Object.entries(DATASETS.higherLower).forEach(([key, ds]) => {
    pool.push({ id: "hilo_" + key, kind: "higherLowerGame", label: ds.label, datasetGroup: "higherLower", datasetKey: key });
  });
  return pool;
}
const ROUND_DEF_POOL = buildRoundDefPool();
function findRoundDef(id) { return ROUND_DEF_POOL.find(r => r.id === id); }

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

function createRoom(hostWs, hostName) {
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
    currentRoundIndex: -1,
    phase: "lobby", // lobby | roundIntro | playing | roundResult | gameEnd
    runtime: null
  };
  rooms.set(code, room);
  addPlayer(room, hostWs, hostId, hostName);
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
    roundDefs: room.roundDefs.map(r => r ? ({ id: r.id, kind: r.kind, label: r.label }) : null),
    availableRoundDefs: ROUND_DEF_POOL.map(r => ({ id: r.id, kind: r.kind, label: r.label })),
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
  const defs = [];
  for (let i = 0; i < room.roundCount; i++) {
    const def = ROUND_DEF_POOL[Math.floor(Math.random() * ROUND_DEF_POOL.length)];
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

  let pool = dsRaw.items.map(it => ({ ...it }));
  let placed = []; // aufsteigend nach Spielreihenfolge, in "order" sortiert (true Reihenfolge)
  let seed = null;

  if (revealOnTurn && dsRaw.seedId) {
    seed = pool.find(it => it.id === dsRaw.seedId);
    pool = pool.filter(it => it.id !== dsRaw.seedId);
    placed = [{ ...seed, revealed: true }];
  }
  pool = pool.slice(0, 10 - placed.length);
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
/* HTTP: statische Dateien aus /public                                       */
/* ------------------------------------------------------------------------ */
const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" };
const server = http.createServer((req, res) => {
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
      const room = createRoom(ws, msg.name || "Host");
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
