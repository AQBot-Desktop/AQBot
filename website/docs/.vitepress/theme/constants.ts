export const APP_VERSION = '0.0.152';

export const GITHUB_REPO = 'https://github.com/AQBot-Desktop/AQBot';
export const GITHUB_RELEASES = `${GITHUB_REPO}/releases`;
export const GITHUB_RELEASE_TAG = `${GITHUB_RELEASES}/tag/v${APP_VERSION}`;

export const RELEASE_DOWNLOAD_BASE = `${GITHUB_REPO}/releases/download/v${APP_VERSION}`;

export function releaseAssetUrl(filename: string): string {
  return `${RELEASE_DOWNLOAD_BASE}/${filename}`;
}

export const SITE_URL = 'https://app.aqbot.top';
