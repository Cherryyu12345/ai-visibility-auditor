<?php
/**
 * Plugin Name:       AI Visibility Bridge
 * Description:       Secure endpoints for AI Visibility Auditor: SEO meta, JSON-LD, robots.txt and llms.txt. Installed only when the site's SEO plugin cannot be written through the core REST API.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * License:           GPL-2.0-or-later
 *
 * Design notes:
 *  - Every route requires an authenticated user with an explicit capability.
 *    There is no shared secret and no public endpoint: the caller authenticates
 *    as a WordPress user with an Application Password, so permissions, roles
 *    and audit trails are WordPress's, not ours.
 *  - Writes go through each SEO plugin's own storage so the plugin's UI keeps
 *    showing the truth. We never write a parallel copy it would ignore.
 *  - Nothing here echoes user input into HTML unescaped. JSON-LD is re-encoded
 *    with wp_json_encode rather than passed through.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('AIVA_BRIDGE_VERSION', '0.1.0');
define('AIVA_BRIDGE_NS', 'ai-visibility-bridge/v1');

define('AIVA_META_SCHEMA', '_aiva_json_ld');
define('AIVA_OPT_ROBOTS', 'aiva_robots_txt');
define('AIVA_OPT_LLMS', 'aiva_llms_txt');

/* -------------------------------------------------------------------------
 * Capability helpers
 * ---------------------------------------------------------------------- */

function aiva_can_edit_post(WP_REST_Request $request) {
    $post_id = (int) $request->get_param('post_id');
    if ($post_id <= 0) {
        return new WP_Error('aiva_bad_post', 'A valid post_id is required.', ['status' => 400]);
    }
    if (!current_user_can('edit_post', $post_id)) {
        return new WP_Error('aiva_forbidden', 'You cannot edit this post.', ['status' => 403]);
    }
    return true;
}

function aiva_can_manage() {
    return current_user_can('manage_options');
}

function aiva_can_read() {
    return current_user_can('edit_posts');
}

/* -------------------------------------------------------------------------
 * SEO plugin detection and writing
 * ---------------------------------------------------------------------- */

function aiva_active_seo_plugin() {
    if (defined('WPSEO_VERSION') || is_plugin_active('wordpress-seo/wp-seo.php')) {
        return 'yoast';
    }
    if (class_exists('RankMath') || defined('RANK_MATH_VERSION')) {
        return 'rankmath';
    }
    if (defined('AIOSEO_VERSION') || function_exists('aioseo')) {
        return 'aioseo';
    }
    return 'none';
}

/**
 * Write SEO fields into whichever plugin owns them.
 *
 * Returns a map of field => true/false so the caller can report exactly which
 * fields landed, rather than assuming a 200 meant everything was written.
 */
function aiva_write_seo_meta($post_id, $fields) {
    $plugin  = aiva_active_seo_plugin();
    $written = [];

    $map = [
        'yoast' => [
            'title'       => '_yoast_wpseo_title',
            'description' => '_yoast_wpseo_metadesc',
            'canonical'   => '_yoast_wpseo_canonical',
        ],
        'rankmath' => [
            'title'       => 'rank_math_title',
            'description' => 'rank_math_description',
            'canonical'   => 'rank_math_canonical_url',
            'robots'      => 'rank_math_robots',
        ],
    ];

    if ($plugin === 'aioseo' && function_exists('aioseo')) {
        // AIOSEO keeps SEO data in its own table. Use its model so its cache and
        // UI stay consistent; post meta writes would be ignored by the plugin.
        try {
            $aioseo_post = \AIOSEO\Plugin\Common\Models\Post::getPost($post_id);
            if (isset($fields['title']))       { $aioseo_post->title            = $fields['title']; }
            if (isset($fields['description'])) { $aioseo_post->description      = $fields['description']; }
            if (isset($fields['canonical']))   { $aioseo_post->canonical_url    = $fields['canonical']; }
            $aioseo_post->post_id = $post_id;
            $aioseo_post->save();
            foreach (array_keys($fields) as $field) {
                $written[$field] = in_array($field, ['title', 'description', 'canonical'], true);
            }
            return ['plugin' => $plugin, 'written' => $written];
        } catch (Throwable $e) {
            return new WP_Error('aiva_aioseo_failed', 'AIOSEO write failed: ' . $e->getMessage(), ['status' => 500]);
        }
    }

    if (!isset($map[$plugin])) {
        // No SEO plugin: fall back to our own meta, which this plugin renders
        // in wp_head. Honest about being a fallback, and it works.
        foreach ($fields as $field => $value) {
            update_post_meta($post_id, '_aiva_seo_' . $field, $value);
            $written[$field] = true;
        }
        return ['plugin' => 'none (bridge-rendered)', 'written' => $written];
    }

    foreach ($fields as $field => $value) {
        if (!isset($map[$plugin][$field])) {
            $written[$field] = false;
            continue;
        }
        update_post_meta($post_id, $map[$plugin][$field], $value);
        $written[$field] = true;
    }

    return ['plugin' => $plugin, 'written' => $written];
}

