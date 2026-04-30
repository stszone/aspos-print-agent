export default {
    testEnvironment:    'node',
    transform:          {},
    testMatch:          ['**/test/**/*.test.js'],
    testTimeout:        15_000,
    setupFiles:         ['./test/setup.js'],
};
