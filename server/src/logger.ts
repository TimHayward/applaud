import pino from "pino";
import { logPath } from "./paths.js";

const level = process.env.LOG_LEVEL ?? "info";

const isTTY = process.stdout.isTTY;

export const logger = isTTY
  ? pino({
      level,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
      },
    })
  : pino({ level }, pino.destination({ dest: logPath(), sync: false, mkdir: true }));
