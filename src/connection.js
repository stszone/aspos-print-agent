/**
 * Reverb WebSocket connection manager.
 *
 * Connects to the ASPOS Reverb server using the Pusher protocol via pusher-js.
 * Subscribes to the private agent channel and emits job events.
 * Reconnects with exponential backoff (1s → 60s max) on disconnect.
 */

import { channelAuth }   from './backend.js';
import config          from './config.js';
import logger          from './logger.js';

const PusherModule = await import('pusher-js');
const Pusher = PusherModule.default?.Pusher ?? PusherModule.default ?? PusherModule.Pusher ?? PusherModule;

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export class AgentConnection {
    /**
     * @param {(job: object) => Promise<void>} onJob — called for each received job
     */
    constructor(onJob) {
        this._onJob       = onJob;
        this._pusher      = null;
        this._channel     = null;
        this._backoff     = MIN_BACKOFF_MS;
        this._stopped     = false;
        this._connected   = false;
        this._reconnectTimer = null;
    }

    get isConnected() {
        return this._connected;
    }

    async connect() {
        if (this._stopped) return;
        if (this._pusher) return;

        logger.info('connection: connecting to Reverb', {
            host: config.reverbHost,
            port: config.reverbPort,
        });

        this._pusher = new Pusher(config.reverbAppKey, {
            wsHost:    config.reverbHost,
            wsPort:    config.reverbPort,
            wssPort:   config.reverbPort,
            forceTLS:  config.reverbScheme === 'https',
            cluster:   '',
            enabledTransports: ['ws', 'wss'],
            authorizer: (channel) => ({
                authorize: (socketId, callback) => {
                    channelAuth(socketId, channel.name)
                        .then(data  => callback(null, data))
                        .catch(err  => callback(err, null));
                },
            }),
        });

        this._pusher.connection.bind('connected', () => {
            if (this._stopped) return;
            logger.info('connection: connected');
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
            this._connected = true;
            this._backoff = MIN_BACKOFF_MS;
            this._subscribe();
        });

        this._pusher.connection.bind('disconnected', () => {
            logger.warn('connection: disconnected');
            this._connected = false;
            this._scheduleReconnect();
        });

        this._pusher.connection.bind('error', (err) => {
            logger.error('connection: error', { err: err?.error?.data?.message ?? err });
            this._connected = false;
            this._scheduleReconnect();
        });
    }

    _subscribe() {
        const channelName = `private-aspos.agents.${config.agentId}`;
        this._channel?.unbind_all?.();
        this._channel = this._pusher.subscribe(channelName);

        this._channel.bind('pusher:subscription_error', (status) => {
            logger.error('connection: subscription auth failed', { status });
        });

        this._channel.bind('pusher:subscription_succeeded', () => {
            logger.info('connection: subscribed', { channel: channelName });
        });

        // PrintJobReady events broadcast by DispatchPrintJob.
        // The backend's PrintJobReady::broadcastAs() returns 'print_job.ready'
        // — that's the wire name. Listening on the FQCN App\Events\PrintJobReady
        // would silently never fire (Reverb doesn't auto-alias).
        this._channel.bind('print_job.ready', (data) => {
            logger.info('connection: received PrintJobReady', { job_id: data?.job_id });
            Promise.resolve(this._onJob(data)).catch(err =>
                logger.error('connection: job handler threw', { err: err.message }),
            );
        });
    }

    _scheduleReconnect() {
        if (this._stopped) return;
        if (this._reconnectTimer) return; // already scheduled

        logger.info('connection: reconnecting in', { ms: this._backoff });

        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._cleanup();
            this.connect();
        }, this._backoff);

        // Exponential backoff with cap
        this._backoff = Math.min(this._backoff * 2, MAX_BACKOFF_MS);
    }

    _cleanup() {
        if (this._pusher) {
            try { this._pusher.disconnect(); } catch (_) {}
            this._pusher  = null;
            this._channel = null;
        }
    }

    stop() {
        this._stopped = true;
        this._connected = false;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        this._cleanup();
        logger.info('connection: stopped');
    }
}
