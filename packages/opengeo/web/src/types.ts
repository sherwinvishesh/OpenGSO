/**
 * The shapes the local API returns.
 *
 * Hand-written rather than imported from core: the dashboard is a separate build with a separate
 * tsconfig, and pulling node-targeted source into a browser bundle to reuse a few interfaces would
 * be a bad trade. The API tests in core are what keep these honest.
 */

export type CheckStatus = 'pass' | 'partial' | 'fail' | 'locked' | 'na';
export type CheckImportance = 'required' | 'recommended';

export interface CheckResult {
  id: string;
  category: 'A' | 'B';
  importance: CheckImportance;
  title: string;
  weight: number;
  status: CheckStatus;
  /** 0..weight. A pass earns all of it, a fail none, a partial something in between. */
  earned: number;
  reason: string;
  detail?: string;
  /** partial and fail: the specific next step, priced. */
  fix?: string;
  /** locked: the check whose failure made this one unmeasurable. */
  lockedBy?: string;
}

export interface Score {
  value: number;
  earned: number;
  possible: number;
  counts: { pass: number; partial: number; fail: number; locked: number; na: number };
  lost: Array<{ id: string; points: number }>;
  /** What is waiting behind a failed prerequisite. `count` is zero on a healthy run. */
  locked: { count: number; points: number; unlockedBy: string[] };
}

/** One past run, as `.opengeo/history.json` records it. Local only, never web-served. */
export interface HistoryEntry {
  at: string;
  url: string;
  mode: TestMode;
  score?: number;
  contentScore?: number;
  counts?: { pass: number; partial: number; fail: number; locked: number; na: number };
  lockedPoints?: number;
  failedIds?: string[];
}

export interface History {
  version: number;
  entries: HistoryEntry[];
}

/** One of the five things the model was asked to judge, scored 0-100. */
export interface QualityFinding {
  area: string;
  note: string;
  score?: number;
}

/** One edit to make. `where` locates it in the document; `impact` says what the reader gains. */
export interface QualityRecommendation {
  area: string;
  action: string;
  impact?: string;
  priority: 'high' | 'medium' | 'low';
  where?: string;
  /** Present on the site-wide list, where the same edit may apply to several documents. */
  documents?: string[];
}

export interface QualityReview {
  provider: string;
  model: string;
  /** 0-100 for this document, weighted across the five areas. Never the structural score. */
  score?: number;
  summary: string;
  findings: QualityFinding[];
  recommendations: QualityRecommendation[];
  raw?: string;
}

/** One Markdown document the site serves, and what the model made of it. */
export interface DocumentReview {
  url: string;
  pageUrl?: string;
  source: string;
  words: number;
  review?: QualityReview;
  error?: string;
}

export interface ContentReview {
  provider: string;
  model: string;
  documents: DocumentReview[];
  /** 0-100 across every document reviewed. The second of OpenGEO's two numbers, never merged. */
  score?: number;
  /** Costliest area first: `lost` is what the gap in that area takes off the 100. */
  areaScores: Array<{ area: string; score: number; weight?: number; lost: number; documents: number }>;
  recommendations: QualityRecommendation[];
  notReviewed: number;
}

export interface DiscoveredDocument {
  url: string;
  pageUrl?: string | null;
  source: string;
  bytes: number;
  words: number;
}

export interface DiscoveryResult {
  documents: DiscoveredDocument[];
  /** Candidates that were fetched and turned out not to be Markdown, with the reason. */
  rejected: Array<{ url: string; source: string; reason: string }>;
  overCap: number;
  sources: { llms: boolean; sitemap: boolean };
}

/** structure = the 0-100 checks, content = the AI review of the Markdown, full = both. */
export type TestMode = 'full' | 'structure' | 'content';

export interface TestResponse {
  mode: TestMode;
  url: string;
  /** Absent in `content` mode, which never runs the structural half. */
  twinUrl?: string;
  framework?: { name: string; confidence: string; evidence: string };
  score?: Score;
  checks?: CheckResult[];
  /** Null rather than absent: the API sends every key, so the shape never depends on the mode. */
  content?: ContentReview | null;
  discovery?: DiscoveryResult | null;
  /** Set when the content pass could not run but was not required. Not an error. */
  contentSkipped?: string | null;
  contentError?: string | null;
  /**
   * The history as it stood *before* this run, so the sparkline does not draw the new score twice.
   * `previous` is the last run of this same URL, which is the only one a delta may be drawn against.
   */
  history?: { trend: number[]; previous: HistoryEntry | null };
}

/** The structural half of a run on its own, which is what a `structure-done` frame carries. */
export interface StructurePayload {
  url: string;
  twinUrl: string;
  framework?: { name: string; confidence: string; evidence: string };
  score: Score;
  checks: CheckResult[];
}

