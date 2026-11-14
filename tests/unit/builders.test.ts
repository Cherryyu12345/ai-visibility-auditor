import { describe, it, expect } from 'vitest';
import { detectBuilder } from '../../src/connectors/wordpress/builders.js';

describe('page-builder detection', () => {
  it('detects Elementor from its edit-mode meta', () => {
    const d = detectBuilder({ meta: { _elementor_edit_mode: 'builder' } });
    expect(d.builder).toBe('elementor');
    expect(d.contentIsBuilderData).toBe(true);
  });

  it('does not flag Elementor when edit mode is not "builder"', () => {
    expect(detectBuilder({ meta: { _elementor_edit_mode: '' } }).contentIsBuilderData).toBe(false);
  });

  it('detects Divi from meta and from shortcodes', () => {
    expect(detectBuilder({ meta: { _et_pb_use_builder: 'on' } }).builder).toBe('divi');
    expect(detectBuilder({ content: '[et_pb_section][/et_pb_section]' }).builder).toBe('divi');
  });

  it('detects WPBakery from vc_ shortcodes when meta is hidden from REST', () => {
    const d = detectBuilder({ content: '[vc_row][vc_column]text[/vc_column][/vc_row]' });
    expect(d.builder).toBe('wpbakery');
    expect(d.evidence).toMatch(/post content/);
  });

  it('detects Beaver Builder', () => {
    expect(detectBuilder({ meta: { _fl_builder_enabled: '1' } }).builder).toBe('beaver');
  });

  it('treats ordinary HTML as safe to write', () => {
    const d = detectBuilder({ content: '<p>Just a normal page.</p>', meta: {} });
    expect(d.builder).toBeNull();
    expect(d.contentIsBuilderData).toBe(false);
  });
});

import { detectBuilderFromHtml } from '../../src/connectors/wordpress/builders.js';

describe('builder detection from rendered HTML', () => {
  it('catches Elementor, which leaves nothing in post_content', () => {
    const d = detectBuilderFromHtml('<body class="page elementor-page elementor-page-12">');
    expect(d.builder).toBe('elementor');
    expect(d.contentIsBuilderData).toBe(true);
  });

  it('catches Elementor from its asset path', () => {
    expect(detectBuilderFromHtml('<link href="/wp-content/plugins/elementor/assets/css/frontend.min.css">').builder)
      .toBe('elementor');
  });

  it('catches Divi, WPBakery and Beaver Builder', () => {
    expect(detectBuilderFromHtml('<div id="et-boc">').builder).toBe('divi');
    expect(detectBuilderFromHtml('<div class="wpb_wrapper">').builder).toBe('wpbakery');
    expect(detectBuilderFromHtml('<div class="fl-builder-content">').builder).toBe('beaver');
  });

  it('leaves an ordinary theme page alone', () => {
    const d = detectBuilderFromHtml('<body class="page page-id-4"><main><p>Hello</p></main></body>');
    expect(d.builder).toBeNull();
    expect(d.contentIsBuilderData).toBe(false);
  });
});
