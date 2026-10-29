/**
 * Tests for the installation settings page (src/setup/settingGroups.js): every
 * setting the page shows exists in the settings registry, can be edited, and
 * has a label and hint in all maker languages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LANGUAGES = ['en', 'nl', 'de', 'fr', 'es'];

const { SETTING_GROUPS } = await import('../src/setup/settingGroups.js');
const { SETTINGS } = await import('../src/services/settings.js');
const keys = Object.values(SETTING_GROUPS).flat();

test('every setting on the page is a known, editable setting', () => {
  assert.equal(new Set(keys).size, keys.length, 'a setting is listed twice');
  for (const key of keys) {
    assert.ok(SETTINGS[key], `${key} is not in the settings registry`);
    assert.ok(!SETTINGS[key].internal, `${key} is internal`);
  }
});

test('every setting has a label and hint in all maker languages', () => {
  for (const language of LANGUAGES) {
    const texts = JSON.parse(readFileSync(new URL(`../locales/${language}.json`, import.meta.url))).installation;
    assert.ok(texts, `${language}: installation texts are missing`);
    for (const key of keys) {
      assert.ok(texts.fields[key]?.label, `${language}: no label for ${key}`);
      assert.ok(texts.fields[key]?.hint, `${language}: no hint for ${key}`);
    }
    for (const key of keys.filter((k) => SETTINGS[k].type === 'enum')) {
      for (const option of SETTINGS[key].options) {
        assert.ok(texts.options[key]?.[option], `${language}: no text for ${key} = ${option}`);
      }
    }
  }
});