/**
 * What the streaming endpoints send while they work. Mirrors `ApiProgress` in core.
 *
 * One union across both pillars, discriminated on `phase`, because the eight names are distinct and
 * a view should not have to be told which endpoint it called to read a frame. The first five belong
 * to a test run and the last three to a generate.
 */
export type ApiProgress =
  | { phase: 'structure' }
  | { phase: 'structure-done'; structure: StructurePayload }
  | { phase: 'discover' }
  | { phase: 'discovered'; documents: number }
  | { phase: 'review'; done: number; total: number; url: string }
  | { phase: 'crawl'; route: string; depth: number; found: number; visited: number }
  | { phase: 'generate'; route: string; index: number; total: number; step: 'fetch' | 'extract' | 'ai' | 'write' }
  | { phase: 'files' };

export type PageStatus = 'written' | 'cached' | 'skipped-manual' | 'proposed' | 'failed';

export interface GeneratePage {
  route: string;
  status: PageStatus;
  tokens: number;
  wordCount: number;
  tier: string;
  warnings: string[];
  reason?: string;
}

export interface SiteFile {
  name: string;
  status: 'written' | 'unchanged' | 'proposed' | 'failed';
  path: string;
  message?: string;
}

export interface GenerateResponse {
  site: string;
  durationMs: number;
  pages: GeneratePage[];
  files: SiteFile[];
  warnings: string[];
  publicDir: string;
}

export type ProbeVerdict = 'pass' | 'fail' | 'warn';

export interface ProdProbe {
  id: string;
  title: string;
  lever: 'routing' | 'negotiation' | 'blocking';
  sent: { url: string; userAgent: string; accept: string };
  status: number;
  verdict: ProbeVerdict;
  reason: string;
  detail?: string;
  headers: Record<string, string>;
  curl: string;
}

export interface ProdResponse {
  target: string;
  twinUrl: string;
  /** The name of the bot whose User-Agent was impersonated for the routing probe. */
  bot: string;
  installed: boolean;
  probes: ProdProbe[];
  robots: { url: string; found: boolean; blocked: string[]; allowed: string[]; notes: string[] };
  conflicts: string[];
  counts: { pass: number; warn: number; fail: number };
  ok: boolean;
}

export interface AiBot {
  name: string;
  vendor: string;
  /** Empty means there is no crawler User-Agent to match, so the bot is robots.txt-only. */
  uaPatterns: string[];
  robotsToken: string;
  kind: BotKind;
  notes?: string;
  /** True for a crawler this project defined itself, rather than one OpenGEO ships with. */
  custom?: boolean;
}

export type BotKind = 'assistant' | 'search' | 'training';

/** What a custom crawler looks like in the config file. Everything but the name is optional. */
export interface CustomBot {
  name: string;
  vendor?: string;
  uaPatterns?: string[];
  robotsToken?: string;
  kind?: BotKind;
  notes?: string;
}

export interface OpenGeoConfig {
  site: string;
  publicDir: string;
  internalDir: string;
  extraRoutes: string[];
  crawl: { maxPages: number; maxDepth: number; exclude: string[] };
  generate: { tier: 'free' | 'ai'; minWords: number };
  bots: { markdownRouting: string[]; blocked: string[]; custom: CustomBot[] };
  ai: { provider: string; model: string; baseUrl?: string; api?: string; auth?: string; headers?: Record<string, string> };
}

/** A row of the provider catalogue, mirrored from core so the picker is never a hardcoded list. */
export interface ProviderInfo {
  id: string;
  label: string;
  api: 'anthropic' | 'openai' | 'gemini';
  baseUrl: string;
  defaultModel: string;
  auth: 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';
  tokenParam: string;
  envVars: string[];
  keysUrl?: string;
  keyless?: boolean;
  userDefined?: boolean;
  note?: string;
}

export interface ManifestPage {
  route: string;
  title: string;
  tokens: number;
  lastUpdated: string;
  tier: string;
}

/** What the URL in onboarding's first field actually answers with. Mirrors `SitePreview` in core. */
export interface SitePreview {
  url: string;
  ok: boolean;
  status: number;
  ttfbMs: number;
  error?: string;
  framework?: string;
  clientRendered?: boolean;
  twin?: { url: string; ok: boolean; status: number; served: boolean };
}

/** Where generated files probably belong, and why. `found: false` is a shrug, not a detection. */
export interface WebRootGuess {
  dir: string;
  why: string;
  found: boolean;
}

export interface State {
  root: string;
  configPath: string;
  configExists: boolean;
  config: OpenGeoConfig;
  version: string;
  packageName: string;
  key: { present: boolean; provider?: string; model?: string; source?: string; path: string };
  ci: boolean;
  providers: string[];
  providerCatalog: ProviderInfo[];
  defaultModels: Record<string, string>;
  manifest?: { generatedAt: string; site: string; pages: ManifestPage[] };
  publicDir: string;
  internalDir: string;
  webRoot: WebRootGuess;
}
