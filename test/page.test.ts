import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('index.html');
const main = read('src/main.ts');

/** Catches ids renamed in one file but not the other. */
describe('page wiring', () => {
  test('every element id the script looks up exists in the HTML', () => {
    const ids = [...main.matchAll(/element(?:<[^>]*>)?\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(ids.length >= 5, 'expected the script to look up several elements');
    for (const id of ids) {
      assert.ok(html.includes(`id="${id}"`), `index.html has no element with id "${id}"`);
    }
  });

  test('every selector the script queries matches something in the HTML', () => {
    const selectors = [...main.matchAll(/querySelector(?:All)?(?:<[^>]*>)?\('([^']+)'\)/g)].map(
      (m) => m[1] as string,
    );
    assert.ok(selectors.length > 0);
    for (const selector of selectors) {
      // Check each class and attribute the selector depends on. Not a full
      // selector engine, but enough to catch a renamed class or attribute.
      const parts = [
        ...[...selector.matchAll(/\.([\w-]+)/g)].map((m) => `class="${m[1]}"`),
        ...[...selector.matchAll(/\[([\w-]+)="([^"]+)"\]/g)].map((m) => `${m[1]}="${m[2]}"`),
      ];
      assert.ok(parts.length > 0, `could not check the selector "${selector}"`);
      for (const part of parts) {
        assert.ok(html.includes(part), `index.html has no ${part} for the selector "${selector}"`);
      }
    }
  });

  test('the entity options match the values the converter accepts', () => {
    const values = [...html.matchAll(/name="entity" value="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(values, ['polyface', '3dface']);
  });
});