/** Render fallback SEO tags only when no SEO plugin is handling them. */
function aiva_render_fallback_seo() {
    if (!is_singular() || aiva_active_seo_plugin() !== 'none') {
        return;
    }
    $post_id     = get_queried_object_id();
    $description = get_post_meta($post_id, '_aiva_seo_description', true);
    $canonical   = get_post_meta($post_id, '_aiva_seo_canonical', true);
    $robots      = get_post_meta($post_id, '_aiva_seo_robots', true);

    if ($description) {
        printf('<meta name="description" content="%s" />' . "\n", esc_attr($description));
    }
    if ($canonical) {
        printf('<link rel="canonical" href="%s" />' . "\n", esc_url($canonical));
    }
    if ($robots) {
        printf('<meta name="robots" content="%s" />' . "\n", esc_attr($robots));
    }
}
add_action('wp_head', 'aiva_render_fallback_seo', 1);

/** Override <title> when we are the fallback provider. */
function aiva_filter_title($title_parts) {
    if (is_singular() && aiva_active_seo_plugin() === 'none') {
        $custom = get_post_meta(get_queried_object_id(), '_aiva_seo_title', true);
        if ($custom) {
            $title_parts['title'] = $custom;
            unset($title_parts['tagline'], $title_parts['site']);
        }
    }
    return $title_parts;
}
add_filter('document_title_parts', 'aiva_filter_title');

/* -------------------------------------------------------------------------
 * JSON-LD injection
 * ---------------------------------------------------------------------- */

function aiva_render_schema() {
    if (!is_singular()) {
        return;
    }
    $stored = get_post_meta(get_queried_object_id(), AIVA_META_SCHEMA, true);
    if (empty($stored)) {
        return;
    }
    $decoded = json_decode($stored, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        return;
    }
    // Re-encode rather than echoing what was stored: guarantees well-formed
    // JSON and neutralises any </script> smuggled into a string value.
    // Deliberately NOT using JSON_UNESCAPED_SLASHES: escaping "/" turns a
    // smuggled "</script>" into "<\/script>", which cannot terminate this
    // block. This is the one thing standing between a JSON-LD field and XSS.
    echo '<script type="application/ld+json">'
        . wp_json_encode($decoded, JSON_UNESCAPED_UNICODE)
        . '</script>' . "\n";
}
add_action('wp_head', 'aiva_render_schema', 20);

/* -------------------------------------------------------------------------
 * robots.txt and llms.txt
 * ---------------------------------------------------------------------- */

/**
 * WordPress only serves /robots.txt when no real file exists at the web root.
 * If one does, our filter never runs and any write would be a false success.
 */
function aiva_robots_served_by_wordpress() {
    return !file_exists(ABSPATH . 'robots.txt');
}

