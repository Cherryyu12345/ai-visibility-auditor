/**
 * Page-builder detection.
 *
 * When a page is built with Elementor, Divi, WPBakery or Beaver Builder, the
 * rendered body comes from builder data in post meta, and `post_content` is
 * either a stale copy or a pile of shortcodes. Writing `content` in that case
 * does not change the page — and worse, on some builders it detaches the layout
 * and the consultant loses the design.
 *
 * So this is a safety gate, not an optimisation: if a builder owns the body, we
 * refuse the content write and route the change elsewhere.
 */

export type Builder = 'elementor' | 'divi' | 'wpbakery' | 'beaver' | null;

interface BuilderRule {
  builder: Exclude<Builder, null>;
  /** Meta key whose presence (with a matching value) indicates builder ownership. */
  metaKey?: string;
  metaValue?: (v: unknown) => boolean;
  /** Shortcode or markup signature in post_content. */
  contentPattern?: RegExp;
  label: string;
}

const RULES: BuilderRule[] = [
  {
    builder: 'elementor',
    metaKey: '_elementor_edit_mode',
    metaValue: (v) => v === 'builder',
    label: 'Elementor (_elementor_edit_mode = builder)',
  },
  {
    builder: 'divi',
    metaKey: '_et_pb_use_builder',
    metaValue: (v) => v === 'on',
    contentPattern: /\[et_pb_(section|row|column)/i,
    label: 'Divi (_et_pb_use_builder = on)',
  },
  {
    builder: 'wpbakery',
    metaKey: '_wpb_vc_js_status',
    metaValue: (v) => v === 'true' || v === true,
    contentPattern: /\[vc_row|\[vc_column/i,
    label: 'WPBakery (vc_* shortcodes)',
  },
  {
    builder: 'beaver',
    metaKey: '_fl_builder_enabled',
    metaValue: (v) => v === '1' || v === 1 || v === true,
    label: 'Beaver Builder (_fl_builder_enabled)',
  },
];

export interface BuilderDetection {
  builder: Builder;
  /** True when the body must not be written through the `content` field. */
  contentIsBuilderData: boolean;
  evidence?: string;
}

export function detectBuilder(post: { meta?: Record<string, unknown>; content?: string }): BuilderDetection {
  const meta = post.meta ?? {};

  for (const rule of RULES) {
    if (rule.metaKey && rule.metaKey in meta) {
      const value = meta[rule.metaKey];
      if (!rule.metaValue || rule.metaValue(value)) {
        return { builder: rule.builder, contentIsBuilderData: true, evidence: rule.label };
      }
    }
  }

  // Shortcode signatures are a weaker signal — meta may be hidden from REST —
  // but a body full of [vc_row] is builder data whatever the meta says.
  const content = post.content ?? '';
  for (const rule of RULES) {
    if (rule.contentPattern?.test(content)) {
      return {
        builder: rule.builder,
        contentIsBuilderData: true,
        evidence: `${rule.label} detected in post content`,
      };
    }
  }

  return { builder: null, contentIsBuilderData: false };
}

/** Message shown on the manual card when a builder blocks a content write. */
export function builderBlockMessage(d: BuilderDetection, pageUrl: string): string {
  return (
    `This page's body is stored as ${d.builder} data (${d.evidence}). ` +
    `Writing it through the API would not change the page and could detach the layout. ` +
    `Edit it in the ${d.builder} editor at ${pageUrl}, or apply the change through Cloudflare instead.`
  );
}

/**
 * Fallback detection from the rendered page.
 *
 * Needed because builder meta keys are not registered with `show_in_rest`, so
 * a site without the companion plugin gives the REST API no hint at all —
 * Elementor in particular leaves nothing in post_content. The rendered HTML
 * does carry fingerprints, so we use it rather than assume a page is safe.
 */
export function detectBuilderFromHtml(html: string): BuilderDetection {
  const rules: Array<{ builder: Exclude<Builder, null>; pattern: RegExp; label: string }> = [
    { builder: 'elementor', pattern: /class="[^"]*\belementor-page\b|\/plugins\/elementor\//i, label: 'Elementor assets or body class' },
    { builder: 'divi', pattern: /id="et-boc"|\/themes\/Divi\//i, label: 'Divi wrapper or theme assets' },
    { builder: 'wpbakery', pattern: /class="[^"]*\bwpb_wrapper\b|\/js_composer\//i, label: 'WPBakery wrapper or assets' },
    { builder: 'beaver', pattern: /class="[^"]*\bfl-builder-content\b/i, label: 'Beaver Builder content wrapper' },
  ];
  for (const rule of rules) {
    if (rule.pattern.test(html)) {
      return { builder: rule.builder, contentIsBuilderData: true, evidence: rule.label };
    }
  }
  return { builder: null, contentIsBuilderData: false };
}
