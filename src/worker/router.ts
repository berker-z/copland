/* ============================================================================
   A small router: method + path pattern → handler with named params.
   ----------------------------------------------------------------------------
   index.ts was a handful of regexes and a switch, and said the next
   parameterised path should come with a real one. This is deliberately tiny:
   ":name" segments capture one path segment of id characters, nothing else
   is special, and the first pattern that matches wins. A path that matches
   no pattern at all is a 404; a path that matches a pattern under a different
   method is also a 404, as before. Anything more would be a dependency.
   ========================================================================== */

export type Params = Record<string, string>;

export interface Route<C> {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: (ctx: C, params: Params) => Promise<Response>;
}

/** Ids are uuids or seed slugs; anything else is not a route we serve. */
const ID = "[A-Za-z0-9_-]+";

/**
 * Compile "/api/boards/:id/tasks" into a regex plus the capture names. The
 * literal parts are escaped so a dot in a path is a dot.
 */
function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        keys.push(segment.slice(1));
        return `(${ID})`;
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { pattern: new RegExp(`^${source}$`), keys };
}

export class Router<C> {
  private readonly routes: Route<C>[] = [];

  on(method: string, path: string, handler: Route<C>["handler"]): this {
    const { pattern, keys } = compile(path);
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  /** The matching route's response, or null when nothing matched. */
  dispatch(method: string, pathname: string, ctx: C): Promise<Response> | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      const params: Params = {};
      route.keys.forEach((key, i) => {
        params[key] = match[i + 1];
      });
      return route.handler(ctx, params);
    }
    return null;
  }
}
