/**
 * Registers a resolver so scripts can import the repo's "@/..." modules directly under
 * node --experimental-strip-types. Kept here rather than in a scratch directory so the demo
 * scripts are runnable from a clean checkout.
 */
import './_gate-preflight.mjs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register('./_ts-hook.mjs', pathToFileURL(new URL('.', import.meta.url).pathname));
