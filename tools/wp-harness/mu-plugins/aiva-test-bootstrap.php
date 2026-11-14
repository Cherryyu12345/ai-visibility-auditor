<?php
/**
 * Test-harness bootstrap. Local Playground site only — never ship this.
 *
 * Prepares a predictable WordPress for the integration suite:
 *   - activates the companion bridge plugin,
 *   - creates an Application Password for admin and writes it to a mounted
 *     host directory so the test runner can pick it up,
 *   - seeds pages the tests can read and write, including one that pretends to
 *     be an Elementor page so the builder-safety path has something to refuse.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('AIVA_OUT_DIR', '/aiva-out');

add_action('init', function () {
    if (get_option('aiva_harness_ready')) {
        return;
    }

    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    require_once ABSPATH . 'wp-admin/includes/user.php';

    $plugin = 'ai-visibility-bridge/ai-visibility-bridge.php';
    if (!is_plugin_active($plugin)) {
        activate_plugin($plugin);
    }

    $admin = get_user_by('login', 'admin');
    if (!$admin) {
        return;
    }

    // Seed content.
    $about = wp_insert_post([
        'post_type'    => 'page',
        'post_title'   => 'About our clinic',
        'post_name'    => 'about',
        'post_status'  => 'publish',
        'post_content' => '<p>We are a clinic.</p>',
    ]);

    $builder_page = wp_insert_post([
        'post_type'    => 'page',
        'post_title'   => 'Treatments',
        'post_name'    => 'treatments',
        'post_status'  => 'publish',
        'post_content' => '<p>Stale copy that Elementor ignores.</p>',
    ]);
    // Mark it as an Elementor page so the connector must refuse content writes.
    update_post_meta($builder_page, '_elementor_edit_mode', 'builder');
    update_post_meta($builder_page, '_elementor_data', '[]');

    $post = wp_insert_post([
        'post_type'    => 'post',
        'post_title'   => 'First post',
        'post_name'    => 'first-post',
        'post_status'  => 'publish',
        'post_content' => '<p>Hello.</p>',
    ]);

    // Application Password for the REST client.
    $created = WP_Application_Passwords::create_new_application_password(
        $admin->ID,
        ['name' => 'ai-visibility-auditor-tests']
    );

    if (!is_wp_error($created)) {
        $payload = [
            'site_url'     => home_url(),
            'username'     => 'admin',
            'app_password' => $created[0],
            'pages'        => [
                'about'     => $about,
                'treatments'=> $builder_page,
                'post'      => $post,
            ],
        ];
        if (is_dir(AIVA_OUT_DIR) && is_writable(AIVA_OUT_DIR)) {
            file_put_contents(AIVA_OUT_DIR . '/harness.json', wp_json_encode($payload, JSON_PRETTY_PRINT));
        }
    }

    update_option('aiva_harness_ready', 1);
}, 1);