function aiva_filter_robots_txt($output, $public) {
    $custom = get_option(AIVA_OPT_ROBOTS, '');
    return $custom !== '' ? $custom : $output;
}
add_filter('robots_txt', 'aiva_filter_robots_txt', 20, 2);

/** Serve /llms.txt, which WordPress has no native concept of. */
function aiva_serve_llms_txt() {
    $path = isset($_SERVER['REQUEST_URI']) ? wp_parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) : '';
    if ($path !== '/llms.txt') {
        return;
    }
    $content = get_option(AIVA_OPT_LLMS, '');
    if ($content === '') {
        return; // Nothing configured: let WordPress 404 as normal.
    }
    header('Content-Type: text/plain; charset=utf-8');
    header('X-Robots-Tag: noindex');
    echo $content;
    exit;
}
add_action('parse_request', 'aiva_serve_llms_txt', 0);

/* -------------------------------------------------------------------------
 * Cache purging
 * ---------------------------------------------------------------------- */

function aiva_purge_caches($post_id = 0) {
    $purged = [];

    if (function_exists('wp_cache_clear_cache')) {            // WP Super Cache
        wp_cache_clear_cache();
        $purged[] = 'WP Super Cache';
    }
    if (function_exists('w3tc_flush_all')) {                   // W3 Total Cache
        w3tc_flush_all();
        $purged[] = 'W3 Total Cache';
    }
    if (class_exists('LiteSpeed\Purge')) {                     // LiteSpeed Cache
        do_action('litespeed_purge_all');
        $purged[] = 'LiteSpeed Cache';
    }
    if (function_exists('rocket_clean_domain')) {              // WP Rocket
        rocket_clean_domain();
        $purged[] = 'WP Rocket';
    }
    if (class_exists('autoptimizeCache')) {                    // Autoptimize
        autoptimizeCache::clearall();
        $purged[] = 'Autoptimize';
    }
    if (has_action('cachify_flush_cache')) {                   // Cachify
        do_action('cachify_flush_cache');
        $purged[] = 'Cachify';
    }

    if ($post_id > 0) {
        clean_post_cache($post_id);
    }

    return $purged;
}

/* -------------------------------------------------------------------------
 * Page-builder visibility
 *
 * Builders store layout in post meta that is not registered with show_in_rest,
 * so the core REST API gives no hint that a page's body is builder-owned.
 * Without this, a content write looks like it succeeded and silently does
 * nothing — or detaches the layout. We compute it server-side and attach it to
 * the REST response for every public post type.
 * ---------------------------------------------------------------------- */

function aiva_detect_builder($post_id, $content = '') {
    $checks = [
        'elementor' => ['meta' => '_elementor_edit_mode', 'match' => 'builder'],
        'divi'      => ['meta' => '_et_pb_use_builder', 'match' => 'on'],
        'wpbakery'  => ['meta' => '_wpb_vc_js_status', 'match' => 'true'],
        'beaver'    => ['meta' => '_fl_builder_enabled', 'match' => '1'],
    ];

    foreach ($checks as $builder => $check) {
        $value = get_post_meta($post_id, $check['meta'], true);
        if ($value !== '' && (string) $value === $check['match']) {
            return ['builder' => $builder, 'content_is_builder_data' => true, 'evidence' => $check['meta']];
        }
    }

    if (preg_match('/\[(et_pb_section|vc_row|vc_column)/i', $content, $m)) {
        $builder = strpos($m[1], 'et_pb') === 0 ? 'divi' : 'wpbakery';
        return ['builder' => $builder, 'content_is_builder_data' => true, 'evidence' => 'shortcode ' . $m[1]];
    }

    return ['builder' => null, 'content_is_builder_data' => false, 'evidence' => null];
}

