const net = require("net");
const crypto = require("crypto");
const EventEmitter = require("events");

class TestClient extends EventEmitter {
  constructor(host, port) {
    super();
    this.socket = net.connect(port, host, () => {
      const key = crypto.randomBytes(16).toString("base64");
      this.socket.write(
        `GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    this._buf = Buffer.alloc(0);
    this._handshakeDone = false;
    this.socket.on("data", (chunk) => this._onData(chunk));
  }
  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    if (!this._handshakeDone) {
      const idx = this._buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      this._buf = this._buf.subarray(idx + 4);
      this._handshakeDone = true;
      this.emit("open");
    }
    for (;;) {
      const frame = this._tryParse(this._buf);
      if (!frame) break;
      this._buf = this._buf.subarray(frame.total);
      if (frame.opcode === 0x1) this.emit("message", frame.payload);
    }
  }
  _tryParse(buf) {
    if (buf.length < 2) return null;
    const b1 = buf[1];
    let len = b1 & 0x7f, offset = 2;
    if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
    else if (len === 127) { if (buf.length < 10) return null; len = buf.readUInt32BE(6); offset = 10; }
    if (buf.length < offset + len) return null;
    const payload = buf.subarray(offset, offset + len).toString("utf8");
    return { opcode: buf[0] & 0x0f, payload, total: offset + len };
  }
  send(obj) {
    const str = JSON.stringify(obj);
    const payload = Buffer.from(str, "utf8");
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    let header;
    const len = payload.length;
    if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
    else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
  close() { this.socket.end(); }
}
module.exports = TestClient;
