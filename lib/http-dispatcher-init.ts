// Load this module before TanStack/h3 so undici.install() replaces Response first.
import { configureHttpDispatcher } from "./http-dispatcher.ts";

configureHttpDispatcher();
