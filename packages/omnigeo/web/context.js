/**
 * What the shell hands every screen, and what a screen hands back. Types only.
 *
 * @import { AiBot, StateResponse, TestResponse } from '../../core/src/shared/api-types.js'
 */

export {};

/** @typedef {'test' | 'generate' | 'prod' | 'bots' | 'settings'} Tab */

/**
 * @typedef {object} Ctx
 * @property {() => StateResponse} state The latest `/api/state`. Read it when drawing, never keep it.
 * @property {() => AiBot[]} bots
 * @property {() => Promise<void>} reload Refetches state and bots, then calls every screen's `update`.
 * @property {(tab: Tab) => void} go
 * @property {() => TestResponse | undefined} lastTest
 * @property {(result: TestResponse) => void} onTestResult
 */

/**
 * A screen is built once and kept. `update` redraws whatever depends on server state, and is called
 * after every reload whether or not the screen is showing, so it is current when it is shown.
 *
 * @typedef {object} View
 * @property {HTMLElement} node
 * @property {() => void} update
 * @property {(key: string) => boolean} [onKey] A single-key shortcut while this screen is showing.
 *   True when the screen used the key.
 */
