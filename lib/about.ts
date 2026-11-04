// Settings → Über Flowplan: version, licence, source and the sponsor link,
// decided on the server so the page shows the right thing at once.
//
// - The source link (AGPL-3.0 §13: whoever runs modified code offers *its*
//   source) is the official repository unless FLOWPLAN_SOURCE_URL names
//   another http(s) address. It is always shown, as is the licence.
// - The sponsor link is hidden with FLOWPLAN_HIDE_SPONSOR=true and always
//   inside the iPhone, iPad and Android apps (store rules on links to tips
//   outside the store). The app names itself in its user agent
//   ("FlowplanMobile/<version>", lib/app-safe-areas.ts); the page checks
//   window.FlowplanApp as well (hideSponsorInPage). Browsers and the desktop
//   app show it.
import { buildInfo } from "./build-info";

// No server-only imports: the settings page and the sign-in page use the
// addresses below as well.
export const GITHUB_URL = "https://github.com/yannicschuller/flowplan";

export const LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";
export const SPONSOR_URL = "https://github.com/sponsors/yannicschuller";
export const DISCORD_URL = "https://discord.gg/bCEdB6MPrR";
export const ISSUES_URL = `${GITHUB_URL}/issues`;

export type ReleaseChannel = "beta" | "release" | "";

export type AboutInfo = {
  version: string;
  commit: string;
  builtAt: string;
  // From the image build (FLOWPLAN_CHANNEL, .github/workflows/docker.yml);
  // "" when not known (development, own builds).
  channel: ReleaseChannel;
  // The source of the running code; `customSource`: FLOWPLAN_SOURCE_URL.
  sourceUrl: string;
  customSource: boolean;
  // Link to the commit, only on the official repository.
  commitUrl: string;
  sponsor: boolean;
};

type Env = Record<string, string | undefined>;

const yes = (value: string | undefined) => /^(1|true|yes|on)$/i.test((value || "").trim());

// The configured source address, or null when none (or no http(s) one).
function customSourceUrl(env: Env) {
  const v = (env.FLOWPLAN_SOURCE_URL || "").trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(v) ? v.replace(/\/+$/, "") : null;
}

export const sourceUrl = (env: Env = process.env) => customSourceUrl(env) || GITHUB_URL;

// The user agent of the mobile apps' web view.
export const nativeAppAgent = (agent: string | null | undefined) => /\bFlowplanMobile\//.test(agent || "");

export function sponsorVisible(env: Env = process.env, agent?: string | null) {
  return !yes(env.FLOWPLAN_HIDE_SPONSOR) && !nativeAppAgent(agent);
}

// The image build sets FLOWPLAN_CHANNEL (next.config.ts bakes it in); a
// value given at runtime wins.
export function releaseChannel(value: string | undefined): ReleaseChannel {
  const c = (value || "").trim().toLowerCase();
  return c === "beta" || c === "release" ? c : "";
}

export function aboutInfo(agent?: string | null, env: Env = process.env): AboutInfo {
  const build = buildInfo();
  const custom = customSourceUrl(env);
  return {
    version: build.version,
    commit: build.commit,
    builtAt: build.builtAt,
    channel: releaseChannel(env.FLOWPLAN_CHANNEL ?? process.env.FLOWPLAN_CHANNEL),
    sourceUrl: custom || GITHUB_URL,
    customSource: !!custom,
    commitUrl: build.commit && !custom ? `${build.repository}/commit/${build.commit}` : "",
    sponsor: sponsorVisible(env, agent),
  };
}

// In the page: the server may not have seen the app's user agent (an older
// app, a proxy rewriting it) – the bridge hides the link as well.
export function hideSponsorInPage(host: { FlowplanApp?: unknown } | undefined = typeof window === "undefined" ? undefined : (window as never)) {
  return !!host?.FlowplanApp;
}
