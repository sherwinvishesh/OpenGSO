/**
 * Every shape that crosses the dashboard's HTTP boundary, in one place (§8).
 *
 * The dashboard is plain JavaScript in a browser and type-checks against this file with no Node
 * types at all, so it can read exactly what the server sends without keeping a copy that drifts.
 * That is the whole reason this module exists, and it sets the one rule for it: types only, no
 * runtime code, and every `@import` here names a module that never touches Node, jsdom or the
 * network. `api-types.test.js` walks the import graph from this file and fails if that changes.
 *
 * The modules that produce these values re-export each name as a typedef, so the server side
 * keeps importing them from where they are made.
 */

export {};

// -- from the Node-free modules they are made in ------------------------------------------------

// Aliases rather than `@import`, which would keep each name private to this file. The dashboard
// needs them too, and this is the one module it is allowed to read.

/**
 * @typedef {import('../test/checks.js').CheckResult} CheckResult
 * @typedef {import('../test/score.js').Score} Score
 * @typedef {import('../test/framework.js').Framework} Framework
 * @typedef {import('./bots.js').AiBot} AiBot
 * @typedef {import('./bots.js').CustomBotInput} CustomBotInput
 * @typedef {import('./providers.js').AiProvider} AiProvider
 * @typedef {import('./providers.js').ProviderApi} ProviderApi
 * @typedef {import('./providers.js').ProviderAuth} ProviderAuth
 * @typedef {import('./providers.js').ProviderInfo} ProviderInfo
 */

// -- config --------------------------------------------------------------------------------------

/**
 * @typedef {object} OmniGeoConfig
 * @property {string} site Base URL the project is generated/tested against. Also the default for a
 *   bare `omnigeo test`.
 * @property {string} [publicOrigin] Where the site is deployed, e.g. `https://example.com`. Every
 *   absolute URL generate writes (sitemap, robots.txt, llms.txt, twin frontmatter and links) uses
 *   it instead of the origin that was crawled, which is usually a dev server.
 * @property {string} publicDir Web root, relative to the project. Everything generate writes lands
 *   here: twins in `md/` for a crawled site, beside each page for one generated from its files.
 * @property {string} internalDir Bookkeeping that must NOT be web-served: the manifest and the
 *   content-hash cache.
 * @property {string[]} extraRoutes Routes the `<a href>` crawl can't reach. The escape hatch for
 *   §17's route-discovery ceiling.
 * @property {object} crawl
 * @property {number} crawl.maxPages
 * @property {number} crawl.maxDepth
 * @property {string[]} crawl.exclude Path prefixes to skip, in addition to the built-in
 *   asset/anchor filtering.
 * @property {object} generate
 * @property {'free' | 'ai'} generate.tier 'free' is algorithmic and needs no key. 'ai' is BYOK and
 *   local-machine-only.
 * @property {number} generate.minWords Below this word count an extracted page gets a low-content
 *   warning (§17 CSR ceiling).
 * @property {'url' | 'files'} [generate.source] Where generate reads the pages from. `url` (the
 *   default) crawls `site`. `files` reads the HTML files in `publicDir` instead, for a site that is a
 *   folder of pages rather than a running server, and writes each twin beside its page.
 * @property {object} bots
 * @property {string[]} bots.markdownRouting Lever 1 (§7): which AI agents receive the markdown
 *   twin. Never blocks anyone - an unlisted bot simply sees the normal site.
 * @property {string[]} bots.blocked Lever 2 (§7): a separate, opt-in list of bots to disallow in
 *   robots.txt. Empty by default; blocking is never the default.
 * @property {CustomBotInput[]} bots.custom Crawlers this project knows about that OmniGEO's shipped
 *   list does not: an in-house agent, or an AI product newer than the installed version. They
 *   behave exactly like built-in entries - both levers apply to them - and naming one in
 *   `markdownRouting` is what turns it on.
 * @property {object} ai Which AI tool `generate --tier ai` and `test --content` talk to.
 *
 *   The optional fields are the "bring your own provider" surface: name any endpoint that speaks
 *   one of the three API shapes and OmniGEO will use it, with no code change and no wait for a
 *   release. They are honoured for built-in providers too, because the usual reason to set
 *   `baseUrl` is a company gateway mirroring a vendor's API rather than a brand-new vendor.
 * @property {AiProvider} ai.provider
 * @property {string} ai.model
 * @property {string} [ai.baseUrl] Overrides the catalogue's endpoint. Required when provider is
 *   `custom`.
 * @property {ProviderApi} [ai.api] Which wire format that endpoint speaks. Defaults to the
 *   provider's own.
 * @property {ProviderAuth} [ai.auth] How the key is attached. Defaults to the provider's own.
 *   `none` sends no key at all.
 * @property {Record<string, string>} [ai.headers] Extra request headers the endpoint needs, e.g. a
 *   gateway's tenant id. Never the key.
 * @property {Record<string, unknown>} [ai.params] Extra fields for the request body, merged over the
 *   ones the catalogue sends for the provider's default model: a reasoning setting, a temperature, a
 *   vendor's own switch. A `null` removes a field the catalogue would have sent. The model, the
 *   messages and `stream` cannot be set here.
 */

