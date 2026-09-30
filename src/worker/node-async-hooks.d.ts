/* The one node module the Worker uses (nodejs_compat provides it). Declared
   here rather than pulling @types/node into the Worker program, which would
   bring every node global with it. Only what tokens.ts calls. */
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
