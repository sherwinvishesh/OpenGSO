/**
 * The shapes the local API returns.
 *
 * Hand-written rather than imported from core: the dashboard is a separate build with a separate
 * tsconfig, and pulling node-targeted source into a browser bundle to reuse a few interfaces would
 * be a bad trade. The API tests in core are what keep these honest.
 */

export type CheckStatus = 'pass' | 'fail' | 'na';
export type CheckImportance = 'required' | 'recommended';

export interface CheckResult {
  id: string;
  category: 'A' | 'B';
  importance: CheckImportance;
  title: string;
  weight: number;
  status: CheckStatus;
  reason: string;
  detail?: string;
}

export interface Score {
  value: number;
  earned: number;
  possible: number;
  counts: { pass: number; fail: number; na: number };
  lost: Array<{ id: string; points: number }>;
}

export interface QualityFinding {
  label: string;
  detail: string;
}

export interface QualityReview {
  provider: string;
  model: string;
  summary: string;
  findings: QualityFinding[];
  suggestions: string[];
  raw?: string;
}

export interface TestResponse {
  url: string;
  twinUrl: string;
  framework?: { name: string; confidence: string; evidence: string };
  score: Score;
  checks: CheckResult[];
  quality?: QualityReview;
  qualityError?: string;
}

export type PageStatus = 'written' | 'cached' | 'skipped-manual' | 'failed';

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
  kind: 'assistant' | 'search' | 'training';
  notes?: string;
}

export interface OpenGeoConfig {
  site: string;
  publicDir: string;
  internalDir: string;
  extraRoutes: string[];
  crawl: { maxPages: number; maxDepth: number; exclude: string[] };
  generate: { tier: 'free' | 'ai'; minWords: number };
  bots: { markdownRouting: string[]; blocked: string[] };
  ai: { provider: 'anthropic' | 'openai' | 'gemini'; model: string };
}

export interface ManifestPage {
  route: string;
  title: string;
  tokens: number;
  lastUpdated: string;
  tier: string;
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
  providers: Array<'anthropic' | 'openai' | 'gemini'>;
  defaultModels: Record<string, string>;
  manifest?: { generatedAt: string; site: string; pages: ManifestPage[] };
  publicDir: string;
  internalDir: string;
}