// -- site preview --------------------------------------------------------------------------------

/**
 * @typedef {object} SitePreview
 * @property {string} url
 * @property {boolean} ok The page answered with a 2xx.
 * @property {number} status
 * @property {number} ttfbMs
 * @property {string} [error] Set when the request never completed: DNS, connection refused, a
 *   timeout.
 * @property {string} [framework] A human name for what is serving the page, when the response
 *   gives it away.
 * @property {boolean} [clientRendered] The raw HTML is an empty mount element, so `generate` will
 *   find nothing to convert.
 * @property {{ url: string; ok: boolean; status: number; served: boolean }} [twin] What is already
 *   at the `.md` URL, if anything.
 */

/**
 * @typedef {object} WebRootGuess
 * @property {string} dir
 * @property {string} why Why this directory, in the half-sentence a prompt can afford to show.
 * @property {boolean} found False when nothing pointed here and the default is being offered for
 *   want of anything better.
 */

// -- test ----------------------------------------------------------------------------------------

/** @typedef {'full' | 'structure' | 'content'} TestMode */

/**
 * @typedef {object} HistoryEntry
 * @property {string} at ISO timestamp of when the run finished.
 * @property {string} url
 * @property {TestMode} mode
 * @property {number} [score] The structural 0-100. Absent in `content` mode, which never runs the checks.
 * @property {number} [contentScore] The content 0-100, kept separate from the structural one exactly as §5 requires.
 * @property {{ pass: number; partial: number; fail: number; locked: number; na: number }} [counts]
 * @property {{ adopted: number; count: number }} [suggestions] How many of the suggestions outside the score the site had
 *   adopted, so the home screen can show the second number without re-running anything.
 * @property {string[]} [failedIds] Ids of the checks that actually failed, so a delta can say what changed rather than only by how much.
 */

/**
 * @typedef {object} History
 * @property {number} version
 * @property {HistoryEntry[]} entries
 */

/** @typedef {'high' | 'medium' | 'low'} Priority */

/**
 * One thing to change, in the imperative.
 *
 * The shape is what makes a recommendation usable rather than decorative: `action` is the edit,
 * `where` is the place in the document to make it, and `impact` is what the reader gains. A model
 * that answers "improve clarity" fails all three, which is why the prompt asks for them by name.
 *
 * @typedef {object} QualityRecommendation
 * @property {string} area Which of the five areas this lifts. Free text, because a model may name its own.
 * @property {string} action The edit to make, in the imperative: "Add the billing period to each plan".
 * @property {string} [impact] What a reader gains. Absent when the model gave only the action.
 * @property {Priority} priority
 * @property {string} [where] A heading or quoted phrase locating the edit. Absent when the change is document-wide.
 */

/**
 * @typedef {object} QualityFinding
 * @property {string} area Short label, normally one of the five area labels.
 * @property {string} note The model's read on this area, in one or two sentences.
 * @property {number} [score] 0-100 for this area alone. Optional: a reply that omitted it still renders.
 */

/**
 * @typedef {object} QualityReview
 * @property {number} [score] 0-100 for this document. Derived from the findings, never asked for directly.
 * @property {string} summary
 * @property {QualityFinding[]} findings
 * @property {QualityRecommendation[]} recommendations
 * @property {AiProvider} provider
 * @property {string} model
 * @property {string} [raw] Set when the model answered but not in the shape asked for. The raw text is still shown.
 */

