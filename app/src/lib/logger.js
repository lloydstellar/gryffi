import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  transport: isDev ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname'
    }
  } : undefined,
  ...(isDev ? {} : {
    formatters: {
      level: (label) => ({ level: label })
    },
    timestamp: pino.stdTimeFunctions.isoTime
  })
});

export default logger;