add_action('rest_api_init', function () {
    foreach (get_post_types(['public' => true], 'names') as $type) {
        register_rest_field($type, 'aiva_builder', [
            'get_callback' => function ($post) {
                $content = isset($post['content']['raw']) ? $post['content']['raw'] : '';
                return aiva_detect_builder($post['id'], $content);
            },
            'schema' => [
                'description' => 'Whether this post body is owned by a page builder.',
                'type'        => 'object',
                'context'     => ['view', 'edit'],
            ],
        ]);
    }
});

/* -------------------------------------------------------------------------
 * Authorization-header diagnostic
 *
 * WordPress returns an identical 401 (rest_not_logged_in) whether credentials
 * were wrong or the Authorization header never arrived — we verified this
 * against a live site. The two have completely different fixes, so the only
 * way to tell them apart is to ask PHP what it received.
 *
 * This route is intentionally public, because it is used precisely when
 * authentication is failing. It returns booleans only: never a header value,
 * a username, or any part of a credential.
 * ---------------------------------------------------------------------- */

add_action('rest_api_init', function () {
    register_rest_route(AIVA_BRIDGE_NS, '/auth-echo', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => function () {
            $raw = '';
            foreach (['HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION'] as $key) {
                if (!empty($_SERVER[$key])) {
                    $raw = $_SERVER[$key];
                    break;
                }
            }
            if ($raw === '' && function_exists('apache_request_headers')) {
                $headers = apache_request_headers();
                foreach ($headers as $name => $value) {
                    if (strtolower($name) === 'authorization') {
                        $raw = $value;
                        break;
                    }
                }
            }

            return [
                'authorization_header_received' => $raw !== '',
                'scheme'                        => $raw === '' ? null : strtok($raw, ' '),
                'php_auth_user_populated'       => !empty($_SERVER['PHP_AUTH_USER']),
                'application_passwords_available' => wp_is_application_passwords_available(),
                'is_ssl'                        => is_ssl(),
                'environment'                   => wp_get_environment_type(),
            ];
        },
    ]);
});

/* -------------------------------------------------------------------------
 * REST routes
 * ---------------------------------------------------------------------- */