/**
 * The content pass over every document the structural pass found.
 *
 * One call per document, because a single call carrying ten documents produces ten shallow
 * paragraphs and one exhausted context window. Documents are reviewed a few at a time and a failure
 * on one is recorded against that document rather than losing the rest.
 *
 * @typedef {object} DocumentReview
 * @property {string} url
 * @property {string} [pageUrl]
 * @property {string} source
 * @property {number} words
 * @property {QualityReview} [review]
 * @property {string} [error] Set when this one document could not be reviewed. The rest of the run still stands.
 */

/**
 * One area, averaged across every document that scored it, with what the gap is costing.
 *
 * @typedef {object} AreaScore
 * @property {string} area
 * @property {number} score 0-100, the mean across documents.
 * @property {number} [weight] Out of 100. Absent for an area the model invented, which therefore costs nothing.
 * @property {number} lost Points off the content score this area is responsible for. `weight * (100 - score) / 100`.
 * @property {number} documents
 */

/**
 * A recommendation after the same edit has been collapsed across the documents that need it.
 *
 * @typedef {QualityRecommendation & {
 *   documents: string[]; // Every document this edit applies to. One entry is the normal case.
 * }} AggregatedRecommendation
 */

/**
 * @typedef {object} ContentReview
 * @property {AiProvider} provider
 * @property {string} model
 * @property {DocumentReview[]} documents
 * @property {number} [score] 0-100 across the whole site's Markdown, and never mixed into the structural score. The mean of
 *   the per-document scores, so ten strong pages are not rescued by one perfect one.
 * @property {AreaScore[]} areaScores Per-area means across every document that scored that area, weakest first.
 * @property {AggregatedRecommendation[]} recommendations Every recommendation, deduplicated across documents and ordered by priority.
 * @property {number} notReviewed Documents found but not reviewed because of `maxDocuments`.
 * @property {string} [halted] Set when the provider answered in a way that holds for every document (a refused key, no credit,
 *   no such model) and the remaining documents were never sent.
 */

/**
 * The structural half of a run, in the shape the dashboard reads it at the top level.
 *
 * @typedef {object} StructurePayload
 * @property {string} url
 * @property {string} twinUrl
 * @property {Framework} [framework]
 * @property {Score} score
 * @property {CheckResult[]} checks
 * @property {FixPrompts} [prompts]
 */

/**
 * Ready-to-paste prompts for a coding agent, built on the server by the same code as `--prompt`.
 * `groups` has a key only for a group with work in it, and `checks` one only for a check that failed
 * or partly passed.
 *
 * @typedef {object} FixPrompts
 * @property {string} all
 * @property {string} summary What `all` asks for, as "2 fixes and 6 suggestions".
 * @property {Partial<Record<'failed' | 'partial' | 'suggestions' | 'locked', string>>} groups
 * @property {Record<string, string>} checks
 */

/**
 * What `POST /api/test` answers with. The structural fields sit at the top level and are absent
 * in `content` mode, which never runs the checks.
 *
 * @typedef {Partial<StructurePayload> & {
 *   mode: TestMode;
 *   url: string;
 *   history: { trend: number[]; previous: HistoryEntry | null };
 *   structure: unknown;
 *   content: ContentReview | null;
 *   discovery: {
 *     documents: Array<{ url: string; pageUrl: string | null; source: string; bytes: number; words: number }>;
 *     rejected: Array<{ url: string; source: string; reason: string }>;
 *     overCap: number;
 *     sources: { llms: boolean; sitemap: boolean };
 *   } | null;
 *   contentSkipped: string | null;
 *   contentError: string | null;
 * }} TestResponse
 */

// -- generate ------------------------------------------------------------------------------------

/** @typedef {'free' | 'ai' | 'manual'} GenerationTier */

/** @typedef {'written' | 'cached' | 'skipped-manual' | 'proposed' | 'failed'} PageStatus */

/**
 * @typedef {object} GeneratePageResult
 * @property {string} route
 * @property {string} url
 * @property {PageStatus} status
 * @property {string} [title]
 * @property {string} [description]
 * @property {GenerationTier} [tier]
 * @property {string} [file]
 * @property {string} [sourceFile] The HTML file the page was read from, relative to the web root.
 *   Only on a run that read the site's files.
 * @property {number} [tokens]
 * @property {number} [wordCount]
 * @property {string[]} warnings
 * @property {string} [reason]
 */

