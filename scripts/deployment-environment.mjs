export const DEPLOYMENT_ENVIRONMENT_KEYS = Object.freeze([
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'NAME',
  'D1_DATABASE_NAME',
  'D1_DATABASE_ID',
  'KV_NAMESPACE_ID',
  'R2_BUCKET_NAME',
  'CUSTOM_DOMAIN',
  'DOMAIN',
  'ADMIN',
  'ADMIN_PASSWORD',
  'CORS_ORIGINS',
  'JWT_SECRET',
  'LONGOS_RELAY_URL',
  'LONGOS_INTEGRATION_TOKEN',
  'RELAY_SHARED_SECRET',
  'CLOUDFLARE_EMAIL',
  'ANALYSIS_CACHE',
  'AI_MODEL',
  'PROJECT_LINK',
  'RESEND_WEBHOOK_SECRET',
  'AUTO_CONFIGURE_EMAIL_ROUTING',
]);

const SENSITIVE_ENVIRONMENT_NAME =
  /(?:token|secret|password|passwd|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key|encryption[_-]?key|signing[_-]?key|cookie|(?:^|_)(?:pat|jwt)(?:_|$))/i;

const DEPLOYMENT_ENVIRONMENT_KEY_SET = new Set(
  DEPLOYMENT_ENVIRONMENT_KEYS.map(name => name.toUpperCase()),
);

export function isSensitiveEnvironmentName(name) {
  return SENSITIVE_ENVIRONMENT_NAME.test(String(name || ''));
}

export function sanitizedVerificationEnvironment(environment = process.env) {
  const clean = {...environment, CI: 'true'};
  for (const name of Object.keys(clean)) {
    if (DEPLOYMENT_ENVIRONMENT_KEY_SET.has(name.toUpperCase()) || isSensitiveEnvironmentName(name)) {
      delete clean[name];
    }
  }
  return clean;
}
