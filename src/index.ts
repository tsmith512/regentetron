import 'dotenv/config';
import chalk from 'chalk';

import { checkSpreadsheetStatus, fetchRedirectRows } from './inputs';
import { processSheetRow, ruleInList } from './processing';
import {
  BulkRedirectListItem,
  emptyBulkList,
  getBulkListContents,
  getBulkListStatus,
  getBulkOpsStatus,
  makeBulkList,
  setListDescription,
  uploadBulkList,
  // uploadBulkList,
} from './outputs';
import { validateBoolean } from './validators';

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
 * @TODO: Now that this is a CLI, not a Worker, this is ... not necessary. But
 * cleaning up how I print reports would be a good idea.
 */
export interface DirectomaticResponse {
  success?: boolean; // If an action was requested
  errors?: any[]; // Error messages either from CF or from this code
  messages?: any[]; // This would be from the CF API
  inputRules?: RedirectProps[];
  invalidRules?: BulkRedirectListItem[] | RawRedirectProps[];
  bulkOperationsId?: string; // The bulk operation assigned, if any
}

// @TODO: Full listing for cf.com but this should be configurable. Move to env var?
export const Locales = [
  'de-de',
  'en-au',
  'en-ca',
  'en-gb',
  'en-in',
  'en-us',
  'es-es',
  'fr-fr',
  'id-id',
  'it-it',
  'ja-jp',
  'ko-kr',
  'nl-nl',
  'pt-br',
  'ru-ru',
  'sv-se',
  'th-th',
  'tr-tr',
  'vi-vn',
  'zh-cn',
  'zh-hans-cn',
  'zh-tw',
];

const arg = process.argv[2] || false;

/**
 * STATUS: Confirm that we can read the Google Sheet and the Rules Lists,
 * count rows in each, and provide links to see each.
 */
const status = async () => {
  const sheet = await checkSpreadsheetStatus();
  const cflist = await getBulkListStatus();

  const success = sheet.success && cflist.success;
  const color = success ? chalk.green : chalk.red;

  console.log(`${chalk.yellow('Success?')} ${color(success)}`);
  console.log(`\n${chalk.red('## Errors:')}`);
  console.log([sheet.errors, cflist.errors].flat().join('\n'));

  console.log(`\n${chalk.blue('## Messages:')}`);
  console.log([sheet.messages, cflist.messages].flat().join('\n'));
};

/**
 * LIST: Show a list of all the redirects that would be generated by the
 * spreadsheet and report a list of any that fail OUR validation.
 */
const list = async () => {
  // Source the unprocessed redirects list from the Google Sheet.
  const inputRows = await fetchRedirectRows();

  // Sanitize, validate, and clean up the input; skim off the bad rows to report.
  const badRows: RawRedirectProps[] = [];
  const redirectsList = inputRows.flatMap((row) => {
    const output = processSheetRow(row);
    if (output) {
      return output;
    } else {
      // If the row was skipped because it was _deleted_, don't include it in
      // the error report output.
      if (!validateBoolean(row.deleted, false)) {
        badRows.push(row);
      }

      // Return empty, which will :magic: away in flatMap() and won't be uploaded.
      return [];
    }
  });

  const color = badRows.length === 0 ? chalk.green : chalk.red;

  const messages = [
    `Google sheet contains ${redirectsList.length} valid rules and ${color(
      badRows.length
    )} rows with errors.`,
  ];

  console.log(`\n${chalk.blue('## Messages:')}\n${messages.join('\n')}`);

  // @TODO: What is a useful way to actually dump these?
  console.log(`\n${chalk.blue('## Valid Rules:')} (total ${redirectsList.length})`);
  console.log(redirectsList.map((r) => `${r.source} --> ${r.destination}`).join('\n'));

  console.log(`\n${chalk.red('## Invalid Rules:')} (total ${badRows.length})`);
  console.log(badRows.map((r) => `${r.source} --> ${r.destination}`).join('\n'));
};

/**
 * DIFF: Pull and process the redirects from the spreadsheet to report on what
 * will be added and what will be removed on a subsequent /publish.
 */
