/**
 * API client for the benchmark console backend.
 * Attaches the Cognito access token to every request.
 */

import { BenchmarkRun, BenchmarkRunConfig } from '@shared/types/benchmark-run';
import { ValidationResult } from '@shared/validation/nfs-workload-validator';
import { Auth } from './auth';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

let authInstance: Auth | null = null;

/** Must be called once at app startup to wire auth into API calls */
export function setAuthProvider(auth: Auth): void {
  authInstance = auth;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  };

  // Attach the access token if available
  if (authInstance) {
    const token = authInstance.getAccessToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    } else if (authInstance.isAuthenticated()) {
      // Token expired but we have a session — try refresh
      const refreshed = await authInstance.refreshTokens();
      if (refreshed) {
        const newToken = authInstance.getAccessToken();
        if (newToken) headers['Authorization'] = `Bearer ${newToken}`;
      }
    }

    // If still no token, redirect to sign-in
    if (!headers['Authorization']) {
      authInstance.signIn();
      throw new ApiError(401, 'Authentication required — redirecting to sign-in');
    }
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  // Handle 401 — token may have been revoked server-side
  if (res.status === 401 && authInstance) {
    const refreshed = await authInstance.refreshTokens();
    if (!refreshed) {
      authInstance.signIn();
      throw new ApiError(401, 'Session expired — redirecting to sign-in');
    }
    // Retry once with the new token
    const retryToken = authInstance.getAccessToken();
    if (retryToken) {
      headers['Authorization'] = `Bearer ${retryToken}`;
      const retryRes = await fetch(`${API_BASE}${path}`, { ...options, headers });
      if (!retryRes.ok) {
        const error = await retryRes.json().catch(() => ({ error: retryRes.statusText }));
        throw new ApiError(retryRes.status, error.error || 'Request failed', error.validationErrors);
      }
      return retryRes.json();
    }
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, error.error || 'Request failed', error.validationErrors);
  }

  return res.json();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public validationErrors?: ValidationResult[]
  ) {
    super(message);
  }
}

export const api = {
  // --- Runs ---
  createRun(params: {
    name: string;
    description?: string;
    tags?: string[];
    config: BenchmarkRunConfig;
  }): Promise<{ run: BenchmarkRun; validationWarnings: ValidationResult[] }> {
    return request('/runs', { method: 'POST', body: JSON.stringify(params) });
  },

  listRuns(limit = 50): Promise<{ runs: BenchmarkRun[] }> {
    return request(`/runs?limit=${limit}`);
  },

  getRun(runId: string): Promise<{ run: BenchmarkRun }> {
    return request(`/runs/${runId}`);
  },

  cancelRun(runId: string): Promise<{ message: string }> {
    return request(`/runs/${runId}/cancel`, { method: 'POST' });
  },

  deleteRun(runId: string): Promise<{ message: string }> {
    return request(`/runs/${runId}`, { method: 'DELETE' });
  },

  deleteRuns(runIds: string[]): Promise<{ results: Array<{ runId: string; success: boolean; error?: string }> }> {
    return Promise.all(
      runIds.map(id =>
        request<{ message: string }>(`/runs/${id}`, { method: 'DELETE' })
          .then(() => ({ runId: id, success: true }))
          .catch(err => ({ runId: id, success: false, error: err.message }))
      )
    ).then(results => ({ results }));
  },

  compareRuns(ids: string[]): Promise<{ runs: BenchmarkRun[] }> {
    return request(`/runs/compare?ids=${ids.join(',')}`);
  },

  // --- Analytics ---
  getAnalyticsSummary(): Promise<AnalyticsSummary> {
    return request('/analytics/summary');
  },

  getAnalyticsTrends(params: {
    metric: string;
    groupBy?: string;
    days?: number;
  }): Promise<TrendData> {
    const qs = new URLSearchParams({ metric: params.metric });
    if (params.groupBy) qs.set('groupBy', params.groupBy);
    if (params.days) qs.set('days', String(params.days));
    return request(`/analytics/trends?${qs}`);
  },

  getHistogram(runId: string): Promise<{ runId: string; histogram: Record<string, number> }> {
    return request(`/analytics/histogram?runId=${runId}`);
  },

  customQuery(query: CustomQueryRequest): Promise<CustomQueryResponse> {
    return request('/analytics/custom', { method: 'POST', body: JSON.stringify(query) });
  },
};

// --- Analytics types ---

export interface AnalyticsSummary {
  totalRuns: number;
  completedRuns: number;
  dateRange: { earliest: string; latest: string };
  summary: {
    iops: { min: number; max: number; avg: number };
    bwKib: { min: number; max: number; avg: number };
    p99Us: { min: number; max: number; avg: number };
  } | null;
  byWorkload: Record<string, GroupSummary>;
  byNfsVersion: Record<string, GroupSummary>;
  byBlockSize: Record<string, GroupSummary>;
}

export interface GroupSummary {
  count: number;
  avgIops: number;
  avgBwKib: number;
  avgP99Us: number;
}

export interface TrendData {
  metric: string;
  groupBy: string;
  days: number;
  series: Array<{
    name: string;
    points: Array<{ timestamp: string; value: number; runId: string; name: string }>;
  }>;
}

export interface CustomQueryRequest {
  dateRange?: { from?: string; to?: string };
  filters?: {
    tags?: string[];
    nfsVersions?: string[];
    blockSizes?: string[];
    workloads?: string[];
    instanceTypes?: string[];
    minNodes?: number;
    maxNodes?: number;
  };
  metrics?: string[];
  xAxis?: 'time' | 'nodeCount' | 'blockSize' | 'nfsVersion';
}

export interface CustomQueryResponse {
  query: CustomQueryRequest;
  totalMatched: number;
  data: Array<Record<string, unknown>>;
}
