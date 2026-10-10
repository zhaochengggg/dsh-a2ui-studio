export default {
  esbuild: {jsx: 'automatic'},
  test: {
    include: ['apps/tests/**/*.spec.ts', 'apps/tests/**/*.spec.tsx', 'tests/**/*.spec.tsx'],
    testTimeout: 15000,
    maxWorkers: 2,
  },
};
