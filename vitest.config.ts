import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['server/**/*.test.ts', 'src/**/*.test.ts'], fileParallelism: false, testTimeout: 30000, hookTimeout: 60000, coverage: { provider: 'v8', include: ['server/policy.ts', 'server/routes.ts'], reporter: ['text', 'html'] } } });
