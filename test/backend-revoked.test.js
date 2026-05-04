/**
 * Tests for the AgentRevokedError detection path in backend.js.
 *
 * We mock global fetch so we can return arbitrary HTTP responses without
 * needing a real backend. The fetch mock is reset before each test.
 */

import { jest } from '@jest/globals';

jest.unstable_mockModule('../src/config.js', () => ({
    default: {
        backendUrl:   'http://localhost',
        agentToken:   'aspos_agt_test',
    },
}));

jest.unstable_mockModule('../src/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
    channelAuth,
    reportHeartbeat,
    reportResult,
    setRevokedHandler,
    AgentRevokedError,
} = await import('../src/backend.js');

function makeResponse(status, body) {
    return {
        status,
        ok:    status >= 200 && status < 300,
        clone: function () { return this; },
        json:  jest.fn().mockResolvedValue(body),
        text:  jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    };
}

function mockFetchOnce(status, body) {
    global.fetch = jest.fn().mockResolvedValueOnce(makeResponse(status, body));
}

// Queue N responses on a single mock so concurrent fetches each get their own.
function mockFetchSequence(...responses) {
    const mock = jest.fn();
    for (const [status, body] of responses) {
        mock.mockResolvedValueOnce(makeResponse(status, body));
    }
    global.fetch = mock;
}

describe('backend: agent_revoked detection', () => {
    let revokedSpy;

    beforeEach(() => {
        revokedSpy = jest.fn();
        setRevokedHandler(revokedSpy);
    });

    afterEach(() => {
        setRevokedHandler(null);
    });

    test('channelAuth throws AgentRevokedError on 410 + agent_revoked body', async () => {
        mockFetchOnce(410, { error: 'agent_revoked' });

        await expect(channelAuth('123.456', 'private-aspos.agents.7'))
            .rejects.toBeInstanceOf(AgentRevokedError);

        expect(revokedSpy).toHaveBeenCalledTimes(1);
    });

    test('reportHeartbeat fires revoked handler on 410 + agent_revoked body', async () => {
        mockFetchOnce(410, { error: 'agent_revoked' });

        await reportHeartbeat();

        expect(revokedSpy).toHaveBeenCalledTimes(1);
    });

    test('reportResult fires revoked handler on 410 + agent_revoked body', async () => {
        mockFetchOnce(410, { error: 'agent_revoked' });

        await reportResult('job_x', 'fail', 'whatever');

        expect(revokedSpy).toHaveBeenCalledTimes(1);
    });

    test('plain 410 without agent_revoked body does NOT trigger handler', async () => {
        // e.g. an upstream proxy returning 410 for an unrelated reason
        mockFetchOnce(410, { error: 'something_else' });

        await reportHeartbeat();

        expect(revokedSpy).not.toHaveBeenCalled();
    });

    test('410 with non-JSON body does NOT trigger handler', async () => {
        global.fetch = jest.fn().mockResolvedValueOnce({
            status: 410,
            ok:     false,
            clone:  function () { return this; },
            json:   jest.fn().mockRejectedValue(new Error('not json')),
            text:   jest.fn().mockResolvedValue('<html>410 Gone</html>'),
        });

        await reportHeartbeat();

        expect(revokedSpy).not.toHaveBeenCalled();
    });

    test('handler fires only once even when multiple endpoints 410 concurrently', async () => {
        // All three concurrent fetches need to actually receive a 410. Queue
        // three responses on one mock — reassigning global.fetch three times
        // would leave only the last assignment, so the first two callers would
        // hit an exhausted mock and not exercise the dedup path.
        mockFetchSequence(
            [410, { error: 'agent_revoked' }],
            [410, { error: 'agent_revoked' }],
            [410, { error: 'agent_revoked' }],
        );

        await Promise.all([
            reportHeartbeat(),
            reportResult('job_a', 'ok'),
            channelAuth('1.2', 'private-aspos.agents.7').catch(() => {}),
        ]);

        expect(global.fetch).toHaveBeenCalledTimes(3);
        expect(revokedSpy).toHaveBeenCalledTimes(1);
    });

    test('200 OK does not trigger handler', async () => {
        mockFetchOnce(200, { auth: 'key:sig' });

        await channelAuth('1.2', 'private-aspos.agents.7');

        expect(revokedSpy).not.toHaveBeenCalled();
    });

    test('401 does not trigger handler (different signal — bad creds, not revoked)', async () => {
        mockFetchOnce(401, { message: 'Unauthenticated.' });

        await reportHeartbeat();

        expect(revokedSpy).not.toHaveBeenCalled();
    });
});
