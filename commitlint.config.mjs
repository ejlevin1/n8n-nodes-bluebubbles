/**
 * Conventional Commits are enforced locally (.githooks/commit-msg) and in CI.
 * release-please derives the next version and CHANGELOG from these messages:
 *   feat -> minor, fix/perf/etc. -> patch,
 *   `type!:` or a `BREAKING CHANGE:` footer -> major (minor while version < 1.0.0).
 *
 * @type {import('@commitlint/types').UserConfig}
 */
export default {
	extends: ['@commitlint/config-conventional'],
	rules: {
		// Long URLs and generated bodies (e.g. Dependabot) routinely exceed 100 chars;
		// warn instead of rejecting. Header length stays an error.
		'body-max-line-length': [1, 'always', 100],
		'footer-max-line-length': [1, 'always', 100],
	},
};
