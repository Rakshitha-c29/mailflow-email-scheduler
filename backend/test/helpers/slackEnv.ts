/**
 * Imported FIRST by slack.test.ts: turns Slack on with fake app credentials (Slack's own
 * endpoints are faked in the test). Must run before src/config/env is evaluated.
 */
process.env.SLACK_CLIENT_ID = 'test-client-id';
process.env.SLACK_CLIENT_SECRET = 'test-client-secret';
process.env.SLACK_REDIRECT_URI = 'https://tunnel.example.test/api/integrations/slack/callback';