/**
 * Why a twin no longer matches the HTML file it was made from.
 *
 * - `changed`: the file is different from the one the twin was made from.
 * - `manual`: the file was modified after a hand-written twin was last saved, so the twin may be
 *   behind. OmniGEO never rewrites a hand-written twin, so only its author can bring it up to date.
 * - `missing`: the file is gone, so the twin describes a page that no longer exists.
 * - `new`: a page with no twin at all.
 *
 * @typedef {'changed' | 'manual' | 'missing' | 'new'} StaleKind
 */

/**
 * @typedef {object} StaleTwin
 * @property {StaleKind} kind
 * @property {string} sourceFile The HTML file, relative to the web root.
 * @property {string} [route]
 * @property {string} [twin] The twin, relative to the web root. Absent for a `new` page.
 * @property {string} [sourceModified] When the HTML file was last modified, as it is on disk now.
 * @property {string} [twinWritten] When the twin was last written.
 * @property {string} message One sentence for a person, naming both files and both times.
 */

/**
 * Whether the twins still match the HTML files they were made from. Only a project that generates
 * from its files has an answer; a crawled one is checked by test's drift check (B14) instead.
 *
 * @typedef {object} FreshnessReport
 * @property {number} checked How many twins were compared with their file.
 * @property {StaleTwin[]} stale
 */

/** @typedef {'robots.txt' | 'llms.txt' | 'sitemap.xml'} SiteFileName */
/** @typedef {'written' | 'unchanged' | 'proposed' | 'failed'} SiteFileStatus */

/**
 * @typedef {object} SiteFileResult
 * @property {SiteFileName} name
 * @property {string} path Absolute path actually written, which is the `.omnigeo-proposed` path when
 *   status is proposed.
 * @property {SiteFileStatus} status
 * @property {string} [message] Populated for `proposed` and `failed`, using the shared §13 copy.
 */

/**
 * @typedef {object} GenerateResponse
 * @property {string} site
 * @property {number} durationMs
 * @property {GeneratePageResult[]} pages
 * @property {SiteFileResult[]} files
 * @property {string[]} warnings
 * @property {string[]} [notes] Worth knowing and not a problem, such as where the public address came
 *   from. Only a run from files has any.
 * @property {string} publicDir
 * @property {'url' | 'files'} source
 */

// -- prod ----------------------------------------------------------------------------------------

/** @typedef {'pass' | 'fail' | 'warn'} ProbeVerdict */
/** @typedef {'routing' | 'negotiation' | 'blocking'} LeverId */

/**
 * @typedef {object} ProdProbe
 * @property {string} id
 * @property {string} title
 * @property {LeverId} lever
 * @property {{ url: string; userAgent: string; accept: string }} sent Exactly what was sent, so a
 *   reader can reproduce the result by hand.
 * @property {number} status
 * @property {ProbeVerdict} verdict
 * @property {string} reason
 * @property {string} [detail]
 * @property {Record<string, string>} headers The §7 headers that came back. Only the ones OmniGEO
 *   has an opinion about.
 * @property {string} curl
 */

/**
 * @typedef {object} RobotsReport
 * @property {string} url
 * @property {boolean} found
 * @property {string[]} blocked
 * @property {string[]} allowed
 * @property {string[]} notes
 */

/**
 * @typedef {object} ProdVerification
 * @property {string} target
 * @property {string} twinUrl
 * @property {string} bot The bot whose User-Agent was impersonated for the routing probe.
 * @property {boolean} installed True when at least one response carried `X-AEO-Version`, i.e. prod
 *   answered at all.
 * @property {ProdProbe[]} probes
 * @property {RobotsReport} robots
 * @property {string[]} conflicts Places where the two levers contradict each other. Empty is the
 *   healthy case.
 * @property {{ pass: number; warn: number; fail: number }} counts
 * @property {boolean} ok
 */

// -- progress ------------------------------------------------------------------------------------

