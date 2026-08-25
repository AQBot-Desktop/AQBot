import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import ar from '../locales/ar.json';
import de from '../locales/de.json';
import enUS from '../locales/en-US.json';
import es from '../locales/es.json';
import fr from '../locales/fr.json';
import hi from '../locales/hi.json';
import ja from '../locales/ja.json';
import ko from '../locales/ko.json';
import ru from '../locales/ru.json';
import zhCN from '../locales/zh-CN.json';
import zhTW from '../locales/zh-TW.json';

const locales = {
  ar,
  de,
  'en-US': enUS,
  es,
  fr,
  hi,
  ja,
  ko,
  ru,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

const languageNeutralKeys = new Set([
  'app.name',
  'gateway.cliProtocolHttp',
  'gateway.cliProtocolHttps',
  'settings.selectionToolbar.searchPresets.google',
  'settings.selectionToolbar.searchPresets.baidu',
  'settings.selectionToolbar.searchPresets.bing',
  'settings.agentWorkspaceNameStrategyUuid',
  'settings.proxyHttp',
  'settings.proxySocks5',
  'settings.github',
  'settings.extraBodyPlaceholder',
  'settings.searchProviders.zhipu',
  'settings.searchProviders.bocha',
  'settings.titlebarIcon.github',
  'settings.cherryImport.source',
  'settings.kelivoImport.source',
  'tray.github',
  'skills.source.aqbot',
  'skills.source.codex',
  'skills.source.claude',
  'imageProtocol.auth.bearer',
  'drawing.option.outputFormat.png',
  'drawing.option.outputFormat.jpeg',
  'drawing.option.outputFormat.webp',
  'drawing.option.referenceImageMode.multipart',
  'drawing.option.referenceImageMode.base64',
  'drawing.warning.separator',
  'settings.localRetrieval.builtinModelId',
]);

const scriptNeutralKeys = new Set([
  ...languageNeutralKeys,
  'common.durationMs',
  'settings.selectionToolbar.aiFeatureTitle',
  'settings.localRetrieval.meta',
]);

const localeScripts: Record<string, RegExp> = {
  ar: /\p{Script=Arabic}/u,
  hi: /\p{Script=Devanagari}/u,
  ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  ko: /\p{Script=Hangul}/u,
  ru: /\p{Script=Cyrillic}/u,
};

const rawVisibleLiteralAllowlist = new Set([
  'AI', 'D2', 'tokens', 'tokens (', 'Beta', 'KB', 'v', 's', 'AQBot', 'WebDAV:',
  'AGPL-3.0', 'GitHub', 'Codex', 'Claude', 'Agents', 'Tavily', 'Exa', 'Bocha',
  'SSE', 'StreamableHTTP', 'Stdio', 'Esc', 'npx', 'x-api-key', 'us-east-1',
  'AKIA...', 'sk-...', 'gpt-5.4-think', 'GPT 5.4 Think', 'my-aqbot-backups',
  'aqbot/', '/aqbot/', '/images/edits', '/tasks/{task_id}', '/tasks/{task_id}/cancel',
  '-y @modelcontextprotocol/server-name', 'http://localhost:3000',
  'https://api.openai.com', 'https://s3.amazonaws.com', 'https://dav.example.com/dav/',
]);

function flatten(value: unknown, prefix = '', result = new Map<string, string>()): Map<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    result.set(prefix, String(value ?? ''));
    return result;
  }

  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, result);
  }
  return result;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/{{\s*([^},\s]+)/g)].map((match) => match[1]).sort();
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function staticTranslationKeys(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const sourceRoot = resolve(process.cwd(), 'src');

  for (const file of sourceFiles(sourceRoot)) {
    const text = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node)
        && node.arguments.length > 0
        && ts.isStringLiteralLike(node.arguments[0])
      ) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : '';
        if (name === 't' || name === 'translate') {
          const key = node.arguments[0].text;
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          result.set(key, [...(result.get(key) ?? []), `${relative(process.cwd(), file)}:${line}`]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return result;
}

function translationDefaultLocations(): string[] {
  const result: string[] = [];
  for (const file of sourceFiles(resolve(process.cwd(), 'src'))) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.arguments.length > 1) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : '';
        const options = node.arguments[1];
        const hasDefault = ts.isStringLiteralLike(options)
          || (ts.isObjectLiteralExpression(options) && options.properties.some(
            (property) => ts.isPropertyAssignment(property)
              && property.name.getText(sourceFile) === 'defaultValue',
          ));
        if (name === 't' && hasDefault) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          result.push(`${relative(process.cwd(), file)}:${line}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return result;
}

function rawVisibleLiterals(): string[] {
  const result: string[] = [];
  const visibleAttributes = new Set(['title', 'aria-label', 'placeholder', 'alt']);
  for (const file of sourceFiles(resolve(process.cwd(), 'src')).filter((path) => path.endsWith('.tsx'))) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const record = (node: ts.Node, value: string) => {
      const normalized = value.replace(/\s+/g, ' ').trim();
      if (!normalized || !/[\p{L}\p{Script=Han}]/u.test(normalized)) return;
      if (rawVisibleLiteralAllowlist.has(normalized)) return;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      result.push(`${relative(process.cwd(), file)}:${line} (${normalized})`);
    };
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) record(node, node.text);
      if (
        ts.isJsxAttribute(node)
        && visibleAttributes.has(node.name.getText(sourceFile))
        && node.initializer
        && ts.isStringLiteral(node.initializer)
      ) {
        record(node, node.initializer.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return result;
}

describe('locale completeness', () => {
  const baseline = flatten(zhCN);
  const expectedKeys = [...baseline.keys()].sort();

  it('keeps every locale complete, non-empty, and placeholder-compatible', () => {
    for (const [locale, translations] of Object.entries(locales)) {
      const values = flatten(translations);
      expect([...values.keys()].sort(), `${locale}: key set`).toEqual(expectedKeys);
      for (const key of expectedKeys) {
        const value = values.get(key) ?? '';
        expect(value.trim(), `${locale}: ${key}`).not.toBe('');
        expect(placeholders(value), `${locale}: ${key} placeholders`).toEqual(
          placeholders(baseline.get(key) ?? ''),
        );
      }
    }
  });

  it('defines every statically referenced translation key', () => {
    const missing = [...staticTranslationKeys()]
      .filter(([key]) => !baseline.has(key))
      .map(([key, locations]) => `${key} (${locations.join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('does not copy translatable English values across every non-Chinese locale', () => {
    const english = flatten(enUS);
    const translatedLocales = [ar, de, es, fr, hi, ja, ko, ru].map((locale) => flatten(locale));
    const copied = expectedKeys.filter((key) => (
      !languageNeutralKeys.has(key)
      && translatedLocales.every((locale) => locale.get(key) === english.get(key))
    ));
    expect(copied).toEqual([]);
  });

  it('uses the target script for non-Latin locale sentences', () => {
    for (const [locale, script] of Object.entries(localeScripts)) {
      const values = flatten(locales[locale as keyof typeof locales]);
      const untranslated = [...values]
        .filter(([key, value]) => (
          !scriptNeutralKeys.has(key)
          && /[A-Za-z]{3}/.test(value)
          && !script.test(value)
        ))
        .map(([key, value]) => `${locale}: ${key} (${value})`);
      expect(untranslated).toEqual([]);
    }
  });

  it('does not hide missing translations behind inline default values', () => {
    expect(translationDefaultLocations()).toEqual([]);
  });

  it('does not render raw user-facing TSX literals', () => {
    expect(rawVisibleLiterals()).toEqual([]);
  });
});
