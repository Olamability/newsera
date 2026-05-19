/**
 * Phase G — Mobile API compatibility guard.
 *
 * Validates that the backend API surface remains compatible with the
 * deployed app versions. Pure compute; the host injects the live API
 * schema and the supported-version manifest.
 */

export interface ApiSchemaField {
  path: string; // dot-path, e.g. "feed.items[].published_at"
  type: string;
  optional: boolean;
}

export interface ApiSchema {
  /** Endpoint key, e.g. "GET /v1/feed". */
  endpoint: string;
  version: string;
  fields: ApiSchemaField[];
  deprecated?: boolean;
}

export interface AppVersionSupport {
  /** App version string, e.g. "2.4.0". */
  version: string;
  status: 'supported' | 'sunset_soon' | 'unsupported';
  /** Endpoints this version depends on. */
  requiredEndpoints: string[];
  releasedAt: string;
  /** Approximate active installs (used for severity weighting). */
  activeInstalls: number;
}

export interface CompatibilityIssue {
  appVersion: string;
  endpoint: string;
  type: 'missing_endpoint' | 'breaking_field_change' | 'deprecated_in_use' | 'unsupported_version_active';
  severity: 'info' | 'warn' | 'severe';
  detail?: Record<string, unknown>;
}

export interface CompatibilityReport {
  ok: boolean;
  issues: CompatibilityIssue[];
  summary: {
    supportedVersions: number;
    sunsetVersions: number;
    unsupportedActive: number;
    deprecatedEndpointsInUse: number;
  };
}

export function evaluateApiCompatibility(
  schemas: ApiSchema[],
  apps: AppVersionSupport[],
  previousSchemas?: ApiSchema[],
): CompatibilityReport {
  const issues: CompatibilityIssue[] = [];
  const endpointMap = new Map(schemas.map((s) => [s.endpoint, s]));
  const previousMap = previousSchemas ? new Map(previousSchemas.map((s) => [s.endpoint, s])) : null;

  for (const app of apps) {
    for (const ep of app.requiredEndpoints) {
      const current = endpointMap.get(ep);
      if (!current) {
        issues.push({
          appVersion: app.version,
          endpoint: ep,
          type: 'missing_endpoint',
          severity: app.status === 'supported' ? 'severe' : 'warn',
          detail: { installs: app.activeInstalls },
        });
        continue;
      }
      if (current.deprecated && app.status === 'supported') {
        issues.push({
          appVersion: app.version,
          endpoint: ep,
          type: 'deprecated_in_use',
          severity: 'warn',
          detail: { installs: app.activeInstalls },
        });
      }
      if (previousMap) {
        const prev = previousMap.get(ep);
        if (prev) {
          // Detect removed/required-now fields.
          for (const f of prev.fields) {
            const currField = current.fields.find((cf) => cf.path === f.path);
            if (!currField) {
              issues.push({
                appVersion: app.version,
                endpoint: ep,
                type: 'breaking_field_change',
                severity: app.status === 'supported' ? 'severe' : 'warn',
                detail: { removedField: f.path },
              });
            } else if (currField.type !== f.type) {
              issues.push({
                appVersion: app.version,
                endpoint: ep,
                type: 'breaking_field_change',
                severity: 'severe',
                detail: { field: f.path, was: f.type, now: currField.type },
              });
            } else if (f.optional && !currField.optional) {
              issues.push({
                appVersion: app.version,
                endpoint: ep,
                type: 'breaking_field_change',
                severity: 'warn',
                detail: { field: f.path, change: 'optional → required' },
              });
            }
          }
        }
      }
    }
    if (app.status === 'unsupported' && app.activeInstalls > 0) {
      issues.push({
        appVersion: app.version,
        endpoint: '*',
        type: 'unsupported_version_active',
        severity: app.activeInstalls > 1_000 ? 'severe' : 'warn',
        detail: { installs: app.activeInstalls },
      });
    }
  }

  const summary = {
    supportedVersions: apps.filter((a) => a.status === 'supported').length,
    sunsetVersions: apps.filter((a) => a.status === 'sunset_soon').length,
    unsupportedActive: apps.filter((a) => a.status === 'unsupported' && a.activeInstalls > 0).length,
    deprecatedEndpointsInUse: issues.filter((i) => i.type === 'deprecated_in_use').length,
  };
  const ok = !issues.some((i) => i.severity === 'severe');
  return { ok, issues, summary };
}