/**
 * What a streaming endpoint sends while it works.
 *
 * Its own union rather than `SuiteProgress | SiteProgress` forwarded raw. `structure-done` carries
 * the whole `TestResult`, evidence included, which is every byte of every document the probe
 * fetched plus a `URL` object that does not survive `JSON.stringify`. The frame a browser needs is
 * the flattened structural payload the final response already sends, so it is built once, here.
 *
 * Discriminated on `phase`, and the eight names are distinct across both pillars, so a client can
 * switch on one field without being told which endpoint it called.
 *
 * @typedef {{ phase: 'structure' }
 *   | { phase: 'structure-done'; structure: StructurePayload }
 *   | { phase: 'discover' }
 *   | { phase: 'discovered'; documents: number }
 *   | { phase: 'review'; done: number; total: number; url: string }
 *   | { phase: 'crawl'; route: string; depth: number; found: number; visited: number }
 *   | { phase: 'generate'; route: string; index: number; total: number; step: 'fetch' | 'extract' | 'ai' | 'write' }
 *   | { phase: 'files' }} ApiProgress
 */

/**
 * The last frame of a `/stream` endpoint: the status and body the plain endpoint would have sent.
 *
 * @typedef {object} StreamDone
 * @property {number} status
 * @property {unknown} body
 */

// -- state and the rest --------------------------------------------------------------------------

/**
 * Score thresholds. A score at or above `good` is good, at or above `fair` is fair, and anything
 * lower is poor.
 *
 * @typedef {object} BandThresholds
 * @property {number} good
 * @property {number} fair
 */

/**
 * @typedef {object} StateResponse
 * @property {string} root
 * @property {string} configPath
 * @property {boolean} configExists
 * @property {OmniGeoConfig} config
 * @property {string} version
 * @property {string} packageName
 * @property {{ present: boolean; provider?: AiProvider; model?: string; source?: string; path: string }} key
 *   Presence only. The value never crosses this boundary, not even to localhost.
 * @property {boolean} ci
 * @property {WebRootGuess} webRoot Where generated files probably belong, worked out from the
 *   project rather than asked.
 *
 *   Part of the state rather than its own endpoint because it is a fact about the directory the
 *   server was pointed at, known before anybody types anything, and onboarding needs it on the
 *   first screen. `found: false` means nothing pointed anywhere and the usual answer is being
 *   offered for want of better, which is worth saying differently in the UI.
 * @property {AiProvider[]} providers
 * @property {Record<AiProvider, string>} defaultModels
 * @property {ProviderInfo[]} providerCatalog The full catalogue, so the dashboard renders real names
 *   and "get a key" links instead of a dropdown of lowercase ids, and knows which entries need an
 *   endpoint typed in.
 * @property {{
 *   generatedAt: string;
 *   site: string;
 *   source: 'url' | 'files';
 *   pages: Array<{ route: string; title: string; tokens: number; lastUpdated: string; tier: string; file: string; sourceFile?: string }>;
 * }} [manifest]
 * @property {string} publicDir
 * @property {string} internalDir
 * @property {FreshnessReport} [freshness] Present when the twins were made from the project's own
 *   HTML files, which is the only case where "this page changed after its twin" can be read off disk.
 * @property {number} checkCount How many structural checks a run makes. Sent rather than retyped,
 *   so the dashboard's copy cannot fall behind the suite.
 * @property {{ structural: BandThresholds; content: BandThresholds }} bands The same thresholds the
 *   terminal colours a score by, for the same reason.
 * @property {string} defaultBot The crawler `prod test` impersonates when none is named.
 */

/**
 * @typedef {object} PreviewResponse
 * @property {SitePreview} preview
 */

/**
 * @typedef {object} BotsResponse
 * @property {AiBot[]} bots
 */

/**
 * @typedef {object} ConfigResponse
 * @property {OmniGeoConfig} config
 * @property {string} configPath
 */

/**
 * What `POST /api/key` reports. Where the key went, never the key.
 *
 * @typedef {object} KeyResponse
 * @property {AiProvider} provider
 * @property {string} model
 * @property {boolean} keyless
 * @property {string} [baseUrl]
 * @property {string} envPath
 * @property {string} gitignorePath
 * @property {boolean} gitignoreAdded
 */

/**
 * @typedef {object} FileResponse
 * @property {string} path
 * @property {string} content
 */

/**
 * Every refusal has an `error`. The two flags mark the refusals a client acts on differently.
 *
 * @typedef {object} ErrorBody
 * @property {string} error
 * @property {boolean} [needsKey] Generate's AI tier was asked for with no key configured.
 * @property {boolean} [configBroken] `omnigeo.config.json` exists and cannot be read.
 */
