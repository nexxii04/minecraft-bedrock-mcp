import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests boot a real RakNet server on UDP and a real Bedrock
    // client against it, so they need a longer budget than unit tests.
    testTimeout: 45_000,
    hookTimeout: 45_000,
    // Serial execution: the integration tests bind UDP sockets and run RakNet
    // handshakes, which do not tolerate several servers competing for a port in
    // the same process.
    fileParallelism: false,
    maxWorkers: 1,
    reporters: ['default'],
  },
});