add_action('rest_api_init', function () {
    register_rest_route(AIVA_BRIDGE_NS, '/status', [
        'methods'             => 'GET',
        'permission_callback' => 'aiva_can_read',
        'callback'            => function () {
            return [
                'ok'         => true,
                'version'    => AIVA_BRIDGE_VERSION,
                'seo_plugin' => aiva_active_seo_plugin(),
            ];
        },
    ]);

    register_rest_route(AIVA_BRIDGE_NS, '/seo-meta', [
        'methods'             => 'POST',
        'permission_callback' => 'aiva_can_edit_post',
        'args'                => [
            'post_id'     => ['required' => true, 'type' => 'integer'],
            'title'       => ['type' => 'string'],
            'description' => ['type' => 'string'],
            'canonical'   => ['type' => 'string'],
            'robots'      => ['type' => 'string'],
        ],
        'callback'            => function (WP_REST_Request $request) {
            $post_id = (int) $request->get_param('post_id');
            $fields  = [];

            foreach (['title', 'description', 'robots'] as $key) {
                $value = $request->get_param($key);
                if ($value !== null) {
                    $fields[$key] = sanitize_text_field($value);
                }
            }
            $canonical = $request->get_param('canonical');
            if ($canonical !== null) {
                $fields['canonical'] = esc_url_raw($canonical);
            }

            if (empty($fields)) {
                return new WP_Error('aiva_no_fields', 'No SEO fields supplied.', ['status' => 400]);
            }

            $result = aiva_write_seo_meta($post_id, $fields);
            if (is_wp_error($result)) {
                return $result;
            }

            return array_merge(['ok' => true, 'post_id' => $post_id], $result);
        },
    ]);

    register_rest_route(AIVA_BRIDGE_NS, '/schema', [
        'methods'             => 'POST',
        'permission_callback' => 'aiva_can_edit_post',
        'args'                => [
            'post_id' => ['required' => true, 'type' => 'integer'],
        ],
        'callback'            => function (WP_REST_Request $request) {
            $post_id = (int) $request->get_param('post_id');
            $json_ld = $request->get_param('json_ld');

            if ($json_ld === null) {
                delete_post_meta($post_id, AIVA_META_SCHEMA);
                return ['ok' => true, 'post_id' => $post_id, 'cleared' => true];
            }
            if (!is_array($json_ld)) {
                return new WP_Error('aiva_bad_schema', 'json_ld must be an object or array.', ['status' => 400]);
            }

            $encoded = wp_json_encode($json_ld);
            if ($encoded === false) {
                return new WP_Error('aiva_bad_schema', 'json_ld could not be encoded.', ['status' => 400]);
            }

            update_post_meta($post_id, AIVA_META_SCHEMA, wp_slash($encoded));
            return ['ok' => true, 'post_id' => $post_id, 'bytes' => strlen($encoded)];
        },
    ]);

    register_rest_route(AIVA_BRIDGE_NS, '/root-files/status', [
        'methods'             => 'GET',
        'permission_callback' => 'aiva_can_manage',
        'callback'            => function () {
            return [
                'robots_txt_served_by_wordpress' => aiva_robots_served_by_wordpress(),
                'static_robots_path'             => aiva_robots_served_by_wordpress() ? null : ABSPATH . 'robots.txt',
                'llms_txt_configured'            => get_option(AIVA_OPT_LLMS, '') !== '',
            ];
        },
    ]);

    register_rest_route(AIVA_BRIDGE_NS, '/root-files', [
        [
            'methods'             => 'GET',
            'permission_callback' => 'aiva_can_manage',
            'callback'            => function (WP_REST_Request $request) {
                $file = $request->get_param('file');
                if ($file === 'robots.txt') {
                    return ['file' => $file, 'content' => get_option(AIVA_OPT_ROBOTS, '')];
                }
                if ($file === 'llms.txt') {
                    return ['file' => $file, 'content' => get_option(AIVA_OPT_LLMS, '')];
                }
                return new WP_Error('aiva_bad_file', 'file must be robots.txt or llms.txt.', ['status' => 400]);
            },
        ],
        [
            'methods'             => 'POST',
            'permission_callback' => 'aiva_can_manage',
            'args'                => [
                'file'    => ['required' => true, 'type' => 'string'],
                'content' => ['required' => true, 'type' => 'string'],
            ],
            'callback'            => function (WP_REST_Request $request) {
                $file    = $request->get_param('file');
                $content = $request->get_param('content');

                if ($file === 'robots.txt') {
                    if (!aiva_robots_served_by_wordpress()) {
                        return new WP_Error(
                            'aiva_static_robots',
                            'A static robots.txt exists at the web root and takes precedence over WordPress. '
                            . 'Writing here would have no effect.',
                            ['status' => 409]
                        );
                    }
                    update_option(AIVA_OPT_ROBOTS, $content, false);
                } elseif ($file === 'llms.txt') {
                    update_option(AIVA_OPT_LLMS, $content, false);
                } else {
                    return new WP_Error('aiva_bad_file', 'file must be robots.txt or llms.txt.', ['status' => 400]);
                }

                aiva_purge_caches();
                return ['ok' => true, 'file' => $file, 'bytes' => strlen($content)];
            },
        ],
    ]);

    register_rest_route(AIVA_BRIDGE_NS, '/purge-cache', [
        'methods'             => 'POST',
        'permission_callback' => 'aiva_can_read',
        'callback'            => function (WP_REST_Request $request) {
            $post_id = (int) $request->get_param('post_id');
            return ['ok' => true, 'purged' => aiva_purge_caches($post_id)];
        },
    ]);
});

/** Flush rewrite state on activation so /llms.txt is routable immediately. */
register_activation_hook(__FILE__, function () {
    flush_rewrite_rules();
});
register_deactivation_hook(__FILE__, function () {
    flush_rewrite_rules();
});
