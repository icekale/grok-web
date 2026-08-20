import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start";
import { getApiMethodRejection } from "./api-methods";
import { runRequestSecurityFromContext } from "./request-peer.server";

const requestSecurityMiddleware = createMiddleware().server(async ({ next, request }) => {
  return runRequestSecurityFromContext(request, () => next());
});

const apiMethodGuardMiddleware = createMiddleware().server(async ({ next, request }) => {
  const rejection = getApiMethodRejection(request);
  return rejection ?? next();
});

const serverFunctionCsrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [
    requestSecurityMiddleware,
    apiMethodGuardMiddleware,
    serverFunctionCsrfMiddleware,
  ],
}));
