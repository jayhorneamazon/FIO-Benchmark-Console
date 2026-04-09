/**
 * Single Lambda entry point for all API routes.
 * Routes based on HTTP method + path from API Gateway HTTP API.
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createRun, listRuns, getRun, cancelRun, compareRuns } from './runs';
import { getSummary, getTrends, getHistogram, customQuery } from './analytics';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  try {
    // --- Analytics ---
    if (method === 'GET' && path === '/analytics/summary') return await getSummary();
    if (method === 'GET' && path === '/analytics/trends') return await getTrends(event);
    if (method === 'GET' && path === '/analytics/histogram') return await getHistogram(event);
    if (method === 'POST' && path === '/analytics/custom') return await customQuery(event);

    // --- Runs CRUD ---
    // POST /runs
    if (method === 'POST' && path === '/runs') {
      return await createRun(event);
    }

    // GET /runs/compare?ids=...  (must be before /runs/{id} to avoid conflict)
    if (method === 'GET' && path === '/runs/compare') {
      return await compareRuns(event);
    }

    // GET /runs
    if (method === 'GET' && path === '/runs') {
      return await listRuns(event);
    }

    // GET /runs/:id
    if (method === 'GET' && path.match(/^\/runs\/[^/]+$/)) {
      return await getRun(event);
    }

    // POST /runs/:id/cancel
    if (method === 'POST' && path.match(/^\/runs\/[^/]+\/cancel$/)) {
      return await cancelRun(event);
    }

    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (err) {
    console.error('Unhandled error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
