import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import config from './config.js';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.join(__dirname, '..', 'logs');

fs.mkdirSync(logsDir, { recursive: true });

const logger = winston.createLogger({
    level: config.logLevel,
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple(),
            ),
        }),
        new DailyRotateFile({
            filename:  path.join(logsDir, 'agent-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            maxFiles:  '30d',
            zippedArchive: true,
        }),
    ],
});

export default logger;
