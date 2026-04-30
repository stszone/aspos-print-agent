import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import config from './config.js';
import fs from 'node:fs';

fs.mkdirSync('./logs', { recursive: true });

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
            filename:  './logs/agent-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxFiles:  '30d',
            zippedArchive: true,
        }),
    ],
});

export default logger;