const diff = async () => {
  // Source the unprocessed redirects list from the Google Sheet.
  const inputRows = await fetchRedirectRows();

  // Sanitize, validate, to make the final list
  const redirectsList = inputRows.flatMap((row) => {
    return processSheetRow(row) ?? [];
  });

  // Format as needed for the Cloudflare Ruleset API
  const spreadsheetList = makeBulkList(redirectsList);

  // Get the current list
  const cloudflareList = await getBulkListContents();

  // We need to see what cloudflareList rules aren't in spreadsheetList
  const removedRules = cloudflareList.filter((rule) => {
    return !ruleInList(rule, spreadsheetList);
  });

  // We need to see what spreadsheetList rules aren't in cloudflareList
  const addedRules = spreadsheetList.filter((rule) => {
    return !ruleInList(rule, cloudflareList);
  });

  const messages = [
    [`There are ${addedRules.length} rules to add (in spreadsheet but not published).`],
    [
      `There are ${removedRules.length} rules to remove (published but not in spreadsheet).`,
    ],
  ];

  console.log(`\n${chalk.blue('## Messages:')}`);
  console.log(messages.join('\n'));

  // @TODO: What is a useful way to actually dump these?
  if (addedRules.length) {
    console.log(`${chalk.green('## To Add:')} (these are only in the spreadshet)`);
    console.log(
      addedRules
        .map((r) => `${r.redirect.source_url} --> ${r.redirect.target_url}`)
        .join('\n')
    );
  }

  if (removedRules.length) {
    console.log(`${chalk.red('## To Remove:')} (these are only in Dash)`);
    console.log(
      removedRules
        .map((r) => `${r.redirect.source_url} --> ${r.redirect.target_url}`)
        .join('\n')
    );
  }
};

/**
 * PUBLISH: Fetch redirects from the Google Sheet, sanitize/validate, prep the
 * "good" ones for the Cloudflare List API, and drop/replace the list. Report on
 * any errors and note any redirects that the API rejected.
 *
 * @TODO: Because we truncate, then post one page at a time, an error mid-upload
 * means only a partial list is published. Skip a row and continue??
 */
const publish = async () => {
  // Source the unprocessed redirects list from the Google Sheet.
  const inputRows = await fetchRedirectRows();

  // Sanitize, validate, to make the final list
  const redirectsList = inputRows.flatMap((row) => {
    return processSheetRow(row) ?? [];
  });

  // Format as needed for the Cloudflare Ruleset API
  const bulkList = makeBulkList(redirectsList);

  // @TODO: Long-term, it would be better to figure out what changes need to be
  // made, and make them, rather than doing a truncate / insert.
  console.log('Truncating the existing list...');
  await emptyBulkList();

  console.log(
    `Uploading ${bulkList.length} redirects in ${Math.ceil(
      bulkList.length / 1000
    )} batches`
  );

  // If you POST too many redirects at once, you'll get a rate limiting response
  // so chunk the list in batches of 1000 and post one at a time.
  let i = 0;
  const batch = 1000;
  const results: boolean[] = []
  for (let n = 0; n < bulkList.length; n += batch) {
    i++;
    console.log(chalk.yellow(`### Batch ${i}`));

    const success = await uploadBatch(i, bulkList.slice(n, n + batch));
    const color = success ? chalk.green : chalk.red;

    console.log(color(`Batch ${i}: ${success ? 'complete' : 'failed'}`));
    results.push(success);
  }

  if (await setListDescription(`Updated by Directomatic on ${Date()}`)) {
    console.log(`${chalk.gray('Updated datestamp in list description.')}`);
  }
};

/**
 * Upload a set of redirects and report on (and await) the results.
 */
const uploadBatch = async (
  i: number,
  batchList: BulkRedirectListItem[]
): Promise<boolean> => {
  // Send the processed list to CF
  const uploadResponse = await uploadBulkList(batchList);

  const color = uploadResponse.success ? chalk.green : chalk.red;
  console.log(`Success? ${color(uploadResponse.success)}`);

  if (uploadResponse.errors?.length) {
    console.log(`${chalk.red('Errors:')}`);
    console.log(JSON.stringify(uploadResponse.errors, null, 2));
  }

  if (uploadResponse.messages?.length) {
    console.log(`${chalk.blue('Messages:')}`);
    console.log(JSON.stringify(uploadResponse.messages, null, 2));
  }

  if (uploadResponse.invalidRules?.length) {
    console.log(`${chalk.red('Invalid Rules:')} (usually duplicates)`);
    console.log(JSON.stringify(uploadResponse.invalidRules, null, 2));
  }

  if (uploadResponse.bulkOperationsId) {
    console.log(`${chalk.white('Awaiting confirmation on bulk operation.')} (${chalk.grey(uploadResponse.bulkOperationsId)})`);
    const success = await getBulkOpsStatus(uploadResponse.bulkOperationsId);

    if (success) {
      console.log(chalk.green(`Batch ${i} accepted.`));
      return true;
    } else {
      console.log(chalk.red(`Bulk operation failed for batch ${i}.`));
      return false;
    }
  } else {
    console.log(chalk.yellow(`No bulk operation returned for batch ${i}.`));
  }

  return uploadResponse.success || false;
};

switch (arg) {
  case 'status':
    status();
    break;
  case 'list':
    list();
    break;
  case 'diff':
    diff();
    break;
  case 'publish':
    publish();
    break;
}
