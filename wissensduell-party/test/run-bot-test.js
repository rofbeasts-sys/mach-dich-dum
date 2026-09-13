const { spawn } = require("child_process");
const path = require("path");
const TestClient = require("./miniwsclient");

const PORT = 3911;
const server = spawn("node", [path.join(__dirname, "..", "server.js")], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", (d) => process.stdout.write("[server] " + d));
server.stderr.on("data", (d) => process.stderr.write("[server-err] " + d));

setTimeout(() => {
  const host = new TestClient("localhost", PORT);
  let roomCode = null;
  let configured = false;
  let botsAdded = false;
  let roundsSeen = [];
  let sawGameEnd = false;

  host.on("open", () => host.send({ action: "createRoom", name: "SoloHost" }));

  host.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === "joined") { roomCode = msg.roomCode; return; }
    if (msg.type === "error") { console.log("ERROR:", msg.message); return; }

    if (msg.type === "roomUpdate" && msg.phase === "lobby") {
      if (!botsAdded) {
        botsAdded = true;
        host.send({ action: "addBot", tier: "dumm" });
        host.send({ action: "addBot", tier: "wissenschaftler" });
        host.send({ action: "addBot", tier: "doktor" });
        return;
      }
      if (botsAdded && msg.players.length === 4 && !configured) {
        configured = true;
        console.log("Teilnehmer:", msg.players.map(p => `${p.name}${p.isBot ? '(' + p.botTierLabel + ')' : ''}`).join(", "));
        host.send({ action: "setRoundCount", count: 5 });
        host.send({ action: "setRoundMode", mode: "random" });
        host.send({ action: "setTeamMode", teamMode: "ffa" });
        host.send({ action: "setPointSystem", system: 1 });
        setTimeout(() => host.send({ action: "startGame" }), 200);
      }
      return;
    }

    if (msg.type === "roundStart") {
      roundsSeen.push(msg.kind);
      console.log(`>>> Runde ${msg.roundNumber}/${msg.totalRounds}: ${msg.kind} (${msg.label})`);
    }
    if (msg.type === "quizQuestion") {
      // Host antwortet bewusst nicht sofort, um zu sehen, dass die Bots trotzdem termingerecht handeln
      setTimeout(() => host.send({ action: "quizAnswer", selectedIndex: 0 }), 300);
    }
    if (msg.type === "quizReveal") {
      console.log("   Quiz-Ergebnis:", msg.results.map(r => `${r.name}:${r.correct ? '✓' : '✕'}`).join(" "));
    }
    if (msg.type === "rankAttempt") {
      console.log(`   Zug: ${msg.teamId.startsWith('bot_') ? 'BOT' : 'HOST'} ${msg.itemName} -> ${msg.correct ? 'richtig' : 'falsch'}`);
    }
    if (msg.type === "rankState" && msg.currentItem && msg.turnTeamId && !msg.turnTeamId.startsWith("bot_")) {
      // Der Host ist an der Reihe (kein Bot-Team) -> Testclient zieht ebenfalls, damit die Runde weiterläuft
      setTimeout(() => host.send({ action: "rankPlace", insertIndex: 0 }), 200);
    }
    if (msg.type === "roundEnd" && !msg.isLastRound) {
      setTimeout(() => host.send({ action: "continue" }), 150);
    }
    if (msg.type === "gameEnd") {
      sawGameEnd = true;
      console.log(">>> GAME END", JSON.stringify(msg.ranking));
    }
  });

  setTimeout(() => {
    console.log("\n=== TESTZUSAMMENFASSUNG ===");
    console.log("Rundentypen gesehen:", roundsSeen.join(", "));
    console.log("Spielende erreicht:", sawGameEnd);
    host.close();
    server.kill();
    process.exit(sawGameEnd ? 0 : 1);
  }, 90000);
}, 700);
