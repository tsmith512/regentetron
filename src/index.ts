declare global {
  // In wrangler.toml
  const GSHEETS_API_ENDPOINT: string;
  const CF_API_ENDPOINT: string;
  const DEFAULT_DEST_DOMAIN: string;

  // In secrets
  const AUTH_TOKEN: string;
  const GSHEETS_ID: string;
  const GSHEETS_API_KEY: string;
  const CF_ACCT_ID: string; // Really, account TAG
  const CF_LIST_ID: string;
  const CF_API_TOKEN: string;
}

import { Router } from 'itty-router';

import { checkSpreadsheetStatus, fetchRedirectRows } from './inputs';
import { processSheetRow } from './processing';
import { BulkRedirectListItem, getBulkListStatus, makeBulkList, uploadBulkList } from './outputs';
import { validateBoolean } from './validators';
import { authCheck } from './auth';

export type RedirectCode = 301 | 302 | 307 | 308;

/**
 * A validated and sanitized redirect object.
 */
export interface RedirectProps {
  source: string;
  destination: string;
  code: RedirectCode;
  localized: boolean;
  deleted: boolean;
}

/**
 * A raw spreadsheet row that could be a redirect object.
 */
export interface RawRedirectProps {
  source: string;
  destination: string;
  code?: string | number;
  localized?: string | boolean;
  deleted?: string | boolean;
}

/**
 * Work-in-progress, but all responses from this service will be one of these.
 */
export interface DirectomaticResponse {
  success?: boolean; // If an action was requested
  errors?: any[]; // Error messages either from CF or from this code
  messages?: any[]; // This would be from the CF API
  inputRules?: RedirectProps[];
  invalidRules?: BulkRedirectListItem[] | RawRedirectProps[];
}

// @TODO: This is not complete; just for initial dev.
export const Locales = ['en-us', 'de-de', 'es-es'];

const router = Router();

// Require a bearer token for any request.
router.all('*', authCheck);

/**
 * GET /
 *
 * Hello World!
 */
router.get('/', () => {
  return new Response(JSON.stringify({ messages: ['Directomatic says hello.']}), {
    headers: { 'content-type': 'application/json' },
  });
});

/**
 * GET /status
 *
 * Confirm that we can read the Google Sheet and the Rules Lists.
 */
router.get('/status', async () => {
  const sheet = await checkSpreadsheetStatus();
  const cflist = await getBulkListStatus();
  return new Response(JSON.stringify({
    success: sheet.success && cflist.success,
    errors: [sheet.errors, cflist.errors].flat(),
    messages: [sheet.messages, cflist.messages].flat(),
  }), {
    headers: { 'content-type': 'application/json' },
  });
});

/**
 * GET /list
 *
 * Show a list of all the redirects that would be generated by the spreadsheet
 * and report a list of any that fail OUR validation, returning the raw data.
 */
router.get('/list', async () => {
  // Source the unprocessed redirects list from the Google Sheet.
  const inputRows = await fetchRedirectRows();

  // Sanitize, validate, and clean up the input; skim off the bad rows to report.
  const badRows: RawRedirectProps[] = [];
  const redirectsList = inputRows.flatMap((row) => {
    const output = processSheetRow(row);
    if (output) {
      return output;
    } else {
      // If the row was skipped because it was deleted, don't include it in the
      // error report output.
      if (!validateBoolean(row.deleted, false)) {
        badRows.push(row);
      }

      // Return empty, which will :magic: away in flatMap().
      return [];
    }
  });

  return new Response(JSON.stringify({
    messages: [
      `Google sheet contains ${redirectsList.length} valid rules and ${badRows.length} rows with errors.`
    ],
    inputRows: redirectsList,
    invalidRules: badRows,
  }), {
    headers: { 'content-type': 'application/json' },
  });
});

/**
 * GET /publish
 *
 * Fetch redirects from the Google Sheet, sanitize/validate, prep the "good" ones
 * for the Cloudflare Ruleset API, and replace the list with the new set. Report
 * on any errors from Cloudflare and note any redirects that the API rejected.
 */
router.get('/publish', async () => {
  // Source the unprocessed redirects list from the Google Sheet.
  const inputRows = await fetchRedirectRows();

  // Sanitize, validate, to make the final list
  const redirectsList = inputRows.flatMap((row) => {
    return processSheetRow(row) ?? [];
  });

  // Format as needed for the Cloudflare Ruleset API
  const bulkList = makeBulkList(redirectsList);

  // Send the processed list to CF
  const uploadResponse = await uploadBulkList(bulkList);

  return new Response(JSON.stringify(uploadResponse), {
    headers: { 'content-type': 'application/json' },
  });
});

addEventListener('fetch', (event: any) => {
  event.respondWith(router.handle(event.request));
});

export {};
