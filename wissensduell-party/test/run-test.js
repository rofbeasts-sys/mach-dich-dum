const { spawn } = require("child_process");
const path = require("path");
const TestClient = require("./miniwsclient");

const PORT = 3910;
const server = spawn("node", [path.join(__dirname, "..", "server.js")], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverReady = false;
server.stdout.on("data", (d) => {
  process.stdout.write("[server] " + d);
  if (d.toString().includes("läuft")) serverReady = true;
});
server.stderr.on("data", (d) => process.stderr.write("[server-err] " + d));

function log(who, msg) { console.log(`[${who}] ${msg.type}`, JSON.stringify(msg).slice(0, 160)); }

setTimeout(() => {
  const host = new TestClient("localhost", PORT);
  const guest = new TestClient("localhost", PORT);
  let roomCode = null;
  let roundsSeen = 0;
  let quizAnswered = false;
  let sawGameEnd = false;
  let guestOpen = false;
  let guestReadyToJoin = false;
  let configuredStarted = false;

  host.on("open", () => host.send({ action: "createRoom", name: "HostSpieler" }));
  guest.on("open", () => {
    guestOpen = true;
    if (guestReadyToJoin) guest.send({ action: "joinRoom", code: roomCode, name: "Gast1" });
  });

  host.on("message", (raw) => {
    const msg = JSON.parse(raw);
    log("HOST", msg);
    if (msg.type === "joined") {
      roomCode = msg.roomCode;
      guestReadyToJoin = true;
      if (guestOpen) guest.send({ action: "joinRoom", code: roomCode, name: "Gast1" });
    }
    if (msg.type === "roomUpdate" && msg.players.length === 2 && msg.phase === "lobby" && !configuredStarted) {
      configuredStarted = true;
      // Host konfiguriert: 5 Runden, Zufallsrunde, Alle gegen alle, Punktesystem 1, dann Start
      host.send({ action: "setRoundCount", count: 5 });
      host.send({ action: "setRoundMode", mode: "random" });
      host.send({ action: "setTeamMode", teamMode: "ffa" });
      host.send({ action: "setPointSystem", system: 1 });
      setTimeout(() => host.send({ action: "startGame" }), 200);
    }
    if (msg.type === "roundStart") {
      roundsSeen++;
      console.log(`>>> Runde ${msg.roundNumber}/${msg.totalRounds}: ${msg.kind} (${msg.label})`);
    }
    if (msg.type === "quizQuestion" && !quizAnswered) {
      quizAnswered = true;
      setTimeout(() => host.send({ action: "quizAnswer", selectedIndex: 0 }), 50);
    } else if (msg.type === "quizQuestion") {
      setTimeout(() => host.send({ action: "quizAnswer", selectedIndex: 0 }), 50);
    }
    if (msg.type === "rankState" && msg.currentItem) {
      // Host ist immer am Zug (FFA, 2 Spieler abwechselnd) -> nur senden wenn wir dran sind
      if (msg.turnTeamId) {
        setTimeout(() => host.send({ action: "rankPlace", insertIndex: 0 }), 30);
      }
    }
    if (msg.type === "roundEnd" && !msg.isLastRound) {
      setTimeout(() => host.send({ action: "continue" }), 100);
    }
    if (msg.type === "gameEnd") {
      sawGameEnd = true;
      console.log(">>> GAME END", JSON.stringify(msg.ranking));
    }
  });

  guest.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === "quizQuestion") {
      setTimeout(() => guest.send({ action: "quizAnswer", selectedIndex: 1 }), 60);
    }
    if (msg.type === "rankState" && msg.currentItem && msg.turnTeamId) {
      setTimeout(() => guest.send({ action: "rankPlace", insertIndex: 0 }), 40);
    }
  });

  setTimeout(() => {    console.log("\n=== TESTZUSAMMENFASSUNG ===");
    console.log("Runden gesehen:", roundsSeen, "(erwartet 5)");
    console.log("Spielende erreicht:", sawGameEnd);
    host.close(); guest.close();
    server.kill();
    process.exit(sawGameEnd && roundsSeen === 5 ? 0 : 1);
  }, 60000);
}, 700);
