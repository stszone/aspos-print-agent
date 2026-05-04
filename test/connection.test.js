/**
 * Tests for AgentConnection reconnect behaviour.
 *
 * We mock pusher-js so there is no real WebSocket traffic.
 */

import { jest } from '@jest/globals';

// --- Pusher mock -------------------------------------------------------
const connectionHandlers = {};
const channelHandlers    = {};
let PusherConstructor;

const mockChannel = {
    bind: jest.fn((event, fn) => { channelHandlers[event] = fn; }),
};
const mockPusher = {
    connection: {
        bind:  jest.fn((event, fn) => { connectionHandlers[event] = fn; }),
        state: 'disconnected',
    },
    subscribe:   jest.fn(() => mockChannel),
    disconnect:  jest.fn(),
};

jest.unstable_mockModule('pusher-js', () => {
    PusherConstructor = jest.fn(() => mockPusher);
    return { default: { Pusher: PusherConstructor }, Pusher: PusherConstructor };
});

// --- Config mock -------------------------------------------------------
jest.unstable_mockModule('../src/config.js', () => ({
    default: {
        reverbAppKey: 'test_key',
        reverbHost:   'localhost',
        reverbPort:   443,
        reverbScheme: 'https',
        agentId:      7,
        backendUrl:   'http://localhost',
        agentToken:   'aspos_agt_test',
        healthPort:   8585,
        logLevel:     'error',
    },
}));

jest.unstable_mockModule('../src/backend.js', () => ({
    channelAuth:  jest.fn().mockResolvedValue({ auth: 'key:sig' }),
    reportResult: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../src/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// --- Import AFTER mocks are registered --------------------------------
const { AgentConnection } = await import('../src/connection.js');

describe('AgentConnection', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        Object.keys(connectionHandlers).forEach(k => delete connectionHandlers[k]);
        Object.keys(channelHandlers).forEach(k => delete channelHandlers[k]);
        // Re-bind mock so fresh call counts are tracked
        mockPusher.connection.bind.mockImplementation((event, fn) => {
            connectionHandlers[event] = fn;
        });
        mockPusher.subscribe.mockReturnValue(mockChannel);
        mockChannel.bind.mockImplementation((event, fn) => {
            channelHandlers[event] = fn;
        });
    });

    test('subscribes to private agent channel on connect', () => {
        const conn = new AgentConnection(jest.fn());
        conn.connect();
        connectionHandlers['connected']?.();
        expect(mockPusher.subscribe).toHaveBeenCalledWith('private-aspos.agents.7');
    });

    test('isConnected is true after connected event', () => {
        const conn = new AgentConnection(jest.fn());
        conn.connect();
        expect(conn.isConnected).toBe(false);
        connectionHandlers['connected']?.();
        expect(conn.isConnected).toBe(true);
    });

    test('isConnected is false after disconnected event', () => {
        const conn = new AgentConnection(jest.fn());
        conn.connect();
        connectionHandlers['connected']?.();
        expect(conn.isConnected).toBe(true);
        connectionHandlers['disconnected']?.();
        expect(conn.isConnected).toBe(false);
        conn.stop(); // cancel pending reconnect timer
    });

    test('schedules reconnect on disconnect', () => {
        jest.useFakeTimers();
        const Pusher = PusherConstructor;
        Pusher.mockClear();

        const conn = new AgentConnection(jest.fn());
        conn.connect();
        connectionHandlers['connected']?.();
        connectionHandlers['disconnected']?.();

        // Initial backoff is 1s
        jest.advanceTimersByTime(1_100);
        expect(Pusher.mock.calls.length).toBeGreaterThanOrEqual(2);

        jest.useRealTimers();
    });

    test('backoff doubles up to 60s max', () => {
        jest.useFakeTimers();
        const conn = new AgentConnection(jest.fn());
        conn.connect();
        connectionHandlers['connected']?.();

        for (let i = 0; i < 10; i++) {
            const delay = conn._backoff;
            connectionHandlers['disconnected']?.();
            jest.advanceTimersByTime(delay + 10);
        }

        expect(conn._backoff).toBeLessThanOrEqual(60_000);
        conn.stop();
        jest.useRealTimers();
    });

    test('stop cancels reconnect and no-ops subsequent events', () => {
        jest.useFakeTimers();
        const conn = new AgentConnection(jest.fn());
        conn.connect();
        connectionHandlers['connected']?.();
        expect(conn.isConnected).toBe(true);
        connectionHandlers['disconnected']?.();
        conn.stop();
        expect(conn._reconnectTimer).toBeNull();
        expect(conn.isConnected).toBe(false);

        // 'connected' fired after stop must not mutate state or call subscribe
        mockPusher.subscribe.mockClear();
        connectionHandlers['connected']?.();
        expect(conn.isConnected).toBe(false);
        expect(mockPusher.subscribe).not.toHaveBeenCalled();

        jest.useRealTimers();
    });

    test('fires onJob callback when PrintJobReady received', async () => {
        const onJob = jest.fn().mockResolvedValue(undefined);
        const conn  = new AgentConnection(onJob);
        conn.connect();
        connectionHandlers['connected']?.();

        const payload = { job_id: 'xyz', driver: 'network_escpos', payload_b64: 'AA==' };
        await channelHandlers['App\\Events\\PrintJobReady']?.(payload);

        expect(onJob).toHaveBeenCalledWith(payload);
    });

    test('onJob errors are caught and logged — not propagated', async () => {
        const { default: logger } = await import('../src/logger.js');
        const boom  = new Error('boom');
        const onJob = jest.fn().mockRejectedValue(boom);
        const conn  = new AgentConnection(onJob);
        conn.connect();
        connectionHandlers['connected']?.();

        const payload = { job_id: 'err-job', driver: 'network_escpos', payload_b64: 'AA==' };

        // Must not throw — errors are swallowed inside connection.js
        await expect(
            Promise.resolve(channelHandlers['App\\Events\\PrintJobReady']?.(payload))
        ).resolves.not.toThrow();

        // Give the microtask queue a tick for the rejection handler to run
        await new Promise(resolve => setImmediate(resolve));

        expect(logger.error).toHaveBeenCalledWith(
            'connection: job handler threw',
            expect.objectContaining({ err: 'boom' })
        );
    });
});
