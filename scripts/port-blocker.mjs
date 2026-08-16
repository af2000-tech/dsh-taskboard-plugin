// 端口占用器（测试辅助）：占用指定端口的非 taskboard 哑监听器，用于降级/收养误判演练。
// 用法：node scripts/port-blocker.mjs [port]（默认 47911）。Ctrl-C 或 kill 结束。
import { createServer } from "node:http";

const port = Number.parseInt(process.argv[2] ?? "47911", 10);
if (!Number.isInteger(port) || port <= 0 || port > 65536) {
  console.error(`invalid port: ${process.argv[2]}`);
  process.exit(2);
}
const server = createServer({ allowHalfOpen: false }, (req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("blocker\n");
});
server.on("connection", (socket) => setTimeout(() => socket.destroy(), 5000));
server.listen(port, "127.0.0.1", () => console.log(`blocker listening on ${port}`));
